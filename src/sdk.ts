import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeCursor } from './cursor.js'
import { executeNodeWorker, executeNodeWorkerSync } from './node-worker-client.js'
import type {
  OpenCodeRecallOptions,
  RecallReadOptions,
  RecallSearchHit,
  RecallSearchOptions,
  RecallSearchResult,
} from './sdk-direct.js'
import {
  DirectOpenCodeRecall,
  directReadHistoryWindow,
  directRenderHistoryWindow,
} from './sdk-direct.js'
import type { HistorySearchResult } from './search.js'
import type { SyncOptions, SyncResult } from './sidecar.js'
import type { TranscriptWindow } from './transcript.js'
import type { HistorySearchWorkerArgs } from './worker-protocol.js'

export type { EmbeddingProvider, OllamaEmbeddingProviderOptions } from './embedding.js'
export { OllamaEmbeddingProvider } from './embedding.js'
export type {
  OpenCodeRecallOptions,
  RecallReadOptions,
  RecallSearchHit,
  RecallSearchOptions,
  RecallSearchResult,
} from './sdk-direct.js'
export type { SyncOptions, SyncResult } from './sidecar.js'
export type { TranscriptWindow } from './transcript.js'

const DEFAULT_SEARCH_LIMIT = 50
const DEFAULT_FRESHNESS_EXCLUSION_MS = 30_000
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

export class OpenCodeRecall {
  readonly #options: OpenCodeRecallOptions

  public constructor(options: OpenCodeRecallOptions = {}) {
    this.#options = options
  }

  public close(): void {
    // Worker-backed SDK calls do not keep resources open in the caller process.
  }

  public async sync(options: SyncOptions = {}): Promise<SyncResult> {
    return this.#direct().then((recall) => recall.sync(options))
  }

  public async syncLexical(): Promise<SyncResult> {
    return this.#direct().then((recall) => recall.syncLexical())
  }

