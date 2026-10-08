# Data model and metrics

## Where the data lives

| Data | Location |
|---|---|
| Recall run | `session_v2` row with `agent = 'recall'`; `parent_id` is the calling session |
| Prompt sent to recall | First `session_message` with `type = 'user'`, field `data.text` |
| Assistant turn | `session_message` with `type = 'assistant'`; `data.time.created` is when the turn started |
| One tool step | Item of `data.content` with `type = 'tool'`; the recall agent calls `execute`, and the inner plugin calls happen inside its JS |
| Inner calls of a step | `state.metadata.toolCalls[]` with `tool`, `status`, `input` |
| Step code | `state.input.code` |
| Step result | `state.content[].text`; `state.metadata.truncated` is set when the harness cut the output |
| Step timing | Tool part `time.created`, `time.ran`, `time.completed` (epoch ms) |
| Sync notice | `<sync indexed_rows="N" seconds="S" />` in the result text, only for syncs slower than `SYNC_NOTICE_THRESHOLD_MS` in `src/search.ts` |

## Metrics

| Metric | Formula | What it shows |
|---|---|---|
| Tool seconds | `completed - ran` | Plugin cost of one step, including index sync |
| Model seconds | `ran - message time.created` | Time the model spent writing the step |
| Width | `len(toolCalls)` | Fan-out of one step; width 1 means one call per model turn |
| Truncated | `metadata.truncated` or `bytes truncated` in the text | The step returned more than the output cap, and the agent lost data |
| Steps per session | count of tool parts | Number of model turns; each turn adds model seconds |
| Wall time | last minus first message `time_created` | What the user waited for |

## How to read the numbers

- Each model turn costs seconds, while extra calls within one step cost little. A high share of model time together with many width-1 steps means the agent should fan out more per turn.
- The scripts add up the sync notices of all searches in a step. Parallel searches can each sync one after another, so the total sync time of a step can be greater than its tool seconds.
- Compare the first step with later steps. The first step includes the sync cost and cold caches.
- A high truncation share means the steps return too much text. Prompt the agent to slice or filter the results inside `execute`.
- Chains of `history_read` with `next` or `prev` mean the agent pages through one transcript turn by turn. One wider read, or head and tail reads together, does the same in fewer turns.
- A directory filter on every first-step search can hide the answer when the conversation happened in another project.
