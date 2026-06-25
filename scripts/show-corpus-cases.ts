/**
 * For each session referenced in scripts/random-corpus.json, print:
 *   - session id + title
 *   - the original sampled user message preview
 *   - all 5 queries that target it
 * So a human can eyeball whether the queries are reasonable.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { Database } from '../src/sqlite.js'

const DB_PATH = process.env['OPENCODE_DB_PATH'] ?? join(homedir(), '.local/share/opencode/opencode.db')

type Case = { name: string; query: string; expectedSessionId: string }
type Corpus = { cases: readonly Case[] }

const corpus = JSON.parse(await readFile('scripts/random-corpus.json', 'utf-8')) as Corpus

const bySession = new Map<string, Case[]>()
for (const c of corpus.cases) {
  const list = bySession.get(c.expectedSessionId) ?? []
  list.push(c)
  bySession.set(c.expectedSessionId, list)
}

const db = new Database(DB_PATH, { readonly: true })

// Pick the first substantive user message per session for context.
const messageQuery = db.query<
  { text: string; title: string },
  [string]
>(`
  select
    json_extract(p.data, '$.text') as text,
    coalesce(s.title, '') as title
  from part p
  join message m on m.id = p.message_id
  join session s on s.id = m.session_id
  where m.session_id = ?
    and json_extract(m.data, '$.role') = 'user'
    and json_extract(p.data, '$.type') = 'text'
    and length(json_extract(p.data, '$.text')) > 60
    and json_extract(p.data, '$.text') not like '%<system-reminder>%'
  order by m.time_created asc
  limit 1
`)

let n = 0
for (const [sessionId, queries] of bySession) {
  n += 1
  const row = messageQuery.get(sessionId)
  const title = row?.title ?? '(no title)'
  const preview = (row?.text ?? '(no user message found)').replace(/\s+/g, ' ').trim().slice(0, 320)
  console.log(`\n=== ${n}. ${sessionId}`)
  console.log(`title:   ${title}`)
  console.log(`message: ${preview}`)
  console.log(`queries:`)
  for (const q of queries) {
    console.log(`  - [${q.name.split(' — ').pop()}] "${q.query}"`)
  }
}

db.close()
