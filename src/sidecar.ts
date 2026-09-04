import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { loadConfig } from './config.js'
import type {
  HistoryDatabase,
  HistoryEventCursor,
  IndexSourceRow,
  SearchOptions,
  SearchRow,
} from './db.js'
import type { EmbeddingProvider } from './embedding.js'
import { LexicalIndex } from './lexical-index.js'
import { Database } from './sqlite.js'

const INDEX_SCHEMA_VERSION = '2'
const SYNC_OVERLAP_MS = 30 * 60 * 1000
const SYNC_BATCH_SIZE = 64
const MAX_INDEX_TEXT_CHARS = 256
const SEMANTIC_CANDIDATE_LIMIT = 80
const LOCK_TTL_MS = 60_000
const MAX_KEYWORD_BOOST = 0.2
const WHITESPACE_REGEX = /\s+/u

interface ChunkRow extends SearchRow {
  readonly chunkId: string
  readonly sourceUpdated: number
  readonly contentHash: string
  readonly model: string
  readonly dims: number
  readonly embedding: ArrayBuffer | Uint8Array
}

export interface SyncResult {
  readonly elapsedMs: number
  readonly indexedRows: number
  readonly deletedRows: number
  readonly lockAcquired: boolean
}

export interface SyncOptions {
  readonly onProgress?: (progress: {
    readonly processedRows: number
    readonly totalRows: number
    readonly indexedRows: number
  }) => void
}

export class RecallSidecarIndex {
  readonly #db: Database
  readonly #owner = randomUUID()
  readonly #lexical: LexicalIndex
  #syncActive = false

