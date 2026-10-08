# Sync profiling

Each `history_search` syncs every configured source before it searches. `HistorySources.sync` in `src/history-sources.ts` runs the sources one after another, and each index has a lock. When another search holds the lock, a search does not wait: it skips the sync and returns results from the index as it is.

## Sync modes

`HistoryDatabase.readIndexChanges` in `src/db.ts` selects the mode:

| Mode | When | Cost |
|---|---|---|
| `incremental` | The source has an `event` table, and the stored cursor matches its latest row | Reads only the sessions named in new events |
| `full` | The source has events, but the stored cursor is missing or does not match | Reads all text parts once |
| `legacy` | The source has no `event` table, the table is empty, or the source is a separate V1 database | Each sync reads all parts of every session updated since `last_source_updated` minus `SYNC_OVERLAP_MS`, then runs `readTextPartIds` over the whole source to find deleted parts |

The index metadata shows the mode: `event_cursor_*` keys with a nonzero row ID mean that sync uses events, while `last_source_updated` means legacy sync.

In legacy mode, the overlap window re-reads every session that was active during the window. A long, active parent session is read again by each sync. The full part-ID scan costs the same whatever the change size, so it sets a floor on sync time. Both costs grow with database size, and the overlap read grows with the number of sessions updated since the last sync.

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
