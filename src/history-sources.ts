import { decodeCursor, encodeCursor, qualifyCursor } from './cursor.js'
import {
  HistoryDatabase,
  type ReadOptions,
  type SearchOptions,
  type SearchRow,
  type SessionIndexOptions,
  type SessionIndexRow,
} from './db.js'
import type { EmbeddingProvider } from './embedding.js'
import { normalizeWindow } from './normalizer.js'
import { rankSearchRows } from './search.js'
import { RecallSidecarIndex, type SyncOptions, type SyncResult } from './sidecar.js'
import {
  type ResolvedSource,
  resolveSources,
  type SourceOptions,
  sourceAvailable,
} from './sources.js'
import type { TranscriptWindow } from './transcript.js'

interface OpenSource {
  readonly source: ResolvedSource
  readonly history: HistoryDatabase
  sidecar?: RecallSidecarIndex
}

interface SearchFeatures {
  readonly lexical: boolean
  readonly semantic: boolean
  readonly sync: boolean
  readonly syncOptions?: SyncOptions | undefined
}

/** Federation lives above the single-source index so event cursors and pruning never cross databases. */
export class HistorySources {
  readonly #sources: readonly ResolvedSource[]
  readonly #open = new Map<string, OpenSource>()

  public constructor(options: SourceOptions = {}) {
    // Validate the entire list before opening any writable sidecar.
    this.#sources = resolveSources(options)
  }

  public close(): void {
    for (const entry of this.#open.values()) {
      entry.sidecar?.close()
      entry.history.close()
    }
    this.#open.clear()
  }

