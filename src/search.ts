import { encodeCursor } from './cursor'
import type { SearchRow } from './db'
import type { SyncResult } from './sidecar'

const SYNC_NOTICE_THRESHOLD_MS = 5_000
const MAX_RESULTS_PER_SESSION = 2
const SEMANTIC_RESCUE_LIMIT = 3
const SEMANTIC_RESCUE_THRESHOLD = 0.62
const SEMANTIC_RESCUE_MARGIN = 0.03
const RECALL_META_PENALTY = 100
const WHITESPACE_REGEX = /\s+/gu
const META_TITLE_PATTERNS = [
  'mine history topics',
  'figma mcp history search',
  'retrieve figma mcp session transcript',
  'figma mcp azure api center registry setup',
  '@general subagent',
] as const
const META_TEXT_PATTERNS = [
  'expected session',
  'candidate query strings',
  'expanded eval results',
  'real-history',
  'use only history_search',
  '<path>',
] as const

export interface HistorySearchResult {
  readonly cursor: string
  readonly sid: string
  readonly directory: string
  readonly title: string
  readonly time: string
  readonly role: string
  readonly score?: number
  readonly text: string
}

export function formatSearchResults(rows: readonly SearchRow[], syncResult?: SyncResult): string {
  const notice = formatSyncNotice(syncResult)
  const result = formatSearchRows(rows)

  return notice === undefined ? result : `${notice}\n${result}`
}

export function rankSearchRows(
  query: string,
  rows: readonly SearchRow[],
  limit: number,
): SearchRow[] {
  const terms = tokenizeQuery(query)
  const phrase = terms.join(' ')
  const candidates = dedupeRows(rows).map((row) => scoreCandidate(row, terms, phrase))
  const strictCandidates = candidates.filter((candidate) => candidate.score >= minimumScore(terms))
  const rescuedCandidates = semanticRescueCandidates(candidates, strictCandidates, terms)
  const deduped = dedupeCandidates([...strictCandidates, ...rescuedCandidates]).sort(
    (left, right) =>
      right.score - left.score ||
      (right.row.score ?? 0) - (left.row.score ?? 0) ||
      right.row.timeCreated - left.row.timeCreated,
  )

  return diversifyBySession(deduped, limit).map(({ row, score }) => ({ ...row, score }))
}

function formatSearchRows(rows: readonly SearchRow[]): string {
  if (rows.length === 0) {
    return 'No matching OpenCode history entries found.'
  }

  return JSON.stringify(rows.map(formatSearchResult), null, 2)
}

function formatSyncNotice(syncResult: SyncResult | undefined): string | undefined {
  if (
    syncResult === undefined ||
    syncResult.indexedRows === 0 ||
    syncResult.elapsedMs < SYNC_NOTICE_THRESHOLD_MS
  ) {
    return undefined
  }

  return `<sync indexed_rows="${syncResult.indexedRows}" seconds="${(syncResult.elapsedMs / 1000).toFixed(2)}" />`
}

function formatSearchResult(row: SearchRow): HistorySearchResult {
  return {
    cursor: encodeCursor({
      version: 1,
      sessionId: row.sessionId,
      messageId: row.messageId,
      partId: row.partId,
      timeCreated: row.timeCreated,
    }),
    sid: row.sessionId,
    directory: row.directory,
    title: row.sessionTitle,
    role: row.role,
    ...(row.score === undefined ? {} : { score: Number(row.score.toFixed(4)) }),
    time: new Date(row.timeCreated).toISOString(),
    text: makeSnippet(row.text),
  }
}

function dedupeRows(rows: readonly SearchRow[]): SearchRow[] {
  const byPart = new Map<string, SearchRow>()

  for (const row of rows) {
    const existing = byPart.get(row.partId)

    if (existing !== undefined && (existing.score ?? 0) >= (row.score ?? 0)) {
      continue
    }

    byPart.set(row.partId, row)
  }

  return [...byPart.values()]
}

function dedupeCandidates(
  candidates: readonly { readonly row: SearchRow; readonly score: number }[],
): { readonly row: SearchRow; readonly score: number }[] {
  const byPart = new Map<string, { readonly row: SearchRow; readonly score: number }>()

  for (const candidate of candidates) {
    const existing = byPart.get(candidate.row.partId)

    if (existing !== undefined && existing.score >= candidate.score) {
      continue
    }

    byPart.set(candidate.row.partId, candidate)
  }

  return [...byPart.values()]
}

function diversifyBySession(
  candidates: readonly { readonly row: SearchRow; readonly score: number }[],
  limit: number,
): { readonly row: SearchRow; readonly score: number }[] {
  const selected: { readonly row: SearchRow; readonly score: number }[] = []
  const perSession = new Map<string, number>()

  for (const candidate of candidates) {
    const count = perSession.get(candidate.row.sessionId) ?? 0

    if (count >= MAX_RESULTS_PER_SESSION) {
      continue
    }

    selected.push(candidate)
    perSession.set(candidate.row.sessionId, count + 1)

    if (selected.length >= limit) {
      return selected
    }
  }

  return selected
}

