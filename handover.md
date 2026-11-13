# Handover: decision models (TypeSafe Jev) in opencode-recall

This branch (`jev-research`, cut from `autocomplete`) carries the research effort. Drop this file before merging anything back.

## Goal

Hill-climb the best way to integrate decision models into recall, so that recall becomes faster, checks more sources and transcripts, and hands a smaller context to the recall LLM.

- Several subagents each build one integration level in their own worktree and branch, then test and analyze it on their own.
- Benchmark on real usage: every past recall subagent run, plus what Joscha asked in the parent session that triggered it.
- Jev is cheap ($0.042 per Mtok input, output free), so use it for wide parallel fan-out. Each future recall run has a total budget of $0.10, most of which is LLM cost. The recall agent may get control over its own budget.
- Run the whole analysis on EliteDesk (`runner-elite`).

## Decisions

- **Plugin-tool route.** The recall agent reaches Jev only through recall's own plugin tools. Inside those tools the plugin calls `context.experimental.generate.decisions(...)` (`@opencode/client` 2.2.5). Agents have no decision tool, the `models` tool rejects `type: "decision"`, and a raw `fetch` to the server returns 401.
- **Temporary evals.** The benchmark data set and harness stay out of the project. Keep them under `.eval-data/` (excluded via `.git/info/exclude`) or `/tmp/opencode`, and never commit them.
- **One worktree and branch for each experiment**, branched from `jev-research`.
- **Recall LLM for phase 1:** `openai/gpt-6-luna-fast#medium` (the model used by most past runs).

## Jev facts

- Registered in `~/.config/opencode2/opencode.base.jsonc` as provider `typesafe-ai` (package `@opencode/ai/providers/typesafe-ai/decisions`, `env: ["TYPESAFE_API_KEY"]`). It has models `jev-latest` and `jev-preview` (both jev-1.14.0) with `type: "decision"`, `capabilities: { tools: false, input: ["text","image"], output: ["decision"], temperature: false }` and `limit: { context: 64000, output: 0 }`. Without the capabilities and limit, the models get chat defaults. Setup notes: `~/.config/opencode2/docs/typesafe-jev-decision-model.md`.
- `opencode/jev-1.13-free` is a built-in key-free alternative.
- Request: `POST /api/experimental/generate/decisions` with `{ model: {id, providerID}, input: [{type:"text", text}], questions: [{type:"predicate", name, instructions}] }`. Choice, score and box question types also exist. With the CLI, use `opencode api post <path> --data "$(cat body.json)"` (the value is a literal string).
- Measured: 0.25 to 0.3 s per call for 850 to 6,700 input tokens. Extra questions in one call cost no time. 30 parallel calls finished in 0.85 s. One request holds about 64k tokens, or 262k with the `TypeSafe-Danger-Zone-Long-Context: true` header (slower, less accurate).
- Jev only answers typed questions (probability, choice, score). It cannot quote, summarize or write queries.

## Integration levels to build (phase 1, one worktree each)

| Variant | Jev's job |
|---|---|
| A rerank | `history_search` takes a `criterion`, pulls 50 to 100 candidates and returns the best few with probabilities |
| B locate | `history_read` takes a `criterion`, chunks whole sessions (about 4k tokens), and returns the best 2 to 3 chunks |
| C pipeline | one `history_find({ queries, criteria })` call: fan-out, dedupe, judge sessions, locate chunks, compact evidence. The agent runs two turns |
| D scan | no retrieval: judge digests (title, first prompt, last answer) of every session in a timeframe or directory |
| E no recall LLM | the parent calls the C tool directly (low priority) |
| F budget | the agent sees and controls a per-run budget (`$0.10` cap) |

Risks to measure: sessions lost to a fixed threshold (rank and cut by budget instead), and Jev input volume and rate limits.

Settings shape to prototype: `judge: { model: "typesafe-ai/jev-latest", maxCandidates, concurrency }`. If `model` is unset, recall behaves as before.

Phase 2 combines the winners and tunes them.

## Current state

- Nothing has been built yet. The next step is the benchmark data set.
- History snapshots from HOMEZONE, taken 2026-11-13, are in `.eval-data/` in this checkout: `opencode-v2.db`, `opencode.db` (V1) and the recall indexes `opencode-recall-v1-index.db` and `opencode-recall-v2-index.db`. Treat 2026-11-13 as the time cutoff. Open them read-only and never point a live OpenCode at them. To use them, write a test `recall.jsonc` whose `database.sources` points `path` and `indexPath` at these copies.
- Past recall runs: 111 sessions with `agent = 'recall'`. 91 are in V2 (`session_v2`, 2026-09-06 to 2026-11-12, mostly `openai/gpt-6-luna-fast#medium`) and 20 are in V1 (`session`, 2026-08-02 to 2026-08-15). `session_v2.cost` is always 0 (subscription), so estimate cost from tokens. The trigger prompt is in the parent session (`parent_id`). V2 user text is in `session_message.data.text` and assistant text in `data.content`. Use single quotes in SQL string literals.
- `TYPESAFE_API_KEY` comes from `~/.config/secrets/typesafe-api-key` through the dotfiles template `~/.config/environment.d/50-opencode.conf`. A fresh OpenCode process needs it in its environment.
- EliteDesk's own live recall plugin is `~/projects/opencode-v2/opencode-recall/dist`. Leave it alone, and test the experiment worktrees in fresh OpenCode processes only.

## Remaining work

1. **Data set (subagent):** mine all 111 recall runs. For each, record the trigger prompt from the parent session, the recall agent's queries, the sessions and cursors it read, its answer, duration and tokens, and whether the parent used the answer. Get gold labels from a strong LLM (expected session IDs and key facts), plus about 10 cases spot-checked by Joscha. Select 30 to 40 benchmark cases. Write everything to `.eval-data/`.
2. **Harness:** run one case against a given plugin build in a fresh OpenCode process (see the opencode-testing skill: test DB from `bun ~/.config/opencode2/scripts/credentials-test-db.ts <dir>/test.db` in a 0700 temp dir, config pointing at the worktree's `dist`). Measure wall time, LLM tokens and cost, Jev tokens, answer accuracy and recall of gold sessions. Run a baseline on `jev-research` first.
3. **Phase 1:** one subagent for each of variants A to D and F, each in `<repo>.worktrees`-style sibling worktrees branched from `jev-research`, building, testing and writing a short analysis.
4. **Phase 2:** combine and tune, then report to Joscha with numbers.

## Commands

```sh
cd /home/joscha/projects/opencode-recall
pnpm install
pnpm run ai:check
pnpm run build
git worktree add ../opencode-recall.jev-a-rerank -b jev-a-rerank jev-research
```

Repository rules are in `AGENTS.md`: pnpm with plain Node (no Bun for the project), no `any`, run `pnpm run ai:check` before commits.

GitHub write access from EliteDesk may be read-only. If a push fails, push through HOMEZONE.
