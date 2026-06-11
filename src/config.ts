import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_OPENCODE_DATA_DIR_RELATIVE = '.local/share/opencode'
const DEFAULT_OPENCODE_DB_FILENAME = 'opencode.db'
const DEFAULT_SIDECAR_DB_FILENAME = 'opencode-recall-index.db'
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'
const DEFAULT_EMBED_MODEL = 'all-minilm'
const CONFIG_FILENAME_PRIMARY = 'recall.jsonc'
const CONFIG_FILENAME_FALLBACK = 'recall.json'

export interface RecallConfig {
  readonly database: {
    readonly path: string
    readonly indexPath: string
  }
  readonly embeddings: {
    readonly ollamaUrl: string
    readonly model: string
  }
}

interface RawConfig {
  readonly database?: {
    readonly path?: string
    readonly indexPath?: string
  }
  readonly embeddings?: {
    readonly ollamaUrl?: string
    readonly model?: string
  }
}

/**
 * Loads recall config with this resolution order (lowest to highest precedence):
 *
 *   1. Built-in defaults
 *   2. <opencode-config>/recall.jsonc (auto-created on first load)
 *   3. Environment variables (OPENCODE_DB_PATH, OPENCODE_RECALL_*)
 *
 * The file is the canonical surface. Env vars stay supported so CI / MCP /
 * sandbox runners can override without writing to disk.
 */
export function loadConfig(): RecallConfig {
  const defaults = defaultConfig()
  ensureGlobalConfigExists()
  const fileConfig = readConfigFile()
  const merged = mergeConfig(defaults, fileConfig)
  return applyEnvOverrides(merged)
}

export function getConfigFilePath(): string {
  return join(openCodeConfigDir(), CONFIG_FILENAME_PRIMARY)
}

function defaultConfig(): RecallConfig {
  const dataDir = openCodeDataDir()
  return {
    database: {
      path: join(dataDir, DEFAULT_OPENCODE_DB_FILENAME),
      indexPath: join(dataDir, DEFAULT_SIDECAR_DB_FILENAME),
    },
    embeddings: {
      ollamaUrl: DEFAULT_OLLAMA_URL,
      model: DEFAULT_EMBED_MODEL,
    },
  }
}

function readConfigFile(): RawConfig {
  const configDir = openCodeConfigDir()
  const primaryPath = join(configDir, CONFIG_FILENAME_PRIMARY)
  const fallbackPath = join(configDir, CONFIG_FILENAME_FALLBACK)

  const path = existsSync(primaryPath)
    ? primaryPath
    : existsSync(fallbackPath)
      ? fallbackPath
      : undefined

  if (path === undefined) {
    return {}
  }

  const raw = readFileSync(path, 'utf-8')
  return parseJsonc(raw, path)
}

function ensureGlobalConfigExists(): void {
  const configDir = openCodeConfigDir()
  const primaryPath = join(configDir, CONFIG_FILENAME_PRIMARY)
  const fallbackPath = join(configDir, CONFIG_FILENAME_FALLBACK)

  if (existsSync(primaryPath) || existsSync(fallbackPath)) {
    return
  }

  mkdirSync(configDir, { recursive: true })
  writeFileSync(primaryPath, DEFAULT_CONFIG_CONTENT, 'utf-8')
}

function mergeConfig(base: RecallConfig, raw: RawConfig): RecallConfig {
  return {
    database: {
      path: expandPath(raw.database?.path) ?? base.database.path,
      indexPath: expandPath(raw.database?.indexPath) ?? base.database.indexPath,
    },
    embeddings: {
      ollamaUrl: nonEmptyString(raw.embeddings?.ollamaUrl) ?? base.embeddings.ollamaUrl,
      model: nonEmptyString(raw.embeddings?.model) ?? base.embeddings.model,
    },
  }
}

