import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeCursor, type HistoryCursor } from './cursor.js'
import { executeNodeWorker, executeNodeWorkerSync } from './node-worker-client.js'
import type {
  OpenCodeRecallOptions,
  RecallReadOptions,
  RecallSearchHit,
  RecallSearchOptions,
  RecallSearchResult,
  RecallSessionIndexEntry,
  RecallSessionIndexOptions,
  RecallSessionIndexResult,
} from './sdk-direct.js'
import type { HistorySearchResult } from './search.js'
import type { SyncOptions, SyncResult } from './sidecar.js'
import type { TranscriptWindow } from './transcript.js'
import type {
  HistoryReadWorkerArgs,
  HistorySearchWorkerArgs,
  SessionIndexWorkerArgs,
} from './worker-protocol.js'

export type { EmbeddingProvider, OllamaEmbeddingProviderOptions } from './embedding.js'
export { OllamaEmbeddingProvider } from './embedding.js'
export type {
  OpenCodeRecallOptions,
  RecallReadOptions,
  RecallSearchHit,
  RecallSearchOptions,
  RecallSearchResult,
  RecallSessionIndexEntry,
  RecallSessionIndexOptions,
  RecallSessionIndexResult,
} from './sdk-direct.js'
export type { SyncOptions, SyncResult } from './sidecar.js'
export type { TranscriptWindow } from './transcript.js'

const DEFAULT_SEARCH_LIMIT = 50
const DEFAULT_SESSION_INDEX_LIMIT = 20
const DEFAULT_FRESHNESS_EXCLUSION_MS = 30_000
const DEFAULT_WORKER_TIMEOUT_MS = 120_000
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

export class OpenCodeRecall {
  readonly #options: OpenCodeRecallOptions

  public constructor(options: OpenCodeRecallOptions = {}) {
    this.#options = options
  }

  public close(): void {
    // Worker-backed SDK calls do not keep resources open in the caller process.
  }

  public async sync(options: SyncOptions = {}): Promise<SyncResult> {
    return this.#direct().then((recall) => recall.sync(options))
  }

  public async syncLexical(): Promise<SyncResult> {
    return this.#direct().then((recall) => recall.syncLexical())
  }

