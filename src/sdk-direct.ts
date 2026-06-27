import { ChatmlRenderer } from './chatml-renderer.js'
import { decodeCursor } from './cursor.js'
import {
  HistoryDatabase,
  type ReadMode,
  type SearchOptions,
  type SearchRow,
  type SessionIndexOptions,
  type SessionIndexRow,
} from './db.js'
import { type EmbeddingProvider, OllamaEmbeddingProvider } from './embedding.js'
import { normalizeWindow } from './normalizer.js'
import { parseReadMode } from './read-mode.js'
import { makeSearchSnippet, rankSearchRows } from './search.js'
import { RecallSidecarIndex, type SyncOptions, type SyncResult } from './sidecar.js'
import type { TranscriptWindow } from './transcript.js'

export type { EmbeddingProvider, OllamaEmbeddingProviderOptions } from './embedding.js'
export { OllamaEmbeddingProvider } from './embedding.js'
export type { SyncOptions, SyncResult } from './sidecar.js'
export type { TranscriptWindow } from './transcript.js'

const DEFAULT_SEARCH_LIMIT = 50
const DEFAULT_SESSION_INDEX_LIMIT = 20
const DEFAULT_READ_LIMIT = 12
const DEFAULT_FRESHNESS_EXCLUSION_MS = 30_000

export interface OpenCodeRecallOptions {
  readonly historyDbPath?: string
  readonly sidecarDbPath?: string
  readonly embeddingProvider?: EmbeddingProvider
}

export interface RecallSearchOptions {
  readonly limit?: number
  readonly after?: Date | number | string
  readonly before?: Date | number | string
  readonly directory?: string
  readonly includeCurrentSession?: boolean
  readonly currentSessionId?: string
  readonly excludeSessionId?: string
  readonly semantic?: boolean
  readonly lexical?: boolean
  readonly sync?: boolean
  readonly syncOptions?: SyncOptions
  readonly workerTimeoutMs?: number | false
}

export interface RecallSearchHit {
  readonly cursor: string
  readonly sessionId: string
  readonly sessionTitle: string
  readonly directory: string
  readonly messageId: string
  readonly partId: string
  readonly role: string
  readonly score?: number
  readonly timeCreated: number
  readonly time: string
  readonly text: string
  readonly source?: SearchRow['source']
}

export interface RecallSessionIndexOptions {
  readonly limit?: number
  readonly title?: string
  readonly after?: Date | number | string
  readonly before?: Date | number | string
  readonly directory?: string
  readonly includeCurrentSession?: boolean
  readonly currentSessionId?: string
  readonly excludeSessionId?: string
  readonly workerTimeoutMs?: number | false
}

export interface RecallSessionIndexEntry {
  readonly cursor: string
  readonly sessionId: string
  readonly title: string
  readonly directory: string
  readonly updatedAt: number
  readonly updated: string
  readonly firstMessageAt?: number
  readonly firstMessage?: string
  readonly lastMessageAt?: number
  readonly lastMessage?: string
  readonly messages: number
  readonly turns: number
  readonly assistantMessages: number
  readonly toolMessages: number
  readonly textParts: number
  readonly approxContextChars: number
}

export interface RecallSessionIndexResult {
  readonly sessions: readonly RecallSessionIndexEntry[]
}

export interface RecallReadOptions {
  readonly mode?: ReadMode
  readonly limit?: number
}

export interface RecallSearchResult {
  readonly hits: readonly RecallSearchHit[]
  readonly sync?: SyncResult
}

export class DirectOpenCodeRecall {
  readonly #history: HistoryDatabase
  readonly #sidecar: RecallSidecarIndex
  readonly #provider: EmbeddingProvider
  readonly #ownsProvider: boolean

  public constructor(options: OpenCodeRecallOptions = {}) {
    this.#history = new HistoryDatabase(options.historyDbPath)
    this.#sidecar = new RecallSidecarIndex(options.sidecarDbPath)
    this.#provider = options.embeddingProvider ?? new OllamaEmbeddingProvider()
    this.#ownsProvider = options.embeddingProvider === undefined
  }

