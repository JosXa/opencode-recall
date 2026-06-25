import type { IndexSourceRow, SearchOptions, SearchRow, SearchSource } from './db.js'
import type { Database } from './sqlite.js'

const FTS_CANDIDATE_LIMIT = 200
const RRF_K = 60
const MAX_QUERY_TERMS = 20
const MIN_TERM_LENGTH = 2
const SESSION_TEXT_JOIN = '\n'

interface LexicalPartRow {
  readonly partId: string
  readonly sessionId: string
  readonly sessionTitle: string
  readonly directory: string
  readonly messageId: string
  readonly role: string
  readonly timeCreated: number
  readonly source: string
  readonly text: string
  readonly bm25: number
}

interface LexicalSessionRow {
  readonly sessionId: string
  readonly sessionTitle: string
  readonly directory: string
  readonly timeCreated: number
  readonly bm25: number
}

interface Filters {
  readonly after?: number
  readonly before?: number
  readonly directory?: string
  readonly excludeSessionId?: string
}

// FTS5-backed lexical retrieval lane co-located with the sidecar database.
//
// Owns two virtual tables:
//   lex_part_fts(text, title)       per-text-part BM25, granular hits
//   lex_session_fts(title, text)    per-session BM25 over concatenated transcript
//
// search() returns SearchRow[] fused via Reciprocal Rank Fusion (k=60), which
// the broader-search benchmark identified as the strongest lexical-only retriever
// across both curated regressions and a 100-query random corpus.
export class LexicalIndex {
  readonly #db: Database

  public constructor(db: Database) {
    this.#db = db
    this.#initialize()
  }

