export interface HistorySearchWorkerArgs {
  readonly q?: string | undefined
  readonly n?: number | undefined
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
}

export interface HistoryReadWorkerArgs {
  readonly cursor?: string | undefined
  readonly mode?: string | undefined
  readonly n?: number | undefined
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
