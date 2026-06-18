// Broader-search experiment.
//
// Goal: compare retrieval strategies for "find the right past session" on the
// existing real-history regression cases, without exploding embedding costs.
//
// Strategies under test:
//   R1  current production ranker         lexical LIKE + semantic + meta rules (rankSearchRows)
//   R2  part-level BM25 (FTS5)            granular, like current lexical, but with BM25
//   R3  session-level BM25 (FTS5)         broader: each row = whole session transcript
//   R4  RRF(part-BM25, session-BM25)      lexical-only fusion. No Ollama. Cheap.
//   R5  RRF(part-BM25, session-BM25,      adds the existing per-part embeddings on top.
//          part-semantic)
//
// Why this question matters:
//   - Per-part embeddings already exist. Adding a per-session embedding is hostile
//     to model limits (avg 6KB, max 750KB per session vs 256/512-token context).
//   - FTS5 BM25 over concatenated session text is the obvious cheap "broader"
//     primitive: zero embedding cost, handles the full transcript, scales fine
//     (25MB total across 4,348 sessions).
//
// Output: aggregate Top-1/3/5, MRR, plus per-case rank table + pass/fail under the
// existing maxRank/maxFalsePositive thresholds defined in evaluate-real-history.ts.

import { Database } from 'bun:sqlite'
import { rmSync } from 'node:fs'

import { HistoryDatabase } from '../src/db'
import { OllamaEmbeddingProvider } from '../src/embedding'
import { rankSearchRows } from '../src/search'
import { RecallSidecarIndex } from '../src/sidecar'

type CaseKind = 'known-hard-paraphrase' | 'must-top-1' | 'must-top-3'

interface RegressionCase {
  readonly name: string
  readonly query: string
  readonly expectedSessionId: string
  readonly kind: CaseKind
  readonly maxRank: number
  readonly maxFalsePositivesBeforeHit: number
}

