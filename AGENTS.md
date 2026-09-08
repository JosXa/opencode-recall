# Project Notes

ALWAYS use pnpm with plain Node.js. NEVER use Bun. Commands: `pnpm install`, `pnpm add`, `pnpm remove`, `pnpm run`, `pnpm test`.

- Keep changes small, typed, and direct. Avoid `any`, avoid avoidable `else`/`try`/`catch`, and do not add compatibility paths without a concrete need.
- Run `pnpm run ai:check` before calling work done. Run `pnpm test` when behavior changes.
- `history_read` cursors are exact values only: `msg_...`, `ses_...`, or values copied from search results / `<nav ...>` attributes. Never invent suffixes like `:10`.

# Node APIs

MUST use Node.js APIs over Bun APIs:

- `node:fs` / `node:fs/promises` instead of `Bun.file()` / `Bun.write()`
- `node:child_process` instead of `Bun.spawn()`

Use `node:*` imports for Node built-ins. Do not introduce `bun:*` imports or global `Bun` APIs.

# Release Workflow

- Version bump should be determined from conventional commits.
- No Changesets setup: bump `package.json`, then explicitly dispatch `.github/workflows/release.yml` for that version.
- Keep the package name `@josxa/opencode-recall`; OpenCode V2 prereleases use the main-line version suffixed exactly `-opencode-v2`.
- Trusted publishing must stay tokenless: `.github/workflows/release.yml` uses `permissions.id-token: write` and `npm publish --provenance --access public`. Do not add an `NPM_TOKEN` secret for normal releases.
- npm trusted publishing must point at owner `JosXa`, repository `opencode-recall`, workflow filename `release.yml` (file `.github/workflows/release.yml`), environment `npm`, and package `@josxa/opencode-recall`.

NEVER ask user for release notes content. Generate release notes from commits when releasing.

## CI Pipeline Quirks

OpenCode V2 prereleases are published only by explicitly dispatching `release.yml` from the `opencode-v2` branch with the exact package version. The workflow does not create tags or GitHub releases.

**Dirty worktrees on explicit git/release requests.** If user explicitly asks to commit, push, or release, proceed with relevant changes. Do NOT refuse only because the worktree is dirty. Leave unrelated dirty files from other authors/sessions untouched unless user explicitly asks. For explicit release requests, create needed commit(s) first, then continue the release flow.

## Recovery: Tag Pushed While CI Failing

MUST delete tag immediately:

```sh
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
```

## Stack

- Biome for formatting, linting, and import organization
- `tsc --noEmit` for type checking
- pnpm is the package manager; Node.js is the runtime for project scripts

## Code Quality

MUST run `pnpm run ai:check` after concluding any changes.

Any change we make must be tested thoroughly in OpenCode.

MUST use one repo-wide `ai:check` command as the default verification step. Run it frequently while working and always before considering the task complete.

If you touch a subsystem with its own fast deterministic tests, run those too.

Do not consider work complete while `ai:check` is failing.

After concluding your changes, you MUST run `ai:check`.

## Style Guide

AVOID:

- `else` statements unless truly necessary
- `try`/`catch` where possible
- `any` type
- `let` statements when a `const` works
- unnecessary destructuring

PREFER:

- small direct functions over speculative abstractions
- keeping logic in one function unless reusable or composable
- Node APIs and small typed wrappers where they are a clean fit

# Pre-Commit Lint Check

MUST run `pnpm run ai:check` before any git commit.

**Behavior:**

1. Warnings in files YOU modified this session → MUST fix before committing.
2. Warnings ONLY in files you did NOT touch (pre-existing issues) → ask user: "Found biome warnings in unmodified files: [list files]. Fix these too, or proceed with just my changes?"
3. Commit only after all warnings in your modified files are resolved.

Compare Biome output against `git diff --name-only` to determine which files you touched.
