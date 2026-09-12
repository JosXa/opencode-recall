import { ChatmlRenderer } from './chatml-renderer.js'
import { qualifyCursor } from './cursor.js'
import type {
  ReadMode,
  SearchOptions,
  SearchRow,
  SessionIndexOptions,
  SessionIndexRow,
} from './db.js'
import { type EmbeddingProvider, OllamaEmbeddingProvider } from './embedding.js'
import { HistorySources } from './history-sources.js'
import { parseReadMode } from './read-mode.js'
import { makeSearchSnippet } from './search.js'
import type { SyncOptions, SyncResult } from './sidecar.js'
import { currentSessionCursor, type SourceOptions } from './sources.js'
import type { TranscriptWindow } from './transcript.js'

export type { RecallSource } from './config.js'
export type { EmbeddingProvider, OllamaEmbeddingProviderOptions } from './embedding.js'
export { OllamaEmbeddingProvider } from './embedding.js'
export type { SyncOptions, SyncResult } from './sidecar.js'
export type { TranscriptWindow } from './transcript.js'

const DEFAULT_SEARCH_LIMIT = 50
const DEFAULT_SESSION_INDEX_LIMIT = 20
const DEFAULT_READ_LIMIT = 12
const DEFAULT_FRESHNESS_EXCLUSION_MS = 30_000

export interface OpenCodeRecallOptions extends SourceOptions {
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
  readonly sourceId?: string
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
  readonly sourceId?: string
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
  readonly #history: HistorySources
  readonly #provider: EmbeddingProvider
  readonly #ownsProvider: boolean
  readonly #options: SourceOptions

  public constructor(options: OpenCodeRecallOptions = {}) {
    this.#options = options
    this.#history = new HistorySources(options)
    this.#provider = options.embeddingProvider ?? new OllamaEmbeddingProvider()
    this.#ownsProvider = options.embeddingProvider === undefined
  }

  public close(): void {
    this.#history.close()

    if (this.#ownsProvider && 'close' in this.#provider) {
      const close = this.#provider.close
      if (typeof close === 'function') {
        close.call(this.#provider)
      }
    }
  }

  public async sync(options: SyncOptions = {}): Promise<SyncResult> {
    return this.#history.sync(this.#provider, options)
  }

  // Build/refresh just the FTS5 lexical index, skipping embeddings.
  // Used when callers opt out of semantic but still want lexical recall.
  public syncLexical(): SyncResult {
    return this.#history.syncLexical()
  }

  public async search(
    query: string,
    options: RecallSearchOptions = {},
  ): Promise<RecallSearchResult> {
    const searchOptions = normalizeSearchOptions(this.#scopeCurrent(options))

    if (isBlankQuery(query)) {
      return { hits: this.#history.recent(searchOptions).map(toSearchHit) }
    }

    const lexicalEnabled = options.lexical !== false
    const semanticEnabled = options.semantic !== false
    const shouldSync = (semanticEnabled || lexicalEnabled) && options.sync !== false
    const result = await this.#history.search(
      query,
      searchOptions,
      {
        lexical: lexicalEnabled,
        semantic: semanticEnabled,
        sync: shouldSync,
        syncOptions: options.syncOptions,
      },
      this.#provider,
    )

    return {
      hits: result.rows.map(toSearchHit),
      ...(result.sync === undefined ? {} : { sync: result.sync }),
    }
  }

  public sessionIndex(options: RecallSessionIndexOptions = {}): RecallSessionIndexResult {
    return {
      sessions: this.#history
        .sessionIndex(normalizeSessionIndexOptions(this.#scopeCurrent(options)))
        .map(toSessionIndexEntry),
    }
  }

  public read(cursorValue: string, options: RecallReadOptions = {}): TranscriptWindow {
    const readOptions = {
      mode: parseReadMode(options.mode),
      limit: options.limit ?? DEFAULT_READ_LIMIT,
    }

    return this.#history.read(cursorValue, readOptions)
  }

  public render(cursorValue: string, options: RecallReadOptions = {}): string {
    return new ChatmlRenderer().render(this.read(cursorValue, options))
  }

  #scopeCurrent<T extends RecallSearchOptions | RecallSessionIndexOptions>(options: T): T {
    return options.currentSessionId === undefined
      ? options
      : {
          ...options,
          currentSessionId: currentSessionCursor(options.currentSessionId, this.#options),
        }
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
  const cursor = qualifyCursor(row.messageId, row.sourceId)
  return {
    cursor,
    ...(row.sourceId === undefined ? {} : { sourceId: row.sourceId }),
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
    cursor: qualifyCursor(row.sessionId, row.sourceId),
    ...(row.sourceId === undefined ? {} : { sourceId: row.sourceId }),
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
