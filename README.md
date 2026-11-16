<div align="center">

<img src="https://raw.githubusercontent.com/JosXa/opencode-recall/main/.github/readme/logo.png" width="128" alt="opencode-recall logo: an elephant with a magnifying-glass eye holding a chat bubble">

# opencode-recall

**Give your [OpenCode](https://opencode.ai) agent a memory of every conversation you've had with it.**

<a href="https://www.npmjs.com/package/@josxa/opencode-recall"><img src="https://img.shields.io/npm/v/%40josxa%2Fopencode-recall?style=flat-square&color=4876D6&labelColor=011627&label=npm" alt="npm version"></a>
<a href="https://github.com/JosXa/opencode-recall/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JosXa/opencode-recall/ci.yml?style=flat-square&labelColor=011627&label=CI" alt="CI status"></a>
<img src="https://img.shields.io/badge/history-local%20%26%20read--only-4876D6?style=flat-square&labelColor=011627" alt="History stays local and read-only">
<img src="https://img.shields.io/badge/semantic%20search-Ollama-4876D6?style=flat-square&labelColor=011627" alt="Semantic search with Ollama">
<a href="https://github.com/JosXa/opencode-recall/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-011627?style=flat-square" alt="MIT license"></a>

[**Install**](#-install) · [Usage](#-usage) · [Configuration](#-configuration) · [Tool reference](#-tool-reference) · [How it works](#-how-it-works)

<br>

<img src="https://raw.githubusercontent.com/JosXa/opencode-recall/main/.github/readme/recall.svg" width="760" alt="You ask '@recall how did we fix the flaky auth test last time?'. Recall runs history_search and history_read, then answers with the fix and the source session.">

</div>

<br>

You've solved this before. Six weeks ago, in another project, you tracked down this exact error. Last month you worked out the release steps in a session you can't find anymore. OpenCode kept all of it, but your agent can't look back. With Recall it can.

## <img src="https://raw.githubusercontent.com/JosXa/opencode-recall/main/.github/readme/icon-brain.svg" width="24" align="absmiddle" alt=""> Why Recall?

🔎 **Find the right session in seconds.** Hybrid lexical and semantic search across every project you've used OpenCode in.

📜 **Read the conversation, not a summary.** The agent pages a bounded window of messages around the match. Tool calls, patches and attachments render as structured ChatML instead of a wall of JSON.

🎯 **Explicit by design.** Recall never injects memories on its own. You, or the agent when you ask, decide when to search, so your context stays lean and you always know why something is in the prompt.

🔒 **Local and read-only.** Recall never writes to `opencode.db`. The embedding index lives in a sidecar SQLite file that you can delete at any time.

### Not a memory system

Agent memory tools extract facts from your sessions and feed them back as standing knowledge. Over time, a guess the agent made once turns into a rule, and an old fact keeps steering new work long after it stopped being true. Recall stores nothing of the sort. It only searches and reads the transcripts OpenCode already keeps.

| | Agent memory | Recall |
|---|---|---|
| What it keeps | Extracted facts and rules | Nothing new; your transcripts stay as they are |
| When it enters the prompt | Automatically, every session | Only when you or the agent ask |
| What the agent sees | A summary, without context | The original messages, with session, directory and date |
| Old or wrong conclusions | Persist until someone deletes them | Read as what they were: one conversation at one point in time |

## <img src="https://raw.githubusercontent.com/JosXa/opencode-recall/main/.github/readme/icon-play-circle.svg" width="24" align="absmiddle" alt=""> What it looks like

<table>
<tr>
<td width="50%" valign="top">
<a href="https://github.com/JosXa/opencode-recall/blob/main/assets/screenshot-01.png"><img src="https://raw.githubusercontent.com/JosXa/opencode-recall/main/assets/screenshot-01.png" alt="Recall is asked how trusted publishing was set up. The agent runs history_search, then history_read, and returns the workflow config, publish command and release flow."></a>
<p><b>"Remind me how we did this."</b><br><sub>One search, one read, and the answer comes back with the actual config and commands.</sub></p>
</td>
<td width="50%" valign="top">
<a href="https://github.com/JosXa/opencode-recall/blob/main/assets/screenshot-02.png"><img src="https://raw.githubusercontent.com/JosXa/opencode-recall/main/assets/screenshot-02.png" alt="Recall is asked about match marker file names. The agent runs a broad search, then a narrower one with a directory filter, and returns a precise file list."></a>
<p><b>When the first search comes up thin, it tries again.</b><br><sub>The agent narrows the query and filters by project until it finds the exact files.</sub></p>
</td>
</tr>
</table>

## <img src="https://raw.githubusercontent.com/JosXa/opencode-recall/main/.github/readme/icon-package.svg" width="24" align="absmiddle" alt=""> Install

```sh
opencode plugin @josxa/opencode-recall -gf
```

This installs the package and adds it to your global OpenCode config.

<details>
<summary>Manual installation</summary>

<br>

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

### Search by meaning with Ollama

To match on meaning, Recall uses [Ollama](https://ollama.com) on your machine. [Install it](https://ollama.com/download) and you're done:

```sh
ollama --version   # prints a version when Ollama is installed
```

On the first search, Recall starts Ollama if needed, downloads a small embedding model[^model] and builds its index.

> [!NOTE]
> Without Ollama, Recall still works but matches only exact words, so rephrased questions miss more often.

## <img src="https://raw.githubusercontent.com/JosXa/opencode-recall/main/.github/readme/icon-message-square-text.svg" width="24" align="absmiddle" alt=""> Usage

Mention `@recall` whenever old context would help:

```text
@recall how did we set up trusted publishing last time?
@recall find the session where we debugged the Postgres connection pool
@recall what did we decide about the rate limiter design?
```

Plain requests work too, because your agent hands them to Recall:

> *"Did we ever debug the Postgres connection pool exhaustion? Find that conversation."*<br>
> *"Search my history for anything about Figma MCP and Azure."*<br>
> *"What were the file names involved when we worked on the timeline component?"*

### How the `recall` subagent works

Recall digs in a dedicated subagent, so the search work stays out of your main conversation:

```mermaid
---
config:
  look: classic
  sequence:
    mirrorActors: false
---
sequenceDiagram
    actor You
    participant Agent as Your agent
    participant Recall as recall subagent
    participant History as History
    You->>Agent: "how did we fix the flaky auth test?"
    Agent->>Recall: question, fresh context
    loop until the answer is solid
        Recall->>History: history_search
        Recall->>History: history_read
    end
    Recall-->>Agent: answer + sources
    Agent-->>You: answer
```

1. **Fresh context.** The subagent receives only your question, so nothing in the current chat biases the search.
2. **Search and read.** It runs `history_search`, loads the messages around a promising hit with `history_read`, and rephrases, narrows or pages when the first results are thin.
3. **Concise answer.** The parent agent receives the findings plus the source sessions (ID, title and directory). Raw transcript pages stay inside the subagent.
4. **Follow-ups go back to Recall.** The parent calls `@recall` again instead of answering from its memory of the first summary.

> [!IMPORTANT]
> The subagent sees only your OpenCode history. It does not read current files, run commands or check whether old facts are still true. Verify anything that may have changed since then.

## <img src="https://raw.githubusercontent.com/JosXa/opencode-recall/main/.github/readme/icon-settings-2.svg" width="24" align="absmiddle" alt=""> Configuration

Most people never edit the config. Recall creates `recall.jsonc` in the OpenCode config directory (usually `~/.config/opencode/recall.jsonc`) on first use. Open it when your OpenCode database lives somewhere unusual, when you want the index elsewhere, or to try another embedding model. For editor completion, set `"$schema"` to the [config schema](https://raw.githubusercontent.com/JosXa/opencode-recall/main/schema/config.schema.json).

```jsonc
{
  "database": {
    // opened read-only
    "path": "~/.local/share/opencode/opencode.db",
    // safe to delete, rebuilt on the next search
    "indexPath": "~/.local/share/opencode/opencode-recall-index.db"
  },
  "embeddings": {
    "ollamaUrl": "http://127.0.0.1:11434",
    // "mxbai-embed-large" matches better but is slower and uses more memory
    "model": "all-minilm"
  }
}
```

| Environment variable | Overrides |
|---|---|
| `OPENCODE_DB_PATH`, `OPENCODE_RECALL_DB_PATH` | `database.path` and any configured source list |
| `OPENCODE_RECALL_OLLAMA_URL` | `embeddings.ollamaUrl` |
| `OPENCODE_RECALL_EMBED_MODEL` | `embeddings.model` |

Use them for CI, MCP and temporary experiments. Run `pnpm run eval:embeddings` to compare installed embedding models against the [local regression cases](https://github.com/JosXa/opencode-recall/blob/main/docs/real-history-regressions.md).

### Give Recall its own model

Recall uses OpenCode's own `agent.recall` configuration. The plugin supplies the description, subagent mode, prompt and history-only permissions. You control `model`, `variant`, `temperature` and the other agent settings:

```jsonc
// ~/.config/opencode/opencode.json
{
  "agent": {
    "recall": { "model": "example-provider/recall-mini", "variant": "low" }
  }
}
```

Recall keeps this model when the parent agent uses another one. Without `agent.recall`, OpenCode's normal default model applies.

### Read V1 and V2 history from either runtime

Put the same named sources into both runtimes' `recall.jsonc`:

```jsonc
{
  "database": {
    "sources": [
      {
        "id": "v1",
        "path": "~/.local/share/opencode/opencode.db",
        "indexPath": "~/.local/share/opencode/recall-v1.db"
      },
      {
        "id": "v2",
        "path": "~/.local/share/opencode/opencode-v2.db",
        "indexPath": "~/.local/share/opencode/recall-v2.db"
      }
    ]
  }
}
```

Results then carry a `sourceId`, and cursors are qualified, such as `v1::msg_example` or `v2::ses_example`.

<details>
<summary>Rules for sources, cursors and the SDK</summary>

<br>

- **One sidecar per source**, shared by all Recall hosts. Event cursors, embeddings, sync locks and stale-row cleanup stay local to that source. Missing sources are skipped without opening or pruning their sidecars. A cursor that names an unavailable source reports an error.
- **Source IDs** must be unique and contain only letters, digits, `_` or `-`. Keep them stable across configs so saved cursors stay usable.
- **Paths:** each canonical source path and each sidecar must be unique, and a sidecar cannot alias a source. Symlinks are resolved. A sidecar records its source identity atomically, so conflicting configurations fail instead of indexing the wrong database. Existing unbound indexes are rebuilt when first bound. Use fresh sidecars per source when you migrate a previously shared index.
- **Cursors:** copy qualified values exactly into read and save calls, including navigation cursors, without offsets. Raw `msg_…` and `ses_…` IDs work when only one available source contains them; ambiguous IDs produce an error that lists the qualified choices.
- **Merging:** copies in different sources stay distinct. Ranking, result limits, recent entries and session lists merge across sources. A qualified `excludeSessionId` filters one source; a raw one applies to all.
- **SDK:** pass the same list to `new OpenCodeRecall({ sources: [...] })` or `searchHistory(query, { sources: [...] })`.
- **Single source:** `database.path`/`database.indexPath` and the SDK's `historyDbPath`/`sidecarDbPath` still work, with unqualified cursors. Default sidecars are named `opencode-recall-<source-path-hash>.db`, so V1 and V2 cannot share an index by accident. The former `legacyPath` option maps to a separate `legacy` source.

</details>

## <img src="https://raw.githubusercontent.com/JosXa/opencode-recall/main/.github/readme/icon-code-xml.svg" width="24" align="absmiddle" alt=""> Tool reference

The `recall` subagent calls four history tools. The main agent does not call them directly.

| Tool | Purpose |
|---|---|
| [`history_search`](#history_search) | Ranked hits for a query, or the most recent messages |
| [`history_read`](#history_read) | A bounded ChatML window around a cursor |
| [`session_index`](#session_index) | Sessions by recency, with size signals |
| [`session_save`](#session_save) | Write a full session transcript to a file |

<details>
<summary><h3>history_search</h3></summary>

| Arg | Type | Notes |
|---|---|---|
| `q` | string | Free-text query. Empty lists the most recent messages. |
| `n` | number | Max hits. Default `8`, max `25`. |
| `directory` | string | Exact session directory. |
| `after`, `before` | ISO date | Message time range. `before` defaults to *now − 30 s*. |
| `includeCurrentSession` | boolean | Include the calling session. Default `false`. |

```jsonc
[
  {
    "cursor": "msg_…",  // pass to history_read
    "sid": "ses_…",
    "dir": "/Users/you/projects/foo",
    "title": "Figma MCP server on Azure API Center",
    "time": "2026-04-12T08:21:44.000Z",
    "role": "assistant",
    "score": 0.7421,
    "text": "…snippet capped at 280 chars…"
  }
]
```

</details>

<details>
<summary><h3>history_read</h3></summary>

| Arg | Type | Notes |
|---|---|---|
| `cursor` | string | **Required.** An exact cursor from search or navigation. |
| `mode` | string | `around` (default), `next`, `prev`, `head` or `tail`. `full` is rejected. |
| `n` | number | Message count. Default `12`, max `50`. |

```xml
<hist sid="ses_…" dir="/…" mode="around" range="42-53" anchor="48" total="120" title="…">
<|im_start|>user name="msg_…" index="42" time="2026-04-12T08:21:44.000Z"
…text and tool_call blocks…
<|im_end|>
<nav cur="…" prev="…" head="…" next="…" tail="…" />
</hist>
```

Capped content carries `truncated` and `original_chars` markers. `<nav/>` gives cursors for paging without a new search. To read from the end, start with `mode="tail"` and follow `prev`. `full` is rejected because large responses can be cut off by the tool transport.

</details>

<details>
<summary><h3>session_index</h3></summary>

| Arg | Type | Notes |
|---|---|---|
| `n` | number | Max sessions. Default `20`, max `100`. |
| `title` | string | Case-insensitive title filter. |
| `directory` | string | Exact session directory. |
| `after`, `before` | ISO date | Update time range. `before` defaults to *now − 30 s*. |
| `includeCurrentSession` | boolean | Include the calling session. Default `false`. |

```jsonc
[
  {
    "cursor": "ses_…", "sid": "ses_…", "title": "Release debugging notes",
    "directory": "/Users/you/projects/foo", "updated": "2026-04-12T08:21:44.000Z",
    "messages": 84, "turns": 18, "assistantMessages": 32, "toolMessages": 9,
    "textParts": 76, "approxContextChars": 118420
  }
]
```

Useful without a search term, to spot substantial sessions at a glance.

</details>

<details>
<summary><h3>session_save</h3></summary>

| Arg | Type | Notes |
|---|---|---|
| `cursor` | string | **Required.** An exact session cursor. |
| `path` | string | **Required.** Destination inside the workspace. Always overwritten. |
| `format` | `chatml` \| `markdown` \| `jsonl` | Default `chatml`. |

```jsonc
{ "path": "recall/ses_….chatml", "bytes": 48321, "messages": 94 }
```

</details>

## <img src="https://raw.githubusercontent.com/JosXa/opencode-recall/main/.github/readme/icon-cpu.svg" width="24" align="absmiddle" alt=""> How it works

```mermaid
---
config:
  look: classic
  themeVariables:
    edgeLabelBackground: transparent
---
flowchart LR
    classDef store fill:#4876D61a,stroke:#4876D6,stroke-width:1.5px
    classDef tool fill:#4876D633,stroke:#4876D6,stroke-width:1.5px
    db[("opencode.db<br><i>read-only</i>")]:::store -- event log sync --> idx[("sidecar index<br><i>chunks + vectors</i>")]:::store
    ollama(["Ollama"]):::store -. embeddings .-> idx
    idx --> search["history_search<br>lexical + semantic"]:::tool
    db --> read["history_read<br>ChatML windows"]:::tool
```

- **Source of truth.** `opencode.db` is opened read-only.
- **Sidecar index.** A separate SQLite file stores text chunks, content hashes and `Float32` embeddings. Session titles are indexed as their own rows, so proper-noun queries match titles before noisy snippets.
- **Sync.** Each search reads OpenCode's event log and reconciles only changed sessions, including deletions. There is no watcher or background process.
- **Vector scoring.** The native `sqlite-vec` extension scores embeddings inside SQLite, so only the best candidates reach JavaScript. Vectors from another model or dimension are excluded.
- **Ranking.** Lexical and semantic candidates merge, get scored by title, text and directory term overlap plus phrase boosts, and are limited to two hits per session. A small semantic lane admits paraphrases with high embedding similarity that miss the lexical filter.
- **Reads.** Windows come from `row_number()` over `(session_id, time_created, id)`. Parts are normalized to `text`, `tool`, `patch` and `file` and capped at 2,000 characters of tool input and 6,000 of output.

## <img src="https://raw.githubusercontent.com/JosXa/opencode-recall/main/.github/readme/icon-terminal.svg" width="24" align="absmiddle" alt=""> Development

```sh
pnpm install
pnpm run ai:check           # biome + tsc
pnpm test                   # deterministic ranking and cursor tests
pnpm run eval:real-history  # regression suite against your local opencode.db
pnpm run build              # emits dist/
```

`node scripts/benchmark-search.mjs BASELINE_ROOT SIDECAR` compares speed, peak memory and top-result overlap against a built baseline checkout. It starts fresh processes, alternates their order and measures vector search apart from embedding and lexical search. The style guide is in [`AGENTS.md`](https://github.com/JosXa/opencode-recall/blob/main/AGENTS.md).

## <img src="https://raw.githubusercontent.com/JosXa/opencode-recall/main/.github/readme/icon-scale.svg" width="24" align="absmiddle" alt=""> License

[MIT](https://github.com/JosXa/opencode-recall/blob/main/LICENSE) © JosXa

[^model]: `all-minilm` by default. See [Configuration](#-configuration) to switch models.
