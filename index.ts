import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Plugin } from '@opencode/plugin'

import {
  HISTORY_FIND_COMMAND,
  HISTORY_READ_COMMAND,
  HISTORY_SEARCH_COMMAND,
  RECALL_AGENT_DESCRIPTION,
  RECALL_AGENT_NAME,
  SESSION_INDEX_COMMAND,
  SESSION_SAVE_COMMAND,
} from './src/commands.js'
import { loadJudgeConfig } from './src/config.js'
import { type FindSearchResult, findEvidence } from './src/find.js'
import {
  executeNodeWorker,
  forwardSessionInterruptions,
  SessionWorkerAbortRegistry,
} from './src/node-worker-client.js'
import type { SessionDigest } from './src/passages.js'
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
const RECALL_AGENT_PROMPT_FILE = 'recall-agent-prompt.txt'
const RECALL_AGENT_FIND_PROMPT_FILE = 'recall-agent-find-prompt.txt'
const TOOL_NAMES = [
  HISTORY_SEARCH_COMMAND,
  HISTORY_READ_COMMAND,
  SESSION_INDEX_COMMAND,
  SESSION_SAVE_COMMAND,
] as const
const RECALL_TOOL_NAMES = [...TOOL_NAMES, HISTORY_FIND_COMMAND] as const
const OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
} as const