  public async search(
    query: string,
    options: RecallSearchOptions = {},
  ): Promise<RecallSearchResult> {
    if (this.#options.embeddingProvider !== undefined) {
      return this.#direct().then((recall) => recall.search(query, options))
    }

    return searchHistory(query, { ...this.#options, ...options })
  }

  public async sessionIndex(
    options: RecallSessionIndexOptions = {},
  ): Promise<RecallSessionIndexResult> {
    if (this.#options.embeddingProvider !== undefined) {
      return this.#direct().then((recall) => recall.sessionIndex(options))
    }

    return sessionIndex({ ...this.#options, ...options })
  }

  public read(cursorValue: string, options: RecallReadOptions = {}): TranscriptWindow {
    return readHistoryWindow(cursorValue, { ...this.#options, ...options })
  }

  public render(cursorValue: string, options: RecallReadOptions = {}): string {
    return renderHistoryWindow(cursorValue, { ...this.#options, ...options })
  }

  async #direct() {
    const { DirectOpenCodeRecall } = await import('./sdk-direct.js')
    const recall = new DirectOpenCodeRecall(this.#options)

    return {
      sync: async (options: SyncOptions) => {
        try {
          return await recall.sync(options)
        } finally {
          recall.close()
        }
      },
      syncLexical: () => {
        try {
          return recall.syncLexical()
        } finally {
          recall.close()
        }
      },
      search: async (query: string, options: RecallSearchOptions) => {
        try {
          return await recall.search(query, options)
        } finally {
          recall.close()
        }
      },
      sessionIndex: (options: RecallSessionIndexOptions) => {
        try {
          return recall.sessionIndex(options)
        } finally {
          recall.close()
        }
      },
      read: (cursor: string, options: RecallReadOptions) => {
        try {
          return recall.read(cursor, options)
        } finally {
          recall.close()
        }
      },
      render: (cursor: string, options: RecallReadOptions) => {
        try {
          return recall.render(cursor, options)
        } finally {
          recall.close()
        }
      },
    }
  }
}

export async function searchHistory(
  query: string,
  options: RecallSearchOptions & OpenCodeRecallOptions = {},
): Promise<RecallSearchResult> {
  if (options.embeddingProvider !== undefined) {
    const { directSearchHistory } = await import('./sdk-direct.js')
    return directSearchHistory(query, options)
  }

  if (options.syncOptions !== undefined) {
    throw new Error(
      'syncOptions require an embeddingProvider because callbacks cannot cross worker process boundaries',
    )
  }

  const raw = await executeNodeWorker(
    PACKAGE_DIR,
    {
      kind: 'search',
      args: searchWorkerArgs(query, options),
      context: { sessionID: options.currentSessionId ?? '' },
    },
    workerSignal(options.workerTimeoutMs),
  )

  return parseWorkerSearchResult(raw)
}

export async function sessionIndex(
  options: RecallSessionIndexOptions & OpenCodeRecallOptions = {},
): Promise<RecallSessionIndexResult> {
  if (options.embeddingProvider !== undefined) {
    const { directSessionIndex } = await import('./sdk-direct.js')
    return directSessionIndex(options)
  }

  const raw = await executeNodeWorker(
    PACKAGE_DIR,
    {
      kind: 'session-index',
      args: sessionIndexWorkerArgs(options),
      context: { sessionID: options.currentSessionId ?? '' },
    },
    workerSignal(options.workerTimeoutMs),
  )

  return parseWorkerSessionIndexResult(raw)
}

export function readHistoryWindow(
  cursor: string,
  options: RecallReadOptions & OpenCodeRecallOptions = {},
): TranscriptWindow {
  const parsed = JSON.parse(
    executeNodeWorkerSync(PACKAGE_DIR, {
      kind: 'read-window',
      args: readWorkerArgs(cursor, options),
    }),
  ) as unknown

  if (isTranscriptWindow(parsed)) {
    return parsed
  }

  throw new Error('Node worker returned invalid transcript window JSON')
}

export function renderHistoryWindow(
  cursor: string,
  options: RecallReadOptions & OpenCodeRecallOptions = {},
): string {
  return executeNodeWorkerSync(PACKAGE_DIR, {
    kind: 'read',
    args: readWorkerArgs(cursor, options),
  })
}

function readWorkerArgs(
  cursor: string,
  options: RecallReadOptions & OpenCodeRecallOptions,
): HistoryReadWorkerArgs {
  return {
    cursor,
    mode: options.mode,
    n: options.limit,
    historyDbPath: options.historyDbPath,
  }
}

function searchWorkerArgs(
  query: string,
  options: RecallSearchOptions & OpenCodeRecallOptions,
): HistorySearchWorkerArgs {
  return {
    q: query,
    n: options.limit ?? DEFAULT_SEARCH_LIMIT,
    maxSearchLimit: Math.max(options.limit ?? DEFAULT_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT),
    directory: options.directory,
    includeCurrentSession: options.includeCurrentSession,
    excludeSessionId: options.excludeSessionId ?? defaultExcludedSessionId(options),
    after: optionalDateArg(options.after),
    before: optionalDateArg(options.before ?? defaultBefore(options)),
    historyDbPath: options.historyDbPath,
    sidecarDbPath: options.sidecarDbPath,
    semantic: options.semantic,
    lexical: options.lexical,
    sync: options.sync,
    format: 'json',
  }
}

function sessionIndexWorkerArgs(
  options: RecallSessionIndexOptions & OpenCodeRecallOptions,
): SessionIndexWorkerArgs {
  return {
    n: options.limit ?? DEFAULT_SESSION_INDEX_LIMIT,
    title: options.title,
    directory: options.directory,
    includeCurrentSession: options.includeCurrentSession,
    excludeSessionId: options.excludeSessionId ?? defaultExcludedSessionId(options),
    after: optionalDateArg(options.after),
    before: optionalDateArg(options.before ?? defaultBefore(options)),
    historyDbPath: options.historyDbPath,
    format: 'json',
  }
}

function parseWorkerSearchResult(value: string): RecallSearchResult {
  const parsed = JSON.parse(value) as unknown

  if (!isWorkerSearchResult(parsed)) {
    throw new Error('Node worker returned invalid SDK search JSON')
  }

  return {
    hits: parsed.hits.map(toSearchHit),
    ...(parsed.sync === undefined ? {} : { sync: parsed.sync }),
  }
}

function parseWorkerSessionIndexResult(value: string): RecallSessionIndexResult {
  const parsed = JSON.parse(value) as unknown

  if (!isWorkerSessionIndexResult(parsed)) {
    throw new Error('Node worker returned invalid SDK session index JSON')
  }

  return {
    sessions: parsed.sessions.map(toSessionIndexEntry),
  }
}

function isHistorySearchResult(value: unknown): value is HistorySearchResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const result = value as Partial<Record<keyof HistorySearchResult, unknown>>
  return (
    typeof result.cursor === 'string' &&
    typeof result.sid === 'string' &&
    (result.messageId === undefined || typeof result.messageId === 'string') &&
    (result.partId === undefined || typeof result.partId === 'string') &&
    typeof result.title === 'string' &&
    typeof result.directory === 'string' &&
    typeof result.time === 'string' &&
    typeof result.role === 'string' &&
    typeof result.text === 'string'
  )
}

function isWorkerSessionIndexResult(value: unknown): value is {
  readonly sessions: readonly WorkerSessionIndexEntry[]
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const result = value as { readonly sessions?: unknown }
  return Array.isArray(result.sessions) && result.sessions.every(isWorkerSessionIndexEntry)
}

interface WorkerSessionIndexEntry {
  readonly cursor: string
  readonly sid: string
  readonly title: string
  readonly directory: string
  readonly updated: string
  readonly firstMessage?: string
  readonly lastMessage?: string
  readonly messages: number
  readonly turns: number
  readonly assistantMessages: number
  readonly toolMessages: number
  readonly textParts: number
  readonly approxContextChars: number
}

function isWorkerSessionIndexEntry(value: unknown): value is WorkerSessionIndexEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const entry = value as Partial<Record<keyof WorkerSessionIndexEntry, unknown>>
  return (
    typeof entry.cursor === 'string' &&
    typeof entry.sid === 'string' &&
    typeof entry.title === 'string' &&
    typeof entry.directory === 'string' &&
    typeof entry.updated === 'string' &&
    (entry.firstMessage === undefined || typeof entry.firstMessage === 'string') &&
    (entry.lastMessage === undefined || typeof entry.lastMessage === 'string') &&
    typeof entry.messages === 'number' &&
    typeof entry.turns === 'number' &&
    typeof entry.assistantMessages === 'number' &&
    typeof entry.toolMessages === 'number' &&
    typeof entry.textParts === 'number' &&
    typeof entry.approxContextChars === 'number'
  )
}

function toSearchHit(result: HistorySearchResult): RecallSearchHit {
  const cursor = safeDecodeCursor(result.cursor)
  const timeCreated = Date.parse(result.time)

  return {
    cursor: result.cursor,
    sessionId: result.sid,
    sessionTitle: result.title,
    directory: result.directory,
    messageId: result.messageId ?? cursor.messageId ?? '',
    partId: result.partId ?? cursor.partId ?? '',
    role: result.role,
    ...(result.score === undefined ? {} : { score: result.score }),
    timeCreated: Number.isFinite(timeCreated) ? timeCreated : 0,
    time: result.time,
    text: result.text,
    ...(result.source === undefined ? {} : { source: result.source }),
  }
}

function toSessionIndexEntry(result: WorkerSessionIndexEntry): RecallSessionIndexEntry {
  const updatedAt = Date.parse(result.updated)
  const firstMessageAt = optionalParsedTime(result.firstMessage)
  const lastMessageAt = optionalParsedTime(result.lastMessage)

  return {
    cursor: result.cursor,
    sessionId: result.sid,
    title: result.title,
    directory: result.directory,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    updated: result.updated,
    ...(firstMessageAt === undefined ? {} : { firstMessageAt, firstMessage: result.firstMessage }),
    ...(lastMessageAt === undefined ? {} : { lastMessageAt, lastMessage: result.lastMessage }),
    messages: result.messages,
    turns: result.turns,
    assistantMessages: result.assistantMessages,
    toolMessages: result.toolMessages,
    textParts: result.textParts,
    approxContextChars: result.approxContextChars,
  }
}

function optionalParsedTime(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function workerSignal(workerTimeoutMs: number | false | undefined): AbortSignal {
  if (workerTimeoutMs === false) {
    return new AbortController().signal
  }

  return AbortSignal.timeout(workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS)
}

function isWorkerSearchResult(value: unknown): value is {
  readonly hits: readonly HistorySearchResult[]
  readonly sync?: SyncResult
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const result = value as { readonly hits?: unknown; readonly sync?: unknown }
  return Array.isArray(result.hits) && result.hits.every(isHistorySearchResult)
}

function safeDecodeCursor(value: string): HistoryCursor {
  try {
    return decodeCursor(value)
  } catch {
    return { version: 1, messageId: value }
  }
}

function isTranscriptWindow(value: unknown): value is TranscriptWindow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const window = value as Partial<Record<keyof TranscriptWindow, unknown>>
  return (
    typeof window.sessionId === 'string' &&
    typeof window.directory === 'string' &&
    typeof window.mode === 'string' &&
    typeof window.startIndex === 'number' &&
    typeof window.endIndex === 'number' &&
    typeof window.anchorIndex === 'number' &&
    typeof window.anchorCursor === 'string' &&
    typeof window.totalMessages === 'number' &&
    Array.isArray(window.messages)
  )
}

function defaultExcludedSessionId(
  options: RecallSearchOptions | RecallSessionIndexOptions,
): string | undefined {
  if (options.includeCurrentSession === true) {
    return undefined
  }

  return options.currentSessionId
}

function defaultBefore(
  options: RecallSearchOptions | RecallSessionIndexOptions,
): Date | number | string | undefined {
  if (options.includeCurrentSession === true || options.currentSessionId === undefined) {
    return undefined
  }

  return Date.now() - DEFAULT_FRESHNESS_EXCLUSION_MS
}

function optionalDateArg(value: Date | number | string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : undefined
  }

  return value.length === 0 ? undefined : value
}
