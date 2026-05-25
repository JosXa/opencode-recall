import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin'

import { ChatmlRenderer } from './src/chatml-renderer'
import { HISTORY_READ_COMMAND, HISTORY_SEARCH_COMMAND } from './src/commands'
import { decodeCursor } from './src/cursor'
import { HistoryDatabase, type ReadMode } from './src/db'
import { OllamaEmbeddingProvider } from './src/embedding'
import { normalizeWindow } from './src/normalizer'
import { formatSearchResults, rankSearchRows } from './src/search'
import { RecallSidecarIndex } from './src/sidecar'

const DEFAULT_SEARCH_LIMIT = 8
const MAX_SEARCH_LIMIT = 25
const DEFAULT_SEARCH_FRESHNESS_EXCLUSION_MS = 30_000
const DEFAULT_READ_LIMIT = 12
const DEFAULT_FULL_LIMIT = 200
const MAX_READ_LIMIT = 50
const MAX_FULL_LIMIT = 500

export const RecallPlugin: Plugin = async () => {
  return {
    config: async (config) => {
      config.command ??= {}
      config.command[HISTORY_SEARCH_COMMAND] = {
        description: 'Search OpenCode history and return ranked cursor anchors',
        template: '',
      }

      config.command[HISTORY_READ_COMMAND] = {
        description: 'Read a cursor-paginated ChatML window from OpenCode history',
        template: '',
      }
    },

    tool: {
      [HISTORY_SEARCH_COMMAND]: tool({
        description:
          'Search OpenCode history. Prefer q/n. Returns compact hits: cursor, sid, dir, title, time, role, score, text.',
        args: {
          q: tool.schema.string('Search query').optional(),
          n: tool.schema.number('Max hits').optional(),
          dir: tool.schema.string('Exact OpenCode session directory filter').optional(),
          after: tool.schema
            .string('Only include messages at or after this ISO date/time')
            .optional(),
          before: tool.schema
            .string('Only include messages at or before this ISO date/time')
            .optional(),
        },
        async execute(args) {
          const query = args.q

          if (query === undefined || query.length === 0) {
            throw new Error('history_search requires q')
          }

          const before = optionalDateFilterValue('before', args.before)
          const options = {
            limit: clampNumber(args.n, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT),
            ...optionalStringFilter('dir', args.dir),
            ...optionalDateFilter('after', args.after),
            before: before ?? Date.now() - DEFAULT_SEARCH_FRESHNESS_EXCLUSION_MS,
          }
          const db = new HistoryDatabase()
          const sidecar = new RecallSidecarIndex()

          try {
            const provider = new OllamaEmbeddingProvider()
            const syncResult = await sidecar.sync(
              (since) => db.readTextPartsForIndex(since),
              provider,
              () => db.readTextPartIds(),
            )
            const semanticRows = await sidecar.search(query, options, provider)
            const lexicalRows = db.lexicalSearch(query, options)
            const rows = rankSearchRows(query, [...lexicalRows, ...semanticRows], options.limit)
            return formatSearchResults(rows, syncResult)
          } finally {
            sidecar.close()
            db.close()
          }
        },
      }),

      [HISTORY_READ_COMMAND]: tool({
        description:
          'Read OpenCode history. Prefer cursor/n. Use nav.next with mode next for continue, nav.prev with mode prev for earlier context, nav.tail with mode tail, nav.head with mode head. Use full only if explicitly requested.',
        args: {
          cursor: tool.schema.string('Cursor from search hit cursor or read nav').optional(),
          mode: tool.schema
            .string('around, next, prev, tail, head, full. Defaults to around.')
            .optional(),
          n: tool.schema.number('Message count').optional(),
        },
        async execute(args) {
          const cursorValue = args.cursor

          if (cursorValue === undefined || cursorValue.length === 0) {
            throw new Error('history_read requires cursor')
          }

          const cursor = decodeCursor(cursorValue)
          const mode = parseReadMode(args.mode)
          const limit = clampNumber(args.n, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT)
          const fullLimit = clampNumber(args.n, DEFAULT_FULL_LIMIT, 1, MAX_FULL_LIMIT)
          const db = new HistoryDatabase()

          try {
            const readOptions = { mode, limit, fullLimit }
            const window = normalizeWindow(
              cursor.messageId === undefined
                ? db.readWindowForSession(requiredSessionId(cursor.sessionId), readOptions)
                : db.readWindow(cursor.messageId, readOptions),
            )
            return new ChatmlRenderer().render(window)
          } finally {
            db.close()
          }
        },
      }),
    },
  }
}

function requiredSessionId(value: string | undefined): string {
  if (value !== undefined) {
    return value
  }

  throw new Error('History cursor does not contain a message or session id')
}

export default RecallPlugin

function parseReadMode(value: string | undefined): ReadMode {
  if (
    value === 'around' ||
    value === 'head' ||
    value === 'next' ||
    value === 'prev' ||
    value === 'tail' ||
    value === 'full'
  ) {
    return value
  }

  return 'around'
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
