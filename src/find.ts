import type { FindSettings } from './config.js'
import { encodeCursor } from './cursor.js'
import type { SessionDigest } from './passages.js'
import type { SessionDigestTarget } from './worker-protocol.js'

export interface FindRequest {
  readonly queries: readonly string[]
  readonly criteria: readonly string[]
}

export interface FindHit {
  readonly sid: string
  readonly sourceId?: string | undefined
  readonly partId: string
  readonly directory: string
  readonly title: string
  readonly time: string
}

export interface FindSearchResult {
  readonly lists: readonly (readonly FindHit[])[]
  readonly notice?: string | undefined
}

export interface DecisionRequest {
  readonly model: { readonly providerID: string; readonly id: string }
  readonly input: { readonly type: 'text'; readonly text: string }[]
  readonly questions: {
    readonly type: 'predicate'
    readonly name: string
    readonly instructions: string
  }[]
}

export interface DecisionAnswer {
  readonly type: string
  readonly name: string
  readonly probability?: number
  readonly message?: string
}

export interface DecisionResult {
  readonly answers: readonly DecisionAnswer[]
  readonly tokens?: { readonly input?: number }
}

export interface FindDependencies {
  readonly model: DecisionRequest['model']
  readonly settings: FindSettings
  readonly search: (queries: readonly string[]) => Promise<FindSearchResult>
  readonly digest: (
    targets: readonly SessionDigestTarget[],
    queries: readonly string[],
  ) => Promise<readonly SessionDigest[]>
  readonly decide: (request: DecisionRequest) => Promise<DecisionResult>
  readonly now?: () => number
}

interface Candidate {
  readonly cursor: string
  readonly title: string
  readonly directory: string
  readonly fusion: number
  readonly hitPartIds: readonly string[]
}

interface Verdict {
  readonly candidate: Candidate
  readonly digest: SessionDigest
  readonly criteria: readonly (number | undefined)[]
  readonly passages: readonly (number | undefined)[]
  readonly match: number | undefined
  readonly error?: string
}

interface Usage {
  calls: number
  inputTokens: number
}

const RRF_OFFSET = 60
const FIRST_PROMPT_LINE_CHARS = 240
const NEAR_MISSES = 3

export async function findEvidence(request: FindRequest, deps: FindDependencies): Promise<string> {
  const now = deps.now ?? Date.now
  const started = now()
  const queries = unique(request.queries)
  const criteria = unique(request.criteria)
  if (queries.length === 0 || criteria.length === 0) {
    return 'history_find needs at least one query and one criterion.'
  }

  const search = await deps.search(queries)
  const notices = search.notice === undefined ? [] : [search.notice]
  const searched = now()
  const candidates = fuseSessions(search.lists).slice(0, deps.settings.candidateSessions)
  if (candidates.length === 0) {
    return [
      `history_find: no hits for ${queries.length} queries.`,
      ...notices,
      timingLine({ search: searched - started, total: now() - started }),
    ].join('\n')
  }

  const digests = await deps.digest(
    candidates.map((candidate) => ({ cursor: candidate.cursor, hitPartIds: candidate.hitPartIds })),
    queries,
  )
  const digested = now()
  const byCursor = new Map(digests.map((digest) => [digest.cursor, digest]))
  const usage: Usage = { calls: 0, inputTokens: 0 }
  const verdicts = await mapConcurrent(
    candidates.flatMap((candidate) => {
      const digest = byCursor.get(candidate.cursor)
      return digest === undefined ? [] : [{ candidate, digest }]
    }),
    deps.settings.concurrency,
    ({ candidate, digest }) => judgeSession(candidate, digest, criteria, deps, usage),
  )
  const judged = now()

  return [
    renderEvidence(verdicts, criteria, queries.length, deps.settings),
    ...notices,
    timingLine({
      search: searched - started,
      digest: digested - searched,
      judge: judged - digested,
      total: judged - started,
    }),
    `[jev calls=${usage.calls} input_tokens=${usage.inputTokens} ms=${judged - digested}]`,
  ].join('\n')
}

