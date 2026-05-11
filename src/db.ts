import { Database } from 'bun:sqlite'

const WHITESPACE_REGEX = /\s+/u

export interface SearchOptions {
  readonly limit: number
  readonly after?: number
  readonly before?: number
}

export type ReadMode = 'around' | 'full' | 'head' | 'next' | 'prev' | 'tail'

export interface ReadOptions {
  readonly mode: ReadMode
  readonly limit: number
  readonly fullLimit: number
}

export interface SearchRow {
  readonly sessionId: string
  readonly sessionTitle: string
  readonly directory: string
  readonly messageId: string
  readonly partId: string
  readonly role: string
  readonly timeCreated: number
  readonly text: string
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
    ].join(' and ')
    const params = [
      ...terms.map((term) => `%${escapeLikeTerm(term)}%`),
      ...(options.after === undefined ? [] : [options.after]),
      ...(options.before === undefined ? [] : [options.before]),
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
    case 'full':
      return { start: 1, end: Math.min(totalMessages, options.fullLimit) }
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
  const { OPENCODE_DB_PATH: configured } = process.env

  if (configured !== undefined && configured.length > 0) {
    return configured
  }

  const { HOME: homePath, USERPROFILE: userProfile } = process.env
  const home = homePath ?? userProfile

  if (home === undefined || home.length === 0) {
    throw new Error('Cannot resolve OpenCode database path without HOME or OPENCODE_DB_PATH')
  }

  return `${home}/.local/share/opencode/opencode.db`
}
