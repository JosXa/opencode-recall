import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin'

import { ChatmlRenderer } from './src/chatml-renderer.js'
import {
  HISTORY_READ_COMMAND,
  HISTORY_SEARCH_COMMAND,
  RECALL_AGENT_DESCRIPTION,
  RECALL_AGENT_NAME,
} from './src/commands.js'
import { decodeCursor } from './src/cursor.js'
import { HistoryDatabase } from './src/db.js'
import { OllamaEmbeddingProvider } from './src/embedding.js'
import { normalizeWindow } from './src/normalizer.js'
import { parseReadMode } from './src/read-mode.js'
import { formatSearchResults, rankSearchRows } from './src/search.js'
import { RecallSidecarIndex } from './src/sidecar.js'

const DEFAULT_SEARCH_LIMIT = 8
const MAX_SEARCH_LIMIT = 25
const DEFAULT_SEARCH_FRESHNESS_EXCLUSION_MS = 30_000
const DEFAULT_READ_LIMIT = 12
const MAX_READ_LIMIT = 50
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const RECALL_AGENT_PROMPT_PATHS = [
  join(PACKAGE_DIR, 'prompts/recall-agent-prompt.txt'),
  join(PACKAGE_DIR, '../prompts/recall-agent-prompt.txt'),
] as const

type PermissionAction = 'ask' | 'allow' | 'deny'
type PermissionConfig = Record<string, PermissionAction | Record<string, PermissionAction>>

export const RecallPlugin: Plugin = async () => {
  const recallAgentPrompt = await loadRecallAgentPrompt()

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

      config.agent ??= {}
      const recallAgent = {
        description: RECALL_AGENT_DESCRIPTION,
        mode: 'subagent',
        prompt: recallAgentPrompt,
        permission: recallAgentPermission(),
      } as NonNullable<typeof config.agent>[string]
      config.agent[RECALL_AGENT_NAME] = recallAgent
    },

    tool: {
      [HISTORY_SEARCH_COMMAND]: tool({
        description: 'Recall OpenCode history.',
        args: {
          q: tool.schema.string().describe('Recall query. Empty=recent.').optional(),
          n: tool.schema.number().describe(`Max hits. Default ${DEFAULT_SEARCH_LIMIT}.`).optional(),
          directory: tool.schema.string().describe('Session directory.').optional(),
          includeCurrentSession: tool.schema
            .boolean()
            .describe('Include current session. Default false.')
            .optional(),
          after: tool.schema.string().describe('Created after ISO date/time.').optional(),
          before: tool.schema.string().describe('Created before ISO date/time.').optional(),
        },
        async execute(args, context) {
          assertRecallAgent(context.agent)

          const query = args.q ?? ''

          const includeCurrentSession = args.includeCurrentSession === true
          const before = optionalDateFilterValue('before', args.before)
          const options = {
            limit: clampNumber(args.n, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT),
            ...optionalStringFilter('directory', args.directory),
            ...currentSessionExclusion(includeCurrentSession, context.sessionID),
            ...optionalDateFilter('after', args.after),
            ...searchBeforeFilter(before, includeCurrentSession),
          }
          const db = new HistoryDatabase()
          const sidecar = new RecallSidecarIndex()

          try {
            if (query.trim().length === 0) {
              return formatSearchResults(db.recent(options))
            }

            const provider = new OllamaEmbeddingProvider()
            const syncResult = await sidecar.sync(
              (since) => db.readTextPartsForIndex(since),
              provider,
              () => db.readTextPartIds(),
            )
            const [semanticRows, lexicalRows] = await Promise.all([
              sidecar.search(query, options, provider),
              Promise.resolve(sidecar.lexicalSearch(query, options)),
            ])
            const rows = rankSearchRows(query, [...lexicalRows, ...semanticRows], options.limit)
            return formatSearchResults(rows, syncResult)
          } finally {
            sidecar.close()
            db.close()
          }
        },
      }),

      [HISTORY_READ_COMMAND]: tool({
        description: 'Read OpenCode history.',
        args: {
          cursor: tool.schema
            .string()
            .describe('Cursor from search/read nav, msg_*, or ses_*. No :offset suffixes.')
            .optional(),
          mode: tool.schema
            .string()
            .describe('around (default), next, prev, tail, head. full is rejected; page instead.')
            .optional(),
          n: tool.schema
            .number()
            .describe(`Message limit (default ${DEFAULT_READ_LIMIT}).`)
            .optional(),
        },
        async execute(args, context) {
          assertRecallAgent(context.agent)

          const cursorValue = args.cursor

          if (cursorValue === undefined || cursorValue.length === 0) {
            throw new Error('history_read requires cursor')
          }

          const cursor = decodeCursor(cursorValue)
          const mode = parseReadMode(args.mode)
          const limit = clampNumber(args.n, DEFAULT_READ_LIMIT, 1, MAX_READ_LIMIT)
          const db = new HistoryDatabase()

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
        },
      }),
    },
  }
}

async function loadRecallAgentPrompt(): Promise<string> {
  for (const path of RECALL_AGENT_PROMPT_PATHS) {
    try {
      return await readFile(path, 'utf-8')
    } catch (error) {
      if (isMissingFileError(error)) {
        continue
      }
      throw error
    }
  }

  throw new Error('Cannot load recall-agent-prompt.txt from package prompts directory')
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function recallAgentPermission(): PermissionConfig {
  return {
    '*': 'deny',
    [HISTORY_SEARCH_COMMAND]: 'allow',
    [HISTORY_READ_COMMAND]: 'allow',
  }
}

function assertRecallAgent(agent: string): void {
  if (agent === RECALL_AGENT_NAME) {
    return
  }

  throw new Error('OpenCode history tools are only available through the @recall subagent.')
}

function requiredSessionId(value: string | undefined): string {
  if (value !== undefined) {
    return value
  }

  throw new Error('History cursor does not contain a message or session id')
}

export default RecallPlugin

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

function currentSessionExclusion(includeCurrentSession: boolean | undefined, sessionID: string) {
  if (includeCurrentSession === true) {
    return {}
  }

  return { excludeSessionId: sessionID }
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
