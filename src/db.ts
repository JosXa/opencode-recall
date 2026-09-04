import { loadConfig } from './config.js'
import { Database } from './sqlite.js'

const WHITESPACE_REGEX = /\s+/u

export interface SearchOptions {
  readonly limit: number
  readonly after?: number
  readonly before?: number
  readonly directory?: string
  readonly excludeSessionId?: string
}

export interface SessionIndexOptions {
  readonly limit: number
  readonly after?: number
  readonly before?: number
  readonly directory?: string
  readonly title?: string
  readonly excludeSessionId?: string
}

export interface SessionIndexRow {
  readonly sessionId: string
  readonly title: string
  readonly directory: string
  readonly updatedAt: number
  readonly firstMessageAt: number | null
  readonly lastMessageAt: number | null
  readonly messageCount: number
  readonly turns: number
  readonly assistantMessages: number
  readonly toolMessages: number
  readonly textPartCount: number
  readonly approxContextChars: number
}

export type ReadMode = 'around' | 'head' | 'next' | 'prev' | 'tail'

export interface ReadOptions {
  readonly mode: ReadMode
  readonly limit: number
}

export interface SearchRow {
  readonly sessionId: string
  readonly sessionTitle: string
  readonly directory: string
  readonly messageId: string
  readonly partId: string
  readonly role: string
  readonly score?: number
  readonly timeCreated: number
  readonly text: string
  readonly source?: SearchSource
}

export type SearchSource = 'semantic-rescue' | 'session-title' | 'text'

export interface IndexSourceRow extends SearchRow {
  readonly sourceUpdated: number
}

export interface HistoryEventCursor {
  readonly rowId: number
  readonly eventId: string
}

export interface HistoryIndexChanges {
  readonly mode: 'full' | 'incremental' | 'legacy'
  readonly cursor?: HistoryEventCursor
  readonly sessionIds: readonly string[]
  readonly rows: readonly IndexSourceRow[]
}

export interface MessageRow {
  readonly messageId: string
  readonly role: string
  readonly timeCreated: number
  readonly messageIndex: number
}

export interface PartRow {
  readonly id: string
  readonly messageId: string
  readonly data: string
}

export interface WindowRows {
  readonly sessionId: string
  readonly title: string
  readonly directory: string
  readonly mode: ReadMode
  readonly anchorMessageId: string
  readonly anchorTimeCreated: number
  readonly anchorIndex: number
  readonly messages: readonly MessageRow[]
  readonly parts: readonly PartRow[]
  readonly hasPrevious: boolean
  readonly hasNext: boolean
  readonly totalMessages: number
}

export class HistoryDatabase {
  readonly #db: Database

  public constructor(path = defaultOpenCodeDbPath()) {
    this.#db = new Database(path, { readonly: true })
  }

  public close(): void {
    this.#db.close()
  }

  public search(query: string, options: SearchOptions): SearchRow[] {
    const terms = tokenizeQuery(query)

    if (terms.length === 0) {
      return []
    }

    const conditions = [
      ...terms.map(() => "lower(json_extract(p.data, '$.text')) like ?"),
      ...(options.after === undefined ? [] : ['m.time_created >= ?']),
      ...(options.before === undefined ? [] : ['m.time_created <= ?']),
      ...(options.directory === undefined ? [] : ['s.directory = ?']),
      ...(options.excludeSessionId === undefined ? [] : ['s.id != ?']),
    ].join(' and ')
    const params = [
      ...terms.map((term) => `%${escapeLikeTerm(term)}%`),
      ...(options.after === undefined ? [] : [options.after]),
      ...(options.before === undefined ? [] : [options.before]),
      ...(options.directory === undefined ? [] : [options.directory]),
      ...(options.excludeSessionId === undefined ? [] : [options.excludeSessionId]),
      options.limit,
    ]
    const rows = this.#db
      .query<SearchRow, (string | number)[]>(`
        select
          s.id as sessionId,
          s.title as sessionTitle,
          s.directory as directory,
          m.id as messageId,
          p.id as partId,
          json_extract(m.data, '$.role') as role,
          m.time_created as timeCreated,
          json_extract(p.data, '$.text') as text
        from part p
        join message m on m.id = p.message_id
        join session s on s.id = p.session_id
        where json_extract(p.data, '$.type') = 'text'
          and ${conditions}
        order by m.time_created desc, p.id desc
        limit ?
      `)
      .all(...params)

    return rows
  }