  public async search(
    query: string,
    options: RecallSearchOptions = {},
  ): Promise<RecallSearchResult> {
    if (this.#options.embeddingProvider !== undefined) {
      return this.#direct().then((recall) => recall.search(query, options))
    }

    return searchHistory(query, { ...this.#options, ...options })
  }

  public read(cursorValue: string, options: RecallReadOptions = {}): TranscriptWindow {
    const recall = new DirectOpenCodeRecall(this.#options)

    try {
      return recall.read(cursorValue, options)
    } finally {
      recall.close()
    }
  }

  public render(cursorValue: string, options: RecallReadOptions = {}): string {
    const recall = new DirectOpenCodeRecall(this.#options)

    try {
      return recall.render(cursorValue, options)
    } finally {
      recall.close()
    }
  }

  async #direct() {
    const recall = new DirectOpenCodeRecall(this.#options)

    return {
      sync: async (options: SyncOptions) => {
        try {
          return await recall.sync(options)
        } finally {
          recall.close()
        }
      },
      syncLexical: () => {
        try {
          return recall.syncLexical()
        } finally {
          recall.close()
        }
      },
      search: async (query: string, options: RecallSearchOptions) => {
        try {
          return await recall.search(query, options)
        } finally {
          recall.close()
        }
      },
      read: (cursor: string, options: RecallReadOptions) => {
        try {
          return recall.read(cursor, options)
        } finally {
          recall.close()
        }
      },
      render: (cursor: string, options: RecallReadOptions) => {
        try {
          return recall.render(cursor, options)
        } finally {
          recall.close()
        }
      },
    }
  }
}

export async function searchHistory(
  query: string,
  options: RecallSearchOptions & OpenCodeRecallOptions = {},
): Promise<RecallSearchResult> {
  if (options.embeddingProvider !== undefined) {
    const { directSearchHistory } = await import('./sdk-direct.js')
    return directSearchHistory(query, options)
  }

  const raw = await executeNodeWorker(
    PACKAGE_DIR,
    {
      kind: 'search',
      args: searchWorkerArgs(query, options),
      context: { sessionID: options.currentSessionId ?? '' },
    },
    AbortSignal.timeout(120_000),
  )

  return { hits: parseWorkerSearchHits(raw) }
}

export function readHistoryWindow(
  cursor: string,
  options: RecallReadOptions & OpenCodeRecallOptions = {},
): TranscriptWindow {
  return directReadHistoryWindow(cursor, options)
}

export function renderHistoryWindow(
  cursor: string,
  options: RecallReadOptions & OpenCodeRecallOptions = {},
): string {
  if (options.embeddingProvider !== undefined) {
    return directRenderHistoryWindow(cursor, options)
  }

  return executeNodeWorkerSync(PACKAGE_DIR, {
    kind: 'read',
    args: {
      cursor,
      mode: options.mode,
      n: options.limit,
      historyDbPath: options.historyDbPath,
    },
  })
}

function searchWorkerArgs(
  query: string,
  options: RecallSearchOptions & OpenCodeRecallOptions,
): HistorySearchWorkerArgs {
  return {
    q: query,
    n: options.limit ?? DEFAULT_SEARCH_LIMIT,
    directory: options.directory,
    includeCurrentSession: options.includeCurrentSession,
    excludeSessionId: options.excludeSessionId ?? defaultExcludedSessionId(options),
    after: optionalDateArg(options.after),
    before: optionalDateArg(options.before ?? defaultBefore(options)),
    historyDbPath: options.historyDbPath,
    sidecarDbPath: options.sidecarDbPath,
    semantic: options.semantic,
    lexical: options.lexical,
    sync: options.sync,
  }
}

function parseWorkerSearchHits(value: string): readonly RecallSearchHit[] {
  const json = searchJsonPayload(value)

  if (json === undefined) {
    return []
  }

  const parsed = JSON.parse(json) as unknown

  if (!Array.isArray(parsed)) {
    return []
  }

  return parsed.flatMap((item) => (isHistorySearchResult(item) ? [toSearchHit(item)] : []))
}

function searchJsonPayload(value: string): string | undefined {
  const start = value.indexOf('[')

  if (start === -1) {
    return undefined
  }

  return value.slice(start)
}

function isHistorySearchResult(value: unknown): value is HistorySearchResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const result = value as Partial<Record<keyof HistorySearchResult, unknown>>
  return (
    typeof result.cursor === 'string' &&
    typeof result.sid === 'string' &&
    typeof result.title === 'string' &&
    typeof result.directory === 'string' &&
    typeof result.time === 'string' &&
    typeof result.role === 'string' &&
    typeof result.text === 'string'
  )
}

function toSearchHit(result: HistorySearchResult): RecallSearchHit {
  const cursor = decodeCursor(result.cursor)
  const timeCreated = Date.parse(result.time)

  return {
    cursor: result.cursor,
    sessionId: result.sid,
    sessionTitle: result.title,
    directory: result.directory,
    messageId: cursor.messageId ?? '',
    partId: cursor.partId ?? '',
    role: result.role,
    ...(result.score === undefined ? {} : { score: result.score }),
    timeCreated: Number.isFinite(timeCreated) ? timeCreated : 0,
    time: result.time,
    text: result.text,
    ...(result.source === undefined ? {} : { source: result.source }),
  }
}

function defaultExcludedSessionId(options: RecallSearchOptions): string | undefined {
  if (options.includeCurrentSession === true) {
    return undefined
  }

  return options.currentSessionId
}

function defaultBefore(options: RecallSearchOptions): Date | number | string | undefined {
  if (options.includeCurrentSession === true || options.currentSessionId === undefined) {
    return undefined
  }

  return Date.now() - DEFAULT_FRESHNESS_EXCLUSION_MS
}

function optionalDateArg(value: Date | number | string | undefined): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : undefined
  }

  return value.length === 0 ? undefined : value
}
