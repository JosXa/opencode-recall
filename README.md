# opencode-recall

Cursor-based semantic OpenCode history recall plugin.

The implementation exposes retrieval primitives that help an agent find a relevant historical anchor and page around it without loading an entire session. Search uses a local sidecar index with Ollama embeddings, while transcript reads stay source-faithful to OpenCode's own database. The v1 transcript renderer is ChatML-like text, backed by an adapter boundary so JSON and Markdown renderers can be added later without changing indexing or pagination logic.

## Tools

- `history_search`: return flat ranked anchors with opaque cursors.
- `history_read`: read a bounded message window around a cursor and render it as ChatML.

## Embeddings

Semantic search requires Ollama. The default model is `all-minilm` because it is small and performed well on local recall test cases.

```sh
ollama serve
ollama pull all-minilm
```

Set `OPENCODE_RECALL_EMBED_MODEL=mxbai-embed-large` to use the larger previous default. Use `bun run eval:embeddings` to compare installed models against the local history test cases.

## Development

```sh
bun install
bun run ai:check
```

The unscoped npm package name is currently taken by another publisher, so this scaffold is private until a publishing name is chosen.
