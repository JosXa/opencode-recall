import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { HistoryDatabase } from '../src/db.js'
import { Database } from '../src/sqlite.js'

test('reading a window evaluates only the selected session', () => {
  const root = mkdtempSync(join(tmpdir(), 'recall-read-scope-'))
  const path = join(root, 'history.db')
  const writer = new Database(path)
  writer.exec(`
    create table session(id text primary key, title text, directory text, time_updated integer);
    create table message(id text primary key, session_id text, data text, time_created integer, time_updated integer);
    create table part(id text primary key, message_id text, session_id text, data text, time_updated integer);
    insert into session values ('ses_target', 'Target', '/target', 3), ('ses_unrelated', 'Unrelated', '/other', 4);
    insert into message values
      ('msg_first', 'ses_target', '{"role":"user"}', 1, 1),
      ('msg_anchor', 'ses_target', '{"role":"assistant"}', 2, 2),
      ('msg_last', 'ses_target', '{"role":"user"}', 3, 3),
      ('msg_other', 'ses_unrelated', 'must not be evaluated as JSON', 4, 4);
  `)
  const history = new HistoryDatabase(path)
  try {
    const window = history.readWindow('msg_anchor', { mode: 'around', limit: 3 })
    expect(window.anchorIndex).toBe(2)
    expect(window.totalMessages).toBe(3)
    expect(window.messages.map((message) => message.messageId)).toEqual([
      'msg_first',
      'msg_anchor',
      'msg_last',
    ])
    expect(history.readWindowForSession('ses_target', { mode: 'tail', limit: 1 }).messages[0]?.messageId).toBe('msg_last')
    expect(() => history.readWindow('msg_missing', { mode: 'around', limit: 3 })).toThrow('missing message')
  } finally {
    history.close()
    writer.close()
    rmSync(root, { recursive: true, force: true })
  }
})
