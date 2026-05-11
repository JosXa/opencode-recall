import { encodeCursor } from './cursor'
import type { SearchRow } from './db'

export interface HistorySearchResult {
  readonly cursor: string
  readonly dir: string
  readonly title: string
  readonly time: string
  readonly role: string
  readonly text: string
}

export function formatSearchResults(rows: readonly SearchRow[]): string {
  if (rows.length === 0) {
    return 'No matching OpenCode history entries found.'
  }

  return JSON.stringify(rows.map(formatSearchResult), null, 2)
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
    dir: row.directory,
    title: row.sessionTitle,
    role: row.role,
    time: new Date(row.timeCreated).toISOString(),
    text: makeSnippet(row.text),
  }
}

function makeSnippet(text: string): string {
  const normalized = text.replaceAll(/\s+/gu, ' ').trim()

  if (normalized.length <= 280) {
    return normalized
  }

  return `${normalized.slice(0, 280)}...`
}
