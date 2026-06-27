import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config, Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin'

import {
  HISTORY_READ_COMMAND,
  HISTORY_SEARCH_COMMAND,
  RECALL_AGENT_DESCRIPTION,
  RECALL_AGENT_NAME,
  SESSION_INDEX_COMMAND,
  SESSION_SAVE_COMMAND,
} from './src/commands.js'
import { executeNodeWorker } from './src/node-worker-client.js'
import {
  DEFAULT_READ_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SESSION_INDEX_LIMIT,
} from './src/tool-defaults.js'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const RECALL_AGENT_PROMPT_PATHS = [
  join(PACKAGE_DIR, 'prompts/recall-agent-prompt.txt'),
  join(PACKAGE_DIR, '../prompts/recall-agent-prompt.txt'),
] as const

type PermissionAction = 'ask' | 'allow' | 'deny'
type PermissionConfig = Record<string, PermissionAction | Record<string, PermissionAction>>
type DynamicPermissionConfig = NonNullable<Config['permission']> & PermissionConfig

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

      config.command[SESSION_INDEX_COMMAND] = {
        description:
          'Browse recallable OpenCode sessions by recency, title, and usefulness signals',
        template: '',
      }

      config.command[SESSION_SAVE_COMMAND] = {
        description: 'Materialize session to file',
        template: '',
      }

      config.permission = recallToolDenyPermission(config.permission)

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

          return executeNodeWorker(
            PACKAGE_DIR,
            { kind: 'search', args, context: { sessionID: context.sessionID } },
            context.abort,
          )
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

          return executeNodeWorker(PACKAGE_DIR, { kind: 'read', args }, context.abort)
        },
      }),

      [SESSION_INDEX_COMMAND]: tool({
        description: 'Browse OpenCode history sessions.',
        args: {
          n: tool.schema
            .number()
            .describe(`Max sessions. Default ${DEFAULT_SESSION_INDEX_LIMIT}.`)
            .optional(),
          title: tool.schema.string().describe('Case-insensitive session title filter.').optional(),
          directory: tool.schema.string().describe('Exact session directory.').optional(),
          includeCurrentSession: tool.schema
            .boolean()
            .describe('Include current session. Default false.')
            .optional(),
          after: tool.schema.string().describe('Session updated after ISO date/time.').optional(),
          before: tool.schema.string().describe('Session updated before ISO date/time.').optional(),
        },
        async execute(args, context) {
          assertRecallAgent(context.agent)

          return executeNodeWorker(
            PACKAGE_DIR,
            { kind: 'session-index', args, context: { sessionID: context.sessionID } },
            context.abort,
          )
        },
      }),

      [SESSION_SAVE_COMMAND]: tool({
        description: 'Materialize session to file.',
        args: {
          cursor: tool.schema.string().describe('Session cursor. ses_* only.'),
          path: tool.schema.string().describe('Workspace-relative destination.'),
          format: tool.schema
            .enum(['chatml', 'markdown', 'jsonl'])
            .describe('Transcript encoding. Default chatml.')
            .optional(),
        },
        async execute(args, context) {
          assertRecallAgent(context.agent)

          return executeNodeWorker(
            PACKAGE_DIR,
            { kind: 'session-save', args, context: { directory: context.directory } },
            context.abort,
          )
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
    [SESSION_INDEX_COMMAND]: 'allow',
    [SESSION_SAVE_COMMAND]: 'allow',
  }
}

function recallToolDenyPermission(
  permission: Config['permission'] | PermissionAction | undefined,
): DynamicPermissionConfig {
  const normalized = typeof permission === 'string' ? { '*': permission } : permission

  return {
    ...normalized,
    [HISTORY_SEARCH_COMMAND]: 'deny',
    [HISTORY_READ_COMMAND]: 'deny',
    [SESSION_INDEX_COMMAND]: 'deny',
    [SESSION_SAVE_COMMAND]: 'deny',
  } as DynamicPermissionConfig
}

function assertRecallAgent(agent: string): void {
  if (agent === RECALL_AGENT_NAME) {
    return
  }

  throw new Error('OpenCode history tools are only available through the @recall subagent.')
}

export default RecallPlugin
