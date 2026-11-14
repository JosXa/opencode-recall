import type { JudgeConfig } from './config.js'
import { encodeCursor } from './cursor.js'
import {
  bestSegments,
  expandSegments,
  type FocusResult,
  focusTranscripts,
  renderSegment,
} from './focus.js'
import type { FocusTranscript } from './focus-transcript.js'
import type { SessionScanResult } from './history-sources.js'
import { type Decide, Jev, mapConcurrent } from './jev.js'
import type { SessionDigest } from './passages.js'
import type { RecallRun } from './recall-run.js'
import { type RankedSession, rankSessions } from './scan.js'
import type { SessionDigestTarget } from './worker-protocol.js'

export interface FindWindow {
  readonly after?: string | undefined
  readonly before?: string | undefined
  readonly withinDays?: number | undefined
}

export interface FindRequest {
  readonly queries: readonly string[]
  readonly criteria: readonly string[]
  readonly window: FindWindow
}

export interface FindHit {
  readonly sid: string
  readonly sourceId?: string | undefined
  readonly partId?: string | undefined
  readonly directory: string
  readonly title: string
}

export interface FindSearchResult {
  readonly lists: readonly (readonly FindHit[])[]
  readonly notice?: string | undefined
}

export interface FindScanResult extends SessionScanResult {
  readonly after?: number | undefined
  readonly before?: number | undefined
}

export interface FindDependencies {
  readonly judge: JudgeConfig
  readonly run: RecallRun
  readonly decide: Decide
  readonly search: (queries: readonly string[], window: FindWindow) => Promise<FindSearchResult>
  readonly scan: (window: FindWindow) => Promise<FindScanResult>
  readonly digest: (
    targets: readonly SessionDigestTarget[],
    terms: readonly string[],
  ) => Promise<readonly SessionDigest[]>
  readonly transcripts: (cursors: readonly string[]) => Promise<readonly FocusTranscript[]>
  readonly standard: () => Promise<string>
  readonly onJudgeDown: () => void
  readonly now?: () => number
}

type Origin = 'carried' | 'scan' | 'search'

interface Candidate {
  readonly cursor: string
  readonly title: string
  readonly directory: string
  readonly fusion: number
  readonly hitPartIds: readonly string[]
  readonly origin: Origin
}

interface Verdict {
  readonly candidate: Candidate
  readonly digest: SessionDigest
  readonly criteria: readonly (number | undefined)[]
  readonly passages: readonly (number | undefined)[]
  readonly match: number | undefined
  readonly unjudged: boolean
}

interface ScanOutcome {
  readonly result: FindScanResult
  readonly judged: number
  readonly candidates: readonly RankedSession[]
}

const RRF_OFFSET = 60
export const BUDGET_FALLBACK_NOTICE =
  'below are history_search results for the queries; read them with history_read without criteria.'

export const STANDARD_FALLBACK_NOTICE =
  'recall switched to the standard history tools (history_search, history_read, session_index); below are history_search results for the queries.'
const FIRST_PROMPT_LINE_CHARS = 240
const NEAR_MISSES = 3
const NEAR_MISS_FOCUS_SESSIONS = 2
const NEAR_MISS_FOCUS_FLOOR = 0.1
const PICK_SEGMENT_CHARS = 2_500
const MIN_SEGMENT_CHARS = 400
const BLOCK_OVERHEAD_CHARS = 1_200
const BREADTH_WORDS =
  /\b(all|every|each|list|timeline|overview|chronolog\w*|history of|alle[nmrs]?|jede[nmrs]?|liste|verlauf|übersicht)\b/iu

interface BlockShape {
  readonly segments: number
  readonly segmentChars: number
  readonly passages: number
  readonly expand: number
}