// Same cases as evaluate-real-history.ts (kept in sync intentionally).
const CASES: readonly RegressionCase[] = [
  { name: 'Figma title retrieval from original query', query: 'figma mcp', expectedSessionId: 'ses_1ea07e649ffe8rG0kUBk4oJQC8', kind: 'must-top-3', maxRank: 3, maxFalsePositivesBeforeHit: 2 },
  { name: 'Figma Azure API Center registry wording', query: 'azure mcp registry figma', expectedSessionId: 'ses_1ea07e649ffe8rG0kUBk4oJQC8', kind: 'must-top-3', maxRank: 3, maxFalsePositivesBeforeHit: 2 },
  { name: 'Figma API Center title phrase', query: 'figma azure api center', expectedSessionId: 'ses_1ea07e649ffe8rG0kUBk4oJQC8', kind: 'must-top-3', maxRank: 2, maxFalsePositivesBeforeHit: 1 },
  { name: 'Executor MCP crash is distinct from Figma', query: 'executor mcp unavailable crash investigation', expectedSessionId: 'ses_1e3f564a4ffehZjhypED2AiJWP', kind: 'must-top-1', maxRank: 1, maxFalsePositivesBeforeHit: 0 },
  { name: 'OpenCode recall semantic history session', query: 'history_search opencode recall semantic ollama', expectedSessionId: 'ses_1e67d9990ffetS3quA8GM8FtA2', kind: 'must-top-3', maxRank: 3, maxFalsePositivesBeforeHit: 2 },
  { name: 'Confluence admin spaces natural wording', query: 'which confluence spaces am I admin in', expectedSessionId: 'ses_1b083fceeffePsPC6T0K5qwuPu', kind: 'known-hard-paraphrase', maxRank: 5, maxFalsePositivesBeforeHit: 4 },
  { name: 'AICREW contenteditable task title', query: 'AICREW-89 contenteditable questions', expectedSessionId: 'ses_1b0abb56bffeeCGKORS30emSLW', kind: 'known-hard-paraphrase', maxRank: 5, maxFalsePositivesBeforeHit: 4 },
  { name: 'German document image translation', query: 'translate German document image to English', expectedSessionId: 'ses_1b0d391f1ffemK07e3R52zEWjn', kind: 'known-hard-paraphrase', maxRank: 5, maxFalsePositivesBeforeHit: 4 },
  { name: 'Ad paranoia psychology paraphrase', query: 'phone microphone spying ads psychology effect', expectedSessionId: 'ses_1b4edec2effemoWfcI1soaIxIz', kind: 'known-hard-paraphrase', maxRank: 5, maxFalsePositivesBeforeHit: 4 },
  { name: 'Ground Zero AI meeting scheduling', query: 'schedule teams meeting Ground Zero AI members', expectedSessionId: 'ses_1b5284a9effemZ64qRqK4ySsS3', kind: 'known-hard-paraphrase', maxRank: 5, maxFalsePositivesBeforeHit: 4 },
  { name: 'ICE Zugbindung rare German token', query: 'zugbindung', expectedSessionId: 'ses_1fbe12286ffe2rE3kLl2aUKtuR', kind: 'must-top-1', maxRank: 1, maxFalsePositivesBeforeHit: 0 },
  { name: 'Dell monitor wake issue', query: 'monitor came back', expectedSessionId: 'ses_1f31807dfffe86817RtAM6jxph', kind: 'must-top-1', maxRank: 1, maxFalsePositivesBeforeHit: 0 },
  { name: 'VSCode key repeat', query: 'key repeat', expectedSessionId: 'ses_1b6603c8effeHJrsLvdXOwotbZ', kind: 'must-top-1', maxRank: 1, maxFalsePositivesBeforeHit: 0 },
  { name: 'KPI upload stopped', query: 'kpi upload stopped', expectedSessionId: 'ses_22689a804ffe1LHHLTtKP46c0O', kind: 'must-top-1', maxRank: 1, maxFalsePositivesBeforeHit: 0 },
  { name: 'AI Hub costs paraphrase', query: 'costs few cents', expectedSessionId: 'ses_1b3f719b5ffeupZr9YRhGD4oml', kind: 'known-hard-paraphrase', maxRank: 5, maxFalsePositivesBeforeHit: 4 },
  { name: 'Ruzanna queue migration distinctive query', query: 'Ruzanna queue migration function app old queue race condition', expectedSessionId: 'ses_1bf5c0887ffegfWQsHfYNXOk0q', kind: 'must-top-1', maxRank: 1, maxFalsePositivesBeforeHit: 0 },
  { name: 'SharePoint shared XLSX programmatic access', query: 'SharePoint shared xlsx programmatically without browser Graph access', expectedSessionId: 'ses_1b5d4a332ffeLedXM5hG1TrtIC', kind: 'must-top-1', maxRank: 1, maxFalsePositivesBeforeHit: 0 },
  { name: 'Plugin logs followup queue keybind', query: 'followup queue alt return keybind create undefined', expectedSessionId: 'ses_1df0e4455ffeu1lUWS6BW9Zcrq', kind: 'must-top-1', maxRank: 1, maxFalsePositivesBeforeHit: 0 },
  { name: 'image_generation SSE timeout', query: 'image_generation no timeout SSE chatgpt backend codex responses', expectedSessionId: 'ses_1fd3561e1ffew8tV28hCsoSafl', kind: 'must-top-1', maxRank: 1, maxFalsePositivesBeforeHit: 0 },
  { name: 'Karabiner German keyboard backslash', query: 'Karabiner Caps Lock ß backslash Option Shift 7', expectedSessionId: 'ses_2212b07fbffek9h6UnD6JH89UO', kind: 'must-top-1', maxRank: 1, maxFalsePositivesBeforeHit: 0 },
  { name: 'GitLab SSH key setup', query: 'add ssh key gitlab public key id_ed25519 fingerprint', expectedSessionId: 'ses_225d62ad9ffeinLJSCdy04G0ot', kind: 'must-top-1', maxRank: 1, maxFalsePositivesBeforeHit: 0 },
  { name: 'MR 83 rebase conflict', query: 'rebase merge request 83 feat citation sentence highlight documentMethods conflict', expectedSessionId: 'ses_207669cddffebgTuNpGTMJ0GEL', kind: 'must-top-1', maxRank: 1, maxFalsePositivesBeforeHit: 0 },
  { name: 'Copilot Premium org policy notification plugin', query: 'Copilot Premium Usage blocked organization policy notification plugin', expectedSessionId: 'ses_2316838fdffeZQkTqILklQsoUB', kind: 'must-top-1', maxRank: 1, maxFalsePositivesBeforeHit: 0 },
  { name: 'LEAGUES project ports status', query: 'LEAGUES localhost 5174 6000 8088 Streaming Cutter API project status', expectedSessionId: 'ses_21f8bc866ffeD0clxoLPAczPeu', kind: 'must-top-1', maxRank: 1, maxFalsePositivesBeforeHit: 0 },
  { name: 'Progressive disclosure AGENTS docs', query: 'progressive disclosure AGENTS.md references context gate root-to-leaf', expectedSessionId: 'ses_1e3800833ffeudY8duZJ80r63U', kind: 'must-top-1', maxRank: 1, maxFalsePositivesBeforeHit: 0 },
]

