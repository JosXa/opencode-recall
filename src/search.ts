import { encodeCursor } from './cursor'
import type { SearchRow } from './db'
import type { SyncResult } from './sidecar'

const SYNC_NOTICE_THRESHOLD_MS = 5_000

export interface HistorySearchResult {
  readonly cursor: string
  readonly sid: string
  readonly dir: string
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
    dir: row.directory,
    title: row.sessionTitle,
    role: row.role,
    ...(row.score === undefined ? {} : { score: Number(row.score.toFixed(4)) }),
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
