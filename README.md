# @josxa/opencode-recall

[![npm](https://img.shields.io/npm/v/%40josxa%2Fopencode-recall.svg)](https://www.npmjs.com/package/@josxa/opencode-recall)
[![CI](https://github.com/JosXa/opencode-recall/actions/workflows/ci.yml/badge.svg)](https://github.com/JosXa/opencode-recall/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> 🧠 **Searchable memory for [OpenCode](https://opencode.ai).** Ask *"what did we figure out about X last month?"* and the agent actually finds it.

Every OpenCode session is already saved locally. Recall makes them searchable, so the agent can pull the right slice of a past conversation back into context on demand, instead of you re-explaining yourself or dumping whole sessions into the prompt.

```text
          you ask                             you (or the agent) follow up
  "what did we figure out                    "show me more around that one"
   about rate limiting?"                        "what came right before?"
             │                                              │
             ▼                                              ▼
   ┌────────────────────┐                      ┌──────────────────────────┐
   │   search history   │ ─ hits + cursors ──► │   ranked snippets        │
   └────────────────────┘                      └────────────┬─────────────┘
                                                            │
                                                      pick a cursor
                                                            │
                                                            ▼
                                               ┌──────────────────────────┐
                                       ┌──────►│   read transcript        │
                                       │       └────────────┬─────────────┘
                                       │                    │
                                       │          transcript + cursors
                                       │                    │
                                       │                    ▼
                                       │       ┌──────────────────────────┐
                                      next page
                                       └──────►│   pull surrounding       │
                                               │   messages (ChatML)      │
                                               └──────────────────────────┘
```

## Why Recall?

You've already solved this problem. You debugged this exact error six weeks ago in another project. You worked out the deploy steps in a session you can't find anymore. The knowledge is *there*, sitting in `opencode.db`, but the agent can't see it.

Recall fixes that:

🔎 **Find the right session in seconds.** Hybrid lexical + semantic search across every project you've used OpenCode in.

📜 **Read the actual conversation, not a summary.** The agent pages a bounded window of messages around the match. Tool calls, patches, and file attachments render as structured ChatML, not a wall of JSON.

🎯 **Explicit by design.** Recall doesn't auto-inject memories. You (or the agent, when you ask) decide when to search. Your context window stays lean and you always know why something showed up in the prompt.

🔒 **Local and read-only.** Your `opencode.db` is never written to. The embedding index lives in a sidecar SQLite file you can delete any time.

## What it looks like

**Simple recall: "remind me how we did this."**

![Recall asking how trusted publishing was set up, agent runs history_search then history_read and returns the workflow config, publish command, and release flow](./assets/screenshot-01.png)

**Iterative recall: agent reformulates the search when the first pass is thin.**

![Recall asking about match marker file names, agent runs an initial broad search, then a narrower one with stronger terms and a directory filter, then returns a precise file list](./assets/screenshot-02.png)

## Install

```sh
opencode plugin @josxa/opencode-recall -gf
```

This installs the package and wires it into your global OpenCode config.

<details>
<summary>Manual installation</summary>

```sh
pnpm add -D @josxa/opencode-recall
```

Then register the plugin in `opencode.json` or `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@josxa/opencode-recall"]
}
```

</details>

## Set up embeddings (Ollama)

Semantic search uses [Ollama](https://ollama.com) running locally. Install it, that's it:

```sh
ollama --version  # should print a version. install from https://ollama.com/download if not.
```

Everything else is handled for you. The first `history_search` call will start `ollama serve` if it isn't running, pull the default embedding model (`all-minilm`, small and fast) if it isn't installed, and build the sidecar index incrementally. Subsequent calls reuse and sync it.

Lexical search still works without Ollama, but you lose paraphrase recall, which is half the value.

## How to actually use it

Recall is explicit. Ask the dedicated subagent when you want old session context:

```text
@recall how did we set up trusted publishing last time?
@recall find the session where we debugged recall lookup accuracy
@recall what did we decide about the rate limiter design?
```

The `recall` subagent starts with fresh context, searches and reads past sessions, then returns only a concise answer to the parent agent. It reports useful source session ids, titles, and directories, but not internal `msg_...` cursors unless you explicitly ask for raw read anchors. That gives you the useful part of session-level querying without dumping raw transcript pages into the main conversation. If you ask a follow-up about the same recalled session, the parent should invoke `@recall` again instead of answering from memory.

The subagent only checks OpenCode history. It does not read current files, run commands, or verify whether old session facts are still true.

Some natural-language prompts that should trigger recall:

- *"Recall how we set up the GitHub Actions release workflow."*
- *"Did we ever debug the Postgres connection pool exhaustion? Find that conversation."*
- *"Pull up the session where we discussed the rate limiter design."*
- *"Search my history for anything about Figma MCP and Azure."*
- *"What were the file names involved when we worked on the timeline component?"*

The recall subagent runs `history_search`, picks a promising hit, calls `history_read` to load the surrounding messages, and can page forward or back if more context is needed.

## Configuration

Recall creates a config file automatically on first use:

```text
<opencode-config-base-path>/recall.jsonc
```

On a normal Linux/macOS setup that is `~/.config/opencode/recall.jsonc`.

Most users never need to edit it. Open it when your OpenCode database lives somewhere unusual, you want the sidecar index somewhere else, or you want to try a different embedding model.

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/JosXa/opencode-recall/main/schema/config.schema.json",

  "database": {
    // OpenCode session database. Opened read-only; recall never writes here.
    // Default: ~/.local/share/opencode/opencode.db
    "path": "~/.local/share/opencode/opencode.db",

    // Sidecar embedding index. Safe to delete; rebuilt on next search.
    // Default: ~/.local/share/opencode/opencode-recall-index.db
    "indexPath": "~/.local/share/opencode/opencode-recall-index.db"
  },

  "embeddings": {
    // Ollama base URL.
    // Default: http://127.0.0.1:11434
    "ollamaUrl": "http://127.0.0.1:11434",

    // Try "mxbai-embed-large" for higher quality at the cost of speed and memory.
    // Default: all-minilm
    "model": "all-minilm"
  }
}
```

Environment variables still work as overrides for CI, MCP, and temporary experiments: `OPENCODE_DB_PATH`, `OPENCODE_RECALL_DB_PATH`, `OPENCODE_RECALL_OLLAMA_URL`, and `OPENCODE_RECALL_EMBED_MODEL`.

Run `pnpm run eval:embeddings` to compare installed embedding models against the local regression cases in [`docs/real-history-regressions.md`](./docs/real-history-regressions.md).

## Tool reference

Recall exposes four history tools. They are intended to be called by the `recall` subagent, not by the main agent directly.

<details>
<summary><code>session_index</code>: browse sessions by recency and usefulness</summary>

| Arg      | Type     | Notes                                                                                                  |
| -------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `n`      | number   | Max sessions (default `20`, max `100`).                                                                |
| `title`  | string   | Case-insensitive session title filter.                                                                |
| `directory` | string   | Exact OpenCode session directory filter.                                                               |
| `after`  | ISO date | Only sessions updated at or after this timestamp.                                                      |
| `before` | ISO date | Only sessions updated at or before this timestamp. Defaults to *now - 30 s* to exclude the live chat.  |

Returns newest-first session rows with a `ses_...` cursor for `history_read` and quick usefulness signals:

```jsonc
[
  {
    "cursor": "ses_...",
    "sid": "ses_...",
    "title": "Release debugging notes",
    "directory": "/Users/you/projects/foo",
    "updated": "2026-04-12T08:21:44.000Z",
    "messages": 84,
    "turns": 18,
    "assistantMessages": 32,
    "toolMessages": 9,
    "textParts": 76,
    "approxContextChars": 118420
  }
]
```

Use this when you do not have a search term yet and want to spot substantial past sessions at a glance.

</details>

<details>
<summary><code>session_save</code>: materialize a session file</summary>

| Arg      | Type                             | Notes                                           |
| -------- | -------------------------------- | ----------------------------------------------- |
| `cursor` | string                           | **Required.** A `ses_...` session cursor only.  |
| `path`   | string                           | **Required.** Workspace-relative destination.   |
| `format` | `chatml` \| `markdown` \| `jsonl` | Transcript encoding. Default `chatml`.          |

Writes the full normalized session transcript and returns a compact receipt:

```jsonc
{
  "path": "recall/ses_....chatml",
  "bytes": 48321,
  "messages": 94
}
```

The destination is always overwritten and must stay inside the active workspace.

</details>

<details>
<summary><code>history_search</code>: return ranked hits for a query</summary>

| Arg      | Type     | Notes                                                                                                  |
| -------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `q`      | string   | **Required.** Free-text query.                                                                         |
| `n`      | number   | Max hits (default `8`, max `25`).                                                                      |
| `directory` | string   | Exact OpenCode session directory filter.                                                               |
| `after`  | ISO date | Only messages at or after this timestamp.                                                              |
| `before` | ISO date | Only messages at or before this timestamp. Defaults to *now − 30 s* to exclude the live conversation.  |

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

</details>

<details>
<summary><code>history_read</code>: read a bounded transcript window around a cursor</summary>

| Arg      | Type   | Notes                                                                                          |
| -------- | ------ | ---------------------------------------------------------------------------------------------- |
| `cursor` | string | **Required.** A `msg_…`, a `ses_…`, or an encoded cursor from `history_search`.                |
| `mode`   | string | `around` (default), `next`, `prev`, `head`, or `tail`. `full` is rejected; page instead.        |
| `n`      | number | Message count. Default `12`, max `50`.                                                         |

Returns a ChatML-like transcript window:

```xml
<hist sid="ses_…" dir="/…" mode="around" range="42-53" anchor="48" total="120" title="…">
<|im_start|>user name="msg_…" index="42" time="2026-04-12T08:21:44.000Z"
…text and tool_call blocks…
<|im_end|>
…more messages…
<nav cur="…" prev="…" head="…" next="…" tail="…" />
</hist>
```

Tool calls, patches, and file attachments render as structured tags with explicit `truncated` / `original_chars` markers when content is capped. The `<nav/>` element gives the agent cursors to keep paging without re-searching. To read from the end upward, start with `mode="tail"`, then pass the returned `prev` cursor back with `mode="prev"` until enough context is loaded. `mode="full"` is intentionally rejected because large transcript responses can still be truncated by the outer tool transport.

</details>

## How it works

```text
┌───────────────────┐    history_search    ┌──────────────────────┐
│     OpenCode      │ ───────────────────► │  Ranked anchors      │
│                   │                      │  (opaque cursors)    │
└───────────────────┘ ◄─────────────┐      └──────────┬───────────┘
         │      history_read        │                 │
         ▼                          │ ChatML window   │
┌───────────────────┐   pagination  │                 │
│  ChatML window    │ ◄─────────────┘                 │
│  with <nav/>      │                                 │
└───────────────────┘                                 │
                                                      ▼
                                     ┌──────────────────────────────┐
                                     │  opencode.db   (read-only)   │
                                     │  + sidecar embedding index   │
                                     └──────────────────────────────┘
```

- **Source of truth.** `opencode.db` is opened read-only. The plugin never writes to it.
- **Sidecar index.** A separate SQLite database (`opencode-recall-index.db`) stores text chunks, content hashes, and `Float32` embedding blobs. Synthetic `session-title:<id>` rows are indexed so proper-noun title queries beat noisy snippet matches.
- **Sync.** Each `history_search` call performs an incremental sync with a 30-minute overlap window and a lock so concurrent agents don't fight. Stale rows are pruned by comparing part ids.
- **Ranking.** Lexical and semantic candidates are merged, scored with title/text/directory term ratios plus phrase boosts, filtered to require enough query-term overlap, and diversified to at most two hits per session. A small semantic-rescue lane admits paraphrase matches that miss lexical filters but have high embedding similarity.
- **Reads.** Windows are computed by `row_number()` over `(session_id, time_created, id)`, then parts are normalized into `text | tool | patch | file` and capped (tool input 2 000 chars, output 6 000 chars).

## Development

```sh
pnpm install
pnpm run ai:check           # biome + tsc type-check
pnpm test                   # deterministic ranking + cursor tests
pnpm run eval:real-history  # regression suite against your local opencode.db
pnpm run build              # emits dist/
```

Code quality is enforced by `biome` and `tsc --noEmit`. See [`AGENTS.md`](./AGENTS.md) for the style guide.

## License

[MIT](./LICENSE) © JosXa