export async function findEvidence(request: FindRequest, deps: FindDependencies): Promise<string> {
  const now = deps.now ?? Date.now
  const started = now()
  const queries = unique(request.queries)
  const criteria = unique(request.criteria)
  if (criteria.length === 0) return 'history_find needs at least one criterion.'
  const settings = deps.judge.find
  const jev = new Jev(deps.judge.model, deps.decide, deps.run.budget, now, deps.judge.timeoutMs)
  const timings: Record<string, number> = {}
  const timed = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
    const begun = now()
    const result = await work()
    timings[stage] = (timings[stage] ?? 0) + now() - begun
    return result
  }
  await timed('sync', () => deps.run.ready)
  const windowed = Object.values(request.window).some((value) => value !== undefined)
  const scanWanted = queries.length === 0 || windowed
  const [search, firstScan] = await Promise.all([
    queries.length === 0
      ? Promise.resolve<FindSearchResult>({ lists: [] })
      : timed('search', () =>
          deps.search(queries, { after: request.window.after, before: request.window.before }),
        ),
    scanWanted
      ? timed('scan', () => scanWindow(request.window, criteria, deps, jev))
      : Promise.resolve(undefined),
  ])
  const notices = search.notice === undefined ? [] : [search.notice]
  const terms = [...queries, ...criteria]
  const candidates = selectCandidates(
    deps.run.carried(settings.carriedSessions).map((session) => ({
      ...session,
      fusion: 1,
      hitPartIds: [],
      origin: 'carried' as const,
    })),
    (firstScan?.candidates ?? []).map(scanCandidate),
    fuseSessions(search.lists),
    settings.candidateSessions,
  )
  const verdicts = await timed('judge', () =>
    judgeCandidates(candidates, terms, criteria, deps, jev),
  )
  let scan = firstScan
  const timing = () =>
    `timing ms: ${Object.entries({ ...timings, total: now() - started })
      .map(([stage, ms]) => `${stage}=${Math.round(ms)}`)
      .join(' ')}`
  if (judgeDown(verdicts, jev)) {
    deps.onJudgeDown()
    return [
      jev.footer(),
      jev.unavailableNotice(STANDARD_FALLBACK_NOTICE),
      await deps.standard(),
    ].join('\n')
  }
  if (verdicts.length > 0 && jev.budgetSpent) {
    return [jev.footer(), jev.budgetNotice(BUDGET_FALLBACK_NOTICE), await deps.standard()].join(
      '\n',
    )
  }
  const strongest = Math.max(0, ...verdicts.map((verdict) => verdict.match ?? 0))
  if (!scanWanted && strongest < settings.weakMatch) {
    scan = await timed('scan', () =>
      scanWindow({ withinDays: deps.judge.scan.fallbackDays }, criteria, deps, jev),
    )
    const judged = new Set(verdicts.map((verdict) => verdict.candidate.cursor))
    const fresh = scan.candidates
      .map(scanCandidate)
      .filter((candidate) => !judged.has(candidate.cursor))
    verdicts.push(
      ...(await timed('judge', () => judgeCandidates(fresh, terms, criteria, deps, jev))),
    )
  }
  const ranked = verdicts.sort(
    (left, right) =>
      (right.match ?? -1) - (left.match ?? -1) || right.candidate.fusion - left.candidate.fusion,
  )
  const matching = ranked.filter((verdict) => isMatch(verdict, deps.judge))
  const partial = partialMatches(ranked, deps.judge)
  const breadth = wantsBreadth([...queries, ...criteria])
  const relevant = [...matching, ...partial]
  const focused = await timed('focus', () =>
    focusMatches(
      relevant.length > 0 ? relevant : nearMisses(ranked),
      breadth ? settings.maxSessions : deps.judge.focus.sessions,
      criteria,
      deps,
      jev,
    ),
  )
  const picked = await timed('pick', () =>
    pickBest(matching, focused, queries, criteria, deps.judge, jev),
  )
  for (const verdict of matching) {
    deps.run.pool.set(verdict.candidate.cursor, {
      cursor: verdict.candidate.cursor,
      title: verdict.candidate.title,
      directory: verdict.candidate.directory,
      match: verdict.match ?? 0,
    })
  }
  const problems = jev.problems()
  return [
    jev.footer(),
    renderEvidence(ranked, picked, partial, focused, criteria, queries.length, deps.judge, breadth),
    ...scanLines(scan),
    ...notices,
    ...(problems === undefined ? [] : [problems]),
    timing(),
  ].join('\n')
}

function judgeDown(verdicts: readonly Verdict[], jev: Jev): boolean {
  if (verdicts.length === 0) return jev.unavailable
  const unjudged = verdicts.filter((verdict) => verdict.unjudged).length
  return jev.failures > 0 && unjudged * 2 > verdicts.length
}

async function scanWindow(
  window: FindWindow,
  criteria: readonly string[],
  deps: FindDependencies,
  jev: Jev,
): Promise<ScanOutcome> {
  const result = await deps.scan(window)
  const scan = deps.judge.scan
  const ranking = await rankSessions(result.sessions, criteria, jev, {
    pack: scan.pack,
    concurrency: deps.judge.find.concurrency,
  })
  return {
    result,
    judged: ranking.judged,
    candidates:
      ranking.judged === 0
        ? result.sessions
            .slice(0, scan.candidates)
            .map((session) => ({ ...session, probability: 0 }))
        : ranking.ranked
            .filter((session) => session.probability >= scan.minProbability)
            .slice(0, scan.candidates),
  }
}

