import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import { ChatmlRenderer } from './chatml-renderer.js'
import { decodeCursor } from './cursor.js'
import { HistoryDatabase, type SessionIndexRow } from './db.js'
import { OllamaEmbeddingProvider } from './embedding.js'
import { normalizeWindow } from './normalizer.js'
import { parseReadMode } from './read-mode.js'
import { formatSearchResult, formatSearchResults, rankSearchRows } from './search.js'
import { RecallSidecarIndex } from './sidecar.js'
import {
  DEFAULT_READ_LIMIT,
  DEFAULT_SEARCH_FRESHNESS_EXCLUSION_MS,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SESSION_INDEX_LIMIT,
  MAX_READ_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SESSION_INDEX_LIMIT,
} from './tool-defaults.js'
import type { TranscriptMessage, TranscriptPart, TranscriptWindow } from './transcript.js'
import type { HistoryWorkerRequest, SessionSaveWorkerArgs } from './worker-protocol.js'

export async function executeWorkerRequest(request: HistoryWorkerRequest): Promise<string> {
  if (request.kind === 'search') {
    return executeHistorySearch(request)
  }

  if (request.kind === 'session-index') {
    return executeSessionIndex(request)
  }

  if (request.kind === 'session-save') {
    return executeSessionSave(request)
  }

  const window = executeHistoryReadWindow(request)

  if (request.kind === 'read-window') {
    return JSON.stringify(window)
  }

  return new ChatmlRenderer().render(window)
}

async function executeSessionSave(
  request: Extract<HistoryWorkerRequest, { readonly kind: 'session-save' }>,
): Promise<string> {
  const cursorValue = request.args.cursor

  if (cursorValue === undefined || cursorValue.length === 0) {
    throw new Error('session_save requires cursor')
  }

  const cursor = decodeCursor(cursorValue)

  if (cursor.sessionId === undefined || cursor.messageId !== undefined) {
    throw new Error('session_save requires a ses_* cursor')
  }

  const destination = resolveWorkspacePath(request.context.directory, request.args.path)
  const format = parseSessionSaveFormat(request.args.format)
  const db = new HistoryDatabase(request.args.historyDbPath)

  try {
    const window = normalizeWindow(db.readSession(cursor.sessionId))
    const content = renderSavedSession(window, format)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content, 'utf-8')

    return JSON.stringify({
      path: relative(resolve(request.context.directory), destination),
      bytes: Buffer.byteLength(content, 'utf-8'),
      messages: window.messages.length,
    })
  } finally {
    db.close()
  }
}

function executeSessionIndex(
  request: Extract<HistoryWorkerRequest, { readonly kind: 'session-index' }>,
): string {
  const includeCurrentSession = request.args.includeCurrentSession === true
  const before = optionalDateFilterValue('before', request.args.before)
  const excludeSessionId = currentSessionExclusion(
    includeCurrentSession,
    request.context.sessionID,
    request.args.excludeSessionId,
  )
  const options = {
    limit: clampNumber(request.args.n, DEFAULT_SESSION_INDEX_LIMIT, 1, MAX_SESSION_INDEX_LIMIT),
    ...optionalStringFilter('directory', request.args.directory),
    ...optionalStringFilter('title', request.args.title),
    ...(excludeSessionId === undefined ? {} : { excludeSessionId }),
    ...optionalDateFilter('after', request.args.after),
    ...searchBeforeFilter(before, includeCurrentSession, request.context.sessionID),
  }
  const db = new HistoryDatabase(request.args.historyDbPath)

  try {
    return formatSessionIndexResponse(request, db.sessionIndex(options))
  } finally {
    db.close()
  }
}

