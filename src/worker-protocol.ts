export interface HistorySearchWorkerArgs {
  readonly q?: string | undefined
  readonly n?: number | undefined
  readonly maxSearchLimit?: number | undefined
  readonly directory?: string | undefined
  readonly includeCurrentSession?: boolean | undefined
  readonly excludeSessionId?: string | undefined
  readonly after?: string | undefined
  readonly before?: string | undefined
  readonly historyDbPath?: string | undefined
  readonly sidecarDbPath?: string | undefined
  readonly semantic?: boolean | undefined
  readonly lexical?: boolean | undefined
  readonly sync?: boolean | undefined
  readonly format?: 'text' | 'json' | undefined
}

export interface HistoryReadWorkerArgs {
  readonly cursor?: string | undefined
  readonly mode?: string | undefined
  readonly n?: number | undefined
  readonly historyDbPath?: string | undefined
}

export interface SessionIndexWorkerArgs {
  readonly n?: number | undefined
  readonly title?: string | undefined
  readonly directory?: string | undefined
  readonly includeCurrentSession?: boolean | undefined
  readonly excludeSessionId?: string | undefined
  readonly after?: string | undefined
  readonly before?: string | undefined
  readonly historyDbPath?: string | undefined
  readonly format?: 'text' | 'json' | undefined
}

export interface SessionSaveWorkerArgs {
  readonly cursor?: string | undefined
  readonly path?: string | undefined
  readonly format?: 'chatml' | 'markdown' | 'jsonl' | undefined
  readonly historyDbPath?: string | undefined
}

export type HistoryWorkerRequest =
  | {
      readonly kind: 'search'
      readonly args: HistorySearchWorkerArgs
      readonly context: {
        readonly sessionID: string
      }
    }
  | {
      readonly kind: 'session-index'
      readonly args: SessionIndexWorkerArgs
      readonly context: {
        readonly sessionID: string
      }
    }
  | {
      readonly kind: 'session-save'
      readonly args: SessionSaveWorkerArgs
      readonly context: {
        readonly directory: string
      }
    }
  | {
      readonly kind: 'read'
      readonly args: HistoryReadWorkerArgs
    }
  | {
      readonly kind: 'read-window'
      readonly args: HistoryReadWorkerArgs
    }

export type HistoryWorkerResponse =
  | {
      readonly ok: true
      readonly data: string
    }
  | {
      readonly ok: false
      readonly error: {
        readonly message: string
      }
    }