function scanCandidate(session: RankedSession): Candidate {
  return {
    cursor: session.cursor,
    title: session.title,
    directory: session.directory,
    fusion: session.probability,
    hitPartIds: [],
    origin: 'scan',
  }
}

export function selectCandidates(
  carried: readonly Candidate[],
  scanned: readonly Candidate[],
  searched: readonly Candidate[],
  limit: number,
): Candidate[] {
  const selected = new Map<string, Candidate>()
  for (const candidate of [...carried, ...scanned, ...searched]) {
    const existing = selected.get(candidate.cursor)
    if (existing !== undefined) {
      selected.set(candidate.cursor, {
        ...existing,
        hitPartIds: [...new Set([...existing.hitPartIds, ...candidate.hitPartIds])],
      })
      continue
    }
    if (selected.size >= limit) continue
    selected.set(candidate.cursor, candidate)
  }
  return [...selected.values()]
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
      if (hit.partId !== undefined) session.hitPartIds.add(hit.partId)
      if (!ranked.has(cursor)) {
        ranked.add(cursor)
        session.fusion += 1 / (RRF_OFFSET + rank)
      }
      sessions.set(cursor, session)
    })
  }
  return [...sessions.values()]
    .sort((left, right) => right.fusion - left.fusion)
    .map((session) => ({ ...session, hitPartIds: [...session.hitPartIds], origin: 'search' }))
}

async function judgeCandidates(
  candidates: readonly Candidate[],
  terms: readonly string[],
  criteria: readonly string[],
  deps: FindDependencies,
  jev: Jev,
): Promise<Verdict[]> {
  if (candidates.length === 0) return []
  const digests = await deps.digest(
    candidates.map((candidate) => ({ cursor: candidate.cursor, hitPartIds: candidate.hitPartIds })),
    terms,
  )
  const byCursor = new Map(digests.map((digest) => [digest.cursor, digest]))
  return mapConcurrent(
    candidates.flatMap((candidate) => {
      const digest = byCursor.get(candidate.cursor)
      return digest === undefined ? [] : [{ candidate, digest }]
    }),
    deps.judge.find.concurrency,
    ({ candidate, digest }) => judgeSession(candidate, digest, criteria, deps.run, jev),
  )
}

async function judgeSession(
  candidate: Candidate,
  digest: SessionDigest,
  criteria: readonly string[],
  run: RecallRun,
  jev: Jev,
): Promise<Verdict> {
  const criterionKeys = criteria.map((criterion) => `${candidate.cursor}\n${criterion}`)
  const criteriaKey = criteria.join('\n')
  const passageKeys = digest.passages.map((passage) => `${passage.cursor}\n${criteriaKey}`)
  const questions = [
    ...criteria.flatMap((criterion, index) =>
      run.verdicts.has(criterionKeys[index] ?? '')
        ? []
        : [
            {
              type: 'predicate' as const,
              name: `c${index + 1}`,
              instructions: `Judging only from the session excerpt, this session satisfies criterion c${index + 1}: ${criterion}`,
            },
          ],
    ),
    ...digest.passages.flatMap((_, index) =>
      run.verdicts.has(passageKeys[index] ?? '')
        ? []
        : [
            {
              type: 'predicate' as const,
              name: `p${index + 1}`,
              instructions: `Passage [p${index + 1}] itself contains direct evidence for at least one criterion.`,
            },
          ],
    ),
  ]
  const answers =
    questions.length === 0
      ? new Map<string, number>()
      : await jev.ask([sessionDossier(candidate, digest, criteria)], questions)
  for (const [name, probability] of answers ?? []) {
    const position = Number(name.slice(1)) - 1
    const key = name.startsWith('c') ? criterionKeys[position] : passageKeys[position]
    if (key !== undefined) run.verdicts.set(key, probability)
  }
  const criterionProbabilities = criterionKeys.map((key) => run.verdicts.get(key))
  return {
    candidate,
    digest,
    criteria: criterionProbabilities,
    passages: passageKeys.map((key) => run.verdicts.get(key)),
    match: criterionProbabilities.some((value) => value === undefined)
      ? undefined
      : Math.min(...criterionProbabilities.map((value) => value ?? 0)),
    unjudged: criterionProbabilities.some((value) => value === undefined),
  }
}