// FTS5 query sanitiser: split into terms, drop FTS operators, OR them.
// Using OR keeps recall high; BM25 handles ranking. Quote each term so '.' and
// non-ASCII don't trip the tokenizer's reserved chars.
function buildMatchQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 1)
    .slice(0, 20)
  if (terms.length === 0) return ''
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ')
}

interface PartFtsRow {
  readonly partId: string
  readonly sessionId: string
  readonly messageId: string
  readonly sessionTitle: string
  readonly directory: string
  readonly role: string
  readonly timeCreated: number
  readonly text: string
  readonly score: number
}

interface SessionFtsRow {
  readonly sessionId: string
  readonly sessionTitle: string
  readonly directory: string
  readonly score: number
}

interface FtsIndex {
  readonly db: Database
  searchParts(query: string, limit: number): readonly PartFtsRow[]
  searchSessions(query: string, limit: number): readonly SessionFtsRow[]
  close(): void
}

function buildFtsIndex(path: string, source: HistoryDatabase): FtsIndex {
  rmSync(path, { force: true })
  rmSync(`${path}-wal`, { force: true })
  rmSync(`${path}-shm`, { force: true })
  const db = new Database(path)
  db.exec('pragma journal_mode = wal')
  db.exec('pragma synchronous = off')
  // part_meta.rowid mirrors part_fts.rowid so bm25() joins are O(1).
  db.exec(`
    create table part_meta (
      rowid integer primary key,
      part_id text unique,
      session_id text,
      session_title text,
      directory text,
      message_id text,
      role text,
      time_created integer
    );
    create virtual table part_fts using fts5(
      text, title,
      tokenize='porter unicode61 remove_diacritics 2',
      prefix='2 3'
    );
    create table session_meta (
      rowid integer primary key,
      session_id text unique,
      session_title text,
      directory text
    );
    create virtual table session_fts using fts5(
      title, text,
      tokenize='porter unicode61 remove_diacritics 2',
      prefix='2 3'
    );
  `)

  console.error('  populating part_fts...')
  const insertPartMeta = db.prepare(
    'insert into part_meta (rowid, part_id, session_id, session_title, directory, message_id, role, time_created) values (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const insertPartFts = db.prepare('insert into part_fts (rowid, text, title) values (?, ?, ?)')
  const partRows = source.readTextPartsForIndex(undefined)
  let rowid = 0
  db.exec('begin')
  for (const row of partRows) {
    rowid += 1
    insertPartMeta.run(
      rowid,
      row.partId,
      row.sessionId,
      row.sessionTitle ?? '',
      row.directory ?? '',
      row.messageId,
      row.role,
      row.timeCreated,
    )
    insertPartFts.run(rowid, row.text ?? '', row.sessionTitle ?? '')
  }
  db.exec('commit')
  console.error(`    indexed ${rowid} part rows`)

  console.error('  populating session_fts (concatenated transcripts)...')
  const sessionBuckets = new Map<
    string,
    { title: string; directory: string; chunks: string[] }
  >()
  for (const row of partRows) {
    const bucket = sessionBuckets.get(row.sessionId) ?? {
      title: row.sessionTitle ?? '',
      directory: row.directory ?? '',
      chunks: [],
    }
    bucket.chunks.push(row.text ?? '')
    sessionBuckets.set(row.sessionId, bucket)
  }

  const insertSessionMeta = db.prepare(
    'insert into session_meta (rowid, session_id, session_title, directory) values (?, ?, ?, ?)',
  )
  const insertSessionFts = db.prepare(
    'insert into session_fts (rowid, title, text) values (?, ?, ?)',
  )
  let sessionRowId = 0
  db.exec('begin')
  for (const [sessionId, bucket] of sessionBuckets) {
    sessionRowId += 1
    insertSessionMeta.run(sessionRowId, sessionId, bucket.title, bucket.directory)
    insertSessionFts.run(sessionRowId, bucket.title, bucket.chunks.join('\n'))
  }
  db.exec('commit')
  console.error(`    indexed ${sessionRowId} session rows`)

  // BM25 column weights:
  //   part_fts(text, title) -> (1.0, 4.0): title hits dominate when a query happens
  //     to land on a synthetic title-only row (we don't seed any here, but the column
  //     captures repeated title content from per-part rows).
  //   session_fts(title, text) -> (4.0, 1.0): title is high-signal for proper-noun
  //     queries; transcript text supplies recall.
  // Lower bm25 = better, so we negate to make "higher score = better" consistent
  // across all retrievers, which is what RRF assumes (rank, not absolute score).
  const partQuery = db.query<
    {
      readonly partId: string
      readonly sessionId: string
      readonly sessionTitle: string
      readonly directory: string
      readonly messageId: string
      readonly role: string
      readonly timeCreated: number
      readonly text: string
      readonly bm25: number
    },
    [string, number]
  >(`
    select
      pm.part_id as partId,
      pm.session_id as sessionId,
      pm.session_title as sessionTitle,
      pm.directory as directory,
      pm.message_id as messageId,
      pm.role as role,
      pm.time_created as timeCreated,
      part_fts.text as text,
      bm25(part_fts, 1.0, 4.0) as bm25
    from part_fts
    join part_meta pm on pm.rowid = part_fts.rowid
    where part_fts match ?
    order by bm25
    limit ?
  `)

  const sessionQuery = db.query<
    {
      readonly sessionId: string
      readonly sessionTitle: string
      readonly directory: string
      readonly bm25: number
    },
    [string, number]
  >(`
    select
      sm.session_id as sessionId,
      sm.session_title as sessionTitle,
      sm.directory as directory,
      bm25(session_fts, 4.0, 1.0) as bm25
    from session_fts
    join session_meta sm on sm.rowid = session_fts.rowid
    where session_fts match ?
    order by bm25
    limit ?
  `)

  return {
    db,
    searchParts(query, limit) {
      const match = buildMatchQuery(query)
      if (match.length === 0) return []
      return partQuery.all(match, limit).map((r) => ({
        partId: r.partId,
        sessionId: r.sessionId,
        messageId: r.messageId,
        sessionTitle: r.sessionTitle,
        directory: r.directory,
        role: r.role,
        timeCreated: r.timeCreated,
        text: r.text,
        score: -r.bm25, // invert so higher=better, matches RRF convention
      }))
    },
    searchSessions(query, limit) {
      const match = buildMatchQuery(query)
      if (match.length === 0) return []
      return sessionQuery.all(match, limit).map((r) => ({
        sessionId: r.sessionId,
        sessionTitle: r.sessionTitle,
        directory: r.directory,
        score: -r.bm25,
      }))
    },
    close() {
      db.close()
    },
  }
}

// Reciprocal Rank Fusion. Standard formula: score = sum(1 / (k + rank_i)).
// k=60 is the Cormack default and robust across regimes.
function rrf<T>(
  rankedLists: readonly (readonly T[])[],
  keyOf: (item: T) => string,
  k = 60,
): { key: string; score: number; representative: T }[] {
  const scores = new Map<string, { score: number; representative: T }>()
  for (const list of rankedLists) {
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i]
      if (item === undefined) continue
      const key = keyOf(item)
      const contribution = 1 / (k + i + 1) // 1-based rank
      const existing = scores.get(key)
      if (existing === undefined) {
        scores.set(key, { score: contribution, representative: item })
      } else {
        existing.score += contribution
      }
    }
  }
  return [...scores.entries()]
    .map(([key, value]) => ({ key, score: value.score, representative: value.representative }))
    .sort((a, b) => b.score - a.score)
}

