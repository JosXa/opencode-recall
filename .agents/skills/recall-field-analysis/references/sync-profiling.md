# Sync profiling

Each `history_search` syncs every configured source before it searches. `HistorySources.sync` in `src/history-sources.ts` runs the sources one after another, and each index has a lock. When another search holds the lock, a search does not wait: it skips the sync and returns results from the index as it is.

## Sync modes

`HistoryDatabase.readIndexChanges` in `src/db.ts` selects the mode:

| Mode | When | Cost |
|---|---|---|
| `incremental` | The stored cursor matches the latest event row, or, for a V2 source with an empty `event` table, the cursor holds a projection watermark | Reads only the changed sessions: those named in new events, or those whose `session_v2.time_updated` or `session_message.time_updated` is newer than the watermark minus one minute |
| `full` | The stored cursor is missing or does not match | Reads all text parts once |
| `legacy` | The source has no `event` and no `session_message` table, or the source is a V2 database with an attached V1 database | Each sync reads all parts of every session updated since `last_source_updated` minus `SYNC_OVERLAP_MS`, then runs `readTextPartIds` over the whole source to find deleted parts |

OpenCode V2 writes `event` rows only for buses created with `persist`, so a normal V2 database has an empty `event` table and uses the projection watermark. The index metadata shows the mode: `event_cursor_*_rowid` above 0 means event sync, `event_cursor_*_updated_at` means projection sync, and only `last_source_updated` means legacy sync.

Incremental sync re-reads each changed session completely, so a long, active parent session costs more than a short one. In legacy mode, the full part-ID scan costs the same whatever the change size and sets a floor of several seconds on large databases.

## Measure a whole sync

`scripts/bench-sync.mts` runs the semantic and lexical sync against a copy of an index and prints the time and row counts of each round. Copy the index first, because the benchmark writes to it:

```sh
sqlite3 <recall-index.db> ".backup /tmp/index-copy.db"
pnpm exec tsx .agents/skills/recall-field-analysis/scripts/bench-sync.mts <history.db> /tmp/index-copy.db 3
```

The first round includes the changes since the live index last synced. Later rounds show the steady cost of a sync with almost no changes. To compare two revisions, run the benchmark on two copies of the same backup, one per revision.

## Measure the phases

`scripts/probe-sync.ts` times the read phases for one source without writing to the index:

```sh
pnpm exec tsx .agents/skills/recall-field-analysis/scripts/probe-sync.ts \
  --history <history.db> --index <recall-index.db>
```

It reports the index metadata, the event mode and changed sessions (when the source has events), and for legacy mode the changed sessions and rows, the time to read them, and the time of the part-ID scan. Index paths come from the recall config (`sources[].indexPath`, or `database.indexPath`).

`pnpm run benchmark:sync` compares the legacy and event read paths for one source. Do not run it against a large V1 database: its legacy read can run out of memory.

## Find what remains

The probe covers the reads only. The other phases are the embedding checks and Ollama calls in `#syncBatch`, the lexical upserts, and the stale-chunk deletion in `src/sidecar.ts`. To measure them, add temporary `performance.now()` logs around those phases in a scratch branch, run one search through the SDK or a replay, and remove the logs afterwards.
