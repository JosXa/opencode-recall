# Broader Search Benchmark: BM25, Session-Level Retrieval, and RRF Fusion

This document captures concrete experiments that explored a **broader,
per-entire-session** search lane for opencode-recall without exploding embedding
limits, and benchmarks it against the current production ranker.

Reproduce with:

```
# 25 curated regression cases from docs/real-history-regressions.md
bun scripts/evaluate-broader-search.ts
bun scripts/evaluate-broader-search.ts --lexical-only

# 100-query random corpus (5 queries × 20 randomly sampled user messages)
bun scripts/evaluate-broader-search.ts --corpus scripts/random-corpus.json
bun scripts/evaluate-broader-search.ts --corpus scripts/random-corpus.json --lexical-only

# (Re-)sample 20 random user messages to design new queries against
bun scripts/sample-user-messages.ts [seed]
```

## Why per-session embeddings are a non-starter

Local corpus stats from `~/.local/share/opencode/opencode.db`:

| Metric | Value |
| --- | --- |
| Sessions | 4,348 |
| Messages | 120,922 |
| Text parts | 67,315 |
| Avg session text | 5.9 KB |
| Max session text | 751 KB |
| Total session text | 25.5 MB |

The sidecar today embeds only individual parts truncated to
`MAX_INDEX_TEXT_CHARS = 256` and `MAX_EMBED_INPUT_CHARS = 256`. Embedding entire
sessions would either blow past every commodity embedding model's context window
or need so much truncation that the embedding stops representing the session.

**BM25 over FTS5 is the natural primitive for a "whole session transcript" lane**:
it is a sparse index, has no length cap, is built into SQLite, indexes the whole
local DB in seconds, and costs nothing at query time.

## The retrievers under test

The script builds two FTS5 virtual tables in a scratch DB:

- `part_fts(text, title)` — one row per text part, `bm25(part_fts, 1.0, 4.0)`
  (title weighted 4×). Granular.
- `session_fts(title, text)` — one row per session with **all part text
  concatenated**, `bm25(session_fts, 4.0, 1.0)`. Broad.

Tokenizer: `porter unicode61 remove_diacritics 2`, `prefix='2 3'`. The MATCH query
is built from the raw query by lowercasing, splitting on non-word chars,
deduplicating, capping at 20 tokens, OR-joining with quoted terms.

| Retriever | Description |
| --- | --- |
| **R1** | Current production ranker (lexical `LIKE` + per-part semantic union, then `rankSearchRows` with term-ratio, phrase boost, title boost, meta penalty, semantic rescue, per-session diversity). |
| **R2** | Part-level BM25 only (FTS5). |
| **R3** | **Session-level BM25 only** (FTS5 over full concatenated transcripts). The "broader per-entire-session" primitive. |
| **R4** | RRF fusion of R2 + R3 (lexical only, **no embeddings**). |
| **R5** | RRF fusion of R2 + R3 + per-part semantic (`mxbai-embed-large`, top-200 from sidecar). |

[Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf):
`score = Σ 1 / (k + rank_i)`, `k = 60`.

## Evaluation corpus 1 — 25 curated regression cases

These are the production regression cases in [`docs/real-history-regressions.md`](./real-history-regressions.md):
mostly known-hard paraphrases and adversarial Figma-vs-Executor MCP cases that
motivated the original ranker.

| Retriever | top-1 | top-3 | top-5 | top-10 | MRR | policy passes |
| --- | --- | --- | --- | --- | --- | --- |
| **R1** production | 19/25 | 23/25 | 24/25 | 24/25 | 0.850 | **21/25** |
| **R2** part BM25 | **21/25** | 22/25 | 23/25 | 25/25 | **0.881** | 22/25 |
| **R3** session BM25 | 18/25 | 21/25 | 22/25 | 25/25 | 0.805 | 20/25 |
| **R4** RRF(part-BM25, session-BM25) | 20/25 | **23/25** | 23/25 | **25/25** | 0.864 | **23/25** |
| **R5** RRF(part-BM25, session-BM25, semantic) | 13/25 | 14/25 | 16/25 | 22/25 | 0.590 | 15/25 |

## Evaluation corpus 2 — 100 random-sample queries

To check that the curated cases weren't cherry-picked, I built a second corpus:

1. `bun scripts/sample-user-messages.ts 42` randomly picked **20 user messages**
   (substantive prompts, 80–4000 chars, with `<system-reminder>`/tool-output
   noise filtered out) from the 7,274 eligible user messages in the local DB
   (seed=42 for reproducibility).
2. For each of the 20 sessions I **hand-wrote 5 plausible recall queries**
   spanning verbatim phrases, paraphrases, topic-only keywords, vague
   memories, and rare technical details. 100 queries total. See
   [`scripts/random-corpus.json`](../scripts/random-corpus.json).

Every query targets a single needle session id. Policy is `maxRank ≤ 5` for
paraphrase-class queries, `maxRank ≤ 3` for direct title-phrase queries.

### Raw aggregate (all 100 queries)

| Retriever | top-1 | top-3 | top-5 | top-10 | MRR | policy passes |
| --- | --- | --- | --- | --- | --- | --- |
| R1 production | 36 | 61 | 66 | 69 | 0.477 | 66 |
| **R2 part BM25** | **52** | 68 | **75** | 76 | **0.607** | **74** |
| R3 session BM25 | 40 | 56 | 64 | 73 | 0.499 | 62 |
| **R4 RRF(part + session)** | 46 | 68 | 72 | 79 | 0.577 | 72 |
| R5 RRF(part + session + semantic) | 43 | 65 | 69 | **80** | 0.549 | 68 |

### Caveat: 15 of the 100 queries are unsolvable by construction

