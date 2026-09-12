import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Plugin } from '@opencode/plugin'

import {
  HISTORY_READ_COMMAND,
  HISTORY_SEARCH_COMMAND,
  RECALL_AGENT_DESCRIPTION,
  RECALL_AGENT_NAME,
  SESSION_INDEX_COMMAND,
  SESSION_SAVE_COMMAND,
} from './src/commands.js'
import {
  executeNodeWorker,
  forwardSessionInterruptions,
  SessionWorkerAbortRegistry,
} from './src/node-worker-client.js'
import {
  DEFAULT_READ_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SESSION_INDEX_LIMIT,
} from './src/tool-defaults.js'
import type {
  HistoryReadWorkerArgs,
  HistorySearchWorkerArgs,
  SessionIndexWorkerArgs,
  SessionSaveWorkerArgs,
} from './src/worker-protocol.js'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const WORKER_DIR = join(PACKAGE_DIR, 'src')
const RECALL_AGENT_PROMPT_PATHS = [
  join(PACKAGE_DIR, 'prompts/recall-agent-prompt.txt'),
  join(PACKAGE_DIR, '../prompts/recall-agent-prompt.txt'),
] as const
const TOOL_NAMES = [
  HISTORY_SEARCH_COMMAND,
  HISTORY_READ_COMMAND,
  SESSION_INDEX_COMMAND,
  SESSION_SAVE_COMMAND,
] as const
const OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
} as const

export const RecallPlugin = Plugin.define({
  id: 'josxa.opencode-recall',
  async setup(context) {
    const recallAgentPrompt = await loadRecallAgentPrompt()
    const workers = new SessionWorkerAbortRegistry()
    const eventSubscription = new AbortController()
    let interruptionError: unknown
    const interruptionForwarder = forwardSessionInterruptions(
      context.event.subscribe({ signal: eventSubscription.signal }),
      workers,
    ).catch((error: unknown) => {
      if (!eventSubscription.signal.aborted) interruptionError = error
    })

    await context.tool.hook('execute.before', (call) => {
      // V2 built-in transforms can append default permissions after third-party agent transforms.
      // Enforce Recall's tool-only sandbox at execution time as the invariant safety boundary.
      if (
        String(call.agent) === RECALL_AGENT_NAME &&
        call.tool !== 'execute' &&
        !isRecallTool(call.tool)
      ) {
        throw new Error('The @recall subagent can only execute OpenCode history tools.')
      }
    })

    await context.command.transform((commands) => {
      registerCommand(
        context,
        commands,
        HISTORY_SEARCH_COMMAND,
        'Search OpenCode history and return ranked cursor anchors',
      )
      registerCommand(
        context,
        commands,
        HISTORY_READ_COMMAND,
        'Read a cursor-paginated ChatML window from OpenCode history',
      )
      registerCommand(
        context,
        commands,
        SESSION_INDEX_COMMAND,
        'Browse recallable OpenCode sessions by recency, title, and usefulness signals',
      )
      registerCommand(context, commands, SESSION_SAVE_COMMAND, 'Materialize session to file')
    })
    await context.agent.transform((agents) => {
      agents.update(RECALL_AGENT_NAME, (agent) => {
        // Keep user-selected model/request settings while owning Recall's safety boundary.
        agent.description = RECALL_AGENT_DESCRIPTION
        agent.mode = 'subagent'
        agent.system = recallAgentPrompt
        agent.permissions = [
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'execute', resource: '*', effect: 'allow' },
          ...toolPermissions('allow'),
        ]
      })
    })

    await context.tool.transform((tools) => {
      tools.add({
        name: HISTORY_SEARCH_COMMAND,
        description: 'Recall OpenCode history.',
        input: {
          ...OBJECT_SCHEMA,
          properties: {
            q: { type: 'string', description: 'Recall query. Empty=recent.' },
            n: { type: 'number', description: `Max hits. Default ${DEFAULT_SEARCH_LIMIT}.` },
            directory: { type: 'string', description: 'Session directory.' },
            includeCurrentSession: {
              type: 'boolean',
              description: 'Include current session. Default false.',
            },
            after: { type: 'string', description: 'Created after ISO date/time.' },
            before: { type: 'string', description: 'Created before ISO date/time.' },
          },
        },
        options: directToolOptions(HISTORY_SEARCH_COMMAND),
        async execute(input, toolContext) {
          const args = input as HistorySearchWorkerArgs
          const content = await workers.run(toolContext.sessionID, (signal) =>
            executeNodeWorker(
              WORKER_DIR,
              { kind: 'search', args, context: { sessionID: toolContext.sessionID } },
              signal,
            ),
          )
          return { content }
        },
      })

      tools.add({
        name: HISTORY_READ_COMMAND,
        description: 'Read OpenCode history.',
        input: {
          ...OBJECT_SCHEMA,
          properties: {
            cursor: {
              type: 'string',
              description:
                'Exact cursor from search/read nav, including source-qualified msg_* or ses_* cursors. No :offset suffixes.',
            },
            mode: {
              type: 'string',
              description:
                'around (default), next, prev, tail, head. full is rejected; page instead.',
            },
            n: {
              type: 'number',
              description: `Message limit (default ${DEFAULT_READ_LIMIT}).`,
            },
          },
        },
        options: directToolOptions(HISTORY_READ_COMMAND),
        async execute(input, toolContext) {
          const content = await workers.run(toolContext.sessionID, (signal) =>
            executeNodeWorker(
              WORKER_DIR,
              { kind: 'read', args: input as HistoryReadWorkerArgs },
              signal,
            ),
          )
          return { content }
        },
      })

      tools.add({
        name: SESSION_INDEX_COMMAND,
        description: 'Browse OpenCode history sessions.',
        input: {
          ...OBJECT_SCHEMA,
          properties: {
            n: {
              type: 'number',
              description: `Max sessions. Default ${DEFAULT_SESSION_INDEX_LIMIT}.`,
            },
            title: { type: 'string', description: 'Case-insensitive session title filter.' },
            directory: { type: 'string', description: 'Exact session directory.' },
            includeCurrentSession: {
              type: 'boolean',
              description: 'Include current session. Default false.',
            },
            after: { type: 'string', description: 'Session updated after ISO date/time.' },
            before: { type: 'string', description: 'Session updated before ISO date/time.' },
          },
        },
        options: directToolOptions(SESSION_INDEX_COMMAND),
        async execute(input, toolContext) {
          const content = await workers.run(toolContext.sessionID, (signal) =>
            executeNodeWorker(
              WORKER_DIR,
              {
                kind: 'session-index',
                args: input as SessionIndexWorkerArgs,
                context: { sessionID: toolContext.sessionID },
              },
              signal,
            ),
          )
          return { content }
        },
      })

      tools.add({
        name: SESSION_SAVE_COMMAND,
        description: 'Materialize session to file.',
        input: {
          ...OBJECT_SCHEMA,
          properties: {
            cursor: {
              type: 'string',
              description:
                'Exact session cursor from session_index, including source-qualified ses_* cursors.',
            },
            path: { type: 'string', description: 'Workspace-relative destination.' },
            format: {
              type: 'string',
              enum: ['chatml', 'markdown', 'jsonl'],
              description: 'Transcript encoding. Default chatml.',
            },
          },
          required: ['cursor', 'path'],
        },
        options: directToolOptions(SESSION_SAVE_COMMAND),
        async execute(input, toolContext) {
          const session = await context.session.get({ sessionID: toolContext.sessionID })
          const content = await workers.run(toolContext.sessionID, (signal) =>
            executeNodeWorker(
              WORKER_DIR,
              {
                kind: 'session-save',
                args: input as SessionSaveWorkerArgs,
                context: { directory: session.location.directory },
              },
              signal,
            ),
          )
          return { content }
        },
      })
    })

    return async () => {
      eventSubscription.abort()
      workers.dispose()
      await interruptionForwarder
      if (interruptionError !== undefined) throw interruptionError
    }
  },
})

