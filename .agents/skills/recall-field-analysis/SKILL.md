---
name: recall-field-analysis
description: Use when analyzing how real recall-agent runs behaved, to improve the recall prompt, tool speed, or index sync.
---

# Recall field analysis

Real recall runs are stored in the OpenCode V2 database: each recall subagent call is a child session with `agent = 'recall'`. Mine those sessions to find out how the agent searched, where the time went, and what the plugin did. Then change the prompt or the code and replay the same prompts to compare.

## Hard rules

- Open the history database read-only. The scripts use `mode=ro`.
- Measure with the timestamps OpenCode records for each tool part. Regex estimates on transcripts can be wrong.
- The search result shows the `<sync indexed_rows=… seconds=…/>` notice only for slow syncs. A step without the notice may still have synced, or may have skipped the sync because another search held the index lock.
- Compare prompt changes against the same prompts taken from real sessions. A new synthetic prompt is not a fair baseline.

## Workflow

1. **Find runs.** `python3 scripts/sessions.py [--grep TEXT] [--since YYYY-MM-DD] [--slow SECONDS]` lists recall sessions with their prompt, step count, first-turn width, and wall time. The scripts take `--db` or `$OPENCODE_DB`; to find the right database, load the `opencode-db` skill.
2. **Aggregate.** `python3 scripts/metrics.py` prints step counts, tool and model seconds, fan-out width, truncation, and `history_read` modes for all runs. To read the numbers, first read [Data model and metrics](./references/data-model.md).
3. **Inspect one run.** `python3 scripts/session.py SID [--prompt] [--calls] [--code]` prints each step. Look for single-call turns, `next`/`prev` paging chains, truncated results, directory filters that hid the answer, and generic queries.
4. **Diagnose slow tools.** `python3 scripts/sync_gaps.py` relates search time and sync cost to the idle gap before each search. To find which sync phase is slow, first read [Sync profiling](./references/sync-profiling.md).
5. **Change and replay.** To rerun real prompts against a changed prompt or plugin and compare the results, first read [Replay](./references/replay.md).

Run the scripts from this skill directory, or pass their full path.
