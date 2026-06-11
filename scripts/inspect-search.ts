import { HistoryDatabase, type SearchRow } from '../src/db'
import { OllamaEmbeddingProvider } from '../src/embedding'
import { rankSearchRows } from '../src/search'
import { RecallSidecarIndex } from '../src/sidecar'

interface InspectOptions {
  readonly query: string
  readonly limit: number
  readonly semanticLimit: number
  readonly lexicalLimit: number
}

const options = parseArgs(process.argv.slice(2))
const history = new HistoryDatabase()
const sidecar = new RecallSidecarIndex()
const provider = new OllamaEmbeddingProvider()

try {
  const searchOptions = { limit: options.limit, before: Date.now() - 30_000 }
  const semanticRows = await sidecar.search(options.query, searchOptions, provider)
  const lexicalRows = history.lexicalSearch(options.query, searchOptions)
  const rankedRows = rankSearchRows(options.query, [...lexicalRows, ...semanticRows], options.limit)

  console.log(
    JSON.stringify(
      {
        query: options.query,
        counts: {
          semantic: semanticRows.length,
          lexical: lexicalRows.length,
          final: rankedRows.length,
        },
        semanticTop: semanticRows.slice(0, options.semanticLimit).map(formatRow),
        lexicalTop: lexicalRows.slice(0, options.lexicalLimit).map(formatRow),
        final: rankedRows.map(formatRow),
      },
      null,
      2,
    ),
  )
} finally {
  sidecar.close()
  history.close()
}

function parseArgs(args: readonly string[]): InspectOptions {
  const queryParts: string[] = []
  let limit = 12
  let semanticLimit = 20
  let lexicalLimit = 20

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === undefined) {
      continue
    }

    if (arg === '--limit') {
      limit = parseNumber(args[index + 1], limit)
      index += 1
      continue
    }

    if (arg === '--semantic') {
      semanticLimit = parseNumber(args[index + 1], semanticLimit)
      index += 1
      continue
    }

    if (arg === '--lexical') {
      lexicalLimit = parseNumber(args[index + 1], lexicalLimit)
      index += 1
      continue
    }

    queryParts.push(arg)
  }

  const query = queryParts.join(' ').trim()

  if (query.length === 0) {
    throw new Error('Usage: bun scripts/inspect-search.ts <query> [--limit 12]')
  }

  return { query, limit, semanticLimit, lexicalLimit }
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function formatRow(row: SearchRow, index: number) {
  return {
    rank: index + 1,
    source: row.source ?? 'text',
    score: row.score === undefined ? undefined : Number(row.score.toFixed(4)),
    sessionId: row.sessionId,
    messageId: row.messageId,
    partId: row.partId,
    title: row.sessionTitle,
    directory: row.directory,
    role: row.role,
    time: new Date(row.timeCreated).toISOString(),
    text: row.text.replaceAll(/\s+/gu, ' ').trim().slice(0, 240),
  }
}
