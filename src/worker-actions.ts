import { ChatmlRenderer } from './chatml-renderer.js'
import { decodeCursor } from './cursor.js'
import { HistoryDatabase } from './db.js'
import { OllamaEmbeddingProvider } from './embedding.js'
import { normalizeWindow } from './normalizer.js'
import { parseReadMode } from './read-mode.js'
import { formatSearchResults, rankSearchRows } from './search.js'
import { RecallSidecarIndex } from './sidecar.js'
import {
  DEFAULT_READ_LIMIT,
  DEFAULT_SEARCH_FRESHNESS_EXCLUSION_MS,
  DEFAULT_SEARCH_LIMIT,
  MAX_READ_LIMIT,
  MAX_SEARCH_LIMIT,
} from './tool-defaults.js'
import type { HistoryWorkerRequest } from './worker-protocol.js'

export async function executeWorkerRequest(request: HistoryWorkerRequest): Promise<string> {
  if (request.kind === 'search') {
    return executeHistorySearch(request)
  }

  return executeHistoryRead(request)
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
  const options = {
    limit: clampNumber(request.args.n, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT),
    ...optionalStringFilter('directory', request.args.directory),
    ...currentSessionExclusion(
      includeCurrentSession,
      request.context.sessionID,
      request.args.excludeSessionId,
    ),
    ...optionalDateFilter('after', request.args.after),
    ...searchBeforeFilter(before, includeCurrentSession),
  }
  const db = new HistoryDatabase(request.args.historyDbPath)
  const sidecar = new RecallSidecarIndex(request.args.sidecarDbPath)

  try {
    if (query.trim().length === 0) {
      return formatSearchResults(db.recent(options))
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
    return formatSearchResults(rows, syncResult)
  } finally {
    sidecar.close()
    db.close()
  }
}

function executeHistoryRead(
  request: Extract<HistoryWorkerRequest, { readonly kind: 'read' }>,
): string {
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
    const window = normalizeWindow(
      cursor.messageId === undefined
        ? db.readWindowForSession(requiredSessionId(cursor.sessionId), readOptions)
        : db.readWindow(cursor.messageId, readOptions),
    )
    return new ChatmlRenderer().render(window)
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
) {
  if (includeCurrentSession === true) {
    return excludeSessionId === undefined ? {} : { excludeSessionId }
  }

  return { excludeSessionId: excludeSessionId ?? sessionID }
}

function searchBeforeFilter(before: number | undefined, includeCurrentSession: boolean) {
  if (before !== undefined) {
    return { before }
  }

  if (includeCurrentSession) {
    return {}
  }

  return { before: Date.now() - DEFAULT_SEARCH_FRESHNESS_EXCLUSION_MS }
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
