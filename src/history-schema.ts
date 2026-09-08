import type { Database } from './sqlite.js'

/** Read the host's materialized projection, never replay events or mutate its database. */
export function installHistorySchema(db: Database): void {
  const tables = new Set(
    db
      .query<{ name: string }>("select name from main.sqlite_master where type = 'table'")
      .all()
      .map((row) => row.name),
  )
  const legacy = ['session', 'message', 'part'].every((name) => tables.has(name))
  const native = ['session_v2', 'session_message'].every((name) => tables.has(name))
  if (!(legacy || native))
    throw new Error(
      'Unsupported OpenCode history schema: expected V1 history tables or V2 session projections',
    )
  const sessions = legacy ? 'select id, title, directory, time_updated from main.session' : ''
  const messages = legacy
    ? 'select id, session_id, data, time_created, time_updated, time_created as history_order from main.message'
    : ''
  const parts = legacy ? 'select id, message_id, session_id, data, time_updated from main.part' : ''
  if (!native) {
    db.exec(`create temp view message as ${messages}`)
    return
  }
  db.function('recall_v2_parts', projectionParts)
  // V2 IDs remain canonical. A database containing an old copy of a migrated
  // session must not expose that copy as a second transcript.
  const oldSessions = legacy
    ? `${sessions} where id not in (select id from main.session_v2) union all `
    : ''
  const oldMessages = legacy
    ? `${messages} where session_id not in (select id from main.session_v2) union all `
    : ''
  const oldParts = legacy
    ? `${parts} where session_id not in (select id from main.session_v2) union all `
    : ''
  db.exec(`
    create temp view session as ${oldSessions}
      select s.id, s.title, s.directory,
        max(s.time_updated, coalesce((select max(m.time_updated) from main.session_message m where m.session_id = s.id), 0)) as time_updated
      from main.session_v2 s;
    create temp view message as ${oldMessages}
      select id, session_id,
        json_object('role', case type when 'assistant' then 'assistant' when 'system' then 'system'
          when 'location-switched' then 'system' when 'shell' then 'tool' else 'user' end) as data,
        time_created, time_updated, seq as history_order
      from main.session_message where type not in ('agent-switched', 'model-switched');
    create temp view part as ${oldParts}
      select m.id || ':' || printf('%08d', p.key) as id, m.id as message_id, m.session_id,
        p.value as data, m.time_updated
      from main.session_message m, json_each(recall_v2_parts(m.type, m.data)) p;
  `)
}

type RecordValue = Partial<
  Record<
    | 'name'
    | 'mime'
    | 'state'
    | 'content'
    | 'type'
    | 'text'
    | 'error'
    | 'id'
    | 'input'
    | 'status'
    | 'skills'
    | 'files'
    | 'snapshot'
    | 'end'
    | 'shellID'
    | 'command'
    | 'output'
    | 'location'
    | 'directory'
    | 'summary'
    | 'recent'
    | 'filename'
    | 'tool'
    | 'callID'
    | 'hash',
    unknown
  >
>
function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {}
}
function array(value: unknown): RecordValue[] {
  return Array.isArray(value) ? value.map(record) : []
}
function text(value: unknown): RecordValue[] {
  return typeof value === 'string' && value.length > 0 ? [{ type: 'text', text: value }] : []
}
function file(value: RecordValue): RecordValue {
  // Attachments stay identifiable without copying base64 payloads into recall.
  return { type: 'file', filename: value.name, mime: value.mime }
}
function tool(value: RecordValue): RecordValue {
  const state = record(value.state)
  const content = array(state.content)
    .map((part) => (part.type === 'text' ? part.text : `[${String(part.type)} attachment omitted]`))
    .join('\n')
  const error = state.error === undefined ? undefined : JSON.stringify(state.error)
  return {
    type: 'tool',
    tool: value.name,
    callID: value.id,
    state: {
      input: state.input,
      status:
        state.status === 'error'
          ? 'failed'
          : state.status === 'streaming'
            ? 'pending'
            : state.status,
      output: content || error,
    },
  }
}

/** Match native SessionMessage semantics while keeping the common transcript model. */
export function projectionParts(type: string, data: string): string {
  const value = record(JSON.parse(data))
  let parts: RecordValue[] = []
  switch (type) {
    case 'user':
      parts = [
        ...array(value.skills).flatMap((skill) => text(skill.text)),
        ...text(value.text),
        ...array(value.files).map(file),
      ]
      break
    case 'assistant': {
      parts = array(value.content).flatMap((part) =>
        part.type === 'tool' ? [tool(part)] : part.type === 'text' ? text(part.text) : [],
      )
      const snapshot = record(value.snapshot)
      if (Array.isArray(snapshot.files))
        parts.push({ type: 'patch', hash: snapshot.end, files: snapshot.files })
      if (value.error !== undefined)
        parts.push({ type: 'text', text: `[Assistant error] ${JSON.stringify(value.error)}` })
      break
    }
    case 'system':
    case 'skill':
      parts = text(value.text)
      break
    case 'synthetic':
      parts = text(`[Synthetic context] ${String(value.text ?? '')}`)
      break
    case 'shell':
      parts = [
        {
          type: 'tool',
          tool: 'shell',
          callID: value.shellID,
          state: {
            input: { command: value.command },
            status:
              value.status === 'completed'
                ? 'completed'
                : value.status === 'running'
                  ? 'running'
                  : 'failed',
            output: record(value.output).output,
          },
        },
      ]
      break
    case 'location-switched':
      parts = text(`[Working directory changed] ${String(record(value.location).directory ?? '')}`)
      break
    case 'compaction':
      parts = text(
        `[Conversation checkpoint: ${String(value.status)}]\n${String(value.summary ?? '')}\n${String(value.recent ?? '')}`,
      )
      break
    default:
      break
  }
  return JSON.stringify(parts)
}