  public close(): void {
    this.#sidecar.close()
    this.#history.close()

    if (this.#ownsProvider && 'close' in this.#provider) {
      const close = this.#provider.close
      if (typeof close === 'function') {
        close.call(this.#provider)
      }
    }
  }

  public async sync(options: SyncOptions = {}): Promise<SyncResult> {
    return this.#sidecar.sync(
      (since) => this.#history.readTextPartsForIndex(since),
      this.#provider,
      () => this.#history.readTextPartIds(),
      options,
    )
  }

  // Build/refresh just the FTS5 lexical index, skipping embeddings.
  // Used when callers opt out of semantic but still want lexical recall.
  public syncLexical(): SyncResult {
    const start = performance.now()
    const result = this.#sidecar.syncLexicalOnly(
      (since) => this.#history.readTextPartsForIndex(since),
      () => this.#history.readTextPartIds(),
    )
    return {
      elapsedMs: performance.now() - start,
      indexedRows: result.indexedRows,
      deletedRows: result.deletedRows,
      lockAcquired: result.lockAcquired,
    }
  }

  public async search(
    query: string,
    options: RecallSearchOptions = {},
  ): Promise<RecallSearchResult> {
    const searchOptions = normalizeSearchOptions(options)

    if (isBlankQuery(query)) {
      return { hits: this.#history.recent(searchOptions).map(toSearchHit) }
    }

    const lexicalEnabled = options.lexical !== false
    const semanticEnabled = options.semantic !== false
    const shouldSync = (semanticEnabled || lexicalEnabled) && options.sync !== false
    const syncResult = shouldSync
      ? semanticEnabled
        ? await this.sync(options.syncOptions)
        : this.syncLexical()
      : undefined
    const lexicalRows = lexicalEnabled ? this.#sidecar.lexicalSearch(query, searchOptions) : []
    const semanticRows = semanticEnabled
      ? await this.#sidecar.search(query, searchOptions, this.#provider)
      : []
    const rows = rankSearchRows(query, [...lexicalRows, ...semanticRows], searchOptions.limit)

    return {
      hits: rows.map(toSearchHit),
      ...(syncResult === undefined ? {} : { sync: syncResult }),
    }
  }

  public sessionIndex(options: RecallSessionIndexOptions = {}): RecallSessionIndexResult {
    return {
      sessions: this.#history
        .sessionIndex(normalizeSessionIndexOptions(options))
        .map(toSessionIndexEntry),
    }
  }

  public read(cursorValue: string, options: RecallReadOptions = {}): TranscriptWindow {
    const cursor = decodeCursor(cursorValue)
    const readOptions = {
      mode: parseReadMode(options.mode),
      limit: options.limit ?? DEFAULT_READ_LIMIT,
    }

    return normalizeWindow(
      cursor.messageId === undefined
        ? this.#history.readWindowForSession(requiredSessionId(cursor.sessionId), readOptions)
        : this.#history.readWindow(cursor.messageId, readOptions),
    )
  }

  public render(cursorValue: string, options: RecallReadOptions = {}): string {
    return new ChatmlRenderer().render(this.read(cursorValue, options))
  }
}

export async function directSearchHistory(
  query: string,
  options: RecallSearchOptions & OpenCodeRecallOptions = {},
): Promise<RecallSearchResult> {
  const recall = new DirectOpenCodeRecall(options)

  try {
    return await recall.search(query, options)
  } finally {
    recall.close()
  }
}

export function directSessionIndex(
  options: RecallSessionIndexOptions & OpenCodeRecallOptions = {},
): RecallSessionIndexResult {
  const recall = new DirectOpenCodeRecall(options)

  try {
    return recall.sessionIndex(options)
  } finally {
    recall.close()
  }
}

export function directReadHistoryWindow(
  cursor: string,
  options: RecallReadOptions & OpenCodeRecallOptions = {},
): TranscriptWindow {
  const recall = new DirectOpenCodeRecall(options)

  try {
    return recall.read(cursor, options)
  } finally {
    recall.close()
  }
}