  public lexicalSearch(query: string, options: SearchOptions): SearchRow[] {
    const terms = tokenizeQuery(query)

    if (terms.length === 0) {
      return []
    }

    const candidateLimit = Math.max(options.limit * 6_250, 50_000)
    const termConditions = terms.map(
      () =>
        `(lower(coalesce(s.title, '')) like ? escape '\\' or lower(coalesce(s.directory, '')) like ? escape '\\' or lower(json_extract(p.data, '$.text')) like ? escape '\\')`,
    )
    const conditions = [
      `(${termConditions.join(' or ')})`,
      ...(options.after === undefined ? [] : ['m.time_created >= ?']),
      ...(options.before === undefined ? [] : ['m.time_created <= ?']),
      ...(options.directory === undefined ? [] : ['s.directory = ?']),
      ...(options.excludeSessionId === undefined ? [] : ['s.id != ?']),
    ].join(' and ')
    const termParams = terms.flatMap((term) => {
      const pattern = `%${escapeLikeTerm(term)}%`
      return [pattern, pattern, pattern]
    })
    const params = [
      ...termParams,
      ...(options.after === undefined ? [] : [options.after]),
      ...(options.before === undefined ? [] : [options.before]),
      ...(options.directory === undefined ? [] : [options.directory]),
      ...(options.excludeSessionId === undefined ? [] : [options.excludeSessionId]),
      candidateLimit,
    ]
    const rows = this.#db
      .query<SearchRow, (string | number)[]>(`
        select
          s.id as sessionId,
          s.title as sessionTitle,
          s.directory as directory,
          m.id as messageId,
          p.id as partId,
          json_extract(m.data, '$.role') as role,
          m.time_created as timeCreated,
          json_extract(p.data, '$.text') as text,
          'text' as source
        from part p
        join message m on m.id = p.message_id
        join session s on s.id = p.session_id
        where json_extract(p.data, '$.type') = 'text'
          and json_extract(p.data, '$.text') is not null
          and ${conditions}
        order by m.time_created desc, p.id desc
        limit ?
      `)
      .all(...params)

    return rows
  }

  public recent(options: SearchOptions): SearchRow[] {
    const conditions = [
      "json_extract(p.data, '$.type') = 'text'",
      "json_extract(p.data, '$.text') is not null",
      ...(options.after === undefined ? [] : ['m.time_created >= ?']),
      ...(options.before === undefined ? [] : ['m.time_created <= ?']),
      ...(options.directory === undefined ? [] : ['s.directory = ?']),
      ...(options.excludeSessionId === undefined ? [] : ['s.id != ?']),
    ].join(' and ')
    const params = [
      ...(options.after === undefined ? [] : [options.after]),
      ...(options.before === undefined ? [] : [options.before]),
      ...(options.directory === undefined ? [] : [options.directory]),
      ...(options.excludeSessionId === undefined ? [] : [options.excludeSessionId]),
      options.limit,
    ]

    return this.#db
      .query<SearchRow, (string | number)[]>(`
        select
          s.id as sessionId,
          s.title as sessionTitle,
          s.directory as directory,
          m.id as messageId,
          p.id as partId,
          json_extract(m.data, '$.role') as role,
          m.time_created as timeCreated,
          json_extract(p.data, '$.text') as text,
          'text' as source
        from part p
        join message m on m.id = p.message_id
        join session s on s.id = p.session_id
        where ${conditions}
        order by m.time_created desc, p.id desc
        limit ?
      `)
      .all(...params)
  }

