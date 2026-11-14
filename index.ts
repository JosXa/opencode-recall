import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Plugin } from '@opencode/plugin'
import { Plugin as EffectPlugin } from '@opencode/plugin/effect'
import { fromPromise } from '@opencode/plugin/promise/adapter'
import { Effect } from 'effect'
import { registerAutocomplete, registerDisabledAutocomplete } from './src/autocomplete.js'
import { autocompleteGeneration } from './src/autocomplete-generation.js'

import {
  HISTORY_FIND_COMMAND,
  HISTORY_READ_COMMAND,
  HISTORY_SEARCH_COMMAND,
  RECALL_AGENT_DESCRIPTION,
  RECALL_AGENT_NAME,
  SESSION_INDEX_COMMAND,
  SESSION_SAVE_COMMAND,
} from './src/commands.js'
import { availableJudge, type JudgeConfig, loadJudgeConfig } from './src/config.js'
import { type FindWindow, findEvidence, STANDARD_FALLBACK_NOTICE } from './src/find.js'
import { historyWorkers } from './src/find-workers.js'
import { focusedRead } from './src/focus.js'
import {
  executeNodeWorker,
  forwardSessionInterruptions,
  SessionWorkerAbortRegistry,
} from './src/node-worker-client.js'
import { RecallRuns } from './src/recall-run.js'
import {
  DEFAULT_READ_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SESSION_INDEX_LIMIT,
} from './src/tool-defaults.js'
import type {
  CurrentSessionScope,
  HistoryReadWorkerArgs,
  HistorySearchWorkerArgs,
  SessionIndexWorkerArgs,
  SessionSaveWorkerArgs,
  SessionScopeContext,
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
const JUDGED_TOOL_NAMES = [
  HISTORY_FIND_COMMAND,
  HISTORY_READ_COMMAND,
  SESSION_SAVE_COMMAND,
] as const
const RECALL_TOOL_NAMES = [...TOOL_NAMES, HISTORY_FIND_COMMAND] as const
const FOCUSED_READ_SEGMENTS = 5
const JUDGE_RETRY_MS = 10 * 60_000
const DAY_MS = 86_400_000
const COMMAND_DESCRIPTIONS = [
  [HISTORY_SEARCH_COMMAND, 'Search OpenCode history and return ranked cursor anchors'],
  [HISTORY_READ_COMMAND, 'Read a cursor-paginated ChatML window from OpenCode history'],
  [
    SESSION_INDEX_COMMAND,
    'Browse recallable OpenCode sessions by recency, title, and usefulness signals',
  ],
  [SESSION_SAVE_COMMAND, 'Materialize session to file'],
] as const
const OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
} as const
const CURRENT_SESSION_SCHEMA = {
  type: 'string',
  enum: ['exclude', 'include', 'only'],
  description:
    'The session that called recall. exclude (default): leave it out. include: search it along with all others. only: look only inside it.',
}