  public async sync(provider: EmbeddingProvider, options: SyncOptions = {}): Promise<SyncResult> {
    const results: SyncResult[] = []
    for (const entry of this.#available())
      results.push(await this.#index(entry).syncHistory(entry.history, provider, options))
    return combineSync(results)
  }

  public syncLexical(): SyncResult {
    return combineSync(
      this.#available().map((entry) => this.#index(entry).syncLexicalHistory(entry.history)),
    )
  }

  public async search(
    query: string,
    options: SearchOptions,
    features: SearchFeatures,
    provider?: EmbeddingProvider,
  ): Promise<{ rows: SearchRow[]; sync?: SyncResult }> {
    if (query.trim() === '') return { rows: this.recent(options) }
    const rows: SearchRow[] = []
    const syncResults: SyncResult[] = []
    const available = this.#available()
    // Every source uses the same provider model, so embed the query only once.
    const queryEmbedding = await embedQuery(query, features.semantic, provider, available.length)
    for (const entry of available) {
      if (!(features.lexical || features.semantic)) continue
      const index = this.#index(entry)
      if (features.sync) {
        syncResults.push(
          features.semantic && provider !== undefined
            ? await index.syncHistory(entry.history, provider, features.syncOptions)
            : index.syncLexicalHistory(entry.history),
        )
      }
      rows.push(...this.#searchSource(entry, query, options, features, provider, queryEmbedding))
    }
    return {
      rows: rankSearchRows(query, rows, options.limit),
      ...(features.sync && (features.lexical || features.semantic)
        ? { sync: combineSync(syncResults) }
        : {}),
    }
  }

  public recent(options: SearchOptions): SearchRow[] {
    return this.#available()
      .flatMap((entry) =>
        entry.history
          .recent(scopedOptions(options, entry.source.id))
          .map((row) => this.#provenance(row, entry.source)),
      )
      .sort((a, b) => b.timeCreated - a.timeCreated || a.sessionId.localeCompare(b.sessionId))
      .slice(0, options.limit)
  }

  #searchSource(
    entry: OpenSource,
    query: string,
    options: SearchOptions,
    features: SearchFeatures,
    provider: EmbeddingProvider | undefined,
    queryEmbedding: Float32Array | undefined,
  ): SearchRow[] {
    const index = this.#index(entry)
    const scoped = scopedOptions(options, entry.source.id)
    const lexical = features.lexical ? index.lexicalSearch(query, scoped) : []
    const semantic =
      features.semantic && provider !== undefined
        ? index.searchWithEmbedding(query, scoped, provider.model, queryEmbedding)
        : []
    return [...lexical, ...semantic].map((row) => this.#provenance(row, entry.source))
  }

  public sessionIndex(options: SessionIndexOptions): SessionIndexRow[] {
    return this.#available()
      .flatMap((entry) =>
        entry.history
          .sessionIndex(scopedOptions(options, entry.source.id))
          .map((row) => this.#provenance(row, entry.source)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId))
      .slice(0, options.limit)
  }

  public read(value: string, options: ReadOptions): TranscriptWindow {
    const { entry, cursor } = this.#route(value)
    const rows =
      cursor.messageId === undefined
        ? entry.history.readWindowForSession(cursor.sessionId ?? '', options)
        : entry.history.readWindow(cursor.messageId, options)
    return this.#window(normalizeWindow(rows), entry.source)
  }

  public readSession(value: string): TranscriptWindow {
    const { entry, cursor } = this.#route(value)
    if (cursor.sessionId === undefined || cursor.messageId !== undefined)
      throw new Error('session_save requires a session cursor')
    return this.#window(normalizeWindow(entry.history.readSession(cursor.sessionId)), entry.source)
  }

  #route(value: string) {
    const cursor = decodeCursor(value)
    if (cursor.sourceId !== undefined) {
      const source = this.#sources.find((item) => item.id === cursor.sourceId)
      if (source === undefined) throw new Error(`Unknown Recall source: ${cursor.sourceId}`)
      if (!sourceAvailable(source))
        throw new Error(`Recall source ${source.id} is unavailable: ${source.path}`)
      return { entry: this.#entry(source), cursor }
    }
    const matches = this.#available().filter((entry) => entry.history.containsCursor(cursor))
    if (matches.length > 1)
      throw new Error(
        `Ambiguous history cursor ${value}. Use one of: ${matches.map((entry) => encodeCursor({ ...cursor, sourceId: entry.source.id })).join(', ')}`,
      )
    const matched = matches[0]
    if (matched === undefined)
      throw new Error(`History cursor not found in available sources: ${value}`)
    return { entry: matched, cursor }
  }

  #available(): OpenSource[] {
    // An offline source is not an empty source: never open or prune its sidecar.
    return this.#sources.filter(sourceAvailable).map((source) => this.#entry(source))
  }

  #entry(source: ResolvedSource): OpenSource {
    const existing = this.#open.get(source.id)
    if (existing !== undefined) return existing
    const entry = { source, history: new HistoryDatabase(source.path) }
    this.#open.set(source.id, entry)
    return entry
  }

  #index(entry: OpenSource): RecallSidecarIndex {
    if (entry.sidecar !== undefined) return entry.sidecar
    const index = new RecallSidecarIndex(entry.source.indexPath)
    try {
      index.bindSource(entry.source.path)
    } catch (error) {
      index.close()
      throw error
    }
    entry.sidecar = index
    return index
  }

  #provenance<T extends { readonly sourceId?: string }>(row: T, source: ResolvedSource): T {
    return this.#sources.length > 1 ? { ...row, sourceId: source.id } : row
  }

  #window(window: TranscriptWindow, source: ResolvedSource): TranscriptWindow {
    if (this.#sources.length === 1) return window
    return {
      ...window,
      sourceId: source.id,
      anchorCursor: qualifyCursor(window.anchorCursor, source.id),
      ...(window.previousCursor === undefined
        ? {}
        : { previousCursor: qualifyCursor(window.previousCursor, source.id) }),
      ...(window.nextCursor === undefined
        ? {}
        : { nextCursor: qualifyCursor(window.nextCursor, source.id) }),
      messages: window.messages.map((message) => ({ ...message, sourceId: source.id })),
    }
  }
}

async function embedQuery(
  query: string,
  semantic: boolean,
  provider: EmbeddingProvider | undefined,
  sourceCount: number,
): Promise<Float32Array | undefined> {
  if (!semantic || provider === undefined || sourceCount === 0) return undefined
  const [embedding] = await provider.embed([query])
  return embedding
}

function scopedOptions<T extends SearchOptions>(options: T, sourceId: string): T {
  const excluded = options.excludeSessionId
  if (excluded === undefined || !excluded.includes('::')) return options
  const cursor = decodeCursor(excluded)
  const { excludeSessionId: _excluded, ...rest } = options
  return {
    ...rest,
    ...(cursor.sourceId === sourceId && cursor.sessionId !== undefined
      ? { excludeSessionId: cursor.sessionId }
      : {}),
  } as T
}

function combineSync(results: readonly SyncResult[]): SyncResult {
  return {
    elapsedMs: results.reduce((total, result) => total + result.elapsedMs, 0),
    indexedRows: results.reduce((total, result) => total + result.indexedRows, 0),
    deletedRows: results.reduce((total, result) => total + result.deletedRows, 0),
    lockAcquired: results.every((result) => result.lockAcquired),
  }
}
