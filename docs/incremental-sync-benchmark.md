# Incremental sync benchmark

This benchmark compares the former timestamp-overlap synchronization plan with the persisted event-log plan. Both paths read the same configured OpenCode database in the same Node.js process. The benchmark is read-only and does not modify either database.

Reproduce it with:

```sh
pnpm run benchmark:sync -- --event-lookback 1000
```

Use `--history <path>` and `--sidecar <path>` to select non-default databases. `--event-lookback` chooses a cursor that many event rows behind the latest persisted event, so repeated runs remain comparable even when no new events arrive.

## Measured result

The September 4, 2026 post-rebase run used Node.js 25.9.0 on macOS against a 10,539,073,536-byte local `opencode.db`. The sidecar contained 123,222 source part IDs. The incremental sample covered the latest 1,000 persisted event rows.

| Plan | Work selected | Time |
| --- | --- | ---: |
| Legacy overlap query | 930 changed rows | 387.23 ms |
| Legacy global stale-ID scan | 123,222 IDs | 25,092.78 ms |
| **Legacy total** | Two full source-table scans | **25,480.01 ms** |
| **Event-log change discovery** | 4 affected sessions, 135 current rows | **15.08 ms** |

The observed source-change discovery wall time was 1,690 times lower. This is a comparison of the old and new source-read plans, not equal-row microbenchmarks: the old plan deliberately reads a 30-minute overlap and every source part ID, while the new plan deliberately reads a bounded event window and only affected sessions. The legacy queries run first, so filesystem caching may favor the incremental measurement. Idle event-feed planning measured from the latest cursor took 0.15 ms and read no transcript rows. Production reconciliation additionally compares about 9,000 source and indexed session IDs to detect sessions whose aggregate events were removed during deletion; the end-to-end timings below include that work.

## End-to-end behavior

The existing production sidecar required one full reconciliation to establish event cursors. That migration indexed 123,012 rows and completed in 83.29 seconds. Two subsequent idle built-runtime synchronizations completed in 80.63 ms and 75.49 ms. A built-runtime search for `trusted publishing`, while the live development session was still generating events, completed in 2.72 seconds total with 1.05 seconds spent synchronizing.

The remaining search time is primarily semantic scoring over the embedding sidecar and is outside this synchronization benchmark.

## What the comparison measures

The legacy side measures `readTextPartsForIndex(lastSynced - 30 minutes)` plus `readTextPartIds()`, matching the former production source-read and stale-pruning inputs. On this database, both queries scan large source tables.

The incremental side snapshots the latest event cursor, reads distinct affected session IDs from the bounded `event.rowid` interval, and loads the current text and title rows only for those sessions. Sidecar reconciliation removes rows absent from each affected session. A lightweight global session-ID comparison detects deleted sessions because OpenCode removes their aggregate events; this replaces the former scan of more than 123,000 part IDs.

The event table covers normal OpenCode history mutations atomically with their projected rows. OpenCode CLI imports bypass the event system; imports performed after a sidecar cursor is established require a forced full rebuild by deleting the sidecar.
