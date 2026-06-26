import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin'

import {
  HISTORY_READ_COMMAND,
  HISTORY_SEARCH_COMMAND,
  RECALL_AGENT_DESCRIPTION,
  RECALL_AGENT_NAME,
} from './src/commands.js'
import { executeNodeWorker } from './src/node-worker-client.js'
import { DEFAULT_READ_LIMIT, DEFAULT_SEARCH_LIMIT } from './src/tool-defaults.js'

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

export default RecallPlugin
