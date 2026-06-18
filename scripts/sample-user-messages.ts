/**
 * Sample 20 random user messages from the OpenCode database, dump their session
 * id, title, and first ~500 chars of message text. Used to hand-design realistic
 * queries for the broader-search benchmark.
 *
 * Run with: bun scripts/sample-user-messages.ts [seed]
 */
import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DB_PATH = process.env['OPENCODE_DB_PATH'] ?? join(homedir(), '.local/share/opencode/opencode.db')
const SEED = Number.parseInt(process.argv[2] ?? '42', 10)
const SAMPLE_COUNT = 20

// Deterministic shuffle from a numeric seed (xorshift32) so re-runs are
// reproducible.
function makeRng(seed: number): () => number {
  let state = seed | 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return ((state >>> 0) % 1_000_000) / 1_000_000
  }
}

const db = new Database(DB_PATH, { readonly: true })

// Pull user message text parts. We want substantive prompts, not tiny "ok"
// follow-ups, so we cap the lower bound at 80 chars of body.
type Row = {
  partId: string
  sessionId: string
  sessionTitle: string
  messageId: string
  text: string
}

const rows = db
  .query<Row, []>(`
    select
      p.id        as partId,
      m.session_id as sessionId,
      coalesce(s.title, '') as sessionTitle,
      p.message_id as messageId,
      json_extract(p.data, '$.text') as text
    from part p
    join message m on m.id = p.message_id
    join session s on s.id = m.session_id
    where json_extract(m.data, '$.role') = 'user'
      and json_extract(p.data, '$.type') = 'text'
      and json_extract(p.data, '$.text') is not null
      and length(json_extract(p.data, '$.text')) between 80 and 4000
      and json_extract(p.data, '$.text') not like '%<system-reminder>%'
      and json_extract(p.data, '$.text') not like '%<command-name>%'
      and json_extract(p.data, '$.text') not like '%<environment_context>%'
  `)
  .all()

console.error(`pool size: ${rows.length} user messages`)

const rng = makeRng(SEED)
// Fisher-Yates partial shuffle for the first SAMPLE_COUNT slots.
const indices = rows.map((_, i) => i)
for (let i = 0; i < Math.min(SAMPLE_COUNT, indices.length); i += 1) {
  const j = i + Math.floor(rng() * (indices.length - i))
  ;[indices[i], indices[j]] = [indices[j] as number, indices[i] as number]
}

const sample = indices.slice(0, SAMPLE_COUNT).map((i) => rows[i] as Row)

const samples = sample.map((r, i) => ({
  n: i + 1,
  sessionId: r.sessionId,
  sessionTitle: r.sessionTitle,
  partId: r.partId,
  messageId: r.messageId,
  textPreview: r.text.slice(0, 600).replace(/\s+/g, ' ').trim(),
  textLength: r.text.length,
}))

console.log(JSON.stringify({ seed: SEED, count: samples.length, samples }, null, 2))
db.close()
