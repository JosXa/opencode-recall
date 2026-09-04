import { statSync } from 'node:fs'

import { loadConfig } from '../src/config.js'
import { HistoryDatabase, type HistoryEventCursor } from '../src/db.js'
import { Database } from '../src/sqlite.js'

const SYNC_OVERLAP_MS = 30 * 60 * 1000
const DEFAULT_EVENT_LOOKBACK = 1_000

const config = loadConfig()
const historyPath = argumentValue('--history') ?? config.database.path
const sidecarPath = argumentValue('--sidecar') ?? config.database.indexPath
const eventLookback = numberArgument('--event-lookback') ?? DEFAULT_EVENT_LOOKBACK
const history = new HistoryDatabase(historyPath)

try {
  const legacySince = readMetadataNumber(sidecarPath, 'last_source_updated')
  const legacyRows = measure(() =>
    history.readTextPartsForIndex(
      legacySince === undefined ? undefined : Math.max(0, legacySince - SYNC_OVERLAP_MS),
    ),
  )
  const legacyPartIds = measure(() => history.readTextPartIds())
  const latest = history.readLatestEventCursor()
  const comparisonCursor =
    latest === undefined ? undefined : readComparisonCursor(historyPath, latest, eventLookback)
  const incremental = measure(() => history.readIndexChanges(comparisonCursor))

  console.log(
    JSON.stringify(
      {
        historyPath,
        historyBytes: statSync(historyPath).size,
        sidecarPath,
        eventLookback,
        legacy: {
          since: legacySince,
          changedRows: legacyRows.value.length,
          changedRowsMs: round(legacyRows.elapsedMs),
          sourcePartIds: legacyPartIds.value.length,
          sourcePartIdsMs: round(legacyPartIds.elapsedMs),
          totalMs: round(legacyRows.elapsedMs + legacyPartIds.elapsedMs),
        },
        incremental: {
          from: comparisonCursor,
          through: incremental.value.cursor,
          mode: incremental.value.mode,
          changedSessions: incremental.value.sessionIds.length,
          reconciledRows: incremental.value.rows.length,
          totalMs: round(incremental.elapsedMs),
        },
      },
      null,
      2,
    ),
  )
} finally {
  history.close()
}

function readComparisonCursor(
  historyPath: string,
  latest: HistoryEventCursor,
  eventLookback: number,
): HistoryEventCursor {
  if (latest.rowId === 0 || eventLookback === 0) {
    return latest
  }

  const db = new Database(historyPath, { readonly: true })
  try {
    const target = Math.max(0, latest.rowId - eventLookback)
    const row = db
      .query<{ readonly rowId: number; readonly eventId: string }, [number]>(`
        select rowid as rowId, id as eventId
        from event
        where rowid <= ?
        order by rowid desc
        limit 1
      `)
      .get(target)
    return row ?? { rowId: 0, eventId: '' }
  } finally {
    db.close()
  }
}

function readMetadataNumber(path: string, key: string): number | undefined {
  const db = new Database(path, { readonly: true })
  try {
    const row = db
      .query<{ readonly value: string }, [string]>('select value from metadata where key = ?')
      .get(key)
    if (row === null) {
      return undefined
    }
    const value = Number(row.value)
    return Number.isFinite(value) ? value : undefined
  } finally {
    db.close()
  }
}

function measure<T>(operation: () => T): { readonly elapsedMs: number; readonly value: T } {
  const start = performance.now()
  const value = operation()
  return { elapsedMs: performance.now() - start, value }
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function numberArgument(name: string): number | undefined {
  const value = argumentValue(name)
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return parsed
}

function round(value: number): number {
  return Number(value.toFixed(2))
}