async function executeHistorySearch(
  request: Extract<HistoryWorkerRequest, { readonly kind: 'search' }>,
): Promise<string> {
  const query = request.args.q ?? ''
  const includeCurrentSession = request.args.includeCurrentSession === true
  const semanticEnabled = request.args.semantic !== false
  const lexicalEnabled = request.args.lexical !== false
  const shouldSync = (semanticEnabled || lexicalEnabled) && request.args.sync !== false
  const before = optionalDateFilterValue('before', request.args.before)
  const excludeSessionId = currentSessionExclusion(
    includeCurrentSession,
    request.context.sessionID,
    request.args.excludeSessionId,
  )
  const maxSearchLimit = request.args.maxSearchLimit ?? MAX_SEARCH_LIMIT
  const options = {
    limit: clampNumber(request.args.n, DEFAULT_SEARCH_LIMIT, 1, maxSearchLimit),
    ...optionalStringFilter('directory', request.args.directory),
    ...(excludeSessionId === undefined ? {} : { excludeSessionId }),
    ...optionalDateFilter('after', request.args.after),
    ...searchBeforeFilter(before, includeCurrentSession, request.context.sessionID),
  }
  const db = new HistoryDatabase(request.args.historyDbPath)
  const sidecar = new RecallSidecarIndex(request.args.sidecarDbPath)

  try {
    if (query.trim().length === 0) {
      const rows = db.recent(options)
      return formatSearchResponse(request, rows)
    }

    const syncStart = performance.now()
    const provider = semanticEnabled ? new OllamaEmbeddingProvider() : undefined
    const syncResult = shouldSync
      ? semanticEnabled && provider !== undefined
        ? await sidecar.sync(
            (since) => db.readTextPartsForIndex(since),
            provider,
            () => db.readTextPartIds(),
          )
        : {
            ...sidecar.syncLexicalOnly(
              (since) => db.readTextPartsForIndex(since),
              () => db.readTextPartIds(),
            ),
            elapsedMs: performance.now() - syncStart,
          }
      : undefined
    const [semanticRows, lexicalRows] = await Promise.all([
      semanticEnabled && provider !== undefined
        ? sidecar.search(query, options, provider)
        : Promise.resolve([]),
      Promise.resolve(lexicalEnabled ? sidecar.lexicalSearch(query, options) : []),
    ])
    const rows = rankSearchRows(query, [...lexicalRows, ...semanticRows], options.limit)
    return formatSearchResponse(request, rows, syncResult)
  } finally {
    sidecar.close()
    db.close()
  }
}

function executeHistoryReadWindow(
  request: Extract<HistoryWorkerRequest, { readonly kind: 'read' | 'read-window' }>,
): TranscriptWindow {
  const cursorValue = request.args.cursor

  if (cursorValue === undefined || cursorValue.length === 0) {
    throw new Error('history_read requires cursor')
  }

  const cursor = decodeCursor(cursorValue)
  const mode = parseReadMode(request.args.mode)
  const limit = clampNumber(request.args.n, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT)
  const db = new HistoryDatabase(request.args.historyDbPath)

  try {
    const readOptions = { mode, limit }
    return normalizeWindow(
      cursor.messageId === undefined
        ? db.readWindowForSession(requiredSessionId(cursor.sessionId), readOptions)
        : db.readWindow(cursor.messageId, readOptions),
    )
  } finally {
    db.close()
  }
}

function optionalDateFilter(name: 'after', value: string | undefined) {
  const timestamp = optionalDateFilterValue(name, value)

  if (timestamp === undefined) {
    return {}
  }

  return { [name]: timestamp }
}

function optionalDateFilterValue(name: 'after' | 'before', value: string | undefined) {
  if (value === undefined || value.length === 0) {
    return undefined
  }

  const timestamp = optionalTimestamp(value)

  if (timestamp === undefined) {
    throw new Error(`Invalid ${name} date filter: ${value}`)
  }

  return timestamp
}

function optionalTimestamp(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined
  }

  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function optionalStringFilter<TName extends string>(name: TName, value: string | undefined) {
  if (value === undefined || value.length === 0) {
    return {}
  }

  return { [name]: value }
}

function currentSessionExclusion(
  includeCurrentSession: boolean | undefined,
  sessionID: string,
  excludeSessionId: string | undefined,
): string | undefined {
  if (includeCurrentSession === true) {
    return excludeSessionId
  }

  const effective = excludeSessionId ?? sessionID
  return effective.length === 0 ? undefined : effective
}

function searchBeforeFilter(
  before: number | undefined,
  includeCurrentSession: boolean,
  currentSessionId: string,
) {
  if (before !== undefined) {
    return { before }
  }

  if (includeCurrentSession || currentSessionId.length === 0) {
    return {}
  }

  return { before: Date.now() - DEFAULT_SEARCH_FRESHNESS_EXCLUSION_MS }
}

function formatSearchResponse(
  request: Extract<HistoryWorkerRequest, { readonly kind: 'search' }>,
  rows: readonly Parameters<typeof formatSearchResult>[0][],
  syncResult?: Parameters<typeof formatSearchResults>[1],
): string {
  if (request.args.format === 'json') {
    return JSON.stringify({
      hits: rows.map(formatSearchResult),
      ...(syncResult === undefined ? {} : { sync: syncResult }),
    })
  }

  return formatSearchResults(rows, syncResult)
}

