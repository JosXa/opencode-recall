import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { HistoryDatabase } from '../src/db.js'
import { RecallSidecarIndex } from '../src/sidecar.js'
import { Database } from '../src/sqlite.js'

test('V2 without an event log keeps indexing sessions created after the first sync', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recall-v2-no-events-'))
  const source = new Database(join(root, 'history.db'))
  source.exec(`
    create table session_v2(id text primary key, title text, directory text, time_updated integer);
    create table session_message(id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
    create table event(id text primary key, aggregate_id text, seq integer, type text, data text);
    insert into session_v2 values ('ses_first', 'First', '/first', 1);
    insert into session_message values ('msg_first', 'ses_first', 'user', 1, 1, 1, '{"text":"first needle"}');
  `)
  const history = new HistoryDatabase(join(root, 'history.db'))
  const sidecar = new RecallSidecarIndex(join(root, 'index.db'))
  const provider = {
    model: 'fixture',
    embed(texts: readonly string[]) {
      return Promise.resolve(texts.map(() => new Float32Array([1, 0])))
    },
  }
  try {
    expect(history.readIndexChanges(undefined).mode).toBe('full')
    expect(sidecar.syncLexicalHistory(history).indexedRows).toBe(2)
    expect((await sidecar.syncHistory(history, provider)).indexedRows).toBe(2)
    const later = Date.now()
    source.exec(`
      insert into session_v2 values ('ses_later', 'Later', '/later', ${later});
      insert into session_message values ('msg_later', 'ses_later', 'user', 1, ${later}, ${later}, '{"text":"later needle"}');
    `)
    expect(history.readIndexChanges({ rowId: 0, eventId: '', updatedAt: later - 1 })).toMatchObject({
      mode: 'incremental',
      sessionIds: ['ses_later'],
      cursor: { updatedAt: later },
    })
    sidecar.syncLexicalHistory(history)
    expect(sidecar.lexicalSearch('later', { limit: 5 })[0]?.sessionId).toBe('ses_later')
    expect((await sidecar.syncHistory(history, provider)).indexedRows).toBe(2)
    // Malformed untouched JSON makes accidental whole-history projection fail.
    source.exec("update session_message set data = 'not JSON' where id = 'msg_first'")
    // Message edits move only session_message.time_updated in V2.
    source.exec(
      `update session_message set data = '{"text":"edited needle"}', time_updated = ${later + 1} where id = 'msg_later'`,
    )
    expect((await sidecar.syncHistory(history, provider)).indexedRows).toBe(1)
    expect(sidecar.lexicalSearch('edited', { limit: 5 })[0]?.sessionId).toBe('ses_later')
    source.exec(`
      update session_message set data = '{"text":"first needle"}' where id = 'msg_first';
      delete from session_message where session_id = 'ses_later';
      delete from session_v2 where id = 'ses_later';
    `)
    expect((await sidecar.syncHistory(history, provider)).deletedRows).toBe(2)
    expect(sidecar.lexicalSearch('edited', { limit: 5 })).toEqual([])
  } finally {
    sidecar.close()
    history.close()
    source.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('V2 keeps indexing new sessions when old events remain in the event log', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recall-v2-stale-events-'))
  const source = new Database(join(root, 'history.db'))
  const start = Date.now()
  // V2 persists bus events only on request: early builds left rows behind and
  // later sessions write projections alone.
  source.exec(`
    create table session_v2(id text primary key, title text, directory text, time_updated integer);
    create table session_message(id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
    create table event(id text primary key, aggregate_id text, seq integer, created integer, type text, data text);
    insert into session_v2 values ('ses_early', 'Early', '/early', ${start});
    insert into session_message values ('msg_early', 'ses_early', 'user', 1, ${start}, ${start}, '{"text":"early needle"}');
    insert into event values ('evt_1', 'ses_early', 1, ${start}, 'session.created.1', '{}');
  `)
  const history = new HistoryDatabase(join(root, 'history.db'))
  const sidecar = new RecallSidecarIndex(join(root, 'index.db'))
  const provider = {
    model: 'fixture',
    embed(texts: readonly string[]) {
      return Promise.resolve(texts.map(() => new Float32Array([1, 0])))
    },
  }
  try {
    sidecar.syncLexicalHistory(history)
    await sidecar.syncHistory(history, provider)
    const later = start + 1
    source.exec(`
      insert into session_v2 values ('ses_later', 'Later', '/later', ${later});
      insert into session_message values ('msg_later', 'ses_later', 'user', 1, ${later}, ${later}, '{"text":"later needle"}');
    `)
    sidecar.syncLexicalHistory(history)
    expect(sidecar.lexicalSearch('later', { limit: 5 })[0]?.sessionId).toBe('ses_later')
    expect((await sidecar.syncHistory(history, provider)).indexedRows).toBe(2)
  } finally {
    sidecar.close()
    history.close()
    source.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('V2 events reconcile projected sessions without reading unchanged transcript JSON', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recall-v2-events-'))
  const source = new Database(join(root, 'history.db'))
  source.exec(`
    create table session_v2(id text primary key, title text, directory text, time_updated integer);
    create table session_message(id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
    create index session_message_session_seq_idx on session_message(session_id, seq);
    create table event(id text primary key, aggregate_id text, seq integer, type text, data text);
    insert into session_v2 values ('ses_steady', 'Steady', '/steady', 1), ('ses_changed', NULL, '/changed', 1);
    insert into session_message values
      ('msg_steady', 'ses_steady', 'user', 1, 1, 1, '{"text":"steady text"}'),
      ('msg_first', 'ses_changed', 'user', 1, 100, 1, '{"text":"original text"}'),
      ('msg_second', 'ses_changed', 'assistant', 2, 50, 1, '{"content":[{"type":"text","text":"response"}]}');
    insert into event values ('evt_1', 'ses_steady', 1, 'session.created.1', '{}'), ('evt_2', 'ses_changed', 1, 'session.created.1', '{}');
  `)
  const history = new HistoryDatabase(join(root, 'history.db'))
  const sidecar = new RecallSidecarIndex(join(root, 'index.db'))
  const embedded: string[] = []
  const provider = {
    model: 'fixture',
    embed(texts: readonly string[]) {
      embedded.push(...texts)
      return Promise.resolve(texts.map(() => new Float32Array([1, 0])))
    },
  }
  try {
    expect((await sidecar.syncHistory(history, provider)).indexedRows).toBe(5)
    expect(sidecar.lexicalSearch('original', { limit: 5 })[0]?.sessionTitle).toBe('')
    expect(history.readTextPartsForSessions(['ses_changed']).find(row => row.source === 'session-title')?.messageId).toBe('msg_first')
    const cursor = history.readLatestEventCursor()
    // Malformed untouched JSON makes accidental whole-history projection fail.
    source.exec("update session_message set data = 'not JSON' where id = 'msg_steady'")
    embedded.length = 0
    expect((await sidecar.syncHistory(history, provider)).indexedRows).toBe(0)
    expect(sidecar.syncLexicalHistory(history).indexedRows).toBe(0)
    source.exec(`
      update session_message set data = '{"text":"replacement text"}', time_updated = 2 where id = 'msg_first';
      update session_v2 set title = 'Renamed', directory = '/renamed', time_updated = 2 where id = 'ses_changed';
      insert into event values ('evt_3', 'ses_changed', 2, 'session.next.context.updated.1', '{}');
    `)
    expect(history.readIndexChanges(cursor).sessionIds).toEqual(['ses_changed'])
    expect(sidecar.syncLexicalHistory(history).indexedRows).toBe(3)
    expect((await sidecar.syncHistory(history, provider)).indexedRows).toBe(2)
    expect(embedded).toEqual(['replacement text', 'Title: Renamed Directory: /renamed'])
    expect(sidecar.lexicalSearch('replacement', { limit: 5 })[0]).toMatchObject({ sessionTitle: 'Renamed', directory: '/renamed' })
    source.exec(`
      delete from session_message where session_id = 'ses_changed';
      delete from session_v2 where id = 'ses_changed';
      delete from event where aggregate_id = 'ses_changed';
      insert into event values ('evt_4', 'ses_steady', 2, 'session.status.1', '{}');
      update session_message set data = '{"text":"steady text"}' where id = 'msg_steady';
    `)
    expect((await sidecar.syncHistory(history, provider)).deletedRows).toBe(3)
    expect(sidecar.lexicalSearch('replacement', { limit: 5 })).toEqual([])
  } finally {
    sidecar.close()
    history.close()
    source.close()
    rmSync(root, { recursive: true, force: true })
  }
})
