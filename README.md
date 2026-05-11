# opencode-recall

Cursor-based OpenCode history recall plugin.

The first implementation target is intentionally small: expose retrieval primitives that help an agent find a relevant historical anchor and page around it without loading an entire session. The v1 transcript renderer is ChatML-like text, backed by an adapter boundary so JSON and Markdown renderers can be added later without changing indexing or pagination logic.

## Planned tools

- `history_search`: return flat ranked anchors with opaque cursors.
- `history_read`: read a bounded message window around a cursor and render it as ChatML.

## Development

```sh
bun install
bun run ai:check
```

The unscoped npm package name is currently taken by another publisher, so this scaffold is private until a publishing name is chosen.
