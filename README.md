# @josxa/opencode-recall

[![npm](https://img.shields.io/npm/v/%40josxa%2Fopencode-recall.svg)](https://www.npmjs.com/package/@josxa/opencode-recall)
[![CI](https://github.com/JosXa/opencode-recall/actions/workflows/ci.yml/badge.svg)](https://github.com/JosXa/opencode-recall/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40josxa%2Fopencode-recall.svg)](./LICENSE)

> Hybrid semantic + lexical recall over your local [OpenCode](https://opencode.ai) session history, with cursor‑paginated ChatML transcript reads.

OpenCode keeps every session in a local SQLite database. This plugin makes that history *first‑class context* for the agent: find a relevant historical anchor with one ranked search, then page a bounded window of messages around it as a ChatML transcript — without loading an entire session into the model.

```text
┌───────────────────┐    history_search    ┌──────────────────────┐
│  OpenCode agent   │ ───────────────────► │  Ranked anchors      │
│ (your assistant)  │                      │  (opaque cursors)    │
└───────────────────┘ ◄─────────────┐      └──────────┬───────────┘
         │      history_read        │                 │
         ▼                          │ ChatML window   │
┌───────────────────┐   pagination  │                 │
│  ChatML window    │ ◄─────────────┘                 │
│  with <nav/>      │                                 │
└───────────────────┘                                 │
                                                      ▼
                                     ┌──────────────────────────────┐
                                     │  opencode.db   (read‑only)   │
                                     │  + sidecar embedding index   │
                                     └──────────────────────────────┘
```

---

## Why

The default way to "remember" prior work is to dump entire sessions into context. That's expensive, noisy, and most of it is irrelevant. Recall flips this around:

- **Search returns anchors, not content.** Each hit is a small JSON row with a cursor.
- **Reads are bounded windows.** You pick `around`, `next`, `prev`, `head`, `tail`, or `full` relative to a cursor, with a hard message limit.
- **The transcript renderer is source‑faithful.** Tool calls, patches, file attachments, and text are normalized into ChatML with clear truncation markers, so the model sees structure instead of a wall of JSON.
- **Ranking is hybrid.** Lexical SQL search runs against the OpenCode DB; semantic search runs against a sidecar embedding index built from the same rows. Results are deduped, term‑filtered, session‑diversified, and a bounded semantic‑rescue lane catches high‑confidence paraphrases.

## Install

```sh
opencode plugin @josxa/opencode-recall -gf
```

This installs the package and wires it into your global OpenCode configuration automatically.

<details>
<summary>Manual installation</summary>

```sh
bun add -d @josxa/opencode-recall
# or
npm install --save-dev @josxa/opencode-recall
```

Then register the package in your OpenCode config (`opencode.json` or `~/.config/opencode/opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@josxa/opencode-recall"]
}
```

</details>

That exposes two tools to the agent:

| Tool             | Purpose                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `history_search` | Return ranked anchors (cursor + metadata + snippet) for a query.   |
| `history_read`   | Read a bounded ChatML window around a cursor.                      |

## Embeddings (Ollama)

Semantic search uses [Ollama](https://ollama.com) running locally. The default model is `all-minilm` — small, fast, and good enough for recall.

```sh
# install: https://ollama.com/download
ollama serve
ollama pull all-minilm
```

The first `history_search` call builds the sidecar index incrementally; subsequent calls reuse and sync it. If the elapsed sync time crosses a threshold, search output is prefixed with a `<sync indexed_rows="…" seconds="…" />` notice so the agent (and you) know an index update happened.

Lexical search keeps working without Ollama — but you lose paraphrase recall, which is half the value.

## Configuration

All configuration is environment‑driven so the plugin works inside MCP, the CLI, and CI without extra wiring.

| Variable                       | Default                                       | Description                                                              |
| ------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------ |
| `OPENCODE_DB_PATH`             | `$HOME/.local/share/opencode/opencode.db`     | OpenCode SQLite database (read‑only).                                    |
| `OPENCODE_RECALL_DB_PATH`      | `$HOME/.local/share/opencode/opencode-recall-index.db` | Sidecar embedding index path.                                  |
| `OPENCODE_RECALL_OLLAMA_URL`   | `http://127.0.0.1:11434`                      | Ollama base URL.                                                         |
| `OPENCODE_RECALL_EMBED_MODEL`  | `all-minilm`                                  | Embedding model name. Try `mxbai-embed-large` for higher quality.        |

Use `bun run eval:embeddings` to compare installed embedding models against the local regression cases in [`docs/real-history-regressions.md`](./docs/real-history-regressions.md).

## Tool reference

### `history_search`

| Arg      | Type     | Notes                                                                  |
| -------- | -------- | ---------------------------------------------------------------------- |
| `q`      | string   | **Required.** Free‑text query.                                         |
| `n`      | number   | Max hits (default `8`, max `25`).                                      |
| `dir`    | string   | Exact OpenCode session directory filter.                               |
| `after`  | ISO date | Only messages at or after this timestamp.                              |
| `before` | ISO date | Only messages at or before this timestamp. Defaults to *now − 30 s* to exclude the live conversation. |

Returns a JSON array of compact hits:

```jsonc
[
  {
    "cursor": "msg_…",     // opaque; pass to history_read
    "sid":    "ses_…",     // OpenCode session id
    "dir":    "/Users/you/projects/foo",
    "title":  "Figma MCP server on Azure API Center",
    "time":   "2026-04-12T08:21:44.000Z",
    "role":   "assistant",
    "score":  0.7421,
    "text":   "…snippet capped at 280 chars…"
  }
]
```

### `history_read`

| Arg      | Type   | Notes                                                                                                      |
| -------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| `cursor` | string | **Required.** A `msg_…`, a `ses_…`, or an encoded cursor from `history_search`.                            |
| `mode`   | string | `around` (default), `next`, `prev`, `head`, `tail`, or `full`.                                             |
| `n`      | number | Message count. Default `12`, max `50`. For `full`, default `200`, max `500`.                               |

Returns a ChatML‑like transcript window:

```xml
<hist sid="ses_…" dir="/…" mode="around" range="42-53" anchor="48" total="120" title="…">
<|im_start|>user name="msg_…" index="42" time="2026-04-12T08:21:44.000Z"
…text and tool_call blocks…
<|im_end|>
…more messages…
<nav cur="…" prev="…" head="…" next="…" tail="…" full="…" />
</hist>
```

Tool calls, patches, and file attachments render as structured tags with explicit `truncated` / `original_chars` markers when content is capped. The `<nav/>` element gives the agent cursors to continue paging without re‑searching.

## How it works

- **Source of truth.** `opencode.db` is opened read‑only. The plugin never writes to it.
- **Sidecar index.** A separate SQLite database (`opencode-recall-index.db`) stores text chunks, content hashes, and `Float32` embedding blobs. Synthetic `session-title:<id>` rows are indexed so proper‑noun title queries beat noisy snippet matches.
- **Sync.** Each `history_search` call performs an incremental sync with a 30‑minute overlap window and a lock so concurrent agents don't fight. Stale rows are pruned by comparing part ids.
- **Ranking.** Lexical + semantic candidates are merged, scored with title/text/directory term ratios + phrase boosts, filtered to require enough query‑term overlap, and diversified to at most two hits per session. A small semantic‑rescue lane admits paraphrase matches that miss lexical filters but have high embedding similarity.
- **Reads.** Windows are computed by `row_number()` over `(session_id, time_created, id)`, then parts are normalized into `text | tool | patch | file` and capped (tool input 2 000 chars, output 6 000 chars).

## Development

```sh
bun install
bun run ai:check       # biome + tsgo type-check
bun test               # deterministic ranking + cursor tests
bun run eval:real-history  # regression suite against your local opencode.db
bun run build          # emits dist/
```

Code quality is enforced by `biome` and `tsgo --noEmit`. See [`AGENTS.md`](./AGENTS.md) for the style guide.

## License

[MIT](./LICENSE) © JosXa
