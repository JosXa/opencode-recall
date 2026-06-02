# Project Notes

- Use Bun only: `bun install`, `bun run`, `bun test`.
- Prefer Bun APIs (`Bun.file`, `Bun.write`, `Bun.spawn`) when practical.
- Keep changes small, typed, and direct. Avoid `any`, avoid avoidable `else`/`try`/`catch`, and do not add compatibility paths without a concrete need.
- Run `bun run ai:check` before calling work done. Run `bun test` when behavior changes.
- `history_read` cursors are exact values only: `msg_...`, `ses_...`, or values copied from search results / `<nav ...>` attributes. Never invent suffixes like `:10`.
- Releases are tag-driven via `vX.Y.Z`; generate notes from commits. Package name is `@josxa/opencode-recall`.