function formatSessionIndexResponse(
  request: Extract<HistoryWorkerRequest, { readonly kind: 'session-index' }>,
  rows: readonly SessionIndexRow[],
): string {
  const results = rows.map(formatSessionIndexRow)

  if (request.args.format === 'json') {
    return JSON.stringify({ sessions: results })
  }

  if (results.length === 0) {
    return 'No OpenCode history sessions found.'
  }

  return JSON.stringify(results, null, 2)
}

function formatSessionIndexRow(row: SessionIndexRow): {
  readonly cursor: string
  readonly sid: string
  readonly title: string
  readonly directory: string
  readonly updated: string
  readonly firstMessage?: string
  readonly lastMessage?: string
  readonly messages: number
  readonly turns: number
  readonly assistantMessages: number
  readonly toolMessages: number
  readonly textParts: number
  readonly approxContextChars: number
} {
  return {
    cursor: row.sessionId,
    sid: row.sessionId,
    title: row.title,
    directory: row.directory,
    updated: new Date(row.updatedAt).toISOString(),
    ...(row.firstMessageAt === null
      ? {}
      : { firstMessage: new Date(row.firstMessageAt).toISOString() }),
    ...(row.lastMessageAt === null
      ? {}
      : { lastMessage: new Date(row.lastMessageAt).toISOString() }),
    messages: row.messageCount,
    turns: row.turns,
    assistantMessages: row.assistantMessages,
    toolMessages: row.toolMessages,
    textParts: row.textPartCount,
    approxContextChars: row.approxContextChars,
  }
}

function parseSessionSaveFormat(
  format: SessionSaveWorkerArgs['format'],
): 'chatml' | 'markdown' | 'jsonl' {
  if (format === undefined) {
    return 'chatml'
  }

  if (format === 'chatml' || format === 'markdown' || format === 'jsonl') {
    return format
  }

  throw new Error(`Unsupported session_save format: ${String(format)}`)
}

function resolveWorkspacePath(directory: string, path: string | undefined): string {
  if (path === undefined || path.length === 0) {
    throw new Error('session_save requires path')
  }

  if (isAbsolute(path)) {
    throw new Error('session_save path must be workspace-relative')
  }

  const root = resolve(directory)
  const destination = resolve(root, path)
  const relativePath = relative(root, destination)

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('session_save path must stay inside workspace')
  }

  return destination
}

function renderSavedSession(
  window: TranscriptWindow,
  format: 'chatml' | 'markdown' | 'jsonl',
): string {
  if (format === 'chatml') {
    return new ChatmlRenderer().render(window)
  }

  if (format === 'jsonl') {
    return `${window.messages.map((message) => JSON.stringify(message)).join('\n')}\n`
  }

  return renderMarkdownSession(window)
}

function renderMarkdownSession(window: TranscriptWindow): string {
  const lines = [
    `# ${window.title ?? window.sessionId}`,
    '',
    `Session: \`${window.sessionId}\``,
    `Directory: \`${window.directory}\``,
    `Messages: ${window.messages.length}`,
  ]

  for (const message of window.messages) {
    lines.push('', renderMarkdownMessage(message))
  }

  return `${lines.join('\n')}\n`
}

function renderMarkdownMessage(message: TranscriptMessage): string {
  const lines = [
    `## ${message.index}. ${message.role}`,
    '',
    `id: \`${message.id}\`  `,
    `time: \`${new Date(message.timeCreated).toISOString()}\``,
  ]

  for (const part of message.parts) {
    lines.push('', renderMarkdownPart(part))
  }

  return lines.join('\n')
}

function renderMarkdownPart(part: TranscriptPart): string {
  switch (part.type) {
    case 'file':
      return `[file omitted: ${part.filename ?? 'unnamed'}, ${part.chars} chars]`
    case 'patch':
      return ['```text', ...part.files, '```'].join('\n')
    case 'text':
      return part.text
    case 'tool':
      return [
        `tool: \`${part.toolName}\` (${part.status})`,
        '',
        '```json',
        part.input,
        '```',
        ...(part.output === undefined ? [] : ['', '```text', part.output, '```']),
      ].join('\n')
    default: {
      const exhaustive: never = part
      throw new Error(`Unsupported transcript part: ${String(exhaustive)}`)
    }
  }
}

function clampNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback
  }

  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function requiredSessionId(value: string | undefined): string {
  if (value !== undefined) {
    return value
  }

  throw new Error('History cursor does not contain a message or session id')
}