  public sessionIndex(options: SessionIndexOptions): SessionIndexRow[] {
    const conditions = [
      ...(options.after === undefined ? [] : ['coalesce(s.time_updated, 0) >= ?']),
      ...(options.before === undefined ? [] : ['coalesce(s.time_updated, 0) <= ?']),
      ...(options.directory === undefined ? [] : ['s.directory = ?']),
      ...(options.title === undefined ? [] : ["lower(coalesce(s.title, '')) like ? escape '\\'"]),
      ...(options.excludeSessionId === undefined ? [] : ['s.id != ?']),
    ]
    const where = conditions.length === 0 ? '' : `where ${conditions.join(' and ')}`
    const params = [
      ...(options.after === undefined ? [] : [options.after]),
      ...(options.before === undefined ? [] : [options.before]),
      ...(options.directory === undefined ? [] : [options.directory]),
      ...(options.title === undefined ? [] : [`%${escapeLikeTerm(options.title.toLowerCase())}%`]),
      ...(options.excludeSessionId === undefined ? [] : [options.excludeSessionId]),
      options.limit,
    ]

    return this.#db
      .query<SessionIndexRow, (string | number)[]>(`
        with message_stats as (
          select
            m.session_id as sessionId,
            min(m.time_created) as firstMessageAt,
            max(m.time_created) as lastMessageAt,
            count(*) as messageCount,
            sum(case when json_extract(m.data, '$.role') = 'user' then 1 else 0 end) as turns,
            sum(case when json_extract(m.data, '$.role') = 'assistant' then 1 else 0 end) as assistantMessages,
            sum(case when json_extract(m.data, '$.role') = 'tool' then 1 else 0 end) as toolMessages
          from message m
          group by m.session_id
        ),
        part_stats as (
          select
            p.session_id as sessionId,
            count(*) as textPartCount,
            sum(length(coalesce(json_extract(p.data, '$.text'), ''))) as approxContextChars
          from part p
          where json_extract(p.data, '$.type') = 'text'
            and json_extract(p.data, '$.text') is not null
          group by p.session_id
        )
        select
          s.id as sessionId,
          coalesce(s.title, '') as title,
          coalesce(s.directory, '') as directory,
          coalesce(s.time_updated, ms.lastMessageAt, 0) as updatedAt,
          ms.firstMessageAt as firstMessageAt,
          ms.lastMessageAt as lastMessageAt,
          coalesce(ms.messageCount, 0) as messageCount,
          coalesce(ms.turns, 0) as turns,
          coalesce(ms.assistantMessages, 0) as assistantMessages,
          coalesce(ms.toolMessages, 0) as toolMessages,
          coalesce(ps.textPartCount, 0) as textPartCount,
          coalesce(ps.approxContextChars, 0) as approxContextChars
        from session s
        left join message_stats ms on ms.sessionId = s.id
        left join part_stats ps on ps.sessionId = s.id
        ${where}
        order by updatedAt desc, s.id desc
        limit ?
      `)
      .all(...params)
  }

  public readTextPartsForIndex(since: number | undefined): IndexSourceRow[] {
    // OpenCode advances session.time_updated when its messages or parts change.
    // Starting incremental reads from those sessions lets SQLite use the
    // session indexes instead of scanning every JSON part in the history DB.
    const changedCondition = since === undefined ? '' : 'and coalesce(s.time_updated, 0) >= ?'
    const params = since === undefined ? [] : [since]

    const textRows = this.#db
      .query<IndexSourceRow, number[]>(`
        with changed_sessions as materialized (
          select s.id, s.title, s.directory, s.time_updated
          from session s
          where 1 = 1
            ${changedCondition}
        )
        select
          s.id as sessionId,
          s.title as sessionTitle,
          s.directory as directory,
          m.id as messageId,
          p.id as partId,
          json_extract(m.data, '$.role') as role,
          m.time_created as timeCreated,
          json_extract(p.data, '$.text') as text,
          'text' as source,
          max(coalesce(p.time_updated, 0), coalesce(m.time_updated, 0), coalesce(s.time_updated, 0)) as sourceUpdated
        from changed_sessions s
        cross join part p on p.session_id = s.id
        join message m on m.id = p.message_id
        where json_extract(p.data, '$.type') = 'text'
          and json_extract(p.data, '$.text') is not null
        order by sourceUpdated, p.id
      `)
      .all(...params)

    return [...textRows, ...this.readSessionTitleRowsForIndex(since)]
  }

