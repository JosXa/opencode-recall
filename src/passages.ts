import { encodeCursor } from './cursor.js'

export interface SessionPart {
  readonly partId: string
  readonly messageId: string
  readonly role: string
  readonly timeCreated: number
  readonly text: string
}

export interface SessionPassage {
  readonly cursor: string
  readonly role: string
  readonly time: string
  readonly text: string
  readonly hit: boolean
}

export interface SessionDigest {
  readonly cursor: string
  readonly started: string
  readonly updated: string
  readonly messages: number
  readonly firstPrompt: string
  readonly passages: readonly SessionPassage[]
}

export interface PassageSelection {
  readonly queries: readonly string[]
  readonly hitPartIds: readonly string[]
  readonly limit: number
  readonly chars: number
}

const FIRST_PROMPT_CHARS = 400
const HIT_BONUS = 1
const QUERY_COVERAGE_BONUS = 0.15
const TERM_SPLIT = /[^\p{L}\p{N}_.-]+/u
const EDGE_PUNCTUATION = /^[.-]+|[.-]+$/gu
const WHITESPACE = /\s+/gu
const MIN_TERM_LENGTH = 3
const MAX_POSITIONS_PER_TERM = 24
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'was',
  'were',
  'what',
  'when',
  'which',
  'how',
  'did',
  'does',
  'about',
  'into',
  'der',
  'die',
  'das',
  'und',
  'mit',
])

export function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(TERM_SPLIT)
        .map((term) => term.replace(EDGE_PUNCTUATION, ''))
        .filter((term) => term.length >= MIN_TERM_LENGTH && !STOPWORDS.has(term)),
    ),
  ]
}

export function selectPassages(
  parts: readonly SessionPart[],
  selection: PassageSelection,
): { readonly part: SessionPart; readonly text: string; readonly hit: boolean }[] {
  const termSets = selection.queries.map(queryTerms).filter((terms) => terms.length > 0)
  const allTerms = [...new Set(termSets.flat())]
  const hits = new Set(selection.hitPartIds)
  return parts
    .filter((part) => part.role !== 'system')
    .map((part) => {
      const lower = part.text.toLowerCase()
      const coverage = termSets.map(
        (terms) => terms.filter((term) => lower.includes(term)).length / terms.length,
      )
      const score =
        Math.max(0, ...coverage) +
        QUERY_COVERAGE_BONUS * coverage.filter((value) => value > 0).length +
        (hits.has(part.partId) ? HIT_BONUS : 0)
      return { part, score, hit: hits.has(part.partId) }
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.part.timeCreated - b.part.timeCreated)
    .slice(0, selection.limit)
    .sort((a, b) => a.part.timeCreated - b.part.timeCreated)
    .map(({ part, hit }) => ({ part, hit, text: excerpt(part.text, allTerms, selection.chars) }))
}

export function digestSession(
  cursor: string,
  sourceId: string | undefined,
  parts: readonly SessionPart[],
  selection: PassageSelection,
): SessionDigest {
  const times = parts.map((part) => part.timeCreated)
  return {
    cursor,
    started: isoTime(Math.min(...times)),
    updated: isoTime(Math.max(...times)),
    messages: new Set(parts.map((part) => part.messageId)).size,
    firstPrompt: firstPrompt(parts),
    passages: selectPassages(parts, selection).map(({ part, text, hit }) => ({
      cursor: encodeCursor({
        version: 1,
        ...(sourceId === undefined ? {} : { sourceId }),
        messageId: part.messageId,
      }),
      role: part.role,
      time: isoTime(part.timeCreated),
      text,
      hit,
    })),
  }
}

function isoTime(time: number): string {
  return Number.isFinite(time) ? new Date(time).toISOString() : ''
}

export function firstPrompt(parts: readonly SessionPart[]): string {
  const first = parts.find((part) => part.role === 'user')
  return first === undefined ? '' : excerpt(first.text, [], FIRST_PROMPT_CHARS)
}

export function excerpt(text: string, terms: readonly string[], chars: number): string {
  const flat = text.replace(WHITESPACE, ' ').trim()
  if (flat.length <= chars) return flat
  const lower = flat.toLowerCase()
  const occurrences = terms
    .flatMap((term) => termPositions(lower, term).map((position) => ({ term, position })))
    .sort((a, b) => a.position - b.position)
  const lead = Math.floor(chars / 4)
  const best = occurrences.reduce(
    (current, { position }) => {
      const windowStart = position - lead
      const covered = new Set(
        occurrences
          .filter((item) => item.position >= windowStart && item.position < windowStart + chars)
          .map((item) => item.term),
      ).size
      return covered > current.covered ? { covered, anchor: position } : current
    },
    { covered: 0, anchor: lead },
  )
  const start = Math.max(0, Math.min(best.anchor - lead, flat.length - chars))
  const end = Math.min(flat.length, start + chars)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

function termPositions(text: string, term: string): number[] {
  const positions: number[] = []
  let index = text.indexOf(term)
  while (index >= 0 && positions.length < MAX_POSITIONS_PER_TERM) {
    positions.push(index)
    index = text.indexOf(term, index + term.length)
  }
  return positions
}
