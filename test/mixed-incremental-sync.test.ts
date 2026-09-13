import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { HistoryDatabase } from '../src/db.js'
import { installHistorySchema } from '../src/history-schema.js'
import { Database } from '../src/sqlite.js'

test.each([false, true])('mixed history scopes incremental transcript reads (native rows: %s)', (nativeRows) => {
  const root = mkdtempSync(join(tmpdir(), 'recall-mixed-events-'))
  const path = join(root, 'history.db')
  const source = new Database(path)
  source.exec(`
    create table session(id text primary key, title text, directory text, time_updated integer);
    create table message(id text primary key, session_id text, data text, time_created integer, time_updated integer);
    create index message_session_idx on message(session_id, time_created, id);
    create table part(id text primary key, message_id text, session_id text, data text, time_updated integer);
    create index part_session_idx on part(session_id);
    create table session_v2(id text primary key, title text, directory text, time_updated integer);
    create table session_message(id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
    create index native_session_idx on session_message(session_id, seq);
    create table event(id text primary key, aggregate_id text, type text);
    insert into session values ('ses_changed', 'Legacy', '/legacy', 1), ('ses_steady', 'Steady', '/steady', 1);
    insert into message values ('msg_changed', 'ses_changed', '{"role":"user"}', 1, 1), ('msg_steady', 'ses_steady', '{"role":"user"}', 1, 1);
    insert into part values ('prt_changed', 'msg_changed', 'ses_changed', '{"type":"text","text":"legacy replacement"}', 1), ('prt_steady', 'msg_steady', 'ses_steady', 'invalid untouched JSON', 1);
    insert into event values ('evt_1', 'ses_steady', 'session.created.1'), ('evt_2', 'ses_changed', 'message.updated.1');
  `)
  if (nativeRows) source.exec(`
    insert into session_v2 values ('ses_changed', 'Native', '/native', 2), ('ses_native_steady', 'Steady native', '/steady', 1);
    insert into session_message values ('msg_native', 'ses_changed', 'user', 1, 2, 2, '{"text":"native replacement"}'), ('msg_native_steady', 'ses_native_steady', 'user', 1, 1, 1, 'invalid untouched JSON');
  `)
  const history = new HistoryDatabase(path)
  const planDb = new Database(path, { readonly: true })
  installHistorySchema(planDb)
  const queries = vi.spyOn(Database.prototype, 'query')
  try {
    const result = history.readIndexChanges({ rowId: 1, eventId: 'evt_1' })
    expect(result.mode).toBe('incremental')
    expect(result.sessionIds).toEqual(['ses_changed'])
    expect(result.rows.map(row => row.text)).toEqual([
      nativeRows ? 'native replacement' : 'legacy replacement',
      nativeRows ? 'Title: Native\nDirectory: /native' : 'Title: Legacy\nDirectory: /legacy',
    ])
    const transcriptQueries = queries.mock.calls.map(([sql]) => sql).filter(sql => sql.includes('as sourceUpdated'))
    queries.mockRestore()
    expect(transcriptQueries).toHaveLength(2)
    for (const sql of transcriptQueries) {
      const params = Array.from(sql.matchAll(/\?/g), () => 'ses_changed')
      const plan = planDb.query<{ detail: string }>(`explain query plan ${sql}`).all(...params).map(row => row.detail)
      // A global message materialization need not parse JSON, so also check its
      // plan. Timing assertions would miss this regression on tiny fixtures.
      expect(plan).not.toEqual(expect.arrayContaining([expect.stringMatching(/SCAN main\.(?:part|message|session_message)\b/)]))
      expect(plan).toEqual(expect.arrayContaining([expect.stringMatching(/SEARCH main\.message .*session_id=/)]))
    }
  } finally {
    queries.mockRestore()
    planDb.close()
    history.close()
    source.close()
    rmSync(root, { recursive: true, force: true })
  }
})
