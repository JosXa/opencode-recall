import { ChatmlRenderer } from './chatml-renderer'
import { decodeCursor } from './cursor'
import { HistoryDatabase, type ReadMode, type SearchOptions, type SearchRow } from './db'
import { type EmbeddingProvider, OllamaEmbeddingProvider } from './embedding'
import { normalizeWindow } from './normalizer'
import { parseReadMode } from './read-mode'
import { rankSearchRows } from './search'
import { RecallSidecarIndex, type SyncOptions, type SyncResult } from './sidecar'
import type { TranscriptWindow } from './transcript'

export type { EmbeddingProvider, OllamaEmbeddingProviderOptions } from './embedding'
export { OllamaEmbeddingProvider } from './embedding'
export type { SyncOptions, SyncResult } from './sidecar'
export type { TranscriptWindow } from './transcript'

const DEFAULT_SEARCH_LIMIT = 50
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

export interface RecallReadOptions {
  readonly mode?: ReadMode
  readonly limit?: number
}

export interface RecallSearchResult {
  readonly hits: readonly RecallSearchHit[]
  readonly sync?: SyncResult
}

export class OpenCodeRecall {
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

  public async search(
    query: string,
    options: RecallSearchOptions = {},
  ): Promise<RecallSearchResult> {
    const searchOptions = normalizeSearchOptions(options)
    const lexicalEnabled = options.lexical !== false
    const semanticEnabled = options.semantic !== false
    const syncResult =
      semanticEnabled && options.sync !== false ? await this.sync(options.syncOptions) : undefined
    const lexicalRows = lexicalEnabled ? this.#history.lexicalSearch(query, searchOptions) : []
    const semanticRows = semanticEnabled
      ? await this.#sidecar.search(query, searchOptions, this.#provider)
      : []
    const rows = rankSearchRows(query, [...lexicalRows, ...semanticRows], searchOptions.limit)

    return {
      hits: rows.map(toSearchHit),
      ...(syncResult === undefined ? {} : { sync: syncResult }),
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

export async function searchHistory(
  query: string,
  options: RecallSearchOptions & OpenCodeRecallOptions = {},
): Promise<RecallSearchResult> {
  const recall = new OpenCodeRecall(options)

  try {
    return await recall.search(query, options)
  } finally {
    recall.close()
  }
}

export function readHistoryWindow(
  cursor: string,
  options: RecallReadOptions & OpenCodeRecallOptions = {},
): TranscriptWindow {
  const recall = new OpenCodeRecall(options)

  try {
    return recall.read(cursor, options)
  } finally {
    recall.close()
  }
}

export function renderHistoryWindow(
  cursor: string,
  options: RecallReadOptions & OpenCodeRecallOptions = {},
): string {
  const recall = new OpenCodeRecall(options)

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

function excludedSessionId(options: RecallSearchOptions): string | undefined {
  if (options.includeCurrentSession === true) {
    return options.excludeSessionId
  }

  return options.excludeSessionId ?? options.currentSessionId
}

function defaultBefore(options: RecallSearchOptions): number | undefined {
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
    text: row.text,
    ...(row.source === undefined ? {} : { source: row.source }),
  }
}

function requiredSessionId(value: string | undefined): string {
  if (value !== undefined) {
    return value
  }

  throw new Error('History cursor does not contain a message or session id')
}
