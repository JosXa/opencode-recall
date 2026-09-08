import { rmSync } from 'node:fs'

import { afterEach, describe, expect, test } from 'vitest'

import { HistoryDatabase } from '../src/db.js'
import type { EmbeddingProvider } from '../src/embedding.js'
import { RecallSidecarIndex } from '../src/sidecar.js'
import { Database } from '../src/sqlite.js'

const temporaryPaths: string[] = []
const fixtures: Fixture[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.sidecar.close()
    fixture.history.close()
    fixture.source.close()
  }
  for (const path of temporaryPaths.splice(0)) {
    removeSqliteFiles(path)
  }
})

describe('persisted event-log synchronization', () => {
  test('reconciles only changed sessions, including metadata changes and deletions', async () => {
    const fixture = createFixture()
    const provider = new RecordingEmbeddingProvider()

    insertSession(fixture.source, 'ses_unchanged', 'Unchanged', 'steady text', 1)
    insertSession(fixture.source, 'ses_changed', 'Original title', 'original text', 2)
    insertSession(fixture.source, 'ses_deleted', 'Delete me', 'obsolete text', 3)
    appendEvent(fixture.source, 'evt_1', 'ses_unchanged', 'session.created.1')
    appendEvent(fixture.source, 'evt_2', 'ses_changed', 'session.created.1')
    appendEvent(fixture.source, 'evt_3', 'ses_deleted', 'session.created.1')
    appendEvent(fixture.source, 'evt_4', 'ses_unchanged', 'session.updated.1')

    const first = await fixture.sidecar.syncHistory(fixture.history, provider)
    expect(first.indexedRows).toBe(6)
    expect(provider.texts).toHaveLength(6)

    provider.texts.length = 0
    fixture.source
      .query('update session set title = ?, directory = ?, time_updated = ? where id = ?')
      .run('Renamed title', '/projects/renamed', 10, 'ses_changed')
    fixture.source
      .query('update part set data = ?, time_updated = ? where id = ?')
      .run(JSON.stringify({ type: 'text', text: 'replacement text' }), 10, 'part_ses_changed')
    fixture.source.query('delete from part where session_id = ?').run('ses_deleted')
    fixture.source.query('delete from message where session_id = ?').run('ses_deleted')
    fixture.source.query('delete from session where id = ?').run('ses_deleted')
    appendEvent(fixture.source, 'evt_5', 'ses_changed', 'session.updated.1')
    appendEvent(fixture.source, 'evt_6', 'ses_changed', 'message.part.updated.1')
    appendEvent(fixture.source, 'evt_7', 'ses_deleted', 'session.deleted.1')
    fixture.source.query('delete from event where aggregate_id = ?').run('ses_deleted')

    const second = await fixture.sidecar.syncHistory(fixture.history, provider)

    expect(second.indexedRows).toBe(2)
    expect(second.deletedRows).toBe(2)
    expect(provider.texts).toEqual([
      'replacement text',
      'Title: Renamed title Directory: /projects/renamed',
    ])
    expect(readChunks(fixture.sidecarPath)).toEqual([
      {
        partId: 'part_ses_changed',
        sessionId: 'ses_changed',
        sessionTitle: 'Renamed title',
        directory: '/projects/renamed',
        text: 'replacement text',
      },
      {
        partId: 'part_ses_unchanged',
        sessionId: 'ses_unchanged',
        sessionTitle: 'Unchanged',
        directory: '/projects/test',
        text: 'steady text',
      },
      {
        partId: 'session-title:ses_changed',
        sessionId: 'ses_changed',
        sessionTitle: 'Renamed title',
        directory: '/projects/renamed',
        text: 'Title: Renamed title Directory: /projects/renamed',
      },
      {
        partId: 'session-title:ses_unchanged',
        sessionId: 'ses_unchanged',
        sessionTitle: 'Unchanged',
        directory: '/projects/test',
        text: 'Title: Unchanged Directory: /projects/test',
      },
    ])
    expect(fixture.sidecar.lexicalSearch('obsolete', { limit: 10 })).toEqual([])
    expect(fixture.sidecar.lexicalSearch('replacement', { limit: 10 })[0]).toMatchObject({
      sessionId: 'ses_changed',
      sessionTitle: 'Renamed title',
      directory: '/projects/renamed',
    })
  })

  test('updates unchanged semantic chunk metadata without re-embedding its text', async () => {
    const fixture = createFixture()
    const provider = new RecordingEmbeddingProvider()
    insertSession(fixture.source, 'ses_metadata', 'Before', 'stable body', 1)
    appendEvent(fixture.source, 'evt_1', 'ses_metadata', 'session.created.1')
    await fixture.sidecar.syncHistory(fixture.history, provider)

    provider.texts.length = 0
    fixture.source
      .query('update session set title = ?, directory = ?, time_updated = ? where id = ?')
      .run('After', '/projects/after', 2, 'ses_metadata')
    appendEvent(fixture.source, 'evt_2', 'ses_metadata', 'session.updated.1')

    const result = await fixture.sidecar.syncHistory(fixture.history, provider)
    const textChunk = readChunks(fixture.sidecarPath).find(
      (row) => row.partId === 'part_ses_metadata',
    )

    expect(result.indexedRows).toBe(1)
    expect(provider.texts).toEqual(['Title: After Directory: /projects/after'])
    expect(textChunk).toMatchObject({
      sessionTitle: 'After',
      directory: '/projects/after',
      text: 'stable body',
    })
  })

  test('keeps lexical and semantic cursors independent', async () => {
    const fixture = createFixture()
    const provider = new RecordingEmbeddingProvider()
    insertSession(fixture.source, 'ses_lanes', 'Lane test', 'first version', 1)
    appendEvent(fixture.source, 'evt_1', 'ses_lanes', 'session.created.1')

    expect(fixture.sidecar.syncLexicalHistory(fixture.history).indexedRows).toBe(2)
    expect((await fixture.sidecar.syncHistory(fixture.history, provider)).indexedRows).toBe(2)

    provider.texts.length = 0
    fixture.source
      .query('update part set data = ?, time_updated = ? where id = ?')
      .run(JSON.stringify({ type: 'text', text: 'second version' }), 2, 'part_ses_lanes')
    appendEvent(fixture.source, 'evt_2', 'ses_lanes', 'message.part.updated.1')
    expect(fixture.sidecar.syncLexicalHistory(fixture.history).indexedRows).toBe(2)

    const semantic = await fixture.sidecar.syncHistory(fixture.history, provider)
    expect(semantic.indexedRows).toBe(1)
    expect(provider.texts).toEqual(['second version'])
  })

  test('replays changes after an embedding failure instead of advancing the cursor', async () => {
    const fixture = createFixture()
    const provider = new RecordingEmbeddingProvider()
    insertSession(fixture.source, 'ses_retry', 'Retry', 'first version', 1)
    appendEvent(fixture.source, 'evt_1', 'ses_retry', 'session.created.1')
    await fixture.sidecar.syncHistory(fixture.history, provider)

    fixture.source
      .query('update part set data = ?, time_updated = ? where id = ?')
      .run(JSON.stringify({ type: 'text', text: 'second version' }), 2, 'part_ses_retry')
    appendEvent(fixture.source, 'evt_2', 'ses_retry', 'message.part.updated.1')

    await expect(
      fixture.sidecar.syncHistory(fixture.history, new FailingEmbeddingProvider()),
    ).rejects.toThrow('embedding failed')
    provider.texts.length = 0
    expect((await fixture.sidecar.syncHistory(fixture.history, provider)).indexedRows).toBe(1)
    expect(provider.texts).toEqual(['second version'])
  })

  test('rejects incomplete embedding batches and replays them on the next sync', async () => {
    const fixture = createFixture()
    insertSession(fixture.source, 'ses_short', 'Short', 'body text', 1)
    appendEvent(fixture.source, 'evt_1', 'ses_short', 'session.created.1')

    await expect(
      fixture.sidecar.syncHistory(fixture.history, new ShortEmbeddingProvider()),
    ).rejects.toThrow('returned 1 vectors for 2 texts')

    const provider = new RecordingEmbeddingProvider()
    expect((await fixture.sidecar.syncHistory(fixture.history, provider)).indexedRows).toBe(2)
    expect(provider.texts).toHaveLength(2)
  })

  test('does not allow overlapping synchronization on one sidecar instance', async () => {
    const fixture = createFixture()
    insertSession(fixture.source, 'ses_overlap', 'Overlap', 'body text', 1)
    appendEvent(fixture.source, 'evt_1', 'ses_overlap', 'session.created.1')
    const provider = new DeferredEmbeddingProvider()

    const first = fixture.sidecar.syncHistory(fixture.history, provider)
    await provider.started
    const second = await fixture.sidecar.syncHistory(fixture.history, new RecordingEmbeddingProvider())
    expect(second.lockAcquired).toBe(false)

    provider.resolve()
    expect((await first).indexedRows).toBe(2)
  })

  test('falls back to a full reconciliation when the persisted cursor identity changes', () => {
    const fixture = createFixture()
    insertSession(fixture.source, 'ses_reset', 'Reset', 'first version', 1)
    appendEvent(fixture.source, 'evt_1', 'ses_reset', 'session.created.1')
    fixture.sidecar.syncLexicalHistory(fixture.history)

    fixture.source
      .query('update part set data = ?, time_updated = ? where id = ?')
      .run(JSON.stringify({ type: 'text', text: 'unlogged replacement' }), 2, 'part_ses_reset')
    fixture.source.query('update event set id = ? where id = ?').run('evt_replaced', 'evt_1')

    const result = fixture.sidecar.syncLexicalHistory(fixture.history)
    expect(result.indexedRows).toBe(2)
    expect(fixture.sidecar.lexicalSearch('replacement', { limit: 5 })[0]?.sessionId).toBe(
      'ses_reset',
    )
  })

  test('does no source transcript scan when no events were appended', () => {
    const fixture = createFixture()
    insertSession(fixture.source, 'ses_idle', 'Idle', 'unchanged text', 1)
    appendEvent(fixture.source, 'evt_1', 'ses_idle', 'session.created.1')
    fixture.sidecar.syncLexicalHistory(fixture.history)

    const result = fixture.sidecar.syncLexicalHistory(fixture.history)
    expect(result).toMatchObject({ indexedRows: 0, deletedRows: 0, lockAcquired: true })
  })

  test('performs one full migration sync for a populated sidecar without an event cursor', () => {
    const fixture = createFixture()
    insertSession(fixture.source, 'ses_migration', 'Migration', 'current text', 1)
    appendEvent(fixture.source, 'evt_1', 'ses_migration', 'session.created.1')
    const rows = fixture.history.readTextPartsForIndex(undefined)
    fixture.sidecar.syncLexicalOnly(
      () => rows,
      () => fixture.history.readTextPartIds(),
    )

    expect(fixture.sidecar.syncLexicalHistory(fixture.history).indexedRows).toBe(2)
    expect(fixture.sidecar.syncLexicalHistory(fixture.history).indexedRows).toBe(0)
  })

  test('backfills an empty lexical index for an eventless populated sidecar', async () => {
    const fixture = createFixture()
    const provider = new RecordingEmbeddingProvider()
    insertSession(fixture.source, 'ses_legacy', 'Legacy', 'historical text', 1)
    fixture.source.exec('drop table event')
    const rows = fixture.history.readTextPartsForIndex(undefined)
    await fixture.sidecar.sync(
      () => rows,
      provider,
      () => fixture.history.readTextPartIds(),
    )

    const sidecarDb = new Database(fixture.sidecarPath)
    sidecarDb.exec(`
      delete from lex_part_fts;
      delete from lex_part_meta;
      delete from lex_session_fts;
      delete from lex_session_meta;
    `)
    sidecarDb.close()

    expect((await fixture.sidecar.syncHistory(fixture.history, provider)).indexedRows).toBe(0)
    expect(fixture.sidecar.lexicalSearch('historical', { limit: 5 })[0]?.sessionId).toBe(
      'ses_legacy',
    )
  })
})