// Map a list of part-level rows to a list of session-level rows (best-per-session,
// stable order). Most metrics here want a session ranking.
function dedupeBySession<T extends { sessionId: string; score?: number }>(
  rows: readonly T[],
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const row of rows) {
    if (seen.has(row.sessionId)) continue
    seen.add(row.sessionId)
    out.push(row)
  }
  return out
}

interface Retriever {
  readonly name: string
  retrieve(query: string, limit: number): Promise<readonly { sessionId: string }[]>
}

async function buildRetrievers(
  history: HistoryDatabase,
  sidecar: RecallSidecarIndex,
  provider: OllamaEmbeddingProvider | undefined,
  fts: FtsIndex,
): Promise<readonly Retriever[]> {
  return [
    // R1: current production ranker. Mirrors evaluate-real-history.ts so deltas are apples-to-apples.
    {
      name: 'R1 production (LIKE+semantic+rules)',
      async retrieve(query, limit) {
        const options = { limit, before: Date.now() - 30_000 }
        const semantic = provider === undefined ? [] : await sidecar.search(query, options, provider)
        const lexical = history.lexicalSearch(query, options)
        const ranked = rankSearchRows(query, [...lexical, ...semantic], limit * 4)
        return dedupeBySession(ranked).slice(0, limit)
      },
    },
    // R2: pure BM25 at the part level.
    {
      name: 'R2 part BM25 (FTS5)',
      retrieve(query, limit) {
        return Promise.resolve(
          dedupeBySession(fts.searchParts(query, limit * 20)).slice(0, limit),
        )
      },
    },
    // R3: pure BM25 at the SESSION level — the "broader" approach. Sees the full
    // transcript per session, no embeddings needed.
    {
      name: 'R3 session BM25 (FTS5, full transcript)',
      retrieve(query, limit) {
        return Promise.resolve(fts.searchSessions(query, limit))
      },
    },
    // R4: RRF over (part BM25, session BM25). Lexical only, no Ollama.
    {
      name: 'R4 RRF(part-BM25, session-BM25)',
      retrieve(query, limit) {
        const partList = dedupeBySession(fts.searchParts(query, 200))
        const sessionList = fts.searchSessions(query, 200)
        const lists: readonly (readonly { sessionId: string }[])[] = [partList, sessionList]
        const fused = rrf(lists, (x) => x.sessionId)
        return Promise.resolve(fused.slice(0, limit).map((f) => ({ sessionId: f.key })))
      },
    },
    // R5: add per-part semantic into the same RRF.
    {
      name: 'R5 RRF(part-BM25, session-BM25, part-semantic)',
      async retrieve(query, limit) {
        const partList = dedupeBySession(fts.searchParts(query, 200))
        const sessionList = fts.searchSessions(query, 200)
        const semantic =
          provider === undefined
            ? []
            : dedupeBySession(
                await sidecar.search(query, { limit: 200 }, provider),
              )
        const lists: readonly (readonly { sessionId: string }[])[] = [
          partList,
          sessionList,
          semantic,
        ]
        const fused = rrf(lists, (x) => x.sessionId)
        return Promise.resolve(fused.slice(0, limit).map((f) => ({ sessionId: f.key })))
      },
    },
  ]
}