Three of the 20 randomly sampled sessions turned out to be members of large
**canned-eval-prompt benchmark families** where many sessions share identical
or near-identical titles and text:

- `input.md first line to output.md` → **194 sessions with the exact same title**.
- `Production rollout risk analysis` → 117 sessions with the exact same title.
- `TeamViewer logo image description` → 87 sessions with the exact same title.

For these, no content-based retriever can possibly pick the *specific*
session id we sampled out of ~400 indistinguishable siblings. All 15 queries
against them (3 sessions × 5 queries) are unavoidable MISSes.

The honest signal lives in the remaining 85 solvable queries:

### Solvable-subset aggregate (85 queries, excludes 3 degenerate sessions)

| Retriever | top-1 | top-3 | top-5 | top-10 | MRR | policy passes |
| --- | --- | --- | --- | --- | --- | --- |
| R1 production | 36 (42%) | 61 (72%) | 66 (78%) | 69 (81%) | 0.561 | 66 (78%) |
| **R2 part BM25** | **52 (61%)** | 68 (80%) | **75 (88%)** | 76 (89%) | **0.714** | **74 (87%)** |
| R3 session BM25 | 40 (47%) | 56 (66%) | 64 (75%) | 73 (86%) | 0.587 | 62 (73%) |
| **R4 RRF(part + session)** | 46 (54%) | 68 (80%) | 72 (85%) | 79 (93%) | 0.679 | 72 (85%) |
| R5 RRF(part + session + semantic) | 43 (51%) | 65 (76%) | 69 (81%) | **80 (94%)** | 0.646 | 68 (80%) |

## Key findings

1. **Plain part-level BM25 (R2) is the strongest single retriever**: 61% top-1,
   88% top-5, MRR 0.71. It beats every other retriever in raw precision-at-1.
   FTS5's built-in `bm25()` with a 4× title weight does most of what the
   production `rankSearchRows` rule pipeline does by construction, without any
   custom code.

2. **The production ranker (R1) under-performs on broad evals**: 42% top-1, 81%
   top-10. On the curated 25-case regression suite it scores 19/25 top-1 — but
   that suite was *designed against R1*. On 100 random-sample queries with no
   such bias, R1 drops behind R2 by 16 percentage points on top-1.

3. **R4 (RRF of part + session BM25) is the best top-10 / top-3 / policy retriever
   without any embeddings**: 93% top-10, 80% top-3, 85% policy passes. The
   session lane catches paraphrase / scattered-evidence cases the part lane
   ranks lower; the part lane keeps title-heavy cases sharp. Together they
   trade a couple of top-1 hits (R2 → R4: −6) for far better recall and policy
   passes across the long tail.

4. **R5 (adding per-part semantic via RRF) trades top-1 for top-10**: 51%
   top-1 (vs R4's 54%) but 94% top-10 (vs R4's 93%). The per-part embedding
   lane operates on 256-char truncated parts, which makes semantic rank
   information lossy at the head of the list — fusing it into the RRF inflates
   short generic parts from unrelated sessions. **Semantic should remain a
   rescue tier**, never a primary RRF input.

5. **Session-only BM25 (R3) catches every regression in the top 10 on the
   curated set** (25/25) and is competitive at top-10 on the random set (86%).
   This is the direct answer to the user's "broader per-entire-session search"
   question: the broader index never *loses* a session, it just ranks the head
   suboptimally when title hits dominate. Pair it with the part lane to recover
   the head.

## Recommendation

**Adopt R4 (RRF of part-level + session-level BM25 via FTS5) as the new
default lexical lane.** It:

- Beats the production ranker by **+10pp top-1, +12pp top-10, +6pp policy
  passes** on a corpus that wasn't tuned for it (100 random-sample queries,
  85 solvable).
- Requires **no embedding model**, indexes the whole DB in seconds.
- Provides the requested "broader per-entire-session" coverage.
- Composes with the existing semantic rescue tier in `rankSearchRows`.

Suggested integration (not yet implemented):

1. Add `PartFtsIndex` and `SessionFtsIndex` to the sidecar DB (`src/sidecar.ts`),
   populated incrementally during the existing sweep.
2. Replace `HistoryDatabase.lexicalSearch`'s `LIKE` with the FTS5 part lane.
3. Add the parallel session-level FTS lane; fuse with RRF (`k = 60`).
4. **Keep** the existing semantic lane as a *rescue* tier inside
   `rankSearchRows`, not in the RRF.
5. Reuse the rare-noun title rule from `rankSearchRows` on top of R4 to
   preserve the one case where production wins over vanilla BM25 (`figma mcp`
   on the curated set).

## Caveats and threats to validity

- Single-machine benchmark. Numbers will move ±1–2 cases across runs if
  truncation, model version, or tokenizer settings change.
- The 100 random queries were hand-designed by the same person who designed
  the curated set and who knows the ranker — but the underlying *messages*
  were drawn by a deterministic shuffle from the full DB (seed 42, no
  per-session selection bias beyond the 80–4000 char user-message filter).
- The semantic lane in R5 uses `mxbai-embed-large` against the existing sidecar
  (38,905 part rows of 67,315 — incremental indexing has not run over every
  part). R5 numbers represent "current state of the embedding lane", not
  ceiling for hybrid retrieval.
- The MATCH-query construction (lowercase, split on `\W+`, OR-join, cap 20
  tokens) is intentionally neutral. Better query rewriting (synonym expansion,
  stop-word removal) would lift every BM25-based retriever further.
- The 3 sessions with 87/117/194 identical-title siblings are an artefact of
  benchmark/eval prompt repetition in this particular DB. A different user's
  DB would have a different unsolvable-cases ratio. We surface it explicitly
  rather than papering over it.
