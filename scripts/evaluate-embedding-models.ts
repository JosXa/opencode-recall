import { rmSync } from 'node:fs'

import { HistoryDatabase, type SearchRow } from '../src/db'
import { OllamaEmbeddingProvider } from '../src/embedding'
import { RecallSidecarIndex, type SyncResult } from '../src/sidecar'

const DEFAULT_MODELS = ['mxbai-embed-large', 'nomic-embed-text', 'all-minilm']
const MODEL_NAMES = process.argv.slice(2).length === 0 ? DEFAULT_MODELS : process.argv.slice(2)

interface RecallEvalCase {
  readonly name: string
  readonly query: string
  readonly expected: readonly string[]
  readonly directory?: string
}

interface EvalHit {
  readonly rank: number
  readonly title: string
  readonly directory: string
  readonly score: number | undefined
  readonly matched: readonly string[]
  readonly text: string
}

interface EvalResult {
  readonly model: string
  readonly sync: SyncResult
  readonly buildSeconds: number
  readonly searchSeconds: number
  readonly hitAt1: number
  readonly hitAt3: number
  readonly hitAt5: number
  readonly cases: readonly {
    readonly name: string
    readonly query: string
    readonly passAt1: boolean
    readonly passAt3: boolean
    readonly passAt5: boolean
    readonly topHits: readonly EvalHit[]
  }[]
}

const CASES: readonly RecallEvalCase[] = [
  {
    name: 'semantic sidecar implementation',
    query: 'semantic embeddings sidecar opencode db',
    expected: ['semantic', 'sidecar', 'opencode'],
    directory: '/projects/opencode-recall',
  },
  {
    name: 'local vector DB planning',
    query: 'vector database opencode.db separate sidecar embeddings',
    expected: ['vector', 'sidecar', 'embedding'],
  },
  {
    name: 'Molty Telegram watcher issue',
    query: 'Molty Telegram watcher delivery OpenClaw gateway',
    expected: ['molty', 'telegram', 'watcher'],
  },
  {
    name: 'bad transcript plugin pain',
    query: 'session transcript raw JSON cursor search plugin poor',
    expected: ['transcript', 'cursor', 'plugin'],
  },
  {
    name: 'Ollama embedding setup',
    query: 'Ollama mxbai embed large install model startup',
    expected: ['ollama', 'mxbai', 'embed'],
  },
  {
    name: 'history read navigation API',
    query: 'continue conversation nav next prev head tail',
    expected: ['nav', 'next', 'mode'],
    directory: '/projects/opencode-recall',
  },
]

const db = new HistoryDatabase()

try {
  const results: EvalResult[] = []

  for (const model of MODEL_NAMES) {
    results.push(await evaluateModel(model, db))
  }

  console.log(JSON.stringify(results, null, 2))
  console.error(formatSummary(results))
} finally {
  db.close()
}

async function evaluateModel(model: string, db: HistoryDatabase): Promise<EvalResult> {
  const indexPath = `/tmp/opencode-recall-eval-${safeModelName(model)}.db`
  removeSqliteFiles(indexPath)

  const provider = new OllamaEmbeddingProvider({ model })
  const sidecar = new RecallSidecarIndex(indexPath)
  const buildStart = performance.now()

  try {
    const sync = await sidecar.sync(
      (since) => db.readTextPartsForIndex(since),
      provider,
      () => db.readTextPartIds(),
    )
    const buildSeconds = secondsSince(buildStart)
    const searchStart = performance.now()
    const cases = []

    for (const testCase of CASES) {
      const rows = await sidecar.search(
        testCase.query,
        {
          limit: 5,
          ...(testCase.directory === undefined ? {} : { directory: testCase.directory }),
        },
        provider,
      )
      const matches = rows.map((row, index) => formatHit(row, index, testCase.expected))
      cases.push({
        name: testCase.name,
        query: testCase.query,
        passAt1: hasMatch(matches, 1, testCase.expected.length),
        passAt3: hasMatch(matches, 3, testCase.expected.length),
        passAt5: hasMatch(matches, 5, testCase.expected.length),
        topHits: matches,
      })
    }

    return {
      model,
      sync,
      buildSeconds,
      searchSeconds: secondsSince(searchStart),
      hitAt1: ratio(cases.filter((testCase) => testCase.passAt1).length, cases.length),
      hitAt3: ratio(cases.filter((testCase) => testCase.passAt3).length, cases.length),
      hitAt5: ratio(cases.filter((testCase) => testCase.passAt5).length, cases.length),
      cases,
    }
  } finally {
    sidecar.close()
  }
}

function formatHit(row: SearchRow, index: number, expected: readonly string[]): EvalHit {
  const haystack = `${row.sessionTitle}\n${row.directory}\n${row.text}`.toLowerCase()
  return {
    rank: index + 1,
    title: row.sessionTitle,
    directory: row.directory,
    score: row.score === undefined ? undefined : Number(row.score.toFixed(4)),
    matched: expected.filter((term) => haystack.includes(term)),
    text: row.text.replaceAll(/\s+/gu, ' ').slice(0, 180),
  }
}

function hasMatch(hits: readonly EvalHit[], count: number, expectedCount: number): boolean {
  return hits.slice(0, count).some((hit) => hit.matched.length === expectedCount)
}

function ratio(numerator: number, denominator: number): number {
  return Number((numerator / denominator).toFixed(3))
}

function secondsSince(start: number): number {
  return Number(((performance.now() - start) / 1000).toFixed(3))
}

function safeModelName(model: string): string {
  return model.replaceAll(/[^a-zA-Z0-9._-]/gu, '_')
}

function removeSqliteFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${path}${suffix}`, { force: true })
  }
}

function formatSummary(results: readonly EvalResult[]): string {
  const lines = ['model\tbuild_s\tsearch_s\tindexed\thit@1\thit@3\thit@5']

  for (const result of results) {
    lines.push(
      [
        result.model,
        result.buildSeconds,
        result.searchSeconds,
        result.sync.indexedRows,
        result.hitAt1,
        result.hitAt3,
        result.hitAt5,
      ].join('\t'),
    )
  }

  return lines.join('\n')
}