interface CaseResult {
  readonly retriever: string
  readonly case: string
  readonly query: string
  readonly expected: string
  readonly rank: number // 0 = miss
  readonly passed: boolean
}

function rankOf(results: readonly { sessionId: string }[], expected: string): number {
  for (let i = 0; i < results.length; i += 1) {
    if (results[i]?.sessionId === expected) return i + 1
  }
  return 0
}

interface Aggregate {
  readonly retriever: string
  readonly top1: number
  readonly top3: number
  readonly top5: number
  readonly top10: number
  readonly mrr: number
  readonly passed: number
  readonly total: number
}

function aggregate(results: readonly CaseResult[]): Aggregate {
  const total = results.length
  const passed = results.filter((r) => r.passed).length
  const top1 = results.filter((r) => r.rank === 1).length
  const top3 = results.filter((r) => r.rank >= 1 && r.rank <= 3).length
  const top5 = results.filter((r) => r.rank >= 1 && r.rank <= 5).length
  const top10 = results.filter((r) => r.rank >= 1 && r.rank <= 10).length
  const mrr =
    results.reduce((sum, r) => (r.rank === 0 ? sum : sum + 1 / r.rank), 0) / Math.max(1, total)
  return { retriever: results[0]?.retriever ?? '?', top1, top3, top5, top10, mrr, passed, total }
}