export function sessionDossier(
  candidate: Pick<Candidate, 'title' | 'directory'>,
  digest: SessionDigest,
  criteria: readonly string[],
): string {
  return [
    'Criteria:',
    ...criteria.map((criterion, index) => `c${index + 1}: ${criterion}`),
    '',
    sessionSummary(candidate, digest),
  ].join('\n')
}

function sessionSummary(
  candidate: Pick<Candidate, 'title' | 'directory'>,
  digest: SessionDigest,
): string {
  return [
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

async function focusMatches(
  matching: readonly Verdict[],
  sessions: number,
  criteria: readonly string[],
  deps: FindDependencies,
  jev: Jev,
): Promise<ReadonlyMap<string, FocusResult>> {
  const focus = deps.judge.focus
  const targets = matching.slice(0, Math.min(sessions, deps.judge.find.maxSessions))
  if (targets.length === 0) return new Map()
  const transcripts = await deps.transcripts(targets.map(anchorCursor))
  const results = await focusTranscripts(
    transcripts,
    criteria,
    focus,
    jev,
    deps.run,
    deps.judge.find.concurrency,
  )
  return new Map(results.map((result) => [result.transcript.sid, result]))
}

interface Picked {
  readonly verdicts: readonly Verdict[]
  readonly probabilities: ReadonlyMap<string, number>
}

async function pickBest(
  matching: readonly Verdict[],
  focused: ReadonlyMap<string, FocusResult>,
  queries: readonly string[],
  criteria: readonly string[],
  judge: JudgeConfig,
  jev: Jev,
): Promise<Picked> {
  const unpicked = { verdicts: matching, probabilities: new Map<string, number>() }
  const top = matching[0]?.match
  if (top === undefined || judge.find.pickSessions < 2) return unpicked
  const close = matching
    .slice(0, judge.find.pickSessions)
    .filter((verdict) => top - (verdict.match ?? 0) <= judge.find.pickMargin)
  if (close.length < 2) return unpicked
  const labels = close.map((_, index) => `S${index + 1}`)
  const answers = await jev.ask(
    [
      [
        'Criteria:',
        ...criteria.map((criterion, index) => `c${index + 1}: ${criterion}`),
        ...(queries.length === 0 ? [] : [`Search terms: ${queries.join('; ')}`]),
      ].join('\n'),
      ...close.map(
        (verdict, index) =>
          `<session id="${labels[index]}">\n${pickDossier(verdict, focused.get(verdict.candidate.cursor), judge)}\n</session>`,
      ),
    ],
    labels.map((label) => ({
      type: 'predicate' as const,
      name: label,
      instructions: `Of the ${close.length} sessions shown, session ${label} is the one that best satisfies every criterion and holds the most specific, final answer about it.`,
    })),
  )
  if (answers === undefined) return unpicked
  const scored = close
    .map((verdict, index) => ({ verdict, probability: answers.get(labels[index] ?? '') ?? 0 }))
    .sort((left, right) => right.probability - left.probability)
  return {
    verdicts: [...scored.map((item) => item.verdict), ...matching.slice(close.length)],
    probabilities: new Map(
      scored.map((item) => [item.verdict.candidate.cursor, item.probability] as const),
    ),
  }
}

function pickDossier(verdict: Verdict, focus: FocusResult | undefined, judge: JudgeConfig): string {
  const segments = focus === undefined ? [] : bestSegments(focus, judge.focus)
  return [
    sessionSummary(verdict.candidate, verdict.digest),
    ...segments.map((segment) => renderSegment(segment, PICK_SEGMENT_CHARS)),
  ].join('\n')
}

export function wantsBreadth(texts: readonly string[]): boolean {
  return texts.some((text) => BREADTH_WORDS.test(text))
}

function anchorCursor(verdict: Verdict): string {
  const best = verdict.digest.passages
    .map((passage, index) => ({ passage, probability: verdict.passages[index] ?? 0 }))
    .sort((left, right) => right.probability - left.probability)[0]
  return best === undefined || best.probability < 0.5
    ? verdict.candidate.cursor
    : best.passage.cursor
}

function nearMisses(ranked: readonly Verdict[]): Verdict[] {
  return ranked
    .filter((verdict) => (verdict.match ?? 0) >= NEAR_MISS_FOCUS_FLOOR)
    .slice(0, NEAR_MISS_FOCUS_SESSIONS)
}

function isMatch(verdict: Verdict, judge: JudgeConfig): boolean {
  return (verdict.match ?? 0) >= judge.find.sessionThreshold
}

function satisfied(verdict: Verdict, judge: JudgeConfig): number {
  return verdict.criteria.filter((value) => (value ?? 0) >= judge.find.sessionThreshold).length
}

function meanCriterion(verdict: Verdict): number {
  return (
    verdict.criteria.reduce<number>((sum, value) => sum + (value ?? 0), 0) /
    Math.max(1, verdict.criteria.length)
  )
}

function partialMatches(ranked: readonly Verdict[], judge: JudgeConfig): Verdict[] {
  return ranked
    .filter(
      (verdict) =>
        verdict.criteria.length > 1 &&
        !isMatch(verdict, judge) &&
        satisfied(verdict, judge) > 0 &&
        verdict.criteria.some((value) => (value ?? 0) >= judge.find.partialMatch),
    )
    .sort(
      (left, right) =>
        satisfied(right, judge) - satisfied(left, judge) ||
        meanCriterion(right) - meanCriterion(left),
    )
}

function renderEvidence(
  ranked: readonly Verdict[],
  picked: Picked,
  partial: readonly Verdict[],
  focused: ReadonlyMap<string, FocusResult>,
  criteria: readonly string[],
  queryCount: number,
  judge: JudgeConfig,
  breadth: boolean,
): string {
  const settings = judge.find
  const matching = picked.verdicts
  const unjudged = ranked.filter((verdict) => verdict.unjudged)
  const lines = [
    `history_find: ${matching.length} of ${ranked.length} judged sessions match all criteria (p>=${settings.sessionThreshold})${partial.length === 0 ? '' : `, ${partial.length} more match some`}; ${queryCount} queries.`,
    ...criteria.map((criterion, index) => `c${index + 1}: ${criterion}`),
  ]
  let budget = settings.outputChars - lines.join('\n').length
  let shownSessions = 0
  let heldPassages = 0
  let budgetCut = 0
  const relevant = [...matching, ...partial]
  const sessions = relevant.slice(0, settings.maxSessions)
  sessions.forEach((verdict, position) => {
    const allowance = Math.floor(budget / (sessions.length - position))
    const block = fitBlock(
      verdict,
      focused.get(verdict.candidate.cursor),
      judge,
      position === 0 ? deepShape(judge, breadth) : undefined,
      position === 0 ? budget : allowance,
      picked.probabilities.get(verdict.candidate.cursor),
    )
    heldPassages += block.held
    if (block.text.length > budget) {
      budgetCut += 1
      return
    }
    budget -= block.text.length + 1
    shownSessions += 1
    lines.push(block.text)
  })
  if (relevant.length === 0) {
    lines.push('No session matched every criterion. Nearest sessions:')
    ranked
      .filter((item) => !item.unjudged)
      .slice(0, NEAR_MISSES)
      .forEach((verdict, position) => {
        const focus = focused.get(verdict.candidate.cursor)
        if (focus === undefined) {
          lines.push(sessionHeader(verdict, judge))
          return
        }
        const block = fitBlock(
          verdict,
          focus,
          judge,
          position === 0 ? deepShape(judge, false) : undefined,
          Math.max(0, budget),
          undefined,
        )
        budget -= block.text.length + 1
        lines.push(block.text)
      })
  }
  const belowThreshold = ranked.length - relevant.length - unjudged.length
  lines.push(
    `held back: ${relevant.length - shownSessions} matching sessions (${budgetCut} over the ${settings.outputChars}-char budget), ${belowThreshold} sessions below threshold, ${heldPassages} passages or segments.`,
  )
  if (unjudged.length > 0) lines.push(`unjudged: ${unjudged.length} sessions`)
  return lines.join('\n')
}

function deepShape(judge: JudgeConfig, breadth: boolean): BlockShape {
  return {
    segments: breadth ? 1 : judge.focus.topSegments,
    segmentChars: judge.focus.topSegmentChars,
    passages: judge.find.maxPassagesPerSession,
    expand: judge.focus.topNeighbours,
  }
}

function fitBlock(
  verdict: Verdict,
  focus: FocusResult | undefined,
  judge: JudgeConfig,
  deep: BlockShape | undefined,
  allowance: number,
  pick: number | undefined,
): { text: string; held: number } {
  const regular: BlockShape = {
    segments: judge.focus.segmentsPerSession,
    segmentChars: judge.focus.segmentChars,
    passages: judge.find.maxPassagesPerSession - judge.focus.segmentsPerSession,
    expand: 0,
  }
  const compact: BlockShape = {
    segments: 1,
    segmentChars: Math.max(MIN_SEGMENT_CHARS, allowance - BLOCK_OVERHEAD_CHARS),
    passages: 1,
    expand: 0,
  }
  const fallback = sessionBlock(verdict, focus, judge, compact, pick)
  return (
    [...(deep === undefined ? [] : [deep]), regular]
      .map((shape) => sessionBlock(verdict, focus, judge, shape, pick))
      .find((block) => block.text.length <= allowance) ?? fallback
  )
}

function sessionBlock(
  verdict: Verdict,
  focus: FocusResult | undefined,
  judge: JudgeConfig,
  shape: BlockShape,
  pick: number | undefined,
): { text: string; held: number } {
  const header = [
    sessionHeader(verdict, judge, pick),
    `  first prompt: ${truncate(verdict.digest.firstPrompt, FIRST_PROMPT_LINE_CHARS)}`,
  ]
  const best =
    focus === undefined
      ? []
      : bestSegments(focus, { ...judge.focus, segmentsPerSession: shape.segments })
  const segments =
    focus === undefined || shape.expand === 0 ? best : expandSegments(focus, best, shape.expand)
  const settings = judge.find
  const passages = verdict.digest.passages
    .map((passage, index) => ({ passage, probability: verdict.passages[index] ?? 0 }))
    .filter((item) => item.probability >= settings.passageThreshold)
    .filter((item) => !segments.some((segment) => segment.text.includes(item.passage.cursor)))
    .sort((left, right) => right.probability - left.probability)
  const shown = passages
    .slice(
      0,
      shape.expand > 0
        ? shape.passages
        : Math.max(1, shape.passages + shape.segments - best.length),
    )
    .sort((left, right) => left.passage.time.localeCompare(right.passage.time))
  const heldSegments =
    focus === undefined
      ? 0
      : focus.scored.filter((segment) => segment.evidence >= judge.focus.minScore).length -
        best.length
  return {
    text: [
      ...header,
      ...segments.map((segment) => renderSegment(segment, shape.segmentChars)),
      ...shown.map(
        ({ passage, probability }) =>
          `  - ${formatProbability(probability)} ${passage.cursor} ${passage.role} ${passage.time.slice(0, 16)}: ${passage.text}`,
      ),
    ].join('\n'),
    held: passages.length - shown.length + Math.max(0, heldSegments),
  }
}

function sessionHeader(verdict: Verdict, judge: JudgeConfig, pick?: number): string {
  const criteria = verdict.criteria
    .map((value, index) => `c${index + 1}=${formatProbability(value)}`)
    .join(' ')
  const coverage =
    isMatch(verdict, judge) || verdict.criteria.length < 2
      ? ''
      : ` partial ${satisfied(verdict, judge)}/${verdict.criteria.length}`
  return `## ${verdict.candidate.cursor} match=${formatProbability(verdict.match)} (${criteria})${coverage}${pick === undefined ? '' : ` best=${formatProbability(pick)}`} · ${sessionFacts(verdict)}`
}

function sessionFacts(verdict: Verdict): string {
  return [
    `${verdict.digest.started.slice(0, 10)}..${verdict.digest.updated.slice(0, 10)}`,
    `${verdict.digest.messages} msgs`,
    `"${verdict.candidate.title}"`,
    verdict.candidate.directory,
    ...(verdict.candidate.origin === 'search' ? [] : [`via ${verdict.candidate.origin}`]),
  ].join(' · ')
}

function scanLines(scan: ScanOutcome | undefined): string[] {
  return scan === undefined ? [] : [scanLine(scan)]
}

function scanLine(scan: ScanOutcome): string {
  const { result } = scan
  const window = `${formatDate(result.after) ?? 'start'}..${formatDate(result.before) ?? 'now'}`
  return `scan: judged ${scan.judged} of ${result.total} sessions active ${window}, ${scan.candidates.length} candidates${result.continueBefore === undefined ? '' : `; older sessions not scanned, continue with before=${new Date(result.continueBefore).toISOString()}`}`
}

function formatDate(time: number | undefined): string | undefined {
  return time === undefined ? undefined : new Date(time).toISOString().slice(0, 16)
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
