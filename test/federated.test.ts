import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { canonicalPath, defaultIndexPath, loadConfig } from '../src/config.js'
import { decodeCursor } from '../src/cursor.js'
import { HistoryDatabase } from '../src/db.js'
import { DirectOpenCodeRecall } from '../src/sdk-direct.js'
import { OpenCodeRecall } from '../src/sdk.js'
import { resolveSources } from '../src/sources.js'
import { Database } from '../src/sqlite.js'
import { executeWorkerRequest } from '../src/worker-actions.js'

afterEach(() => vi.unstubAllEnvs())

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recall-federated-'))
  const sources = [
    { id: 'v1', path: join(root, 'v1.db'), indexPath: join(root, 'v1-index.db') },
    { id: 'v2', path: join(root, 'v2.db'), indexPath: join(root, 'v2-index.db') },
  ]
  const legacy = new Database(sources[0]!.path)
  const native = new Database(sources[1]!.path)
  legacy.exec(`
    create table session(id text primary key, title text, directory text, time_updated integer);
    create table message(id text primary key, session_id text, data text, time_created integer, time_updated integer);
    create table part(id text primary key, message_id text, session_id text, data text, time_updated integer);
    create index part_session on part(session_id);
    insert into session values ('ses_shared', 'Legacy plan', '/legacy', 100);
    insert into message values ('msg_shared', 'ses_shared', '{"role":"user"}', 100, 100);
    insert into part values ('msg_shared:00000000', 'msg_shared', 'ses_shared', '{"type":"text","text":"cobalt legacy original"}', 100);
  `)
  native.exec(`
    create table session_v2(id text primary key, title text, directory text, time_updated integer);
    create table session_message(id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
    create index session_message_session_seq_idx on session_message(session_id, seq);
    insert into session_v2 values ('ses_shared', 'Native plan', '/native', 300);
    insert into session_message values
      ('msg_shared', 'ses_shared', 'user', 1, 300, 300, '{"text":"cobalt native original"}'),
      ('msg_second', 'ses_shared', 'assistant', 2, 200, 300, '{"content":[{"type":"text","text":"cobalt native response"}]}');
  `)
  for (const db of [legacy, native]) db.exec(`
    create table event(id text primary key, aggregate_id text, type text);
    insert into event values ('evt_initial', 'ses_shared', 'session.next.created.1');
  `)
  const embedded: string[] = []
  const provider = { model: 'fixture', embed(texts: readonly string[]) {
    embedded.push(...texts)
    return Promise.resolve(texts.map(() => new Float32Array([1, 0])))
  } }
  return { root, sources, legacy, native, embedded, provider, cleanup() {
    legacy.close(); native.close(); rmSync(root, { recursive: true, force: true })
  } }
}

