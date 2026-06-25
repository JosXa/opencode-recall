# Real history recall regressions

This document captures the before/after target for the May 2026 recall failure where a user asked for an old Figma MCP conversation. The OpenCode TUI session picker found the title immediately, but `history_search` returned current-session and unrelated MCP noise.

## Before

The plugin indexed only message text parts for embeddings. Session titles were copied onto chunk rows but were not embedded, lexically searched, or strongly boosted. Ranking mostly used cosine similarity plus a tiny keyword boost against `row.text`, which made exact proper-noun title matches lose to vague MCP-looking transcript snippets.

`history_read` also treated anything except `msg_...` as base64url JSON. Passing a normal OpenCode session cursor such as `ses_1ea07e649ffe8rG0kUBk4oJQC8` decoded to invalid bytes and produced `JSON Parse error: Unrecognized token '�'` instead of reading the session or returning a useful cursor error.

## Acceptance goal

Needle-in-haystack searches over the real local OpenCode DB should find known sessions with very few false positives. These cases are intentionally based on prior conversations and titles in `~/.local/share/opencode/opencode.db`:

| Query | Expected session | Category | Rank target |
| --- | --- | --- | --- |
| `figma mcp` | `ses_1ea07e649ffe8rG0kUBk4oJQC8`, `Figma MCP server on Azure API Center` | must top 3 | top 3 |
| `azure mcp registry figma` | same Figma Azure API Center session | must top 3 | top 3 |
| `figma azure api center` | same Figma Azure API Center session | must top 3 | top 2 |
| `executor mcp unavailable crash investigation` | `ses_1e3f564a4ffehZjhypED2AiJWP`, `Executor MCP unavailable crash investigation` | must top 1 | top 1 |
| `history_search opencode recall semantic ollama` | `ses_1e67d9990ffetS3quA8GM8FtA2`, OpenCode recall search development | must top 3 | top 3 |
| `which confluence spaces am I admin in` | `ses_1b083fceeffePsPC6T0K5qwuPu`, `Confluence admin spaces lookup` | known hard paraphrase | top 5 |
| `AICREW-89 contenteditable questions` | `ses_1b0abb56bffeeCGKORS30emSLW`, `Git worktree for AICREW-89 contenteditable` | known hard paraphrase | top 5 |
| `translate German document image to English` | `ses_1b0d391f1ffemK07e3R52zEWjn`, `Translate German document image to English` | known hard paraphrase | top 5 |
| `phone microphone spying ads psychology effect` | `ses_1b4edec2effemoWfcI1soaIxIz`, `Baader-Meinhof & confirmation bias in ad paranoia` | known hard paraphrase | top 5 |
| `schedule teams meeting Ground Zero AI members` | `ses_1b5284a9effemZ64qRqK4ySsS3`, `Schedule Teams meeting with Ground Zero AI members` | known hard paraphrase | top 5 |
| `zugbindung` | `ses_1fbe12286ffe2rE3kLl2aUKtuR`, `ICE Zugbindung bei Flugverspätung` | must top 1 | top 1 |
| `monitor came back` | `ses_1f31807dfffe86817RtAM6jxph`, `Disconnecting DELL monitor via macOS settings` | must top 1 | top 1 |
| `key repeat` | `ses_1b6603c8effeHJrsLvdXOwotbZ`, `VSCode key repeat disabled on macOS` | must top 1 | top 1 |
| `kpi upload stopped` | `ses_22689a804ffe1LHHLTtKP46c0O`, `KPI results upload stalled in production` | must top 1 | top 1 |
| `costs few cents` | `ses_1b3f719b5ffeupZr9YRhGD4oml`, `AI Hub monthly cost estimation dev/live (fork #1)` | known hard paraphrase | top 5 |
| `Ruzanna queue migration function app old queue race condition` | `ses_1bf5c0887ffegfWQsHfYNXOk0q`, `Queue migration & deploy function summary for Ruzanna` | must top 1 | top 1 |
| `SharePoint shared xlsx programmatically without browser Graph access` | `ses_1b5d4a332ffeLedXM5hG1TrtIC`, `SharePoint file access check` | must top 1 | top 1 |
| `followup queue alt return keybind create undefined` | `ses_1df0e4455ffeu1lUWS6BW9Zcrq`, `Plugin errors debug via logs` | must top 1 | top 1 |
| `image_generation no timeout SSE chatgpt backend codex responses` | `ses_1fd3561e1ffew8tV28hCsoSafl`, `image_generation tool timeout investigation` | must top 1 | top 1 |
| `Karabiner Caps Lock ß backslash Option Shift 7` | `ses_2212b07fbffek9h6UnD6JH89UO`, `Mac backslash with Karabiner hotkeys` | must top 1 | top 1 |
| `add ssh key gitlab public key id_ed25519 fingerprint` | `ses_225d62ad9ffeinLJSCdy04G0ot`, `Adding SSH key to GitLab` | must top 1 | top 1 |
| `rebase merge request 83 feat citation sentence highlight documentMethods conflict` | `ses_207669cddffebgTuNpGTMJ0GEL`, `Rebase MR !83 ai-hub` | must top 1 | top 1 |
| `Copilot Premium Usage blocked organization policy notification plugin` | `ses_2316838fdffeZQkTqILklQsoUB`, `Copilot Premium blocked for notification plugin` | must top 1 | top 1 |
| `LEAGUES localhost 5174 6000 8088 Streaming Cutter API project status` | `ses_21f8bc866ffeD0clxoLPAczPeu`, `LEAGUES project status overview` | must top 1 | top 1 |
| `progressive disclosure AGENTS.md references context gate root-to-leaf` | `ses_1e3800833ffeudY8duZJ80r63U`, `Progressive disclosure in AGENTS.md` | must top 1 | top 1 |

The ranking should also be strict: rows that do not match enough query terms are filtered out, and no session should flood the top results with more than two hits before other relevant sessions can appear.

## After

The implementation now combines lexical DB search with semantic sidecar search, indexes one synthetic `session-title:<session_id>` row per session, scores title phrase/title term matches aggressively, filters weak multi-term matches, and diversifies results by session. A bounded semantic rescue lane admits high-confidence embedding hits even when the query is a paraphrase with weak token overlap. `history_read` accepts `ses_...` directly and anchors session reads at the first message.

Run the regression suite with:

```sh
pnpm test
pnpm run eval:real-history
```

The real-history evaluator rebuilds an isolated temporary sidecar index and fails non-zero if any expected session misses its rank/noise target.