  public sync(
    rows: readonly IndexSourceRow[],
    sourcePartIds: readonly string[] | undefined,
  ): { indexedRows: number; deletedRows: number } {
    const affectedSessions = new Set<string>()
    let indexed = 0

    this.#db.transaction(() => {
      for (const row of rows) {
        const text = normalizeText(row.text)
        if (text.length === 0) {
          continue
        }
        this.#upsertPart(row, text)
        affectedSessions.add(row.sessionId)
        indexed += 1
      }
    })()

    let deleted = 0
    if (sourcePartIds !== undefined) {
      deleted = this.#removeStale(sourcePartIds, affectedSessions)
    }

    if (affectedSessions.size > 0) {
      this.#db.transaction(() => {
        for (const sessionId of affectedSessions) {
          this.#rebuildSession(sessionId)
        }
      })()
    }

    return { indexedRows: indexed, deletedRows: deleted }
  }

  public search(query: string, options: SearchOptions): SearchRow[] {
    const match = buildMatchQuery(query)
    if (match.length === 0) {
      return []
    }

    const filters: Filters = {
      ...(options.after === undefined ? {} : { after: options.after }),
      ...(options.before === undefined ? {} : { before: options.before }),
      ...(options.directory === undefined ? {} : { directory: options.directory }),
      ...(options.excludeSessionId === undefined
        ? {}
        : { excludeSessionId: options.excludeSessionId }),
    }

    const partRows = this.#searchParts(match, filters)
    const sessionRows = this.#searchSessions(match, filters)

    return this.#fuseAndProject(partRows, sessionRows, options.limit)
  }

  public hasIndexedRows(): boolean {
    const row = this.#db
      .query<{ readonly count: number }, []>('select count(*) as count from lex_part_meta')
      .get()
    return (row?.count ?? 0) > 0
  }

  #initialize(): void {
    this.#db.exec(`
      create table if not exists lex_part_meta (
        rowid integer primary key,
        part_id text unique not null,
        session_id text not null,
        session_title text not null,
        directory text not null,
        message_id text not null,
        role text not null,
        time_created integer not null,
        source text not null default 'text'
      );
      create index if not exists lex_part_meta_session_idx on lex_part_meta(session_id);
      create index if not exists lex_part_meta_time_idx on lex_part_meta(time_created);

      create virtual table if not exists lex_part_fts using fts5(
        text, title,
        tokenize='porter unicode61 remove_diacritics 2',
        prefix='2 3'
      );

      create table if not exists lex_session_meta (
        rowid integer primary key,
        session_id text unique not null,
        session_title text not null,
        directory text not null,
        time_created integer not null default 0
      );
      create index if not exists lex_session_meta_time_idx on lex_session_meta(time_created);

      create virtual table if not exists lex_session_fts using fts5(
        title, text,
        tokenize='porter unicode61 remove_diacritics 2',
        prefix='2 3'
      );
    `)
  }

  #upsertPart(row: IndexSourceRow, text: string): void {
    const existing = this.#db
      .query<{ readonly rowid: number }, [string]>(
        'select rowid from lex_part_meta where part_id = ?',
      )
      .get(row.partId)

    if (existing === null) {
      const inserted = this.#db
        .query<
          { readonly rowid: number },
          [string, string, string, string, string, string, number, string]
        >(`
          insert into lex_part_meta
            (part_id, session_id, session_title, directory, message_id, role, time_created, source)
          values (?, ?, ?, ?, ?, ?, ?, ?)
          returning rowid
        `)
        .get(
          row.partId,
          row.sessionId,
          row.sessionTitle,
          row.directory,
          row.messageId,
          row.role,
          row.timeCreated,
          row.source ?? 'text',
        )
      if (inserted === null) {
        return
      }
      this.#db
        .query<unknown, [number, string, string]>(
          'insert into lex_part_fts (rowid, text, title) values (?, ?, ?)',
        )
        .run(inserted.rowid, text, row.sessionTitle)
      return
    }

    this.#db
      .query<unknown, [string, string, string, string, string, number, string, string]>(`
        update lex_part_meta set
          session_id = ?,
          session_title = ?,
          directory = ?,
          message_id = ?,
          role = ?,
          time_created = ?,
          source = ?
        where part_id = ?
      `)
      .run(
        row.sessionId,
        row.sessionTitle,
        row.directory,
        row.messageId,
        row.role,
        row.timeCreated,
        row.source ?? 'text',
        row.partId,
      )
    this.#db
      .query<unknown, [number]>('delete from lex_part_fts where rowid = ?')
      .run(existing.rowid)
    this.#db
      .query<unknown, [number, string, string]>(
        'insert into lex_part_fts (rowid, text, title) values (?, ?, ?)',
      )
      .run(existing.rowid, text, row.sessionTitle)
  }

  #rebuildSession(sessionId: string): void {
    const parts = this.#db
      .query<
        {
          readonly rowid: number
          readonly text: string
          readonly sessionTitle: string
          readonly directory: string
          readonly timeCreated: number
        },
        [string]
      >(`
        select
          pm.rowid as rowid,
          coalesce(f.text, '') as text,
          pm.session_title as sessionTitle,
          pm.directory as directory,
          pm.time_created as timeCreated
        from lex_part_meta pm
        left join lex_part_fts f on f.rowid = pm.rowid
        where pm.session_id = ?
        order by pm.time_created
      `)
      .all(sessionId)

    if (parts.length === 0) {
      const existing = this.#db
        .query<{ readonly rowid: number }, [string]>(
          'select rowid from lex_session_meta where session_id = ?',
        )
        .get(sessionId)
      if (existing === null) {
        return
      }
      this.#db
        .query<unknown, [number]>('delete from lex_session_fts where rowid = ?')
        .run(existing.rowid)
      this.#db
        .query<unknown, [string]>('delete from lex_session_meta where session_id = ?')
        .run(sessionId)
      return
    }

    const last = parts.at(-1) ?? parts[0]
    if (last === undefined) {
      return
    }
    const title = last.sessionTitle
    const directory = last.directory
    const timeCreated = last.timeCreated
    const text = parts.map((part) => part.text).join(SESSION_TEXT_JOIN)
    const existing = this.#db
      .query<{ readonly rowid: number }, [string]>(
        'select rowid from lex_session_meta where session_id = ?',
      )
      .get(sessionId)

    if (existing === null) {
      const inserted = this.#db
        .query<{ readonly rowid: number }, [string, string, string, number]>(`
          insert into lex_session_meta (session_id, session_title, directory, time_created)
          values (?, ?, ?, ?)
          returning rowid
        `)
        .get(sessionId, title, directory, timeCreated)
      if (inserted === null) {
        return
      }
      this.#db
        .query<unknown, [number, string, string]>(
          'insert into lex_session_fts (rowid, title, text) values (?, ?, ?)',
        )
        .run(inserted.rowid, title, text)
      return
    }

    this.#db
      .query<unknown, [string, string, number, string]>(`
        update lex_session_meta set
          session_title = ?,
          directory = ?,
          time_created = ?
        where session_id = ?
      `)
      .run(title, directory, timeCreated, sessionId)
    this.#db
      .query<unknown, [number]>('delete from lex_session_fts where rowid = ?')
      .run(existing.rowid)
    this.#db
      .query<unknown, [number, string, string]>(
        'insert into lex_session_fts (rowid, title, text) values (?, ?, ?)',
      )
      .run(existing.rowid, title, text)
  }

  #removeStale(sourcePartIds: readonly string[], affectedSessions: Set<string>): number {
    const sourceSet = new Set(sourcePartIds)
    const indexedRows = this.#db
      .query<{ readonly rowid: number; readonly partId: string; readonly sessionId: string }, []>(
        'select rowid, part_id as partId, session_id as sessionId from lex_part_meta',
      )
      .all()
    let removed = 0

    this.#db.transaction(() => {
      for (const row of indexedRows) {
        if (sourceSet.has(row.partId)) {
          continue
        }
        this.#db.query<unknown, [number]>('delete from lex_part_fts where rowid = ?').run(row.rowid)
        this.#db
          .query<unknown, [number]>('delete from lex_part_meta where rowid = ?')
          .run(row.rowid)
        affectedSessions.add(row.sessionId)
        removed += 1
      }
    })()

    return removed
  }

  #searchParts(match: string, filters: Filters): readonly LexicalPartRow[] {
    const params: (string | number)[] = [match]
    const where = buildFilterClauses(filters, params, 'pm')
    params.push(FTS_CANDIDATE_LIMIT)
    return this.#db
      .query<LexicalPartRow, (string | number)[]>(`
        select
          pm.part_id as partId,
          pm.session_id as sessionId,
          pm.session_title as sessionTitle,
          pm.directory as directory,
          pm.message_id as messageId,
          pm.role as role,
          pm.time_created as timeCreated,
          pm.source as source,
          lex_part_fts.text as text,
          bm25(lex_part_fts, 1.0, 4.0) as bm25
        from lex_part_fts
        join lex_part_meta pm on pm.rowid = lex_part_fts.rowid
        where lex_part_fts match ?
          ${where}
        order by bm25
        limit ?
      `)
      .all(...params)
  }

  #searchSessions(match: string, filters: Filters): readonly LexicalSessionRow[] {
    const params: (string | number)[] = [match]
    const where = buildFilterClauses(filters, params, 'sm')
    params.push(FTS_CANDIDATE_LIMIT)
    return this.#db
      .query<LexicalSessionRow, (string | number)[]>(`
        select
          sm.session_id as sessionId,
          sm.session_title as sessionTitle,
          sm.directory as directory,
          sm.time_created as timeCreated,
          bm25(lex_session_fts, 4.0, 1.0) as bm25
        from lex_session_fts
        join lex_session_meta sm on sm.rowid = lex_session_fts.rowid
        where lex_session_fts match ?
          ${where}
        order by bm25
        limit ?
      `)
      .all(...params)
  }

  #fuseAndProject(
    partRows: readonly LexicalPartRow[],
    sessionRows: readonly LexicalSessionRow[],
    limit: number,
  ): SearchRow[] {
    const bestPartBySession = firstBySession(partRows)
    const fallbackBySession = firstBySession(sessionRows)
    const fusedScores = fuseScores(partRows, sessionRows)

    const ordered = [...fusedScores.entries()].sort((left, right) => right[1] - left[1])
    const ceiling = Math.max(limit, 50)
    const output: SearchRow[] = []

    for (const [sessionId, score] of ordered) {
      if (output.length >= ceiling) {
        break
      }
      const row = this.#projectRow(sessionId, score, bestPartBySession, fallbackBySession)
      if (row !== undefined) {
        output.push(row)
      }
    }

    return output
  }

  #projectRow(
    sessionId: string,
    score: number,
    bestPartBySession: Map<string, LexicalPartRow>,
    fallbackBySession: Map<string, LexicalSessionRow>,
  ): SearchRow | undefined {
    const partRow = bestPartBySession.get(sessionId)
    if (partRow !== undefined) {
      return { ...rowToSearchRow(partRow, normalizeSource(partRow.source)), score }
    }
    const sessionRow = fallbackBySession.get(sessionId)
    if (sessionRow === undefined) {
      return undefined
    }
    const representative = this.#fetchSessionRepresentative(sessionRow.sessionId)
    if (representative === undefined) {
      return undefined
    }
    return { ...rowToSearchRow(representative, 'session-title'), score }
  }

  #fetchSessionRepresentative(sessionId: string): LexicalPartRow | undefined {
    const row = this.#db
      .query<LexicalPartRow, [string]>(`
        select
          pm.part_id as partId,
          pm.session_id as sessionId,
          pm.session_title as sessionTitle,
          pm.directory as directory,
          pm.message_id as messageId,
          pm.role as role,
          pm.time_created as timeCreated,
          pm.source as source,
          coalesce(f.text, '') as text,
          0 as bm25
        from lex_part_meta pm
        left join lex_part_fts f on f.rowid = pm.rowid
        where pm.session_id = ?
        order by pm.time_created
        limit 1
      `)
      .get(sessionId)
    return row ?? undefined
  }
}

function normalizeSource(source: string): SearchSource {
  if (source === 'session-title' || source === 'semantic-rescue') {
    return source
  }
  return 'text'
}

function firstBySession<T extends { sessionId: string }>(rows: readonly T[]): Map<string, T> {
  const output = new Map<string, T>()
  for (const row of rows) {
    if (!output.has(row.sessionId)) {
      output.set(row.sessionId, row)
    }
  }
  return output
}

function fuseScores(
  partRows: readonly LexicalPartRow[],
  sessionRows: readonly LexicalSessionRow[],
): Map<string, number> {
  const scores = new Map<string, number>()
  const partRanks = new Map<string, number>()
  let partRank = 0
  for (const row of partRows) {
    if (partRanks.has(row.sessionId)) {
      continue
    }
    partRank += 1
    partRanks.set(row.sessionId, partRank)
  }
  for (const [sessionId, rank] of partRanks) {
    scores.set(sessionId, (scores.get(sessionId) ?? 0) + 1 / (RRF_K + rank))
  }
  for (let index = 0; index < sessionRows.length; index += 1) {
    const row = sessionRows[index]
    if (row === undefined) {
      continue
    }
    const rank = index + 1
    scores.set(row.sessionId, (scores.get(row.sessionId) ?? 0) + 1 / (RRF_K + rank))
  }
  return scores
}

function rowToSearchRow(row: LexicalPartRow, source: SearchSource): Omit<SearchRow, 'score'> {
  return {
    sessionId: row.sessionId,
    sessionTitle: row.sessionTitle,
    directory: row.directory,
    messageId: row.messageId,
    partId: row.partId,
    role: row.role,
    timeCreated: row.timeCreated,
    text: row.text,
    source,
  }
}

const WHITESPACE_RUN = /\s+/gu
const TOKEN_SPLIT = /[^\p{L}\p{N}_]+/u

function normalizeText(text: string): string {
  return text.replaceAll(WHITESPACE_RUN, ' ').trim()
}

// FTS5 query sanitiser: drop operators, lowercase, quote each term, OR-join.
// Quoting blocks accidental syntax (dots, hyphens) and matches the benchmark
// behaviour that produced the R4 RRF result.
function buildMatchQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .map((term) => term.trim())
    .filter((term) => term.length >= MIN_TERM_LENGTH)
    .slice(0, MAX_QUERY_TERMS)
  if (terms.length === 0) {
    return ''
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')
}

function buildFilterClauses(
  filters: Filters,
  params: (string | number)[],
  alias: 'pm' | 'sm',
): string {
  const clauses: string[] = []
  if (filters.after !== undefined) {
    clauses.push(`${alias}.time_created >= ?`)
    params.push(filters.after)
  }
  if (filters.before !== undefined) {
    clauses.push(`${alias}.time_created <= ?`)
    params.push(filters.before)
  }
  if (filters.directory !== undefined) {
    clauses.push(`${alias}.directory = ?`)
    params.push(filters.directory)
  }
  if (filters.excludeSessionId !== undefined) {
    clauses.push(`${alias}.session_id != ?`)
    params.push(filters.excludeSessionId)
  }
  return clauses.length === 0 ? '' : ` and ${clauses.join(' and ')}`
}
