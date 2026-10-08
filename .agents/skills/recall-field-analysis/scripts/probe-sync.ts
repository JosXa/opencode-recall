// Time the read phases of one index sync for a history source without writing to the index.
// Usage: pnpm exec tsx .agents/skills/recall-field-analysis/scripts/probe-sync.ts --history <db> --index <index-db>
import { HistoryDatabase } from '../../../../src/db.js'
import { Database } from '../../../../src/sqlite.js'

const OVERLAP_MS = 30 * 60 * 1000

const history = argument('--history')
const index = argument('--index')
const meta = new Database(index, { readonly: true })
const metadata = Object.fromEntries(
  meta
    .query<{ key: string; value: string }, []>('select key, value from metadata')
    .all()
    .map((row) => [row.key, row.value]),
)
meta.close()

const db = new HistoryDatabase(history)
const cursor = db.readLatestEventCursor()
const stored = {
  rowId: Number(metadata['event_cursor_semantic_rowid'] ?? 0),
  eventId: metadata['event_cursor_semantic_event_id'] ?? '',
}
const report: Record<string, unknown> = { history, metadata, latestEvent: cursor }

if (cursor !== undefined && cursor.rowId > 0) {
  const started = performance.now()
  const changes = db.readIndexChanges(stored)
  report['event'] = {
    mode: changes.mode,
    changedSessions: changes.sessionIds.length,
    rows: changes.rows.length,
    ms: Math.round(performance.now() - started),
  }
}

const last = Number(metadata['last_source_updated'])
if (Number.isFinite(last)) {
  const started = performance.now()
  const rows = db.readTextPartsForIndex(Math.max(0, last - OVERLAP_MS))
  const middle = performance.now()
  const ids = db.readTextPartIds()
  report['legacy'] = {
    changedSessions: new Set(rows.map((row) => row.sessionId)).size,
    changedRows: rows.length,
    changedRowsMs: Math.round(middle - started),
    partIds: ids.length,
    partIdsMs: Math.round(performance.now() - middle),
  }
}

db.close()
console.log(JSON.stringify(report, null, 2))

function argument(name: string): string {
  const value = process.argv[process.argv.indexOf(name) + 1]
  if (!process.argv.includes(name) || value === undefined) {
    throw new Error(`Missing ${name}`)
  }
  return value
}