export function fuseSessions(hitLists: readonly (readonly FindHit[])[]): Candidate[] {
  const sessions = new Map<
    string,
    { cursor: string; title: string; directory: string; fusion: number; hitPartIds: Set<string> }
  >()
  for (const hits of hitLists) {
    const ranked = new Set<string>()
    hits.forEach((hit, rank) => {
      const cursor = encodeCursor({
        version: 1,
        sessionId: hit.sid,
        ...(hit.sourceId === undefined ? {} : { sourceId: hit.sourceId }),
      })
      const session = sessions.get(cursor) ?? {
        cursor,
        title: hit.title,
        directory: hit.directory,
        fusion: 0,
        hitPartIds: new Set<string>(),
      }
      session.hitPartIds.add(hit.partId)
      if (!ranked.has(cursor)) {
        ranked.add(cursor)
        session.fusion += 1 / (RRF_OFFSET + rank)
      }
      sessions.set(cursor, session)
    })
  }
  return [...sessions.values()]
    .sort((left, right) => right.fusion - left.fusion)
    .map((session) => ({ ...session, hitPartIds: [...session.hitPartIds] }))
}

async function judgeSession(
  candidate: Candidate,
  digest: SessionDigest,
  criteria: readonly string[],
  deps: FindDependencies,
  usage: Usage,
): Promise<Verdict> {
  const request: DecisionRequest = {
    model: deps.model,
    input: [{ type: 'text', text: sessionDossier(candidate, digest, criteria) }],
    questions: [
      ...criteria.map((criterion, index) => ({
        type: 'predicate' as const,
        name: `c${index + 1}`,
        instructions: `Judging only from the session excerpt, this session satisfies criterion c${index + 1}: ${criterion}`,
      })),
      ...digest.passages.map((_, index) => ({
        type: 'predicate' as const,
        name: `p${index + 1}`,
        instructions: `Passage [p${index + 1}] itself contains direct evidence for at least one criterion.`,
      })),
    ],
  }
  const attempt = () =>
    deps.decide(request).then((result) => {
      usage.calls += 1
      usage.inputTokens += result.tokens?.input ?? 0
      return result
    })
  const outcome = await attempt()
    .catch(() => attempt())
    .then(
      (result) => ({ result }),
      (error: unknown) => ({ error: errorMessage(error) }),
    )
  if ('error' in outcome) {
    return {
      candidate,
      digest,
      criteria: [],
      passages: [],
      match: undefined,
      error: outcome.error,
    }
  }
  const probability = (name: string) =>
    outcome.result.answers.find((answer) => answer.name === name)?.probability
  const criterionProbabilities = criteria.map((_, index) => probability(`c${index + 1}`))
  return {
    candidate,
    digest,
    criteria: criterionProbabilities,
    passages: digest.passages.map((_, index) => probability(`p${index + 1}`)),
    match: criterionProbabilities.some((value) => value === undefined)
      ? undefined
      : Math.min(...criterionProbabilities.map((value) => value ?? 0)),
  }
}

export function sessionDossier(
  candidate: Candidate,
  digest: SessionDigest,
  criteria: readonly string[],
): string {
  return [
    'Criteria:',
    ...criteria.map((criterion, index) => `c${index + 1}: ${criterion}`),
    '',
    `Session: ${candidate.title}`,
    `Directory: ${candidate.directory}`,
    `Active: ${digest.started} to ${digest.updated} (${digest.messages} messages)`,
    `First user prompt: ${digest.firstPrompt}`,
    '',
    'Passages:',
    ...digest.passages.map(
      (passage, index) => `[p${index + 1}] ${passage.role} ${passage.time}: ${passage.text}`,
    ),
  ].join('\n')
}

