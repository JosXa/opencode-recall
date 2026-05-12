import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { IndexSourceRow, SearchOptions, SearchRow } from './db'
import type { EmbeddingProvider } from './embedding'

const INDEX_SCHEMA_VERSION = '1'
const SYNC_OVERLAP_MS = 30 * 60 * 1000
const SYNC_BATCH_SIZE = 8
const MAX_INDEX_TEXT_CHARS = 500
const LOCK_TTL_MS = 60_000
const SIDE_CAR_FILENAME = 'opencode-recall-index.db'
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

export class RecallSidecarIndex {
  readonly #db: Database
  readonly #owner = randomUUID()

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
        content_hash text not null,
        model text not null,
        dims integer not null,
        embedding blob not null
      );
      create index if not exists chunk_time_created_idx on chunk(time_created);
      create index if not exists chunk_source_updated_idx on chunk(source_updated);
      create index if not exists chunk_message_id_idx on chunk(message_id);
    `)
    this.#setMetadata('schema_version', INDEX_SCHEMA_VERSION)
  }

  public close(): void {
    this.#db.close()
  }

  public async sync(
    sourceRows: (since: number | undefined) => readonly IndexSourceRow[],
    provider: EmbeddingProvider,
    sourcePartIds?: () => readonly string[],
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
      const since = lastSynced === undefined ? undefined : Math.max(0, lastSynced - SYNC_OVERLAP_MS)
      const rows = sourceRows(since)
      let maxUpdated = lastSynced ?? 0

      for (let index = 0; index < rows.length; index += SYNC_BATCH_SIZE) {
        const batch = rows.slice(index, index + SYNC_BATCH_SIZE)
        indexedRows += await this.#syncBatch(batch, provider)
        maxUpdated = maxSourceUpdated(batch, maxUpdated)
      }

      if (sourcePartIds !== undefined) {
        deletedRows = this.#deleteStaleChunks(sourcePartIds())
      }

      this.#setMetadata('last_source_updated', String(maxUpdated))
      this.#setMetadata('embedding_model', provider.model)
      return { elapsedMs: performance.now() - start, indexedRows, deletedRows, lockAcquired: true }
    } finally {
      this.#releaseLock()
    }
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
          content_hash as contentHash,
          model,
          dims,
          embedding
        from chunk
        where model = ?
          and (? is null or time_created >= ?)
          and (? is null or time_created <= ?)
          and (? is null or directory = ?)
      `)
      .all(
        provider.model,
        options.after ?? null,
        options.after ?? null,
        options.before ?? null,
        options.before ?? null,
        options.dir ?? null,
        options.dir ?? null,
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
      .slice(0, options.limit)
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
      }))
  }

  public hasIndexedChunks(): boolean {
    const row = this.#db
      .query<{ readonly count: number }, []>('select count(*) as count from chunk')
      .get()
    return (row?.count ?? 0) > 0
  }

  async #syncBatch(batch: readonly IndexSourceRow[], provider: EmbeddingProvider): Promise<number> {
    const pending = batch
      .map((row) => {
        const text = normalizeIndexText(row.text)
        return { row, text, hash: contentHash(row, text, provider.model) }
      })
      .filter(
        (item) => item.text.length > 0 && this.#needsEmbedding(item.row, item.hash, provider.model),
      )

    if (pending.length === 0) {
      return 0
    }

    const embeddings = await provider.embed(pending.map((item) => item.text))
    let indexedRows = 0

    for (const [pendingIndex, embedding] of embeddings.entries()) {
      const item = pending[pendingIndex]

      if (item === undefined) {
        continue
      }

      this.#upsertChunk(item.row, item.text, item.hash, provider.model, embedding)
      indexedRows += 1
    }

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
          number,
          Uint8Array,
        ]
      >(`
        insert into chunk (
          chunk_id, session_id, session_title, directory, message_id, part_id, role,
          time_created, source_updated, text, content_hash, model, dims, embedding
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        hash,
        model,
        embedding.length,
        float32ToBlob(embedding),
      )
  }

  #acquireLock(): boolean {
    const now = Date.now()
    const expiresAt = now + LOCK_TTL_MS
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

    return row?.owner === this.#owner
  }

  #releaseLock(): void {
    this.#db
      .query<unknown, [string]>("delete from sync_lock where name = 'sync' and owner = ?")
      .run(this.#owner)
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
  const { OPENCODE_RECALL_DB_PATH: configured } = process.env

  if (configured !== undefined && configured.length > 0) {
    return configured
  }

  const { HOME: homePath, USERPROFILE: userProfile } = process.env
  const home = homePath ?? userProfile

  if (home === undefined || home.length === 0) {
    throw new Error('Cannot resolve recall sidecar path without HOME or OPENCODE_RECALL_DB_PATH')
  }

  return `${home}/.local/share/opencode/${SIDE_CAR_FILENAME}`
}

function ensureParentDirectory(path: string): void {
  const parent = dirname(path)
  if (!parent || parent === '.') {
    return
  }

  mkdirSync(parent, { recursive: true })
}