function strictScore(row: SearchRow, terms: readonly string[], phrase: string): number {
  const title = normalize(row.sessionTitle)
  const directory = normalize(row.directory)
  const text = normalize(row.text)
  const searchable = `${title} ${directory} ${text}`
  const titleMatches = matchedTermCount(title, terms)
  const textMatches = matchedTermCount(text, terms)
  const directoryMatches = matchedTermCount(directory, terms)
  const totalMatches = matchedTermCount(searchable, terms)

  if (terms.length > 1 && totalMatches < requiredTermMatches(terms)) {
    return 0
  }

  if (terms.length === 1 && totalMatches === 0) {
    return 0
  }

  const titleRatio = ratio(titleMatches, terms.length)
  const textRatio = ratio(textMatches, terms.length)
  const directoryRatio = ratio(directoryMatches, terms.length)
  const semantic = row.score ?? 0
  const phraseBoost = phrase.length > 0 && searchable.includes(phrase) ? 3 : 0
  const titlePhraseBoost = phrase.length > 0 && title.includes(phrase) ? 5 : 0
  const titleSourceBoost = row.source === 'session-title' ? 2 : 0
  const exactness = titleRatio * 9 + textRatio * 4 + directoryRatio
  const metaPenalty = recallMetaPenalty(title, text)

  return exactness + phraseBoost + titlePhraseBoost + titleSourceBoost + semantic - metaPenalty
}

function scoreCandidate(
  row: SearchRow,
  terms: readonly string[],
  phrase: string,
): { readonly row: SearchRow; readonly score: number } {
  return { row, score: strictScore(row, terms, phrase) }
}

function semanticRescueCandidates(
  candidates: readonly { readonly row: SearchRow; readonly score: number }[],
  strictCandidates: readonly { readonly row: SearchRow; readonly score: number }[],
  terms: readonly string[],
): { readonly row: SearchRow; readonly score: number }[] {
  const bestStrictSemantic = Math.max(
    0,
    ...strictCandidates.map((candidate) => candidate.row.score ?? 0),
  )

  return candidates
    .filter((candidate) => candidate.score < minimumScore(terms))
    .filter((candidate) => recallMetaPenaltyForRow(candidate.row) === 0)
    .filter((candidate) => semanticScore(candidate.row) >= SEMANTIC_RESCUE_THRESHOLD)
    .filter(
      (candidate) => semanticScore(candidate.row) >= bestStrictSemantic - SEMANTIC_RESCUE_MARGIN,
    )
    .sort(
      (left, right) =>
        semanticScore(right.row) - semanticScore(left.row) ||
        right.row.timeCreated - left.row.timeCreated,
    )
    .slice(0, SEMANTIC_RESCUE_LIMIT)
    .map((candidate) => ({
      row: { ...candidate.row, source: 'semantic-rescue' },
      score: minimumScore(terms) + semanticScore(candidate.row),
    }))
}

function semanticScore(row: SearchRow): number {
  return row.score ?? 0
}

function recallMetaPenalty(title: string, text: string): number {
  if (title.startsWith('history search')) {
    return RECALL_META_PENALTY
  }

  if (META_TITLE_PATTERNS.some((pattern) => title.includes(pattern))) {
    return RECALL_META_PENALTY
  }

  if (META_TEXT_PATTERNS.some((pattern) => text.includes(pattern))) {
    return RECALL_META_PENALTY
  }

  if (text.startsWith('top=ses_')) {
    return RECALL_META_PENALTY
  }

  if (
    title.includes('activity tracker plugin improvements') &&
    hasAny(text, ['figma', 'history_search'])
  ) {
    return RECALL_META_PENALTY
  }

  return 0
}

function recallMetaPenaltyForRow(row: SearchRow): number {
  return recallMetaPenalty(normalize(row.sessionTitle), normalize(row.text))
}

function hasAny(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern))
}

function minimumScore(terms: readonly string[]): number {
  if (terms.length <= 1) {
    return 1
  }

  return terms.length <= 3 ? 3 : 2.5
}

function requiredTermMatches(terms: readonly string[]): number {
  return Math.ceil(terms.length * 0.65)
}

function makeSnippet(text: string): string {
  const normalized = text.replaceAll(/\s+/gu, ' ').trim()

  if (normalized.length <= 280) {
    return normalized
  }

  return `${normalized.slice(0, 280)}...`
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(WHITESPACE_REGEX)
    .map((term) => term.replaceAll(/^[^\p{L}\p{N}_-]+|[^\p{L}\p{N}_-]+$/gu, '').trim())
    .filter((term) => term.length > 1)
    .slice(0, 10)
}

function normalize(text: string): string {
  return text.toLowerCase().replaceAll(WHITESPACE_REGEX, ' ').trim()
}

function matchedTermCount(text: string, terms: readonly string[]): number {
  return terms.filter((term) => termVariants(term).some((variant) => text.includes(variant))).length
}

function termVariants(term: string): readonly string[] {
  if (term.length <= 3 || !term.endsWith('s')) {
    return [term]
  }

  return [term, term.slice(0, -1)]
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0
  }

  return numerator / denominator
}