export function directRenderHistoryWindow(
  cursor: string,
  options: RecallReadOptions & OpenCodeRecallOptions = {},
): string {
  const recall = new DirectOpenCodeRecall(options)

  try {
    return recall.render(cursor, options)
  } finally {
    recall.close()
  }
}

function normalizeSearchOptions(options: RecallSearchOptions): SearchOptions {
  const excluded = excludedSessionId(options)

  return {
    limit: options.limit ?? DEFAULT_SEARCH_LIMIT,
    ...optionalTimestampFilter('after', options.after),
    ...optionalTimestampFilter('before', options.before ?? defaultBefore(options)),
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    ...(excluded === undefined ? {} : { excludeSessionId: excluded }),
  }
}

function normalizeSessionIndexOptions(options: RecallSessionIndexOptions): SessionIndexOptions {
  const excluded = excludedSessionId(options)

  return {
    limit: options.limit ?? DEFAULT_SESSION_INDEX_LIMIT,
    ...optionalTimestampFilter('after', options.after),
    ...optionalTimestampFilter('before', options.before ?? defaultBefore(options)),
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(excluded === undefined ? {} : { excludeSessionId: excluded }),
  }
}

function isBlankQuery(query: string): boolean {
  return query.trim().length === 0
}

function excludedSessionId(
  options: RecallSearchOptions | RecallSessionIndexOptions,
): string | undefined {
  if (options.includeCurrentSession === true) {
    return options.excludeSessionId
  }

  return options.excludeSessionId ?? options.currentSessionId
}

function defaultBefore(
  options: RecallSearchOptions | RecallSessionIndexOptions,
): number | undefined {
  if (options.includeCurrentSession === true || options.currentSessionId === undefined) {
    return undefined
  }

  return Date.now() - DEFAULT_FRESHNESS_EXCLUSION_MS
}

function optionalTimestampFilter(
  name: 'after' | 'before',
  value: Date | number | string | undefined,
) {
  const timestamp = optionalTimestamp(value)

  if (timestamp === undefined) {
    return {}
  }

  return { [name]: timestamp }
}

function optionalTimestamp(value: Date | number | string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }

  if (value instanceof Date) {
    return value.getTime()
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }

  if (value.length === 0) {
    return undefined
  }

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function toSearchHit(row: SearchRow): RecallSearchHit {
  const cursor = row.messageId
  return {
    cursor,
    sessionId: row.sessionId,
    sessionTitle: row.sessionTitle,
    directory: row.directory,
    messageId: row.messageId,
    partId: row.partId,
    role: row.role,
    ...(row.score === undefined ? {} : { score: Number(row.score.toFixed(4)) }),
    timeCreated: row.timeCreated,
    time: new Date(row.timeCreated).toISOString(),
    text: makeSearchSnippet(row.text),
    ...(row.source === undefined ? {} : { source: row.source }),
  }
}

function toSessionIndexEntry(row: SessionIndexRow): RecallSessionIndexEntry {
  return {
    cursor: row.sessionId,
    sessionId: row.sessionId,
    title: row.title,
    directory: row.directory,
    updatedAt: row.updatedAt,
    updated: new Date(row.updatedAt).toISOString(),
    ...(row.firstMessageAt === null
      ? {}
      : {
          firstMessageAt: row.firstMessageAt,
          firstMessage: new Date(row.firstMessageAt).toISOString(),
        }),
    ...(row.lastMessageAt === null
      ? {}
      : {
          lastMessageAt: row.lastMessageAt,
          lastMessage: new Date(row.lastMessageAt).toISOString(),
        }),
    messages: row.messageCount,
    turns: row.turns,
    assistantMessages: row.assistantMessages,
    toolMessages: row.toolMessages,
    textParts: row.textPartCount,
    approxContextChars: row.approxContextChars,
  }
}

function requiredSessionId(value: string | undefined): string {
  if (value !== undefined) {
    return value
  }

  throw new Error('History cursor does not contain a message or session id')
}