interface Fixture {
  readonly source: Database
  readonly history: HistoryDatabase
  readonly sidecar: RecallSidecarIndex
  readonly sidecarPath: string
}

function createFixture(): Fixture {
  const sourcePath = temporaryPath('source')
  const sidecarPath = temporaryPath('sidecar')
  const source = new Database(sourcePath)
  source.exec(`
    create table session (id text primary key, title text, directory text, time_updated integer);
    create table message (
      id text primary key,
      session_id text,
      data text,
      time_created integer,
      time_updated integer
    );
    create table part (
      id text primary key,
      message_id text,
      session_id text,
      data text,
      time_updated integer
    );
    create index part_session_idx on part(session_id);
    create table event (
      id text primary key,
      aggregate_id text not null,
      seq integer not null,
      type text not null,
      data text not null,
      created integer not null
    );
  `)
  const history = new HistoryDatabase(sourcePath)
  const sidecar = new RecallSidecarIndex(sidecarPath)
  const fixture = { source, history, sidecar, sidecarPath }
  fixtures.push(fixture)
  return fixture
}

function insertSession(
  db: Database,
  sessionId: string,
  title: string,
  text: string,
  timestamp: number,
): void {
  db.query('insert into session values (?, ?, ?, ?)').run(
    sessionId,
    title,
    '/projects/test',
    timestamp,
  )
  db.query('insert into message values (?, ?, ?, ?, ?)').run(
    `msg_${sessionId}`,
    sessionId,
    JSON.stringify({ role: 'user' }),
    timestamp,
    timestamp,
  )
  db.query('insert into part values (?, ?, ?, ?, ?)').run(
    `part_${sessionId}`,
    `msg_${sessionId}`,
    sessionId,
    JSON.stringify({ type: 'text', text }),
    timestamp,
  )
}