  public constructor(path = defaultSidecarPath()) {
    ensureParentDirectory(path)
    this.#db = new Database(path)
    this.#db.exec('pragma journal_mode = wal')
    this.#db.exec('pragma busy_timeout = 2500')
    this.#db.exec(`
      create table if not exists metadata (
        key text primary key,
        value text not null
      );
      create table if not exists sync_lock (
        name text primary key,
        owner text not null,
        expires_at integer not null
      );
      create table if not exists chunk (
        chunk_id text primary key,
        session_id text not null,
        session_title text not null,
        directory text not null,
        message_id text not null,
        part_id text not null unique,
        role text not null,
          time_created integer not null,
          source_updated integer not null,
          text text not null,
          source text not null default 'text',
          content_hash text not null,
        model text not null,
        dims integer not null,
        embedding blob not null
      );
      create index if not exists chunk_time_created_idx on chunk(time_created);
      create index if not exists chunk_source_updated_idx on chunk(source_updated);
      create index if not exists chunk_message_id_idx on chunk(message_id);
      create index if not exists chunk_session_id_idx on chunk(session_id);
    `)
    this.#ensureSourceColumn()
    this.#setMetadata('schema_version', INDEX_SCHEMA_VERSION)
    this.#lexical = new LexicalIndex(this.#db)
  }

  public close(): void {
    this.#db.close()
  }

  public async sync(
    sourceRows: (since: number | undefined) => readonly IndexSourceRow[],
    provider: EmbeddingProvider,
    sourcePartIds?: () => readonly string[],
    options: SyncOptions = {},
  ): Promise<SyncResult> {
    const start = performance.now()

    if (!this.#acquireLock()) {
      return {
        elapsedMs: performance.now() - start,
        indexedRows: 0,
        deletedRows: 0,
        lockAcquired: false,
      }
    }

    let indexedRows = 0
    let deletedRows = 0

    try {
      const lastSynced = this.#getNumberMetadata('last_source_updated')
      // Force a full lexical backfill when the FTS5 tables are empty on an
      // otherwise-populated sidecar. Happens once per DB after upgrading from
      // the legacy semantic-only schema.
      const needsLexicalBackfill = !this.#lexical.hasIndexedRows() && this.hasIndexedChunks()
      const since =
        lastSynced === undefined || needsLexicalBackfill
          ? undefined
          : Math.max(0, lastSynced - SYNC_OVERLAP_MS)
      const rows = sourceRows(since)
      let maxUpdated = lastSynced ?? 0

      for (let index = 0; index < rows.length; index += SYNC_BATCH_SIZE) {
        const batch = rows.slice(index, index + SYNC_BATCH_SIZE)
        indexedRows += await this.#syncBatch(batch, provider)
        maxUpdated = maxSourceUpdated(batch, maxUpdated)
        // A killed worker must resume after its last completed embedding batch,
        // rather than restarting the entire backlog on the next search.
        this.#setMetadata('last_source_updated', String(maxUpdated))
        options.onProgress?.({
          processedRows: Math.min(index + batch.length, rows.length),
          totalRows: rows.length,
          indexedRows,
        })
      }

      // Rebuilding a session-level FTS document per embedding batch becomes
      // quadratic for large sessions. Apply all lexical changes in one pass.
      this.#lexical.sync(rows, undefined)

      if (sourcePartIds !== undefined) {
        const ids = sourcePartIds()
        deletedRows = this.#deleteStaleChunks(ids)
        this.#lexical.sync([], ids)
      }

      this.#setMetadata('last_source_updated', String(maxUpdated))
      this.#setMetadata('embedding_model', provider.model)
      return { elapsedMs: performance.now() - start, indexedRows, deletedRows, lockAcquired: true }
    } finally {
      this.#releaseLock()
    }
  }

  public async syncHistory(
    history: HistoryDatabase,
    provider: EmbeddingProvider,
    options: SyncOptions = {},
  ): Promise<SyncResult> {
    const start = performance.now()
    if (!this.#acquireLock()) {
      return emptySyncResult(start)
    }

    let indexedRows = 0
    let deletedRows = 0
    let lockLost = false
    const lockHeartbeat = setInterval(() => {
      try {
        lockLost ||= !this.#refreshLock()
      } catch {
        lockLost = true
      }
    }, LOCK_TTL_MS / 3)
    lockHeartbeat.unref()
    try {
      const modelChanged = this.#getMetadata('embedding_model') !== provider.model
      const cursor = modelChanged ? undefined : this.#getEventCursor('semantic')
      const changes = history.readIndexChanges(cursor)
      if (changes.mode === 'legacy') {
        return await this.#syncHistoryLegacy(
          history,
          provider,
          options,
          start,
          modelChanged,
          () => lockLost || !this.#refreshLock(),
        )
      }

      for (let index = 0; index < changes.rows.length; index += SYNC_BATCH_SIZE) {
        const batch = changes.rows.slice(index, index + SYNC_BATCH_SIZE)
        indexedRows += await this.#syncBatch(batch, provider, () => lockLost)
        if (lockLost || !this.#refreshLock()) {
          throw new Error('Recall sidecar synchronization lock expired')
        }
        options.onProgress?.({
          processedRows: Math.min(index + batch.length, changes.rows.length),
          totalRows: changes.rows.length,
          indexedRows,
        })
      }

      const sessionIds =
        changes.mode === 'full'
          ? changes.sessionIds
          : this.#includeDeletedSessionIds(history, changes.sessionIds)
      const partIds = indexablePartIds(changes.rows)
      this.#withOwnedLock(() => {
        deletedRows =
          changes.mode === 'full'
            ? this.#deleteStaleChunks(partIds)
            : this.#deleteStaleChunksForSessions(sessionIds, partIds)
        if (changes.mode === 'full') {
          this.#lexical.sync(changes.rows, partIds)
        } else {
          this.#lexical.reconcileSessions(changes.rows, sessionIds)
        }
        if (changes.cursor !== undefined) {
          this.#setEventCursors(changes.cursor)
        }
        this.#setMetadata('embedding_model', provider.model)
      }, lockLost)
      return { elapsedMs: performance.now() - start, indexedRows, deletedRows, lockAcquired: true }
    } finally {
      clearInterval(lockHeartbeat)
      this.#releaseLock()
    }
  }

  // LexicalIndex owns nested transactions, so the semantic path keeps its sync
  // steps explicit instead of wrapping the whole method in another transaction.
  public syncLexicalOnly(
    sourceRows: (since: number | undefined) => readonly IndexSourceRow[],
    sourcePartIds?: () => readonly string[],
  ): { indexedRows: number; deletedRows: number; lockAcquired: boolean } {
    if (!this.#acquireLock()) {
      return { indexedRows: 0, deletedRows: 0, lockAcquired: false }
    }
    try {
      const lastSynced = this.#getNumberMetadata('last_lexical_synced')
      const needsBackfill = !this.#lexical.hasIndexedRows()
      const since =
        lastSynced === undefined || needsBackfill
          ? undefined
          : Math.max(0, lastSynced - SYNC_OVERLAP_MS)
      const rows = sourceRows(since)
      const { indexedRows } = this.#lexical.sync(rows, undefined)
      let deletedRows = 0
      if (sourcePartIds !== undefined) {
        const ids = sourcePartIds()
        const result = this.#lexical.sync([], ids)
        deletedRows = result.deletedRows
      }
      const maxUpdated = maxSourceUpdated(rows, lastSynced ?? 0)
      this.#setMetadata('last_lexical_synced', String(maxUpdated))
      return { indexedRows, deletedRows, lockAcquired: true }
    } finally {
      this.#releaseLock()
    }
  }

  public syncLexicalHistory(history: HistoryDatabase): SyncResult {
    const start = performance.now()
    if (!this.#acquireLock()) {
      return emptySyncResult(start)
    }

    let lockLost = false
    const lockHeartbeat = setInterval(() => {
      try {
        lockLost ||= !this.#refreshLock()
      } catch {
        lockLost = true
      }
    }, LOCK_TTL_MS / 3)
    lockHeartbeat.unref()
    try {
      const changes = history.readIndexChanges(this.#getEventCursor('lexical'))
      if (changes.mode === 'legacy') {
        const result = this.#syncLexicalHistoryLegacy(
          history,
          () => lockLost || !this.#refreshLock(),
        )
        return { ...result, elapsedMs: performance.now() - start }
      }

      const sessionIds =
        changes.mode === 'full'
          ? changes.sessionIds
          : this.#includeDeletedSessionIds(history, changes.sessionIds)
      const partIds = indexablePartIds(changes.rows)
      const result = this.#withOwnedLock(() => {
        const reconciled =
          changes.mode === 'full'
            ? this.#lexical.sync(changes.rows, partIds)
            : this.#lexical.reconcileSessions(changes.rows, sessionIds)
        if (changes.cursor !== undefined) {
          this.#setEventCursor('lexical', changes.cursor)
        }
        return reconciled
      }, lockLost)
      return { ...result, elapsedMs: performance.now() - start, lockAcquired: true }
    } finally {
      clearInterval(lockHeartbeat)
      this.#releaseLock()
    }
  }

  public lexicalSearch(query: string, options: SearchOptions): SearchRow[] {
    return this.#lexical.search(query, options)
  }

  public hasLexicalIndex(): boolean {
    return this.#lexical.hasIndexedRows()
  }

  public async search(
    query: string,
    options: SearchOptions,
    provider: EmbeddingProvider,
  ): Promise<SearchRow[]> {
    const [queryEmbedding] = await provider.embed([query])

    if (queryEmbedding === undefined) {
      return []
    }

    const rows = this.#db
      .query<
        ChunkRow,
        [
          string,
          number | null,
          number | null,
          number | null,
          number | null,
          string | null,
          string | null,
          string | null,
          string | null,
        ]
      >(`
        select
          chunk_id as chunkId,
          session_id as sessionId,
          session_title as sessionTitle,
          directory,
          message_id as messageId,
          part_id as partId,
          role,
          time_created as timeCreated,
          source_updated as sourceUpdated,
          text,
          source,
          content_hash as contentHash,
          model,
          dims,
          embedding
        from chunk
        where model = ?
          and (? is null or time_created >= ?)
          and (? is null or time_created <= ?)
          and (? is null or directory = ?)
          and (? is null or session_id != ?)
      `)
      .all(
        provider.model,
        options.after ?? null,
        options.after ?? null,
        options.before ?? null,
        options.before ?? null,
        options.directory ?? null,
        options.directory ?? null,
        options.excludeSessionId ?? null,
        options.excludeSessionId ?? null,
      )
    const terms = tokenizeQuery(query)

    return rows
      .map((row) => ({
        row,
        score: combinedScore(queryEmbedding, row, terms),
      }))
      .sort(
        (left, right) => right.score - left.score || right.row.timeCreated - left.row.timeCreated,
      )
      .slice(0, Math.max(options.limit, SEMANTIC_CANDIDATE_LIMIT))
      .map(({ row, score }) => ({
        sessionId: row.sessionId,
        sessionTitle: row.sessionTitle,
        directory: row.directory,
        messageId: row.messageId,
        partId: row.partId,
        role: row.role,
        score,
        timeCreated: row.timeCreated,
        text: row.text,
        source: row.source ?? 'text',
      }))
  }

  public hasIndexedChunks(): boolean {
    const row = this.#db
      .query<{ readonly count: number }, []>('select count(*) as count from chunk')
      .get()
    return (row?.count ?? 0) > 0
  }

  async #syncBatch(
    batch: readonly IndexSourceRow[],
    provider: EmbeddingProvider,
    lockWasLost: () => boolean = () => false,
  ): Promise<number> {
    const candidates = batch
      .map((row) => {
        const text = normalizeIndexText(row.text)
        return { row, text, hash: contentHash(row, text, provider.model) }
      })
      .filter((item) => item.text.length > 0)
    const pending = candidates.filter((item) =>
      this.#needsEmbedding(item.row, item.hash, provider.model),
    )

    if (pending.length === 0) {
      this.#withOwnedLock(() => {
        for (const item of candidates) {
          this.#updateChunkMetadata(item.row, item.text)
        }
      }, lockWasLost())
      return 0
    }

    const embeddings = await provider.embed(pending.map((item) => item.text))
    if (embeddings.length !== pending.length) {
      throw new Error(
        `Embedding provider returned ${embeddings.length} vectors for ${pending.length} texts`,
      )
    }
    let indexedRows = 0

    this.#withOwnedLock(() => {
      for (const item of candidates) {
        if (!pending.includes(item)) {
          this.#updateChunkMetadata(item.row, item.text)
        }
      }
      for (const [pendingIndex, embedding] of embeddings.entries()) {
        const item = pending[pendingIndex]
        if (item === undefined) {
          continue
        }
        this.#upsertChunk(item.row, item.text, item.hash, provider.model, embedding)
        indexedRows += 1
      }
    }, lockWasLost())

    return indexedRows
  }

  #needsEmbedding(row: IndexSourceRow, hash: string, model: string): boolean {
    const existing = this.#db
      .query<{ readonly contentHash: string; readonly model: string }, [string]>(
        'select content_hash as contentHash, model from chunk where part_id = ?',
      )
      .get(row.partId)

    return existing === null || existing.contentHash !== hash || existing.model !== model
  }

  #deleteStaleChunks(sourcePartIds: readonly string[]): number {
    const sourceIds = new Set(sourcePartIds)
    const indexedIds = this.#db
      .query<{ readonly partId: string }, []>('select part_id as partId from chunk')
      .all()
    let deletedRows = 0

    for (const row of indexedIds) {
      if (sourceIds.has(row.partId)) {
        continue
      }

      this.#db.query<unknown, [string]>('delete from chunk where part_id = ?').run(row.partId)
      deletedRows += 1
    }

    return deletedRows
  }

  #deleteStaleChunksForSessions(
    sessionIds: readonly string[],
    sourcePartIds: readonly string[],
  ): number {
    if (sessionIds.length === 0) {
      return 0
    }

    const sourceIds = new Set(sourcePartIds)
    let deletedRows = 0
    for (const batch of batches(sessionIds)) {
      const placeholders = batch.map(() => '?').join(',')
      const indexedIds = this.#db
        .query<{ readonly partId: string }, string[]>(`
          select part_id as partId
          from chunk
          where session_id in (${placeholders})
        `)
        .all(...batch)
      for (const row of indexedIds) {
        if (sourceIds.has(row.partId)) {
          continue
        }
        this.#db.query<unknown, [string]>('delete from chunk where part_id = ?').run(row.partId)
        deletedRows += 1
      }
    }
    return deletedRows
  }

  #includeDeletedSessionIds(
    history: HistoryDatabase,
    changedSessionIds: readonly string[],
  ): string[] {
    const sourceSessionIds = new Set(history.readSessionIds())
    const indexedSessionIds = this.#db
      .query<{ readonly sessionId: string }, []>(
        'select distinct session_id as sessionId from chunk',
      )
      .all()
      .map((row) => row.sessionId)
    indexedSessionIds.push(...this.#lexical.indexedSessionIds())

    const sessionIds = new Set(changedSessionIds)
    for (const sessionId of indexedSessionIds) {
      if (!sourceSessionIds.has(sessionId)) {
        sessionIds.add(sessionId)
      }
    }
    return [...sessionIds]
  }

  #updateChunkMetadata(row: IndexSourceRow, text: string): void {
    this.#db
      .query<
        unknown,
        [string, string, string, string, string, number, number, string, string, string]
      >(`
        update chunk set
          session_id = ?,
          session_title = ?,
          directory = ?,
          message_id = ?,
          role = ?,
          time_created = ?,
          source_updated = ?,
          text = ?,
          source = ?
        where part_id = ?
      `)
      .run(
        row.sessionId,
        row.sessionTitle,
        row.directory,
        row.messageId,
        row.role,
        row.timeCreated,
        row.sourceUpdated,
        text,
        row.source ?? 'text',
        row.partId,
      )
  }

  #upsertChunk(
    row: IndexSourceRow,
    text: string,
    hash: string,
    model: string,
    embedding: Float32Array,
  ): void {
    this.#db
      .query<
        unknown,
        [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          number,
          number,
          string,
          string,
          string,
          string,
          number,
          Uint8Array,
        ]
      >(`
        insert into chunk (
          chunk_id, session_id, session_title, directory, message_id, part_id, role,
          time_created, source_updated, text, source, content_hash, model, dims, embedding
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(part_id) do update set
          chunk_id = excluded.chunk_id,
          session_id = excluded.session_id,
          session_title = excluded.session_title,
          directory = excluded.directory,
          message_id = excluded.message_id,
          role = excluded.role,
          time_created = excluded.time_created,
          source_updated = excluded.source_updated,
          text = excluded.text,
          source = excluded.source,
          content_hash = excluded.content_hash,
          model = excluded.model,
          dims = excluded.dims,
          embedding = excluded.embedding
      `)
      .run(
        hashId(row.partId, model),
        row.sessionId,
        row.sessionTitle,
        row.directory,
        row.messageId,
        row.partId,
        row.role,
        row.timeCreated,
        row.sourceUpdated,
        text,
        row.source ?? 'text',
        hash,
        model,
        embedding.length,
        float32ToBlob(embedding),
      )
  }

  #acquireLock(): boolean {
    if (this.#syncActive) {
      return false
    }
    this.#syncActive = true
    const now = Date.now()
    const expiresAt = now + LOCK_TTL_MS
    try {
      this.#db
        .query<unknown, [string, number, number]>(`
          insert into sync_lock (name, owner, expires_at) values ('sync', ?, ?)
          on conflict(name) do update set owner = excluded.owner, expires_at = excluded.expires_at
          where sync_lock.expires_at < ?
        `)
        .run(this.#owner, expiresAt, now)
      const row = this.#db
        .query<{ readonly owner: string }, []>("select owner from sync_lock where name = 'sync'")
        .get()
      const acquired = row?.owner === this.#owner
      this.#syncActive = acquired
      return acquired
    } catch (error) {
      this.#syncActive = false
      if (isSqliteContention(error)) {
        return false
      }
      throw error
    }
  }

  #releaseLock(): void {
    try {
      this.#db
        .query<unknown, [string]>("delete from sync_lock where name = 'sync' and owner = ?")
        .run(this.#owner)
    } finally {
      this.#syncActive = false
    }
  }

  #refreshLock(): boolean {
    const result = this.#db
      .query<unknown, [number, string]>(
        "update sync_lock set expires_at = ? where name = 'sync' and owner = ?",
      )
      .run(Date.now() + LOCK_TTL_MS, this.#owner)
    return Number(result.changes) === 1
  }

  #withOwnedLock<TResult>(callback: () => TResult, alreadyLost = false): TResult {
    return this.#db.transaction(() => {
      const row = this.#db
        .query<{ readonly owner: string }, []>("select owner from sync_lock where name = 'sync'")
        .get()
      if (alreadyLost || row?.owner !== this.#owner) {
        throw new Error('Recall sidecar synchronization lock expired')
      }
      this.#refreshLock()
      return callback()
    }, true)()
  }

  #ensureSourceColumn(): void {
    const rows = this.#db.query<{ readonly name: string }, []>('pragma table_info(chunk)').all()

    if (rows.some((row) => row.name === 'source')) {
      return
    }

    this.#db.exec("alter table chunk add column source text not null default 'text'")
  }

  #getNumberMetadata(key: string): number | undefined {
    const row = this.#db
      .query<{ readonly value: string }, [string]>(
        'select cast(value as text) as value from metadata where key = ?',
      )
      .get(key)

    if (row === null) {
      return undefined
    }

    const value = parseInt(row.value, 10)
    return Number.isFinite(value) ? value : undefined
  }

  #getMetadata(key: string): string | undefined {
    const row = this.#db
      .query<{ readonly value: string }, [string]>('select value from metadata where key = ?')
      .get(key)
    return row?.value
  }

  #getEventCursor(lane: 'lexical' | 'semantic'): HistoryEventCursor | undefined {
    const rowId = this.#getNumberMetadata(`event_cursor_${lane}_rowid`)
    const eventId = this.#getMetadata(`event_cursor_${lane}_event_id`)
    if (rowId === undefined || eventId === undefined || !Number.isSafeInteger(rowId) || rowId < 0) {
      return undefined
    }
    return { rowId, eventId }
  }

  #setEventCursor(lane: 'lexical' | 'semantic', cursor: HistoryEventCursor): void {
    this.#setMetadata(`event_cursor_${lane}_rowid`, String(cursor.rowId))
    this.#setMetadata(`event_cursor_${lane}_event_id`, cursor.eventId)
  }

  #setEventCursors(cursor: HistoryEventCursor): void {
    this.#db.transaction(() => {
      this.#setEventCursor('lexical', cursor)
      this.#setEventCursor('semantic', cursor)
    })()
  }

  async #syncHistoryLegacy(
    history: HistoryDatabase,
    provider: EmbeddingProvider,
    options: SyncOptions,
    start: number,
    forceFull: boolean,
    lockWasLost: () => boolean,
  ): Promise<SyncResult> {
    const lastSynced = this.#getNumberMetadata('last_source_updated')
    const needsLexicalBackfill = !this.#lexical.hasIndexedRows() && this.hasIndexedChunks()
    const since =
      forceFull || lastSynced === undefined || needsLexicalBackfill
        ? undefined
        : Math.max(0, lastSynced - SYNC_OVERLAP_MS)
    const rows = history.readTextPartsForIndex(since)
    let indexedRows = 0
    let maxUpdated = lastSynced ?? 0
    for (let index = 0; index < rows.length; index += SYNC_BATCH_SIZE) {
      const batch = rows.slice(index, index + SYNC_BATCH_SIZE)
      indexedRows += await this.#syncBatch(batch, provider, lockWasLost)
      this.#withOwnedLock(() => this.#lexical.sync(batch, undefined), lockWasLost())
      maxUpdated = maxSourceUpdated(batch, maxUpdated)
      options.onProgress?.({
        processedRows: Math.min(index + batch.length, rows.length),
        totalRows: rows.length,
        indexedRows,
      })
    }
    const partIds = history.readTextPartIds()
    const deletedRows = this.#withOwnedLock(() => {
      const deleted = this.#deleteStaleChunks(partIds)
      this.#lexical.sync([], partIds)
      this.#setMetadata('last_source_updated', String(maxUpdated))
      this.#setMetadata('embedding_model', provider.model)
      return deleted
    }, lockWasLost())
    return { elapsedMs: performance.now() - start, indexedRows, deletedRows, lockAcquired: true }
  }

  #syncLexicalHistoryLegacy(
    history: HistoryDatabase,
    lockWasLost: () => boolean,
  ): {
    indexedRows: number
    deletedRows: number
    lockAcquired: true
  } {
    const lastSynced = this.#getNumberMetadata('last_lexical_synced')
    const since = lastSynced === undefined ? undefined : Math.max(0, lastSynced - SYNC_OVERLAP_MS)
    const rows = history.readTextPartsForIndex(since)
    const ids = history.readTextPartIds()
    const { indexedRows, deletedRows } = this.#withOwnedLock(() => {
      const indexed = this.#lexical.sync(rows, undefined).indexedRows
      const deleted = this.#lexical.sync([], ids).deletedRows
      this.#setMetadata('last_lexical_synced', String(maxSourceUpdated(rows, lastSynced ?? 0)))
      return { indexedRows: indexed, deletedRows: deleted }
    }, lockWasLost())
    return { indexedRows, deletedRows, lockAcquired: true }
  }

  #setMetadata(key: string, value: string): void {
    this.#db
      .query<unknown, [string, string]>(`
        insert into metadata (key, value) values (?, ?)
        on conflict(key) do update set value = excluded.value
      `)
      .run(key, value)
  }
}

function normalizeIndexText(text: string): string {
  const normalized = text.replaceAll(/\s+/gu, ' ').trim()
  return normalized.length > MAX_INDEX_TEXT_CHARS
    ? normalized.slice(0, MAX_INDEX_TEXT_CHARS)
    : normalized
}

function emptySyncResult(start: number): SyncResult {
  return {
    elapsedMs: performance.now() - start,
    indexedRows: 0,
    deletedRows: 0,
    lockAcquired: false,
  }
}

function isSqliteContention(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = 'code' in error ? String(error.code) : ''
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
}

function indexablePartIds(rows: readonly IndexSourceRow[]): string[] {
  return rows.filter((row) => normalizeIndexText(row.text).length > 0).map((row) => row.partId)
}

const SQLITE_BATCH_SIZE = 500

function batches(values: readonly string[]): readonly string[][] {
  const output: string[][] = []
  for (let index = 0; index < values.length; index += SQLITE_BATCH_SIZE) {
    output.push(values.slice(index, index + SQLITE_BATCH_SIZE))
  }
  return output
}

function contentHash(row: IndexSourceRow, text: string, model: string): string {
  return hashId('chunk-v1', row.partId, row.messageId, model, text)
}

function maxSourceUpdated(rows: readonly IndexSourceRow[], fallback: number): number {
  return rows.reduce((max, row) => Math.max(max, row.sourceUpdated), fallback)
}

function hashId(...parts: readonly string[]): string {
  const hash = createHash('sha256')

  for (const part of parts) {
    hash.update(part)
    hash.update('\0')
  }

  return hash.digest('hex')
}

function float32ToBlob(value: Float32Array): Uint8Array {
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
}

function blobToFloat32(value: ArrayBuffer | Uint8Array): Float32Array {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  const dims = Math.min(left.length, right.length)
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0

  for (let index = 0; index < dims; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude))
}

function combinedScore(
  queryEmbedding: Float32Array,
  row: ChunkRow,
  terms: readonly string[],
): number {
  const semanticScore = cosineSimilarity(queryEmbedding, blobToFloat32(row.embedding))
  const keywordBoost = terms.length === 0 ? 0 : matchedTermCount(row.text, terms) / terms.length
  return semanticScore + Math.min(MAX_KEYWORD_BOOST, keywordBoost * MAX_KEYWORD_BOOST)
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(WHITESPACE_REGEX)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 8)
}

function matchedTermCount(text: string, terms: readonly string[]): number {
  const normalized = text.toLowerCase()
  return terms.filter((term) => normalized.includes(term)).length
}

function defaultSidecarPath(): string {
  return loadConfig().database.indexPath
}

function ensureParentDirectory(path: string): void {
  const parent = dirname(path)
  if (!parent || parent === '.') {
    return
  }

  mkdirSync(parent, { recursive: true })
}