export const RecallPlugin = Plugin.define({
  id: 'josxa.opencode-recall',
  async setup(context) {
    const judge = loadJudgeConfig()
    const enabledTools = judge === undefined ? TOOL_NAMES : RECALL_TOOL_NAMES
    const recallAgentPrompt = await loadRecallAgentPrompt(
      judge === undefined ? RECALL_AGENT_PROMPT_FILE : RECALL_AGENT_FIND_PROMPT_FILE,
    )
    const availableModels = new Set<string>()
    const refreshModels = async () => {
      const models = (await context.model.list()).data
      availableModels.clear()
      for (const model of models) {
        if (model.enabled) availableModels.add(`${model.providerID}/${model.id}`)
      }
    }
    await refreshModels()
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
      const isRecallAgent = String(call.agent) === RECALL_AGENT_NAME
      if (isRecallAgent && call.tool !== 'execute' && !isRecallTool(call.tool)) {
        throw new Error('The @recall subagent can only execute OpenCode history tools.')
      }
      // History pages stay in the dedicated recall context; other agents delegate to @recall.
      if (!isRecallAgent && isRecallTool(call.tool)) {
        throw new Error('OpenCode history tools are only available through the @recall subagent.')
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
    const configureRecall: Parameters<Plugin.Context['agent']['transform']>[0] = (agents) => {
      for (const agent of agents.list()) {
        if (String(agent.id) === RECALL_AGENT_NAME) continue
        // Deny last so broader agent rules cannot expose history tools outside @recall.
        agent.permissions = [
          ...agent.permissions.filter((rule) => !isRecallTool(rule.action)),
          ...toolPermissions(enabledTools, 'deny'),
        ]
      }
      agents.update(RECALL_AGENT_NAME, (agent) => {
        // Keep an executable user-selected model; stale machine config must not disable Recall.
        if (
          agent.model !== undefined &&
          !availableModels.has(`${agent.model.providerID}/${agent.model.id}`)
        ) {
          delete agent.model
        }
        agent.description = RECALL_AGENT_DESCRIPTION
        agent.mode = 'subagent'
        agent.system = recallAgentPrompt
        agent.permissions = [
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'execute', resource: '*', effect: 'allow' },
          ...toolPermissions(enabledTools, 'allow'),
        ]
      })
    }
    let agentRegistration = await context.agent.transform(configureRecall)
    let admissionRefresh = Promise.resolve()
    await context.session.hook('prompt', async () => {
      // Native configuration transforms can register after plugin setup. Prompt
      // admission runs after startup, before model selection, so reapply here.
      admissionRefresh = admissionRefresh
        .catch(() => {
          // The previous prompt already received its error; allow the next retry.
        })
        .then(async () => {
          await refreshModels()
          const { data: agent } = await context.agent.get({ agentID: RECALL_AGENT_NAME })
          if (!agent.model || availableModels.has(`${agent.model.providerID}/${agent.model.id}`))
            return
          await agentRegistration.dispose()
          agentRegistration = await context.agent.transform(configureRecall)
        })
      await admissionRefresh
    })

    await context.tool.transform((tools) => {
      tools.add({
        name: HISTORY_SEARCH_COMMAND,
        description: 'Recall OpenCode history.',
        input: {
          ...OBJECT_SCHEMA,
          properties: {
            q: { type: 'string', description: 'Recall query. Empty=recent.' },
            excludeSubagents: {
              type: 'boolean',
              description: 'Return only main sessions. Default false.',
            },
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
                'Exact cursor from search/read nav, including source-qualified cursors; raw msg_* or ses_* also accepted. No :offset suffixes.',
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
            excludeSubagents: {
              type: 'boolean',
              description: 'Return only main sessions. Default false.',
            },
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

      if (judge === undefined) return
      tools.add({
        name: HISTORY_FIND_COMMAND,
        description:
          'Find judged evidence in OpenCode history in one call: searches every query, fuses hits by session, and a decision model checks each session and passage against the criteria.',
        input: {
          ...OBJECT_SCHEMA,
          properties: {
            queries: {
              type: 'array',
              items: { type: 'string' },
              description:
                '3-8 search queries: distinctive terms, synonyms, likely file/tool/project names, German and English variants.',
            },
            criteria: {
              type: 'array',
              items: { type: 'string' },
              description:
                '1-4 atomic yes/no conditions a matching session must satisfy, e.g. "The session changes the Traefik config of josxa.dev".',
            },
            directory: { type: 'string', description: 'Exact session directory.' },
            after: { type: 'string', description: 'Created after ISO date/time.' },
            before: { type: 'string', description: 'Created before ISO date/time.' },
          },
          required: ['queries', 'criteria'],
        },
        options: directToolOptions(HISTORY_FIND_COMMAND),
        async execute(input, toolContext) {
          const request = input as {
            readonly queries: readonly string[]
            readonly criteria: readonly string[]
            readonly directory?: string
            readonly after?: string
            readonly before?: string
          }
          const content = await workers.run(toolContext.sessionID, (signal) => {
            const worker = (payload: Parameters<typeof executeNodeWorker>[1]) =>
              executeNodeWorker(WORKER_DIR, payload, signal)
            return findEvidence(request, {
              model: judge.model,
              settings: judge.find,
              search: async (queries) => {
                const shards = await Promise.all(
                  Array.from({ length: judge.find.searchShards }, async (_, index) => {
                    const response = await worker({
                      kind: 'search',
                      args: {
                        queries,
                        shard: { index, count: judge.find.searchShards },
                        n: judge.find.queryHits,
                        maxSearchLimit: judge.find.queryHits,
                        excludeSubagents: true,
                        directory: request.directory,
                        after: request.after,
                        before: request.before,
                        sync: false,
                        format: 'json',
                      } as HistorySearchWorkerArgs,
                      context: { sessionID: toolContext.sessionID },
                    })
                    return JSON.parse(response) as FindSearchResult
                  }),
                )
                return {
                  lists: shards.flatMap((shard) => shard.lists),
                  notice: shards.find((shard) => shard.notice !== undefined)?.notice,
                }
              },
              digest: async (sessions, queries) =>
                JSON.parse(
                  await worker({
                    kind: 'session-digest',
                    args: {
                      sessions,
                      queries,
                      passagesPerSession: judge.find.passagesPerSession,
                      passageChars: judge.find.passageChars,
                    },
                  }),
                ) as readonly SessionDigest[],
              decide: (decision) => context.experimental.generate.decisions(decision),
            })
          })
          void executeNodeWorker(
            WORKER_DIR,
            {
              kind: 'search',
              args: {
                q: request.queries[0] ?? '',
                n: 1,
                format: 'json',
              } as HistorySearchWorkerArgs,
              context: { sessionID: toolContext.sessionID },
            },
            new AbortController().signal,
          ).catch(() => undefined)
          return { content }
        },
      })
    })

    return async () => {
      eventSubscription.abort()
      workers.dispose()
      await admissionRefresh
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

function toolPermissions(names: readonly string[], effect: 'allow' | 'deny') {
  return names.map((action) => ({ action, resource: '*', effect }))
}

function directToolOptions(permission: string) {
  return { codemode: true as const, permission }
}

async function loadRecallAgentPrompt(file: string): Promise<string> {
  for (const path of [
    join(PACKAGE_DIR, 'prompts', file),
    join(PACKAGE_DIR, '..', 'prompts', file),
  ]) {
    try {
      return await readFile(path, 'utf-8')
    } catch (error) {
      if (isMissingFileError(error)) continue
      throw error
    }
  }

  throw new Error(`Cannot load ${file} from package prompts directory`)
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isRecallTool(tool: string): tool is (typeof RECALL_TOOL_NAMES)[number] {
  return RECALL_TOOL_NAMES.some((name) => name === tool)
}

export default RecallPlugin