function renderEvidence(
  verdicts: readonly Verdict[],
  criteria: readonly string[],
  queryCount: number,
  settings: FindSettings,
): string {
  const ranked = [...verdicts].sort(
    (left, right) =>
      (right.match ?? -1) - (left.match ?? -1) || right.candidate.fusion - left.candidate.fusion,
  )
  const matching = ranked.filter((verdict) => (verdict.match ?? 0) >= settings.sessionThreshold)
  const failed = ranked.filter((verdict) => verdict.error !== undefined)
  const lines = [
    `history_find: ${matching.length} of ${verdicts.length} judged sessions match all criteria (p>=${settings.sessionThreshold}); ${queryCount} queries.`,
    ...criteria.map((criterion, index) => `c${index + 1}: ${criterion}`),
  ]
  let budget = settings.outputChars - lines.join('\n').length
  let shownSessions = 0
  let heldPassages = 0
  let budgetCut = 0
  for (const verdict of matching.slice(0, settings.maxSessions)) {
    const block = sessionBlock(verdict, settings)
    heldPassages += block.held
    if (block.text.length > budget) {
      budgetCut += 1
      continue
    }
    budget -= block.text.length + 1
    shownSessions += 1
    lines.push(block.text)
  }
  if (matching.length === 0) {
    lines.push('No session matched every criterion. Nearest sessions:')
    for (const verdict of ranked.filter((item) => item.error === undefined).slice(0, NEAR_MISSES)) {
      lines.push(sessionHeader(verdict))
    }
  }
  const belowThreshold = verdicts.length - matching.length - failed.length
  lines.push(
    `held back: ${matching.length - shownSessions} matching sessions (${budgetCut} over the ${settings.outputChars}-char budget), ${belowThreshold} sessions below threshold, ${heldPassages} passages below p>=${settings.passageThreshold} or over ${settings.maxPassagesPerSession} per session.`,
  )
  if (failed.length > 0) {
    lines.push(`judge errors: ${failed.length} sessions unjudged (${failed[0]?.error ?? ''})`)
  }
  return lines.join('\n')
}

function sessionBlock(verdict: Verdict, settings: FindSettings): { text: string; held: number } {
  const passages = verdict.digest.passages
    .map((passage, index) => ({ passage, probability: verdict.passages[index] ?? 0 }))
    .filter((item) => item.probability >= settings.passageThreshold)
    .sort((left, right) => right.probability - left.probability)
  const shown = passages
    .slice(0, settings.maxPassagesPerSession)
    .sort((left, right) => left.passage.time.localeCompare(right.passage.time))
  return {
    text: [
      sessionHeader(verdict),
      `  first prompt: ${truncate(verdict.digest.firstPrompt, FIRST_PROMPT_LINE_CHARS)}`,
      ...shown.map(
        ({ passage, probability }) =>
          `  - ${formatProbability(probability)} ${passage.cursor} ${passage.role} ${passage.time.slice(0, 16)}: ${passage.text}`,
      ),
    ].join('\n'),
    held: verdict.digest.passages.length - shown.length,
  }
}

function sessionHeader(verdict: Verdict): string {
  const criteria = verdict.criteria
    .map((value, index) => `c${index + 1}=${formatProbability(value)}`)
    .join(' ')
  return [
    `## ${verdict.candidate.cursor} match=${formatProbability(verdict.match)} (${criteria})`,
    `${verdict.digest.started.slice(0, 10)}..${verdict.digest.updated.slice(0, 10)}`,
    `${verdict.digest.messages} msgs`,
    `"${verdict.candidate.title}"`,
    verdict.candidate.directory,
  ].join(' · ')
}

function timingLine(stages: Readonly<Record<string, number>>): string {
  return `timing ms: ${Object.entries(stages)
    .map(([stage, ms]) => `${stage}=${Math.round(ms)}`)
    .join(' ')}`
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      const item = items[index] as T
      results[index] = await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane))
  return results
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))]
}

function truncate(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`
}

function formatProbability(value: number | undefined): string {
  return value === undefined ? '?' : value.toFixed(2)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