  public readLatestEventCursor(): HistoryEventCursor | undefined {
    if (!this.#hasTable('event')) {
      return undefined
    }

    const row = this.#db
      .query<{ readonly rowId: number; readonly eventId: string }, []>(`
        select rowid as rowId, id as eventId
        from event
        order by rowid desc
        limit 1
      `)
      .get()

    return row ?? { rowId: 0, eventId: '' }
  }

  public readIndexChanges(cursor: HistoryEventCursor | undefined): HistoryIndexChanges {
    if (!this.#hasTable('event')) {
      return { mode: 'legacy', sessionIds: [], rows: [] }
    }

    return this.#db.transaction(() => {
      const latest = this.#readLatestEventCursor()
      if (cursor === undefined || !this.#eventCursorMatches(cursor, latest)) {
        return {
          mode: 'full' as const,
          cursor: latest,
          sessionIds: [],
          rows: this.readTextPartsForIndex(undefined),
        }
      }

      const sessionIds = this.readChangedSessionIds(cursor.rowId, latest.rowId)
      return {
        mode: 'incremental' as const,
        cursor: latest,
        sessionIds,
        rows: this.readTextPartsForSessions(sessionIds),
      }
    })()
  }

  public eventCursorMatches(cursor: HistoryEventCursor): boolean {
    if (!this.#hasTable('event')) {
      return false
    }

    return this.#eventCursorMatches(cursor, this.#readLatestEventCursor())
  }

  #eventCursorMatches(cursor: HistoryEventCursor, latest: HistoryEventCursor): boolean {
    if (cursor.rowId === 0) {
      return cursor.eventId === ''
    }

    if (latest.rowId < cursor.rowId) {
      return false
    }

    const row = this.#db
      .query<{ readonly eventId: string }, [number]>(
        'select id as eventId from event where rowid = ?',
      )
      .get(cursor.rowId)

    if (row !== null) {
      return row.eventId === cursor.eventId
    }

    return false
  }

  public readChangedSessionIds(afterRowId: number, throughRowId: number): string[] {
    if (throughRowId <= afterRowId) {
      return []
    }

    return this.#db
      .query<{ readonly sessionId: string }, [number, number]>(`
        select distinct aggregate_id as sessionId
        from event not indexed
        where rowid > ? and rowid <= ?
          and (type glob 'session.*' or type glob 'message.*')
          and aggregate_id glob 'ses_*'
        order by aggregate_id
      `)
      .all(afterRowId, throughRowId)
      .map((row) => row.sessionId)
  }

  public readSessionIds(): string[] {
    return this.#db
      .query<{ readonly sessionId: string }, []>('select id as sessionId from session')
      .all()
      .map((row) => row.sessionId)
  }

  public readTextPartsForSessions(sessionIds: readonly string[]): IndexSourceRow[] {
    if (sessionIds.length === 0) {
      return []
    }

    const rows: IndexSourceRow[] = []
    for (const batch of batches(sessionIds)) {
      const placeholders = batch.map(() => '?').join(',')
      const textRows = this.#db
        .query<IndexSourceRow, string[]>(`
          select
            s.id as sessionId,
            s.title as sessionTitle,
            s.directory as directory,
            m.id as messageId,
            p.id as partId,
            json_extract(m.data, '$.role') as role,
            m.time_created as timeCreated,
            json_extract(p.data, '$.text') as text,
            'text' as source,
            max(coalesce(p.time_updated, 0), coalesce(m.time_updated, 0), coalesce(s.time_updated, 0)) as sourceUpdated
          from session s
          cross join part p on p.session_id = s.id
          join message m on m.id = p.message_id
          where s.id in (${placeholders})
            and json_extract(p.data, '$.type') = 'text'
            and json_extract(p.data, '$.text') is not null
          order by s.id, p.id
        `)
        .all(...batch)
      rows.push(...textRows, ...this.#readSessionTitleRowsForSessions(batch))
    }

    return rows
  }

  public readSessionTitleRowsForIndex(since: number | undefined): IndexSourceRow[] {
    const changedCondition = since === undefined ? '' : 'where coalesce(s.time_updated, 0) >= ?'
    const params = since === undefined ? [] : [since]

    return this.#db
      .query<IndexSourceRow, number[]>(`
        select
          s.id as sessionId,
          s.title as sessionTitle,
          s.directory as directory,
          fm.id as messageId,
          'session-title:' || s.id as partId,
          coalesce(json_extract(fm.data, '$.role'), 'user') as role,
          coalesce(fm.time_created, s.time_updated) as timeCreated,
          trim('Title: ' || coalesce(s.title, '') || char(10) || 'Directory: ' || coalesce(s.directory, '')) as text,
          'session-title' as source,
          coalesce(s.time_updated, 0) as sourceUpdated
        from session s
        join message fm on fm.id = (
          select m.id
          from message m
          where m.session_id = s.id
          order by m.time_created, m.id
          limit 1
        )
        ${changedCondition}
        order by sourceUpdated, s.id
      `)
      .all(...params)
  }

  public readTextPartIds(): string[] {
    const rows = this.#db
      .query<{ readonly partId: string }, []>(`
        select p.id as partId
        from part p
        where json_extract(p.data, '$.type') = 'text'
          and json_extract(p.data, '$.text') is not null
      `)
      .all()

    return [...rows.map((row) => row.partId), ...this.readSessionTitlePartIds()]
  }

  public readSessionTitlePartIds(): string[] {
    const rows = this.#db
      .query<{ readonly partId: string }, []>(`
        select 'session-title:' || s.id as partId
        from session s
        where exists (select 1 from message m where m.session_id = s.id)
      `)
      .all()

    return rows.map((row) => row.partId)
  }

  #readSessionTitleRowsForSessions(sessionIds: readonly string[]): IndexSourceRow[] {
    const placeholders = sessionIds.map(() => '?').join(',')
    return this.#db
      .query<IndexSourceRow, string[]>(`
        select
          s.id as sessionId,
          s.title as sessionTitle,
          s.directory as directory,
          fm.id as messageId,
          'session-title:' || s.id as partId,
          coalesce(json_extract(fm.data, '$.role'), 'user') as role,
          coalesce(fm.time_created, s.time_updated) as timeCreated,
          trim('Title: ' || coalesce(s.title, '') || char(10) || 'Directory: ' || coalesce(s.directory, '')) as text,
          'session-title' as source,
          coalesce(s.time_updated, 0) as sourceUpdated
        from session s
        join message fm on fm.id = (
          select m.id
          from message m
          where m.session_id = s.id
          order by m.time_created, m.id
          limit 1
        )
        where s.id in (${placeholders})
        order by s.id
      `)
      .all(...sessionIds)
  }

  #hasTable(name: string): boolean {
    return (
      this.#db
        .query<{ readonly present: number }, [string]>(`
          select 1 as present
          from sqlite_master
          where type = 'table' and name = ?
        `)
        .get(name) !== null
    )
  }

  #readLatestEventCursor(): HistoryEventCursor {
    const row = this.#db
      .query<{ readonly rowId: number; readonly eventId: string }, []>(`
        select rowid as rowId, id as eventId
        from event
        order by rowid desc
        limit 1
      `)
      .get()

    return row ?? { rowId: 0, eventId: '' }
  }

  public readWindowForSession(sessionId: string, options: ReadOptions): WindowRows {
    const anchor = this.#db
      .query<{ readonly messageId: string }, [string]>(`
        select id as messageId
        from message
        where session_id = ?
        order by time_created, id
        limit 1
      `)
      .get(sessionId)

    if (anchor === null) {
      throw new Error(`History session cursor points to missing or empty session: ${sessionId}`)
    }

    return this.readWindow(anchor.messageId, options)
  }

  public readSession(sessionId: string): WindowRows {
    const totalMessages = countMessages(this.#db, sessionId)

    if (totalMessages === 0) {
      throw new Error(`History session cursor points to missing or empty session: ${sessionId}`)
    }

    return this.readWindowForSession(sessionId, { mode: 'head', limit: totalMessages })
  }

  public readWindow(anchorMessageId: string, options: ReadOptions): WindowRows {
    const anchor = this.#db
      .query<
        MessageRow & {
          readonly sessionId: string
          readonly title: string
          readonly directory: string
        },
        [string]
      >(`
        with ordered as (
          select
            m.id as messageId,
            m.session_id as sessionId,
            s.title as title,
            s.directory as directory,
            json_extract(m.data, '$.role') as role,
            m.time_created as timeCreated,
            row_number() over (partition by m.session_id order by m.time_created, m.id) as messageIndex
          from message m
          join session s on s.id = m.session_id
        )
        select * from ordered where messageId = ?
      `)
      .get(anchorMessageId)

    if (anchor === null) {
      throw new Error(`History cursor points to missing message: ${anchorMessageId}`)
    }

    const totalMessages = countMessages(this.#db, anchor.sessionId)
    const range = getReadRange(anchor.messageIndex, totalMessages, options)
    const messages = this.#db
      .query<MessageRow, [string, number, number]>(`
        with ordered as (
          select
            m.id as messageId,
            json_extract(m.data, '$.role') as role,
            m.time_created as timeCreated,
            row_number() over (partition by m.session_id order by m.time_created, m.id) as messageIndex
          from message m
          where m.session_id = ?
        )
        select * from ordered
        where messageIndex between ? and ?
        order by messageIndex
      `)
      .all(anchor.sessionId, range.start, range.end)

    const messageIds = messages.map((message) => message.messageId)
    const parts = readParts(this.#db, messageIds)
    const lastIndex = messages.at(-1)?.messageIndex ?? anchor.messageIndex

    return {
      sessionId: anchor.sessionId,
      title: anchor.title,
      directory: anchor.directory,
      mode: options.mode,
      anchorMessageId: anchor.messageId,
      anchorTimeCreated: anchor.timeCreated,
      anchorIndex: anchor.messageIndex,
      messages,
      parts,
      hasPrevious: range.start > 1,
      hasNext: hasMessageAfter(this.#db, anchor.sessionId, lastIndex),
      totalMessages,
    }
  }
}

const SQLITE_BATCH_SIZE = 500

function batches(values: readonly string[]): readonly string[][] {
  const output: string[][] = []
  for (let index = 0; index < values.length; index += SQLITE_BATCH_SIZE) {
    output.push(values.slice(index, index + SQLITE_BATCH_SIZE))
  }
  return output
}

function getReadRange(
  anchorIndex: number,
  totalMessages: number,
  options: ReadOptions,
): { readonly start: number; readonly end: number } {
  switch (options.mode) {
    case 'next':
      return { start: anchorIndex + 1, end: anchorIndex + options.limit }
    case 'around':
      return {
        start: Math.max(1, anchorIndex - Math.floor(options.limit / 2)),
        end: anchorIndex + Math.ceil(options.limit / 2) - 1,
      }
    case 'prev':
      return { start: Math.max(1, anchorIndex - options.limit), end: anchorIndex - 1 }
    case 'head':
      return { start: 1, end: options.limit }
    case 'tail':
      return { start: Math.max(1, totalMessages - options.limit + 1), end: totalMessages }
    default: {
      const exhaustive: never = options.mode
      throw new Error(`Unsupported read mode: ${String(exhaustive)}`)
    }
  }
}

function readParts(db: Database, messageIds: readonly string[]): PartRow[] {
  if (messageIds.length === 0) {
    return []
  }

  const placeholders = messageIds.map(() => '?').join(',')
  return db
    .query<PartRow, string[]>(`
      select id, message_id as messageId, data
      from part
      where message_id in (${placeholders})
      order by message_id, id
    `)
    .all(...messageIds)
}

function hasMessageAfter(db: Database, sessionId: string, index: number): boolean {
  const row = db
    .query<{ readonly count: number }, [string, number]>(`
      with ordered as (
        select row_number() over (partition by session_id order by time_created, id) as messageIndex
        from message
        where session_id = ?
      )
      select count(*) as count from ordered where messageIndex > ?
    `)
    .get(sessionId, index)

  return (row?.count ?? 0) > 0
}

function countMessages(db: Database, sessionId: string): number {
  const row = db
    .query<{ readonly count: number }, [string]>(
      'select count(*) as count from message where session_id = ?',
    )
    .get(sessionId)

  return row?.count ?? 0
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(WHITESPACE_REGEX)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 8)
}

function escapeLikeTerm(term: string): string {
  return term.replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function defaultOpenCodeDbPath(): string {
  return loadConfig().database.path
}
