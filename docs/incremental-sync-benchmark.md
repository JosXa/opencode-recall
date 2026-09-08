# Incremental sync benchmark

This benchmark compares the former timestamp-overlap synchronization plan with the persisted event-log plan. Both paths read the same configured OpenCode database in the same Node.js process. The benchmark is read-only and does not modify either database.

Reproduce it with:

```sh
pnpm run benchmark:sync -- --event-lookback 1000
```

Use `--history <path>` and `--sidecar <path>` to select non-default databases. `--event-lookback` chooses a cursor that many event rows behind the latest persisted event, so repeated runs remain comparable even when no new events arrive.

## What the comparison measures

The legacy side measures `readTextPartsForIndex(lastSynced - 30 minutes)` plus `readTextPartIds()`, matching the former production source-read and stale-pruning inputs.

The incremental side snapshots the latest event cursor, reads distinct affected session IDs from the bounded `event.rowid` interval, and loads the current text and title rows only for those sessions. Sidecar reconciliation removes rows absent from each affected session. A lightweight global session-ID comparison detects deleted sessions because OpenCode removes their aggregate events; this replaces the former scan of every part ID.

The event table covers normal OpenCode history mutations atomically with their projected rows. OpenCode CLI imports bypass the event system; imports performed after a sidecar cursor is established require a forced full rebuild by deleting the sidecar.
