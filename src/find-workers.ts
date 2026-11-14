import type { JudgeConfig } from './config.js'
import type { FindDependencies, FindScanResult, FindSearchResult } from './find.js'
import type { FocusTranscript } from './focus-transcript.js'
import { executeNodeWorker } from './node-worker-client.js'
import type { SessionDigest } from './passages.js'
import type { HistorySearchWorkerArgs, SessionScanWorkerArgs } from './worker-protocol.js'

export type HistoryWorkerDependencies = Pick<
  FindDependencies,
  'search' | 'scan' | 'digest' | 'transcripts'
>

export interface HistoryWorkerScope {
  readonly workerDir: string
  readonly sessionID: string
  readonly directory?: string | undefined
  readonly signal: AbortSignal
}

export function historyWorkers(
  judge: JudgeConfig,
  scope: HistoryWorkerScope,
): HistoryWorkerDependencies {
  const worker = (payload: Parameters<typeof executeNodeWorker>[1]) =>
    executeNodeWorker(scope.workerDir, payload, scope.signal)
  const context = { sessionID: scope.sessionID }
  return {
    search: async (queries, window) => {
      const count = judge.find.searchShards
      const shards = await Promise.all(
        Array.from({ length: count }, async (_, index) => {
          const args = {
            queries,
            shard: { index, count },
            n: judge.find.queryHits,
            maxSearchLimit: judge.find.queryHits,
            excludeSubagents: true,
            directory: scope.directory,
            ...window,
            sync: false,
            format: 'json',
          } as HistorySearchWorkerArgs
          return JSON.parse(await worker({ kind: 'search', args, context })) as FindSearchResult
        }),
      )
      return {
        lists: shards.flatMap((shard) => shard.lists),
        notice: shards.find((shard) => shard.notice !== undefined)?.notice,
      }
    },
    scan: async (window) => {
      const args = {
        ...window,
        directory: scope.directory,
        maxSessions: judge.scan.maxSessions,
        maxInputTokens: judge.scan.maxInputTokens,
        digestChars: judge.scan.digestChars,
        promptSamples: judge.scan.promptSamples,
        sessionsPerDirectory: judge.scan.sessionsPerDirectory,
        excludeDirectories: judge.scan.excludeDirectories,
      } as SessionScanWorkerArgs
      return JSON.parse(await worker({ kind: 'scan-sessions', args, context })) as FindScanResult
    },
    digest: async (sessions, terms) => {
      const args = {
        sessions,
        queries: terms,
        passagesPerSession: judge.find.passagesPerSession,
        passageChars: judge.find.passageChars,
      }
      return JSON.parse(await worker({ kind: 'session-digest', args })) as readonly SessionDigest[]
    },
    transcripts: async (cursors) => {
      const args = { cursors, textChars: judge.focus.textChars, toolChars: judge.focus.toolChars }
      return JSON.parse(
        await worker({ kind: 'focus-transcripts', args }),
      ) as readonly FocusTranscript[]
    },
  }
}
