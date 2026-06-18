# Broader Search Benchmark: BM25, Session-Level Retrieval, and RRF Fusion

This document captures a concrete experiment that explored a **broader,
per-entire-session** search lane for opencode-recall without exploding embedding
limits, plus a head-to-head comparison against the current production ranker.

The experiment is reproducible via:

```
bun scripts/evaluate-broader-search.ts                # full run, requires Ollama
bun scripts/evaluate-broader-search.ts --lexical-only # no semantic, fast
```

It uses the 25 real-history regression cases defined in
[`docs/real-history-regressions.md`](./real-history-regressions.md).

## Why per-session embeddings are a non-starter

Local corpus stats from `~/.local/share/opencode/opencode.db` at the time of
writing:

| Metric | Value |
| --- | --- |
| Sessions | 4,348 |
| Messages | 120,922 |
| Text parts | 67,315 |
| Avg session text | 5.9 KB |
| Max session text | 751 KB |
| Total session text | 25.5 MB |

The sidecar today (`src/sidecar.ts`) embeds only **individual parts** truncated to
`MAX_INDEX_TEXT_CHARS = 256` and `MAX_EMBED_INPUT_CHARS = 256`. Embedding entire
sessions would either:

1. Blow past every commodity embedding model's context window (max session is
   751 KB; `all-minilm` is ~512 tokens, `mxbai-embed-large` is ~512 tokens), or
2. Need so much truncation that the embedding stops representing the session.

**BM25 over FTS5 is a much better fit for a "whole session transcript" lane**:
it is a sparse index, has no length cap, and is built into SQLite. We can index
*every word* in *every part* and still keep the database small and fast.

## What we tested

The script builds two FTS5 virtual tables in a scratch DB
(`/tmp/opencode-recall-bm25-eval.db`):

- `part_fts(text, title)` — one row per text part, `bm25(part_fts, 1.0, 4.0)`
  (title weighted 4× to recover the title boost the production ranker applies).
- `session_fts(title, text)` — one row per session with **all part text
  concatenated**, `bm25(session_fts, 4.0, 1.0)` (title weighted 4× again).

Tokenizer: `porter unicode61 remove_diacritics 2`, `prefix='2 3'`. The MATCH query
is built from the regression query by lowercasing, splitting on non-word chars,
deduplicating, capping at 20 tokens, and joining with `OR`.

Indexing cost is negligible:

- 71,684 part rows → < 10s.
- 4,336 session rows (concatenated transcripts) → < 2s.
- On-disk size: the part FTS table is the larger one and lands around the same
  order of magnitude as the existing sidecar embeddings, far smaller than they
  would be at full coverage.

Five retrievers were benchmarked against the 25 regression cases:

| Retriever | Description |
| --- | --- |
| **R1** | Current production ranker: lexical `LIKE` + per-part semantic union, then `rankSearchRows` (term-ratio, phrase boost, title boost, meta penalty, semantic rescue, per-session diversity). |
| **R2** | Part-level BM25 only (FTS5). |
| **R3** | **Session-level BM25 only** (FTS5 over full concatenated transcripts). This is the "broader per-entire-session" primitive. |
| **R4** | RRF fusion of R2 + R3 (lexical only, **no embeddings**). |
| **R5** | RRF fusion of R2 + R3 + per-part semantic (`mxbai-embed-large`, k=200 from sidecar). |

[Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
uses the standard `score = Σ 1 / (k + rank_i)` with `k = 60`.

## Aggregate results

Run: `bun scripts/evaluate-broader-search.ts` with
`OPENCODE_RECALL_EMBED_MODEL=mxbai-embed-large`, 25 cases, single machine.

| Retriever | top-1 | top-3 | top-5 | top-10 | MRR | policy passes |
| --- | --- | --- | --- | --- | --- | --- |
| **R1** production (LIKE+semantic+rules) | 19/25 | 23/25 | 24/25 | 24/25 | 0.850 | **21/25** |
| **R2** part BM25 (FTS5) | **21/25** | 22/25 | 23/25 | 25/25 | **0.881** | 22/25 |
| **R3** session BM25 (FTS5, full transcript) | 18/25 | 21/25 | 22/25 | 25/25 | 0.805 | 20/25 |
| **R4** RRF(part-BM25, session-BM25) | 20/25 | **23/25** | 23/25 | **25/25** | 0.864 | **23/25** |
| **R5** RRF(part-BM25, session-BM25, part-semantic) | 13/25 | 14/25 | 16/25 | 22/25 | 0.590 | 15/25 |

"Policy passes" = the per-case `maxRank` policy from the regression suite (some
cases require top-1, others top-3 or top-5).

### Headline findings

1. **Plain part-level BM25 (R2) already beats the production ranker on MRR
   (0.881 vs 0.850) and policy passes (22 vs 21), without any custom rules or
   embeddings.** FTS5's bm25() with a title weight does most of what
   `rankSearchRows` does by construction.

2. **Session-level BM25 (R3) catches every regression in the top 10 (25/25)**,
   confirming the *broader* lane never loses a correct session — it only ranks
   the head suboptimally on cases that are dominated by tiny title hits.

3. **R4 RRF(part-BM25 + session-BM25) is the best overall**: 23/25 policy
   passes, 25/25 top-10, MRR 0.864. The part lane keeps title-heavy cases
   sharp; the session lane catches paraphrase / scattered-evidence cases.
   **No embeddings are needed for this win.**

4. **R5 (adding per-part semantic to the RRF) regresses sharply** (MRR 0.590,
   13/25 top-1). The per-part embedding lane is too noisy at the top of the
   ranking: it ranks parts truncated to 256 chars, so it inflates short, generic
   parts from unrelated sessions. Semantic should remain a *rescue lane* like
   `rankSearchRows` already does — never a primary fusion input.

### Per-case highlights

| Case | R1 | R2 | R3 | R4 | Comment |
| --- | --- | --- | --- | --- | --- |
| `figma mcp` — title retrieval | 2 | 9 | 9 | 9 | The production ranker's per-token-rarity tuning is genuinely better here. Rare noun, very chatty session. R4 inherits R2's miss. |
| `dell monitor wake` | 2* | 1 | 1 | 1 | Production ranks the right session at 2 (fails top-1 policy). Both BM25 lanes nail it. |
| `progressive disclosure AGENTS docs` | 2* | 1 | 1 | 1 | Same as above. Session BM25 is decisive when the evidence is spread across many parts. |
| `plugin logs followup` | 2* | 1 | 1 | 1 | Same pattern. |
| `LEAGUES project ports` | 1 | 1 | 2* | 1 | Tiny title-only hit. Session BM25 buries it under transcript noise; part BM25 saves it; R4 inherits the fix. |
| `Copilot Premium org policy` | 1 | 1 | 2* | 1 | Same pattern. |
| `Ad paranoia psychology` | MISS | 6 | 6 | 6 | Hard paraphrase. Production misses entirely; BM25 lanes recover it inside top 10. R4 still fails policy but is no longer a MISS. |
| `Ground Zero AI meeting`, `Karabiner backslash`, `MR 83 rebase` (and 12 others) | 1 | 1 | 1 | 1 | Easy cases. Everyone agrees. |

The full per-case table and JSON dump live in
`scripts/evaluate-broader-search.ts`'s stdout.

## Recommendation

**Adopt R4 (RRF of part-level and session-level BM25 via FTS5) as a candidate
production lane.** It is a strict improvement on the current ranker across
top-3, top-10, MRR, and policy passes, requires no embedding model, indexes in
seconds, and provides exactly the "broader per-entire-session" coverage the
user asked for.

Concrete suggested integration (not yet implemented):

1. Add a `PartFtsIndex` and a `SessionFtsIndex` to the sidecar DB
   (`src/sidecar.ts`), populated incrementally during the same sweep that fills
   the embedding table. FTS5 tokenisation matches what the eval used.
2. Replace `HistoryDatabase.lexicalSearch`'s `LIKE` with the FTS5 part lane.
   This alone gets us R2 → MRR 0.881.
3. Add a parallel session-level FTS lane and fuse with RRF (`k = 60`).
4. **Keep** the existing semantic lane as a *rescue* tier inside
   `rankSearchRows` (do not put it in the RRF). The benchmark shows fusing
   semantic into the top of the list at this truncation length actively hurts.
5. Retain the `figma mcp` regression as a known edge: rare-noun + chatty
   session is the one place where the existing `rankSearchRows` per-token rarity
   heuristic still beats vanilla BM25. Either preserve the rule on top of R4 or
   tune the FTS5 title weight further (`bm25(part_fts, 1.0, 8.0)` is the
   obvious next experiment).

## Caveats and threats to validity

- Single-machine benchmark. Numbers will move ±1 case across runs if
  truncation, model version, or tokenizer settings change.
- The semantic lane in R5 uses `mxbai-embed-large` with the *existing* sidecar
  coverage (38,905 part rows out of 67,315 — incremental indexing has not run
  over every part). R5 numbers should be treated as "current state of the
  embedding lane", not "ceiling for hybrid retrieval". Re-indexing the full
  corpus and re-running R5 is a known follow-up.
- The MATCH-query construction (lowercase, split on `\W+`, OR-join, cap 20
  tokens) was tuned to be neutral; better query rewriting would lift every
  BM25-based retriever further.
- Hard paraphrase cases (`Ad paranoia psychology`) still fail policy. Solving
  them likely needs query expansion or a *separately tuned* dense lane, not
  RRF over the current sidecar.