type CommandDraft = Parameters<Parameters<Plugin.Context['command']['transform']>[0]>[0]

function registerCommand(
  context: Plugin.Context,
  commands: CommandDraft,
  name: string,
  description: string,
): void {
  commands.add({
    name,
    description,
    execute: async ({ sessionID, prompt, delivery }) => {
      // The promise client omits undefined optionals on its wire input.
      // Native command invocations contain only the arguments, not the slash command name.
      // Append the instruction so existing attachment mention offsets still match the text.
      const input = JSON.parse(
        JSON.stringify({
          sessionID,
          ...prompt,
          text: `${prompt.text}\n\nUse ${name} to fulfill this request.`,
          delivery,
        }),
      ) as Parameters<typeof context.session.prompt>[0]
      await context.session.prompt(input)
    },
  })
}

function toolPermissions(effect: 'allow' | 'deny') {
  return TOOL_NAMES.map((action) => ({ action, resource: '*', effect }))
}

function directToolOptions(permission: string) {
  return { codemode: true as const, permission }
}

async function loadRecallAgentPrompt(): Promise<string> {
  for (const path of RECALL_AGENT_PROMPT_PATHS) {
    try {
      return await readFile(path, 'utf-8')
    } catch (error) {
      if (isMissingFileError(error)) continue
      throw error
    }
  }

  throw new Error('Cannot load recall-agent-prompt.txt from package prompts directory')
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isRecallTool(tool: string): tool is (typeof TOOL_NAMES)[number] {
  return TOOL_NAMES.some((name) => name === tool)
}

export default RecallPlugin