describe('federated history', () => {
  test('session index bounds metric reads before parsing unrelated history', async () => {
    const f = fixture()
    const recall = new OpenCodeRecall({ sources: f.sources })
    try {
      // Invalid JSON makes an accidental corpus-wide metric scan fail deterministically.
      f.legacy.exec(`
        -- Migrated databases can contain both schemas, producing UNION views.
        create table session_v2(id text primary key, title text, directory text, time_updated integer);
        create table session_message(id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
        create index message_session on message(session_id);
        with recursive n(x) as (values(1) union all select x+1 from n where x<2000)
        insert into session select 'ses_old'||x, 'Old', '/old', 1 from n;
        insert into message select 'msg_'||id, id, 'invalid JSON', 1, 1 from session where directory='/old';
        insert into part select 'part_'||id, id, session_id, 'invalid JSON', 1 from message where time_created=1;
      `)
      f.native.exec(`
        with recursive n(x) as (values(1) union all select x+1 from n where x<2000)
        insert into session_v2 select 'ses_old'||x, 'Old', '/old', 1 from n;
        insert into session_message select 'msg_'||id, id, 'user', 1, 1, 1, 'invalid JSON' from session_v2 where directory='/old';
      `)
      const newest = await recall.sessionIndex({ limit: 1, includeCurrentSession: true })
      expect(newest.sessions).toMatchObject([{ cursor: 'v2::ses_shared', messages: 2, textParts: 2 }])
      const filtered = await recall.sessionIndex({ limit: 1, directory: '/legacy', includeCurrentSession: true })
      expect(filtered.sessions).toMatchObject([{ cursor: 'v1::ses_shared', messages: 1, textParts: 1 }])
      // Eventless timestamp sync must not expand unrelated mixed-schema rows either.
      for (const source of f.sources) {
        const history = new HistoryDatabase(source.path)
        try {
          expect(history.readTextPartsForIndex(100).every(row => row.sessionId === 'ses_shared')).toBe(true)
          expect(history.readSessionTitleRowsForIndex(100)).toHaveLength(1)
          expect(history.readTextPartsForSessions(['ses_shared']).length).toBe(source.id === 'v1' ? 2 : 3)
        } finally { history.close() }
      }
    } finally { recall.close(); f.cleanup() }
  })

  test('ranks globally without collapsing same IDs and routes reads, navigation and saved sessions', async () => {
    const f = fixture()
    const recall = new OpenCodeRecall({ sources: f.sources, embeddingProvider: f.provider })
    try {
      const result = await recall.search('cobalt', { lexical: true, semantic: true })
      expect(result.hits.map(hit => hit.sourceId).sort()).toEqual(['v1', 'v2', 'v2'])
      expect(f.embedded.filter(text => text === 'cobalt')).toHaveLength(1)
      f.embedded.length = 0
      await recall.search('cobalt', { lexical: true, semantic: true, sync: false })
      expect(f.embedded).toEqual(['cobalt'])
      expect(result.hits.filter(hit => hit.messageId === 'msg_shared').map(hit => hit.cursor).sort()).toEqual(['v1::msg_shared', 'v2::msg_shared'])
      expect((await recall.search('cobalt', { semantic: false, limit: 1 })).hits).toHaveLength(1)
      expect((await recall.search('', { limit: 1 })).hits[0]?.sourceId).toBe('v2')
      expect((await recall.sessionIndex()).sessions.map(row => row.cursor)).toEqual(['v2::ses_shared', 'v1::ses_shared'])
      expect((await recall.search('cobalt', { semantic: false, directory: '/legacy' })).hits.map(row => row.sourceId)).toEqual(['v1'])
      expect((await recall.search('cobalt', { semantic: false, excludeSessionId: 'v1::ses_shared' })).hits.every(row => row.sourceId === 'v2')).toBe(true)
      expect(() => recall.read('msg_shared')).toThrow('v1::msg_shared, v2::msg_shared')
      expect(() => recall.read('ses_shared')).toThrow('v1::ses_shared, v2::ses_shared')
      const window = recall.read('v2::ses_shared', { mode: 'head', limit: 1 })
      expect(window.messages[0]?.id).toBe('msg_shared')
      expect(window.nextCursor).toBe('v2::msg_shared')
      expect(recall.read(window.nextCursor!, { mode: 'next', limit: 1 }).messages[0]?.id).toBe('msg_second')
      expect(recall.read('msg_second').sourceId).toBe('v2')
      expect(recall.render('v1::msg_shared')).toContain('id="v1::msg_shared"')
      expect(decodeCursor(window.anchorCursor)).toMatchObject({ sourceId: 'v2', messageId: 'msg_shared' })
      await executeWorkerRequest({ kind: 'session-save', args: { sources: f.sources, cursor: 'v1::ses_shared', path: 'saved.jsonl', format: 'jsonl' }, context: { directory: f.root } })
      expect(readFileSync(join(f.root, 'saved.jsonl'), 'utf8')).toContain('cobalt legacy original')
      expect(readFileSync(join(f.root, 'saved.jsonl'), 'utf8')).toContain('"sourceId":"v1"')
      expect(readFileSync(join(f.root, 'saved.jsonl'), 'utf8')).not.toContain('native')
    } finally { recall.close(); f.cleanup() }
  })

  test('keeps event cursors, reused embeddings and deletions independent', async () => {
    const f = fixture()
    const recall = new DirectOpenCodeRecall({ sources: f.sources, embeddingProvider: f.provider })
    try {
      expect((await recall.sync()).indexedRows).toBe(5)
      f.embedded.length = 0
      expect((await recall.sync()).indexedRows).toBe(0)
      f.native.exec(`update session_message set data='{"text":"cobalt native changed"}',time_updated=400 where id='msg_shared'; insert into event values ('evt_changed', 'ses_shared', 'session.next.context.updated.1')`)
      expect(recall.syncLexical().indexedRows).toBe(3)
      expect((await recall.sync()).indexedRows).toBe(1)
      expect(f.embedded).toEqual(['cobalt native changed'])
      f.legacy.exec(`delete from part; delete from message; delete from session; insert into event values ('evt_deleted', 'ses_shared', 'session.deleted')`)
      expect((await recall.sync()).deletedRows).toBe(2)
      const hits = await recall.search('cobalt', { semantic: false })
      expect(hits.hits).toHaveLength(1)
      expect(hits.hits.every(hit => hit.sourceId === 'v2')).toBe(true)
    } finally { recall.close(); f.cleanup() }
  })

  test('skips unavailable sources without opening or pruning their indexes', async () => {
    const f = fixture()
    const recall = new DirectOpenCodeRecall({ sources: f.sources, embeddingProvider: f.provider })
    try {
      await recall.sync()
      recall.close()
      const before = readFileSync(f.sources[1]!.indexPath)
      renameSync(f.sources[1]!.path, `${f.sources[1]!.path}.offline`)
      const offline = new DirectOpenCodeRecall({ sources: f.sources, embeddingProvider: f.provider })
      try {
        expect((await offline.search('cobalt', { semantic: false })).hits.map(hit => hit.sourceId)).toEqual(['v1'])
        expect(() => offline.read('v2::ses_shared')).toThrow('Recall source v2 is unavailable')
        expect(readFileSync(f.sources[1]!.indexPath)).toEqual(before)
      } finally { offline.close() }
      renameSync(`${f.sources[1]!.path}.offline`, f.sources[1]!.path)
    } finally { recall.close(); f.cleanup() }
  })

  test('rejects conflicting paths, symlink aliases and cross-process ownership before pruning', async () => {
    const f = fixture()
    try {
      const shared = f.sources.map(source => ({ ...source, indexPath: f.sources[0]!.indexPath }))
      expect(() => new DirectOpenCodeRecall({ sources: shared })).toThrow('cannot share a sidecar')
      expect(existsSync(f.sources[0]!.indexPath)).toBe(false)
      expect(() => resolveSources({ sources: [{ ...f.sources[0]!, indexPath: f.sources[1]!.path }, f.sources[1]!] })).toThrow('aliases a source')
      symlinkSync(f.sources[0]!.path, join(f.root, 'alias.db'))
      expect(() => resolveSources({ sources: [f.sources[0]!, { ...f.sources[1]!, path: join(f.root, 'alias.db') }] })).toThrow('Duplicate Recall source database')
      const owner = new OpenCodeRecall({ sources: [f.sources[0]!] })
      await owner.search('cobalt', { semantic: false })
      const impostor = new OpenCodeRecall({ sources: [{ ...f.sources[1]!, indexPath: f.sources[0]!.indexPath }] })
      await expect(impostor.search('cobalt', { semantic: false })).rejects.toThrow('belongs to a different source')
      expect((await owner.search('cobalt', { semantic: false })).hits[0]?.text).toContain('legacy original')
    } finally { f.cleanup() }
  })

  test('parallel fresh workers share each source sidecar coherently', async () => {
    const f = fixture()
    try {
      const recall = new OpenCodeRecall({ sources: f.sources })
      await Promise.all(Array.from({ length: 4 }, () => recall.search('cobalt', { semantic: false })))
      const final = await recall.search('cobalt', { semantic: false })
      expect(final.sync?.indexedRows).toBe(0)
      expect(final.hits.map(hit => hit.sourceId).sort()).toEqual(['v1', 'v2'])
      const copies = await recall.search('original', { semantic: false })
      expect(copies.hits.map(hit => hit.cursor).sort()).toEqual(['v1::msg_shared', 'v2::msg_shared'])
    } finally { f.cleanup() }
  })

  test('configuration and explicit environment overrides isolate sources and default indexes', async () => {
    const f = fixture()
    try {
      vi.stubEnv('OPENCODE_CONFIG_DIR', f.root)
      vi.stubEnv('OPENCODE_DB_PATH', '')
      vi.stubEnv('OPENCODE_RECALL_DB_PATH', '')
      writeFileSync(join(f.root, 'recall.jsonc'), JSON.stringify({ database: { sources: f.sources } }))
      expect(resolveSources().map(source => source.id)).toEqual(['v1', 'v2'])
      const recall = new OpenCodeRecall()
      expect((await recall.search('cobalt', { semantic: false })).hits.map(hit => hit.sourceId).sort()).toEqual(['v1', 'v2'])
      vi.stubEnv('OPENCODE_DB', f.sources[1]!.path)
      const filtered = await recall.search('cobalt', { semantic: false, currentSessionId: 'ses_shared' })
      expect(filtered.hits.map(hit => hit.sourceId)).toEqual(['v1'])
      vi.stubEnv('OPENCODE_DB_PATH', f.sources[0]!.path)
      expect(loadConfig().database.sources).toBeUndefined()
      expect(resolveSources()).toHaveLength(1)
      expect(resolveSources()[0]?.path).toBe(canonicalPath(f.sources[0]!.path))
      expect(defaultIndexPath(f.sources[0]!.path)).not.toBe(defaultIndexPath(f.sources[1]!.path))
      vi.stubEnv('OPENCODE_DB_PATH', '')
      vi.stubEnv('OPENCODE_RECALL_DB_PATH', join(f.root, 'isolated.db'))
      expect(resolveSources()).toHaveLength(1)
    } finally { f.cleanup() }
  })
})
