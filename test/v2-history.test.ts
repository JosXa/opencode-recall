import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { HistoryDatabase } from '../src/db.js'
import { installHistorySchema } from '../src/history-schema.js'
import { normalizeWindow } from '../src/normalizer.js'
import { Database } from '../src/sqlite.js'

describe('native V2 history projection', () => {
  test('includes a separate read-only V1 database and prefers native sessions with duplicate IDs', () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-combined-'))
    const nativePath = join(root, 'native.db')
    const legacyPath = join(root, 'legacy.db')
    const native = new Database(nativePath)
    const legacy = new Database(legacyPath)
    native.exec(`
      create table session_v2(id text primary key, title text, directory text, time_updated integer);
      create table session_message(id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
      create table event(id text, aggregate_id text);
      insert into session_v2 values ('ses_shared', NULL, '/project', 200);
      insert into session_message values ('msg_native', 'ses_shared', 'user', 1, 200, 200, '{"text":"native needle"}');
    `)
    legacy.exec(`
      create table session(id text primary key, title text, directory text, time_updated integer);
      create table message(id text primary key, session_id text, data text, time_created integer, time_updated integer);
      create table part(id text primary key, message_id text, session_id text, data text, time_updated integer);
      insert into session values ('ses_old', 'Old plan', '/project', 100), ('ses_shared', 'Stale copy', '/project', 100);
      insert into message values ('msg_old', 'ses_old', '{"role":"user"}', 100, 100), ('msg_stale', 'ses_shared', '{"role":"user"}', 100, 100);
      insert into part values ('prt_old', 'msg_old', 'ses_old', '{"type":"text","text":"legacy needle"}', 100), ('prt_stale', 'msg_stale', 'ses_shared', '{"type":"text","text":"stale needle"}', 100);
    `)
    const db = new HistoryDatabase(nativePath, legacyPath)
    const attachment = new Database(nativePath, { readonly: true })
    installHistorySchema(attachment, legacyPath)
    try {
      expect(() => attachment.exec("update recall_legacy.session set title='changed'")).toThrow(/readonly/)
      expect(db.sessionIndex({ limit: 10 }).map(row => row.sessionId)).toEqual(['ses_shared', 'ses_old'])
      expect(db.lexicalSearch('needle', { limit: 10 }).map(row => row.messageId).sort()).toEqual(['msg_native', 'msg_old'])
      expect(db.readIndexChanges(undefined).mode).toBe('legacy')
      legacy.exec("update session set time_updated=300 where id='ses_old'; update part set data='{\"type\":\"text\",\"text\":\"updated old plan\"}', time_updated=300 where id='prt_old'")
      expect(db.readTextPartsForIndex(250).map(row => row.text)).toContain('updated old plan')
      expect(normalizeWindow(db.readSession('ses_old')).messages[0]?.id).toBe('msg_old')
    } finally {
      attachment.close(); db.close(); native.close(); legacy.close(); rmSync(root, { recursive: true, force: true })
    }
  })

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
