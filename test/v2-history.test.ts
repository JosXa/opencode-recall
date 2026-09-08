import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { HistoryDatabase } from '../src/db.js'
import { normalizeWindow } from '../src/normalizer.js'
import { Database } from '../src/sqlite.js'

describe('native V2 history projection', () => {
  test('orders by durable sequence, preserves multipart tools/files, filters sessions and refreshes live rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-v2-'))
    const path = join(root, 'history.db')
    const writer = new Database(path)
    writer.exec(`
      create table session_v2(id text primary key, title text, directory text, time_updated integer);
      create table session_message(id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
      insert into session_v2 values('ses_parent', 'Parent', '/project', 100), ('ses_child', 'Child', '/child', 200);
    `)
    const insert = (id: string, session: string, type: string, seq: number, data: unknown) => writer.query('insert into session_message values(?,?,?,?,?,?,?)').run(id, session, type, seq, 100 - seq, 100, JSON.stringify(data))
    insert('msg_z', 'ses_parent', 'user', 1, { text: 'needle question', files: [{ name: 'sample.png', mime: 'image/png', data: 'SECRET_BASE64' }] })
    insert('msg_a', 'ses_parent', 'assistant', 2, { content: [
      { type: 'text', text: 'before' },
      { type: 'tool', id: 'call_example', name: 'read', state: { status: 'completed', input: { path: 'sample' }, content: [{ type: 'text', text: 'tool result' }] } },
      { type: 'text', text: 'after' },
      { type: 'tool', id: 'call_failed', name: 'shell', state: { status: 'error', input: {}, error: { message: 'intentional failure' } } },
    ] })
    insert('msg_child', 'ses_child', 'user', 1, { text: 'needle child' })
    const db = new HistoryDatabase(path)
    try {
      const window = normalizeWindow(db.readSession('ses_parent'))
      expect(window.messages.map(m => m.id)).toEqual(['msg_z', 'msg_a'])
      expect(window.messages[0]?.parts[1]).toMatchObject({ type: 'file', filename: 'sample.png', mime: 'image/png', omitted: true })
      expect(JSON.stringify(window)).not.toContain('SECRET_BASE64')
      expect(window.messages[1]?.parts.map(p => p.type)).toEqual(['text', 'tool', 'text', 'tool'])
      expect(window.messages[1]?.parts[1]).toMatchObject({ type: 'tool', callId: 'call_example', output: 'tool result', status: 'completed' })
      expect(window.messages[1]?.parts[3]).toMatchObject({ status: 'failed', output: '{"message":"intentional failure"}' })
      expect(db.readWindow('msg_z', { mode: 'next', limit: 1 }).messages.map(m => m.messageId)).toEqual(['msg_a'])
      expect(db.readWindow('msg_a', { mode: 'prev', limit: 1 }).messages.map(m => m.messageId)).toEqual(['msg_z'])
      expect(db.lexicalSearch('needle', { limit: 10, excludeSessionId: 'ses_parent' }).map(r => r.sessionId)).toEqual(['ses_child'])
      expect(db.recent({ limit: 10, directory: '/child' }).map(r => r.messageId)).toEqual(['msg_child'])
      expect(db.sessionIndex({ limit: 10, title: 'child' }).map(r => r.sessionId)).toEqual(['ses_child'])
      const old = db.readTextPartsForIndex(0)
      expect(old.some(r => r.text === 'needle child')).toBe(true)
      writer.query('update session_message set data=?,time_updated=300 where id=?').run(JSON.stringify({ text: 'updated needle' }), 'msg_child')
      expect(db.readTextPartsForIndex(200).map(r => r.text)).toContain('updated needle')
      expect(writer.query<{ name: string }>("select name from sqlite_master where name='part'").all()).toEqual([])
    } finally { db.close(); writer.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