function applyEnvOverrides(config: RecallConfig): RecallConfig {
  const {
    OPENCODE_DB_PATH,
    OPENCODE_RECALL_DB_PATH,
    OPENCODE_RECALL_EMBED_MODEL,
    OPENCODE_RECALL_OLLAMA_URL,
  } = process.env
  return {
    database: {
      path: expandPath(OPENCODE_DB_PATH) ?? config.database.path,
      indexPath: expandPath(OPENCODE_RECALL_DB_PATH) ?? config.database.indexPath,
    },
    embeddings: {
      ollamaUrl: nonEmptyString(OPENCODE_RECALL_OLLAMA_URL) ?? config.embeddings.ollamaUrl,
      model: nonEmptyString(OPENCODE_RECALL_EMBED_MODEL) ?? config.embeddings.model,
    },
  }
}

function openCodeConfigDir(): string {
  const { OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME } = process.env
  const configured = nonEmptyString(OPENCODE_CONFIG_DIR)
  if (configured !== undefined) {
    return configured
  }

  const xdgConfigHome = nonEmptyString(XDG_CONFIG_HOME)
  const configHome = xdgConfigHome ?? join(homedirOrThrow(), '.config')

  return join(configHome, 'opencode')
}

function openCodeDataDir(): string {
  const { XDG_DATA_HOME } = process.env
  const dataHome = nonEmptyString(XDG_DATA_HOME)
  if (dataHome !== undefined) {
    return join(dataHome, 'opencode')
  }

  return join(homedirOrThrow(), DEFAULT_OPENCODE_DATA_DIR_RELATIVE)
}

function homedirOrThrow(): string {
  const home = homedir()
  if (home.length === 0) {
    throw new Error('Cannot resolve recall config: no home directory available')
  }

  return home
}

function expandPath(value: string | undefined): string | undefined {
  const trimmed = nonEmptyString(value)
  if (trimmed === undefined) {
    return undefined
  }

  if (trimmed === '~') {
    return homedirOrThrow()
  }

  if (trimmed.startsWith('~/')) {
    return join(homedirOrThrow(), trimmed.slice(2))
  }

  return trimmed
}

function nonEmptyString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Strips simple JSONC comments and trailing commas, then JSON.parse.
 * Good enough for this small config file; if recall ever needs full JSONC
 * fidelity, swap this for jsonc-parser.
 */
function parseJsonc(input: string, sourcePath: string): RawConfig {
  const stripped = stripJsoncComments(input)
  const withoutTrailingCommas = stripped.replace(/,\s*([}\]])/g, '$1')

  try {
    const parsed = JSON.parse(withoutTrailingCommas) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as RawConfig
    }
    return {}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse recall config at ${sourcePath}: ${message}`)
  }
}

function stripJsoncComments(input: string): string {
  return input.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const DEFAULT_CONFIG_CONTENT = `{
  // JSON Schema for editor autocompletion.
  "$schema": "https://raw.githubusercontent.com/JosXa/opencode-recall/main/schema/config.schema.json",

  // Database locations.
  "database": {
    // OpenCode session database. Opened read-only; recall never writes here.
    // Default: ~/.local/share/opencode/opencode.db
    // "path": "~/.local/share/opencode/opencode.db",

    // Sidecar embedding index. Safe to delete; rebuilt on next search.
    // Default: ~/.local/share/opencode/opencode-recall-index.db
    // "indexPath": "~/.local/share/opencode/opencode-recall-index.db"
  },

  // Embedding backend (Ollama). The plugin starts \`ollama serve\` and pulls
  // the model on first use if needed; you usually do not need to touch this.
  "embeddings": {
    // Ollama base URL.
    // Default: http://127.0.0.1:11434
    // "ollamaUrl": "http://127.0.0.1:11434",

    // Embedding model. Try "mxbai-embed-large" for higher quality at the cost
    // of speed and memory. Run \`bun run eval:embeddings\` to compare models
    // against the regression cases in docs/real-history-regressions.md.
    // Default: all-minilm
    // "model": "all-minilm"
  }
}
`