export const RecallPlugin = Plugin.define({
  id: 'josxa.opencode-recall',
  async setup(context) {
    const configuredJudge = loadJudgeConfig()
    const standardPrompt = await loadRecallAgentPrompt(RECALL_AGENT_PROMPT_FILE)
    const judgedPrompt =
      configuredJudge === undefined
        ? standardPrompt
        : await loadRecallAgentPrompt(RECALL_AGENT_FIND_PROMPT_FILE)
    let activeJudge: JudgeConfig | undefined
    let judgeRetryAt = 0
    const enabledTools = (): readonly string[] =>
      activeJudge === undefined ? TOOL_NAMES : JUDGED_TOOL_NAMES
    const availableModels = new Set<string>()
    const decisionModels = new Set<string>()
    const refreshModels = async () => {
      const [models, decisions] = await Promise.all([
        context.model.list(),
        configuredJudge === undefined
          ? Promise.resolve(undefined)
          : context.model.list({ types: ['decision'] }).catch(() => undefined),
      ])
      availableModels.clear()
      for (const model of models.data) {
        if (model.enabled) availableModels.add(`${model.providerID}/${model.id}`)
      }
      decisionModels.clear()
      for (const model of decisions?.data ?? []) {
        if (model.enabled) decisionModels.add(`${model.providerID}/${model.id}`)
      }
    }
    const usableJudge = () =>
      typeof context.experimental?.generate?.decisions === 'function' && Date.now() >= judgeRetryAt
        ? availableJudge(configuredJudge, (model) =>
            decisionModels.has(`${model.providerID}/${model.id}`),
          )
        : undefined
    await refreshModels()
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket access for the host option index signature.
    const enabled = context.options['autocomplete'] === true
    const stopAutocomplete = enabled
      ? await registerAutocomplete(context, WORKER_DIR)
      : await registerDisabledAutocomplete(context)
    const workers = new SessionWorkerAbortRegistry()
    const runs = new RecallRuns(configuredJudge?.maxRunTokens ?? 0)
    const eventSubscription = new AbortController()
    let interruptionError: unknown
    const interruptionForwarder = forwardSessionInterruptions(
      context.event.subscribe({ signal: eventSubscription.signal }),
      workers,
      (sessionID) => runs.end(sessionID),
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

    if (configuredJudge !== undefined) {
      await context.session.hook('context', (request) => {
        if (activeJudge === undefined || String(request.agent) !== RECALL_AGENT_NAME) return
        void runs
          .get(request.sessionID)
          .prepare(() =>
            executeNodeWorker(
              WORKER_DIR,
              { kind: 'sync-lexical', args: {} },
              new AbortController().signal,
            ),
          )
      })
    }

    const configureCommands: Parameters<Plugin.Context['command']['transform']>[0] = (commands) => {
      for (const [name, description] of COMMAND_DESCRIPTIONS) {
        if (enabledTools().includes(name)) registerCommand(context, commands, name, description)
      }
    }
    const configureRecall: Parameters<Plugin.Context['agent']['transform']>[0] = (agents) => {
      for (const agent of agents.list()) {
        if (String(agent.id) === RECALL_AGENT_NAME) continue
        // Deny last so broader agent rules cannot expose history tools outside @recall.
        agent.permissions = [
          ...agent.permissions.filter((rule) => !isRecallTool(rule.action)),
          ...toolPermissions(enabledTools(), 'deny'),
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
        agent.system = activeJudge === undefined ? standardPrompt : judgedPrompt
        agent.permissions = [
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'execute', resource: '*', effect: 'allow' },
          ...toolPermissions(enabledTools(), 'allow'),
        ]
      })
    }
    let surface: readonly Registration[] = []
    const registerSurface = async () => {
      activeJudge = usableJudge()
      await Promise.all(surface.map((registration) => registration.dispose()))
      surface = [
        await context.command.transform(configureCommands),
        await context.agent.transform(configureRecall),
        await context.tool.transform(configureTools),
      ]
    }
    let admissionRefresh = Promise.resolve()
    const refreshSurface = (refresh: () => Promise<boolean>) => {
      admissionRefresh = admissionRefresh
        .catch(() => {
          // The previous prompt already received its error; allow the next retry.
        })
        .then(async () => {
          if (await refresh()) await registerSurface()
        })
      return admissionRefresh
    }
    const judgeChanged = () => judgeKey(usableJudge()) !== judgeKey(activeJudge)
    const markJudgeDown = () => {
      judgeRetryAt = Date.now() + JUDGE_RETRY_MS
      void refreshSurface(async () => judgeChanged()).catch(() => undefined)
    }
    const callerScope = async (sessionID: string): Promise<SessionScopeContext> => {
      const session = await context.session.get({ sessionID }).catch(() => undefined)
      return { sessionID: session?.parentID ?? sessionID, recallSessionID: sessionID }
    }
    const standardHistory = async (
      scopeContext: SessionScopeContext,
      request: {
        readonly queries: readonly string[]
        readonly window: FindWindow
        readonly directory?: string | undefined
        readonly currentSession: CurrentSessionScope
      },
      signal: AbortSignal,
    ) => {
      const scope = {
        directory: request.directory,
        after:
          request.window.after ??
          (request.window.withinDays === undefined
            ? undefined
            : new Date(Date.now() - request.window.withinDays * DAY_MS).toISOString()),
        before: request.window.before,
        excludeSubagents: true,
        currentSession: request.currentSession,
      }
      if (request.queries.length === 0) {
        return executeNodeWorker(
          WORKER_DIR,
          { kind: 'session-index', args: scope as SessionIndexWorkerArgs, context: scopeContext },
          signal,
        )
      }
      const pages = await Promise.all(
        request.queries.map(
          async (q) =>
            `### history_search q=${JSON.stringify(q)}\n${await executeNodeWorker(
              WORKER_DIR,
              {
                kind: 'search',
                args: { ...scope, q } as HistorySearchWorkerArgs,
                context: scopeContext,
              },
              signal,
            )}`,
        ),
      )
      return pages.join('\n\n')
    }
    await context.session.hook('prompt', async () => {
      // Native configuration transforms can register after plugin setup. Prompt
      // admission runs after startup, before model selection, so reapply here.
      await refreshSurface(async () => {
        await refreshModels()
        const { data: agent } = await context.agent.get({ agentID: RECALL_AGENT_NAME })
        const staleModel =
          agent.model !== undefined &&
          !availableModels.has(`${agent.model.providerID}/${agent.model.id}`)
        return staleModel || judgeChanged()
      })
    })

    const configureTools: Parameters<Plugin.Context['tool']['transform']>[0] = (tools) => {
      const judge = activeJudge
      if (judge === undefined) {
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
              currentSession: CURRENT_SESSION_SCHEMA,
              after: { type: 'string', description: 'Created after ISO date/time.' },
              before: { type: 'string', description: 'Created before ISO date/time.' },
            },
          },
          options: directToolOptions(HISTORY_SEARCH_COMMAND),
          async execute(input, toolContext) {
            const args = input as HistorySearchWorkerArgs
            const scopeContext = await callerScope(toolContext.sessionID)
            const content = await workers.run(toolContext.sessionID, (signal) =>
              executeNodeWorker(
                WORKER_DIR,
                { kind: 'search', args, context: scopeContext },
                signal,
              ),
            )
            return { content }
          },
        })
      }

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
              description:
                judge === undefined
                  ? `Message limit (default ${DEFAULT_READ_LIMIT}).`
                  : `Message limit (default ${DEFAULT_READ_LIMIT}); with criteria: segments shown (default ${FOCUSED_READ_SEGMENTS}).`,
            },
            ...(judge === undefined
              ? {}
              : {
                  criteria: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      'Focused read: judge the whole containing session in segments and return only the segments matching these conditions. mode is ignored.',
                  },
                }),
          },
        },
        options: directToolOptions(HISTORY_READ_COMMAND),
        async execute(input, toolContext) {
          const args = input as HistoryReadWorkerArgs & { readonly criteria?: readonly string[] }
          const criteria = args.criteria?.filter((criterion) => criterion.trim().length > 0) ?? []
          const content = await workers.run(toolContext.sessionID, (signal) =>
            judge === undefined ||
            usableJudge() === undefined ||
            criteria.length === 0 ||
            args.cursor === undefined
              ? executeNodeWorker(WORKER_DIR, { kind: 'read', args }, signal)
              : focusedRead(args.cursor, criteria, args.n ?? FOCUSED_READ_SEGMENTS, {
                  judge,
                  run: runs.get(toolContext.sessionID),
                  decide: (decision) => context.experimental.generate.decisions(decision),
                  onJudgeDown: markJudgeDown,
                  ...historyWorkers(judge, {
                    workerDir: WORKER_DIR,
                    context: { sessionID: toolContext.sessionID },
                    signal,
                  }),
                }),
          )
          return { content }
        },
      })

      if (judge === undefined) {
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
              currentSession: CURRENT_SESSION_SCHEMA,
              after: { type: 'string', description: 'Session updated after ISO date/time.' },
              before: { type: 'string', description: 'Session updated before ISO date/time.' },
            },
          },
          options: directToolOptions(SESSION_INDEX_COMMAND),
          async execute(input, toolContext) {
            const scopeContext = await callerScope(toolContext.sessionID)
            const content = await workers.run(toolContext.sessionID, (signal) =>
              executeNodeWorker(
                WORKER_DIR,
                {
                  kind: 'session-index',
                  args: input as SessionIndexWorkerArgs,
                  context: scopeContext,
                },
                signal,
              ),
            )
            return { content }
          },
        })
      }

      tools.add({
        name: SESSION_SAVE_COMMAND,
        description: 'Materialize session to file.',
        input: {
          ...OBJECT_SCHEMA,
          properties: {
            cursor: {
              type: 'string',
              description:
                judge === undefined
                  ? 'Exact session cursor from session_index, including source-qualified ses_* cursors.'
                  : 'Exact session cursor from history_find, including source-qualified ses_* cursors.',
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
          'Find judged evidence in OpenCode history in one call: searches the queries, scans session digests in the time window, and a decision model checks each candidate session, passage and transcript segment against the criteria.',
        input: {
          ...OBJECT_SCHEMA,
          properties: {
            queries: {
              type: 'array',
              items: { type: 'string' },
              description:
                '0-8 search queries: distinctive terms, synonyms, likely file/tool/project names, German and English variants. Empty: scan the time window only.',
            },
            criteria: {
              type: 'array',
              items: { type: 'string' },
              description:
                '1-4 atomic yes/no conditions a matching session must satisfy, e.g. "The session changes the Traefik config of josxa.dev".',
            },
            withinDays: {
              type: 'number',
              description:
                'Relative window: sessions active in the last N days of history. Use for recent, yesterday, last week.',
            },
            after: { type: 'string', description: 'Active after ISO date/time.' },
            before: { type: 'string', description: 'Active before ISO date/time.' },
            directory: { type: 'string', description: 'Exact session directory.' },
            currentSession: CURRENT_SESSION_SCHEMA,
          },
          required: ['criteria'],
        },
        options: directToolOptions(HISTORY_FIND_COMMAND),
        async execute(input, toolContext) {
          const request = input as {
            readonly queries?: readonly string[]
            readonly criteria: readonly string[]
            readonly withinDays?: number
            readonly after?: string
            readonly before?: string
            readonly directory?: string
            readonly currentSession?: CurrentSessionScope
          }
          const sessionID = toolContext.sessionID
          const scopeContext = await callerScope(sessionID)
          const currentSession = request.currentSession ?? 'exclude'
          const window = {
            after: request.after,
            before: request.before,
            withinDays: request.withinDays,
          }
          const queries = request.queries ?? []
          const standard = (signal: AbortSignal) =>
            standardHistory(
              scopeContext,
              { queries, window, directory: request.directory, currentSession },
              signal,
            )
          const workerScope = (signal: AbortSignal) =>
            historyWorkers(judge, {
              workerDir: WORKER_DIR,
              context: scopeContext,
              currentSession,
              directory: request.directory,
              signal,
            })
          const callerRead = async (signal: AbortSignal) =>
            usableJudge() === undefined
              ? `judge unavailable: showing a plain window around ${scopeContext.sessionID} instead of judged segments.\n${await workerScope(signal).read(scopeContext.sessionID)}`
              : focusedRead(scopeContext.sessionID, request.criteria, FOCUSED_READ_SEGMENTS, {
                  judge,
                  run: runs.get(sessionID),
                  decide: (decision) => context.experimental.generate.decisions(decision),
                  onJudgeDown: markJudgeDown,
                  ...workerScope(signal),
                })
          const content = await workers.run(sessionID, async (signal) =>
            currentSession === 'only'
              ? callerRead(signal)
              : usableJudge() === undefined
                ? `judge unavailable: ${STANDARD_FALLBACK_NOTICE}\n${await standard(signal)}`
                : findEvidence(
                    { queries, criteria: request.criteria, window },
                    {
                      judge,
                      run: runs.get(sessionID),
                      decide: (decision) => context.experimental.generate.decisions(decision),
                      standard: () => standard(signal),
                      onJudgeDown: markJudgeDown,
                      ...workerScope(signal),
                    },
                  ),
          )
          void executeNodeWorker(
            WORKER_DIR,
            {
              kind: 'search',
              args: {
                q: request.queries?.[0] ?? request.criteria[0] ?? 'sync',
                n: 1,
                format: 'json',
              } as HistorySearchWorkerArgs,
              context: scopeContext,
            },
            new AbortController().signal,
          ).catch(() => undefined)
          return { content }
        },
      })
    }
    await registerSurface()

    return async () => {
      await stopAutocomplete()
      eventSubscription.abort()
      workers.dispose()
      await admissionRefresh
      await interruptionForwarder
      if (interruptionError !== undefined) throw interruptionError
    }
  },
})

type Registration = Awaited<ReturnType<Plugin.Context['agent']['transform']>>
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

function judgeKey(judge: JudgeConfig | undefined) {
  return judge === undefined ? '' : `${judge.model.providerID}/${judge.model.id}`
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

export default EffectPlugin.define({
  id: RecallPlugin.id,
  effect: (native) =>
    Effect.gen(function* () {
      const runtime = yield* Effect.context<unknown>()
      const generation = autocompleteGeneration(
        { text: native.generate.text, session: native.session.generate },
        runtime,
      )
      // OpenCode's Promise API adapter drops request options, including signal.
      // Run only autocomplete generation through the cancellable native Effects.
      yield* fromPromise({
        ...RecallPlugin,
        setup: (context) =>
          RecallPlugin.setup({
            ...context,
            generate: { text: generation.text },
            session: {
              ...context.session,
              generate: generation.session,
            },
          }),
      }).effect(native)
    }),
})