async function main() {
  const lexicalOnly = process.argv.includes('--lexical-only')
  const ftsPath = '/tmp/opencode-recall-bm25-eval.db'
  const indexPath = '/tmp/opencode-recall-broader-sidecar.db'
  const useDefaultSidecar = !process.argv.includes('--fresh-sidecar')

  console.error(`building FTS5 indexes at ${ftsPath}...`)
  const history = new HistoryDatabase()
  const fts = buildFtsIndex(ftsPath, history)

  // Reuse the user's already-populated sidecar by default (288MB, mxbai+minilm rows).
  // This skips a ~hour-long re-embed. Pass --fresh-sidecar to rebuild.
  const sidecar = new RecallSidecarIndex(useDefaultSidecar ? undefined : indexPath)
  const provider = lexicalOnly ? undefined : new OllamaEmbeddingProvider()

  const retrievers = await buildRetrievers(history, sidecar, provider, fts)
  const all: CaseResult[] = []
  const limit = 10

  // Print a per-case rank matrix as we go.
  const header = ['case', ...retrievers.map((r) => shortName(r.name))]
  const rows: string[][] = []

  for (const tc of CASES) {
    const row = [trim(tc.name, 50)]
    for (const r of retrievers) {
      const hits = await r.retrieve(tc.query, limit)
      const rank = rankOf(hits, tc.expectedSessionId)
      const passed =
        rank > 0 && rank <= tc.maxRank && (rank - 1) <= tc.maxFalsePositivesBeforeHit
      all.push({
        retriever: r.name,
        case: tc.name,
        query: tc.query,
        expected: tc.expectedSessionId,
        rank,
        passed,
      })
      row.push(rank === 0 ? 'MISS' : `${rank}${passed ? '' : '*'}`)
    }
    rows.push(row)
  }

  // Aggregate per retriever.
  const aggregates = retrievers.map((r) =>
    aggregate(all.filter((row) => row.retriever === r.name)),
  )

  console.log('\n=== per-case rank (lower=better, * = fails maxRank policy, MISS = not in top 10) ===')
  printTable([header, ...rows])

  console.log('\n=== aggregate metrics ===')
  printTable([
    ['retriever', 'top1', 'top3', 'top5', 'top10', 'MRR', 'passes policy'],
    ...aggregates.map((a) => [
      shortName(a.retriever),
      `${a.top1}/${a.total}`,
      `${a.top3}/${a.total}`,
      `${a.top5}/${a.total}`,
      `${a.top10}/${a.total}`,
      a.mrr.toFixed(3),
      `${a.passed}/${a.total}`,
    ]),
  ])

  // JSON summary at the end so it's machine-readable.
  console.log('\n=== json ===')
  console.log(JSON.stringify({ aggregates, all }, null, 2))

  fts.close()
  sidecar.close()
  history.close()
  if (provider !== undefined) provider.close()
}

function shortName(s: string): string {
  return s.split(' ').slice(0, 1).join(' ') + ' ' + s.split(' ').slice(1).join(' ').slice(0, 40)
}

function trim(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

function printTable(rows: readonly (readonly string[])[]) {
  const widths: number[] = []
  for (const row of rows) {
    for (let i = 0; i < row.length; i += 1) {
      widths[i] = Math.max(widths[i] ?? 0, row[i]?.length ?? 0)
    }
  }
  for (const row of rows) {
    console.log(row.map((cell, i) => (cell ?? '').padEnd(widths[i] ?? 0)).join('  '))
  }
}

await main()