function appendEvent(db: Database, id: string, sessionId: string, type: string): void {
  db.query('insert into event values (?, ?, ?, ?, ?, ?)').run(
    id,
    sessionId,
    1,
    type,
    '{}',
    Date.now(),
  )
}

interface StoredChunk {
  readonly partId: string
  readonly sessionId: string
  readonly sessionTitle: string
  readonly directory: string
  readonly text: string
}

function readChunks(path: string): StoredChunk[] {
  const db = new Database(path, { readonly: true })
  try {
    return db
      .query<StoredChunk, []>(`
        select
          part_id as partId,
          session_id as sessionId,
          session_title as sessionTitle,
          directory,
          text
        from chunk
        order by part_id
      `)
      .all()
  } finally {
    db.close()
  }
}

class RecordingEmbeddingProvider implements EmbeddingProvider {
  public readonly model = 'test-model'
  public readonly texts: string[] = []

  public embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    this.texts.push(...texts)
    return Promise.resolve(texts.map(() => new Float32Array([1, 0, 0])))
  }
}

class FailingEmbeddingProvider implements EmbeddingProvider {
  public readonly model = 'test-model'

  public embed(): Promise<readonly Float32Array[]> {
    throw new Error('embedding failed')
  }
}

class ShortEmbeddingProvider implements EmbeddingProvider {
  public readonly model = 'test-model'

  public embed(): Promise<readonly Float32Array[]> {
    return Promise.resolve([new Float32Array([1, 0, 0])])
  }
}

class DeferredEmbeddingProvider implements EmbeddingProvider {
  public readonly model = 'test-model'
  readonly #started: () => void
  readonly #resume: Promise<void>
  readonly #resolve: () => void
  public readonly started: Promise<void>

  public constructor() {
    const started = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    this.started = started.promise
    this.#started = started.resolve
    this.#resume = resume.promise
    this.#resolve = resume.resolve
  }

  public async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    this.#started()
    await this.#resume
    return texts.map(() => new Float32Array([1, 0, 0]))
  }

  public resolve(): void {
    this.#resolve()
  }
}

function temporaryPath(label: string): string {
  const path = `/tmp/opencode-recall-${label}-${crypto.randomUUID()}.db`
  temporaryPaths.push(path)
  return path
}

function removeSqliteFiles(path: string): void {
  rmSync(path, { force: true })
  rmSync(`${path}-shm`, { force: true })
  rmSync(`${path}-wal`, { force: true })
}
