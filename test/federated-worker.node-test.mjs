import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)
const sdk = new URL('../dist/src/sdk.js', import.meta.url).href
const worker = new URL('../dist/src/node-worker-client.js', import.meta.url).href
const workerDir = new URL('../dist/src/', import.meta.url).pathname

test('built SDK and workers federate V1 and V2 from fresh processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recall-built-federated-'))
  const sources = ['v1', 'v2'].map(id => ({ id, path: join(root, `${id}.db`), indexPath: join(root, `${id}-index.db`) }))
  for (const source of sources) {
    const db = new DatabaseSync(source.path)
    if (source.id === 'v1') db.exec(`
      create table session(id text primary key, title text, directory text, time_updated integer);
      create table message(id text primary key, session_id text, data text, time_created integer, time_updated integer);
      create table part(id text primary key, message_id text, session_id text, data text, time_updated integer);
      insert into session values ('ses_shared','V1','/v1',1);
      insert into message values ('msg_shared','ses_shared','{"role":"user"}',1,1);
      insert into part values ('msg_shared:00000000','msg_shared','ses_shared','{"type":"text","text":"cobalt legacy"}',1);
    `)
    if (source.id === 'v2') db.exec(`
      create table session_v2(id text primary key, title text, directory text, time_updated integer);
      create table session_message(id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
      insert into session_v2 values ('ses_shared','V2','/v2',2);
      insert into session_message values ('msg_shared','ses_shared','user',1,2,2,'{"text":"cobalt native"}');
    `)
    db.exec(`create table event(id text primary key, aggregate_id text, type text); insert into event values ('evt_1','ses_shared','session.created.1')`)
    db.close()
  }
  await writeFile(join(root, 'recall.jsonc'), JSON.stringify({ database: { sources } }))
  const env = { ...process.env, OPENCODE_CONFIG_DIR: root, OPENCODE_DB_PATH: '', OPENCODE_RECALL_DB_PATH: '' }
  const execute = code => run(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env })
  try {
    const search = `const { OpenCodeRecall } = await import(${JSON.stringify(sdk)}); const recall = new OpenCodeRecall(); console.log(JSON.stringify(await recall.search('cobalt', { semantic: false })))`
    const first = JSON.parse((await execute(search)).stdout)
    assert.equal(first.sync.indexedRows, 4)
    assert.deepEqual(first.hits.map(hit => hit.cursor).sort(), ['v1::msg_shared', 'v2::msg_shared'])
    const second = JSON.parse((await execute(search)).stdout)
    assert.equal(second.sync.indexedRows, 0)
    const read = JSON.parse((await execute(`const { readHistoryWindow } = await import(${JSON.stringify(sdk)}); console.log(JSON.stringify(readHistoryWindow('v2::msg_shared')))`)).stdout)
    assert.equal(read.sourceId, 'v2')
    assert.equal(read.messages[0].parts[0].text, 'cobalt native')
    await execute(`const { executeNodeWorker } = await import(${JSON.stringify(worker)}); console.log(await executeNodeWorker(${JSON.stringify(workerDir)}, {kind:'session-save',args:{cursor:'v1::ses_shared',path:'saved.md',format:'markdown'},context:{directory:${JSON.stringify(root)}}}, new AbortController().signal))`)
    const { readFile } = await import('node:fs/promises')
    const saved = await readFile(join(root, 'saved.md'), 'utf8')
    assert.ok(saved.includes('v1::ses_shared'))
    assert.ok(saved.includes('cobalt legacy'))
    assert.ok(!saved.includes('cobalt native'))
    await assert.rejects(execute(`const { readHistoryWindow } = await import(${JSON.stringify(sdk)}); readHistoryWindow('msg_shared')`), /Ambiguous history cursor.*v1::msg_shared.*v2::msg_shared/s)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
