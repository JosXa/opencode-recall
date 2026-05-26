# Package Manager

ALWAYS use Bun. NEVER npm. Commands: `bun install`, `bun add`, `bun remove`, `bun run`, `bun test`.

# Bun APIs

MUST use Bun-native APIs over Node.js equivalents when practical:

- `Bun.file()`, `Bun.write()` instead of `node:fs`
- `Bun.spawn()` instead of `node:child_process`

Use `node:*` imports only when no Bun equivalent exists.

# Release Workflow

- Version bump should be determined from conventional commits.
- Publish to npm is automated by pushing a `vX.Y.Z` tag (see `.github/workflows/release.yml`).
- Package is published as `@josxa/opencode-recall` (scoped, public, with provenance). The unscoped `opencode-recall` name on npm belongs to another publisher.

NEVER ask user for release notes content. Generate release notes from commits when releasing.

## Stack

- Biome for formatting, linting, and import organization
- `tsgo --noEmit` for type checking
- Bun is the package manager and runtime for project scripts

## Code Quality

MUST run `bun run ai:check` after concluding any changes.

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
- Bun APIs where they are a clean fit
