import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

import { getConfigFilePath, loadConfig } from '../src/config'
import { decodeCursor } from '../src/cursor'
import { HistoryDatabase, type IndexSourceRow, type SearchRow } from '../src/db'
import type { EmbeddingProvider } from '../src/embedding'
import { OllamaEmbeddingProvider } from '../src/embedding'
import { rankSearchRows } from '../src/search'
import { OpenCodeRecall, searchHistory } from '../src/sdk'
import { RecallSidecarIndex } from '../src/sidecar'

const BASE_ROW = {
  sessionId: 'ses_other',
  sessionTitle: 'Completely unrelated conversation',
  directory: '/Users/joscha',
  messageId: 'msg_other',
  partId: 'part_other',
  role: 'assistant',
  timeCreated: 1,
  text: 'generic mcp troubleshooting with no figma or azure registry context',
} satisfies SearchRow

describe('config file loading', () => {
  test('auto-creates recall.jsonc at the OpenCode config base path', () => {
    withRecallEnv(() => {
      const configPath = getConfigFilePath()

      expect(existsSync(configPath)).toBe(false)
      const config = loadConfig()

      expect(existsSync(configPath)).toBe(true)
      expect(readFileSync(configPath, 'utf-8')).toContain('"database"')
      expect(config.database.path).toContain('/opencode/opencode.db')
      expect(config.database.indexPath).toContain('/opencode/opencode-recall-index.db')
      expect(config.embeddings).toEqual({
        ollamaUrl: 'http://127.0.0.1:11434',
        model: 'all-minilm',
      })
    })
  })

  test('loads JSONC config with comments, trailing commas, and tilde paths', () => {
    withRecallEnv(({ configDir }) => {
      writeFileSync(
        `${configDir}/recall.jsonc`,
        `{
          // The parser must not treat URL slashes inside strings as comments.
          "database": {
            "path": "~/custom/opencode.db",
            "indexPath": "~/custom/recall-index.db",
          },
          "embeddings": {
            "ollamaUrl": "http://ollama.example:11434",
            "model": "mxbai-embed-large",
          },
        }`,
      )

      const home = process.env['HOME'] ?? ''
      const config = loadConfig()

      expect(config.database.path).toBe(`${home}/custom/opencode.db`)
      expect(config.database.indexPath).toBe(`${home}/custom/recall-index.db`)
      expect(config.embeddings).toEqual({
        ollamaUrl: 'http://ollama.example:11434',
        model: 'mxbai-embed-large',
      })
    })
  })

  test('environment variables override file config', () => {
    withRecallEnv(({ configDir }) => {
      writeFileSync(
        `${configDir}/recall.jsonc`,
        JSON.stringify({
          database: { path: '/file/history.db', indexPath: '/file/index.db' },
          embeddings: { ollamaUrl: 'http://file.example:11434', model: 'file-model' },
        }),
      )
      process.env['OPENCODE_DB_PATH'] = '/env/history.db'
      process.env['OPENCODE_RECALL_DB_PATH'] = '/env/index.db'
      process.env['OPENCODE_RECALL_OLLAMA_URL'] = 'http://env.example:11434'
      process.env['OPENCODE_RECALL_EMBED_MODEL'] = 'env-model'

      expect(loadConfig()).toEqual({
        database: { path: '/env/history.db', indexPath: '/env/index.db' },
        embeddings: { ollamaUrl: 'http://env.example:11434', model: 'env-model' },
      })
    })
  })

  test('default constructors use resolved file config', async () => {
    await withRecallEnvAsync(async ({ configDir }) => {
      const historyPath = `/tmp/opencode-recall-config-history-${crypto.randomUUID()}.db`
      const sidecarPath = `/tmp/opencode-recall-config-sidecar-${crypto.randomUUID()}.db`
      const db = new Database(historyPath)
      const originalFetch = globalThis.fetch
      const requests: string[] = []

      try {
        db.exec(`
          create table session (id text primary key, title text, directory text, time_updated integer);
          create table message (id text primary key, session_id text, data text, time_created integer, time_updated integer);
          create table part (id text primary key, message_id text, session_id text, data text, time_updated integer);
        `)
        insertTextPart(db, 'ses_config', 'Config DB', 'msg_config', 'part_config', 1)
        writeFileSync(
          `${configDir}/recall.jsonc`,
          JSON.stringify({
            database: { path: historyPath, indexPath: sidecarPath },
            embeddings: { ollamaUrl: 'http://config-ollama.test', model: 'config-model' },
          }),
        )

        const history = new HistoryDatabase()
        const index = new RecallSidecarIndex()
        globalThis.fetch = ((input, init) => {
          requests.push(String(input))
          if (String(input).endsWith('/api/version')) {
            return Promise.resolve(Response.json({ version: 'test' }))
          }
          if (String(input).endsWith('/api/tags')) {
            return Promise.resolve(Response.json({ models: [{ name: 'config-model:latest' }] }))
          }

          requests.push(String(init?.body))
          return Promise.resolve(Response.json({ embeddings: [[1, 2, 3]] }))
        }) as typeof fetch

        try {
          expect(history.lexicalSearch('invoices cli', { limit: 5 })).toHaveLength(1)
          expect(existsSync(sidecarPath)).toBe(true)
          await new OllamaEmbeddingProvider().embed(['config search'])
          expect(requests).toContain('http://config-ollama.test/api/version')
          expect(requests.some((request) => request.includes('"model":"config-model"'))).toBe(true)
        } finally {
          history.close()
          index.close()
        }
      } finally {
        globalThis.fetch = originalFetch
        db.close()
        removeSqliteFiles(historyPath)
        removeSqliteFiles(sidecarPath)
      }
    })
  })
})

describe('cursor decoding', () => {
  test('accepts OpenCode session ids directly', () => {
    expect(decodeCursor('ses_1ea07e649ffe8rG0kUBk4oJQC8')).toEqual({
      version: 1,
      sessionId: 'ses_1ea07e649ffe8rG0kUBk4oJQC8',
    })
  })

  test('rejects invalid cursors without leaking JSON parse garbage', () => {
    expect(() => decodeCursor('definitely-not-a-cursor')).toThrow(
      'Invalid history cursor. Expected msg_..., ses_..., or an encoded cursor from history_search.',
    )
  })

  test('rejects invented session offset suffixes', () => {
    expect(() => decodeCursor('ses_1ea07e649ffe8rG0kUBk4oJQC8:10')).toThrow(
      'Invalid history cursor. Expected msg_..., ses_..., or an encoded cursor from history_search.',
    )
  })
})

describe('ollama embeddings', () => {
  test('normalizes long inputs before calling Ollama', async () => {
    const originalFetch = globalThis.fetch
    const requests: string[] = []

    globalThis.fetch = ((input, init) => {
      if (String(input).endsWith('/api/version')) {
        return Promise.resolve(Response.json({ version: 'test' }))
      }
      if (String(input).endsWith('/api/tags')) {
        return Promise.resolve(Response.json({ models: [{ name: 'all-minilm:latest' }] }))
      }

      requests.push(String(init?.body))
      return Promise.resolve(Response.json({ embeddings: [[1, 2, 3]] }))
    }) as typeof fetch

    try {
      await new OllamaEmbeddingProvider({ baseUrl: 'http://ollama.test' }).embed([
        `${'tool '.repeat(200)}final term`,
      ])
    } finally {
      globalThis.fetch = originalFetch
    }

    const payload = JSON.parse(requests[0] ?? '{}') as { readonly input?: readonly string[] }

    expect(payload.input?.[0]?.length).toBeLessThanOrEqual(256)
    expect(payload.input?.[0]).not.toContain('\n')
  })

  test('splits oversized Ollama batches on context length errors', async () => {
    const originalFetch = globalThis.fetch
    const requestSizes: number[] = []

    globalThis.fetch = ((input, init) => {
      if (String(input).endsWith('/api/version')) {
        return Promise.resolve(Response.json({ version: 'test' }))
      }
      if (String(input).endsWith('/api/tags')) {
        return Promise.resolve(Response.json({ models: [{ name: 'all-minilm:latest' }] }))
      }

      const payload = JSON.parse(String(init?.body)) as { readonly input?: readonly string[] }
      requestSizes.push(payload.input?.length ?? 0)

      if ((payload.input?.length ?? 0) > 1) {
        return Promise.resolve(
          new Response('{"error":"the input length exceeds the context length"}', {
            status: 400,
            statusText: 'Bad Request',
          }),
        )
      }

      return Promise.resolve(Response.json({ embeddings: [[1, 2, 3]] }))
    }) as typeof fetch

    try {
      const embeddings = await new OllamaEmbeddingProvider({ baseUrl: 'http://ollama.test' }).embed([
        'first invoice cli note',
        'second invoice cli note',
        'third invoice cli note',
      ])
      expect(embeddings).toHaveLength(3)
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(requestSizes).toEqual([3, 2, 1, 1, 1])
  })

  test('shrinks single inputs rejected for context length', async () => {
    const originalFetch = globalThis.fetch
    const inputLengths: number[] = []

    globalThis.fetch = ((request, init) => {
      if (String(request).endsWith('/api/version')) {
        return Promise.resolve(Response.json({ version: 'test' }))
      }
      if (String(request).endsWith('/api/tags')) {
        return Promise.resolve(Response.json({ models: [{ name: 'all-minilm:latest' }] }))
      }

      const payload = JSON.parse(String(init?.body)) as { readonly input?: readonly string[] }
      const embedInput = payload.input?.[0] ?? ''
      inputLengths.push(embedInput.length)

      if (embedInput.length > 32) {
        return Promise.resolve(
          new Response('{"error":"the input length exceeds the context length"}', {
            status: 400,
            statusText: 'Bad Request',
          }),
        )
      }

      return Promise.resolve(Response.json({ embeddings: [[1, 2, 3]] }))
    }) as typeof fetch

    try {
      const embeddings = await new OllamaEmbeddingProvider({ baseUrl: 'http://ollama.test' }).embed([
        'invoice '.repeat(40),
      ])
      expect(embeddings).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(inputLengths).toEqual([256, 127, 63, 31])
  })
})

describe('strict ranking', () => {
  test('promotes exact title matches over noisy semantic-looking text', () => {
    const rows: SearchRow[] = [
      { ...BASE_ROW, score: 0.99 },
      {
        ...BASE_ROW,
        sessionId: 'ses_1ea07e649ffe8rG0kUBk4oJQC8',
        sessionTitle: 'Figma MCP server on Azure API Center',
        messageId: 'msg_figma',
        partId: 'session-title:ses_1ea07e649ffe8rG0kUBk4oJQC8',
        source: 'session-title',
        score: 0.5,
        text: 'Title: Figma MCP server on Azure API Center\nDirectory: /Users/joscha',
      },
    ]

    expect(rankSearchRows('figma mcp', rows, 5)[0]?.sessionId).toBe(
      'ses_1ea07e649ffe8rG0kUBk4oJQC8',
    )
  })

  test('filters rows that do not match enough query terms', () => {
    const rows = rankSearchRows('figma azure api center', [BASE_ROW], 5)

    expect(rows).toEqual([])
  })

  test('allows partial term matches with semantic support because recall chunks are short', () => {
    const rows = rankSearchRows(
      'power platform connector',
      [
        {
          ...BASE_ROW,
          sessionTitle: 'Platform connector docs',
          messageId: 'msg_platform_connector',
          partId: 'part_platform_connector',
          score: 0.5,
          text: 'platform connector setup notes without the missing domain term',
        },
      ],
      5,
    )

    expect(rows[0]?.sessionId).toBe(BASE_ROW.sessionId)
  })

  test('filters weak partial lexical tails for short queries', () => {
    const rows = rankSearchRows(
      'power platform connector',
      [
        {
          ...BASE_ROW,
          sessionTitle: 'Generic architecture notes',
          messageId: 'msg_weak_partial',
          partId: 'part_weak_partial',
          text: 'platform policy notes for a broad internal marketplace',
        },
      ],
      5,
    )

    expect(rows).toEqual([])
  })

  test('does not rescue weak semantic matches for nonsense queries', () => {
    const rows = rankSearchRows(
      'qxnovarplume yztranglemoss',
      [
        {
          ...BASE_ROW,
          score: 0.48,
          text: 'now add the new qa event kind values and helpers',
        },
      ],
      5,
    )

    expect(rows).toEqual([])
  })

  test('filters noisy file dump chunks from lexical tails', () => {
    const rows = rankSearchRows(
      'power platform connector',
      [
        {
          ...BASE_ROW,
          sessionTitle: 'Unrelated implementation review',
          messageId: 'msg_file_dump',
          partId: 'part_file_dump',
          text: '<path>/repo/frontend/platform-connector.md</path> power platform connector docs dump',
        },
      ],
      5,
    )

    expect(rows).toEqual([])
  })

  test('rescues high-confidence semantic matches with weak lexical overlap', () => {
    const rows = rankSearchRows(
      'phone microphone spying ads psychology effect',
      [
        {
          ...BASE_ROW,
          sessionId: 'ses_baader_meinhof',
          sessionTitle: 'Baader-Meinhof & confirmation bias in ad paranoia',
          messageId: 'msg_baader_meinhof',
          partId: 'part_baader_meinhof',
          score: 0.7,
          text: 'frequency illusion and confirmation bias explain why ads feel related to recent conversations',
        },
      ],
      5,
    )

    expect(rows[0]?.sessionId).toBe('ses_baader_meinhof')
    expect(rows[0]?.source).toBe('semantic-rescue')
  })

  test('diversifies results by session to reduce current-session flooding', () => {
    const rows: SearchRow[] = Array.from({ length: 5 }, (_, index) => ({
      ...BASE_ROW,
      sessionId: 'ses_current',
      sessionTitle: 'Figma MCP current diagnostic session',
      messageId: `msg_current_${index}`,
      partId: `part_current_${index}`,
      timeCreated: 10 + index,
      text: 'figma mcp azure api center registry',
    }))
    rows.push({
      ...BASE_ROW,
      sessionId: 'ses_old',
      sessionTitle: 'Figma MCP server on Azure API Center',
      messageId: 'msg_old',
      partId: 'part_old',
      text: 'figma mcp azure api center',
    })

    const ranked = rankSearchRows('figma mcp azure api center', rows, 5)

    expect(ranked.filter((row) => row.sessionId === 'ses_current')).toHaveLength(2)
    expect(ranked.some((row) => row.sessionId === 'ses_old')).toBe(true)
  })
})

describe('current session exclusion', () => {
  test('lexical search excludes the current session by default option', () => {
    const path = `/tmp/opencode-recall-history-${crypto.randomUUID()}.db`
    const db = new Database(path)

    try {
      db.exec(`
        create table session (id text primary key, title text, directory text, time_updated integer);
        create table message (id text primary key, session_id text, data text, time_created integer, time_updated integer);
        create table part (id text primary key, message_id text, session_id text, data text, time_updated integer);
      `)
      insertTextPart(db, 'ses_current', 'Current chat', 'msg_current', 'part_current', 2)
      insertTextPart(db, 'ses_old', 'Older chat', 'msg_old', 'part_old', 1)

      const history = new HistoryDatabase(path)
      try {
        const results = history.lexicalSearch('invoices cli', {
          limit: 10,
          excludeSessionId: 'ses_current',
        })

        expect(results.map((row) => row.sessionId)).toEqual(['ses_old'])
      } finally {
        history.close()
      }
    } finally {
      db.close()
      removeSqliteFiles(path)
    }
  })

  test('semantic sidecar search excludes the current session by default option', async () => {
    const path = `/tmp/opencode-recall-sidecar-${crypto.randomUUID()}.db`
    const index = new RecallSidecarIndex(path)
    const provider = new ConstantEmbeddingProvider()
    const rows = [
      indexRow('ses_current', 'msg_current', 'part_current', 2),
      indexRow('ses_old', 'msg_old', 'part_old', 1),
    ]

    try {
      await index.sync(() => rows, provider, () => rows.map((row) => row.partId))
      const excluded = await index.search(
        'invoices cli',
        { limit: 10, excludeSessionId: 'ses_current' },
        provider,
      )
      const included = await index.search('invoices cli', { limit: 10 }, provider)

      expect(excluded.map((row) => row.sessionId)).toEqual(['ses_old'])
      expect(included.map((row) => row.sessionId)).toContain('ses_current')
    } finally {
      index.close()
      removeSqliteFiles(path)
    }
  })
})

describe('library sdk', () => {
  test('root module stays plugin-only for file URL loading', async () => {
    const root = await import('../index')

    expect(Object.keys(root).sort()).toEqual(['RecallPlugin', 'default'])
  })

  test('searchHistory returns ranked public hits from custom databases', async () => {
    const historyPath = `/tmp/opencode-recall-sdk-history-${crypto.randomUUID()}.db`
    const sidecarPath = `/tmp/opencode-recall-sdk-sidecar-${crypto.randomUUID()}.db`
    const db = new Database(historyPath)

    try {
      db.exec(`
        create table session (id text primary key, title text, directory text, time_updated integer);
        create table message (id text primary key, session_id text, data text, time_created integer, time_updated integer);
        create table part (id text primary key, message_id text, session_id text, data text, time_updated integer);
      `)
      insertTextPart(db, 'ses_sdk', 'SDK integration', 'msg_sdk', 'part_sdk', 1)

      const result = await searchHistory('invoices cli', {
        historyDbPath: historyPath,
        sidecarDbPath: sidecarPath,
        embeddingProvider: new ConstantEmbeddingProvider(),
        limit: 5,
      })

      expect(result.hits[0]).toMatchObject({
        cursor: 'msg_sdk',
        sessionId: 'ses_sdk',
        sessionTitle: 'SDK integration',
        directory: '/projects/invoices-cli',
      })
      expect(result.sync?.lockAcquired).toBe(true)
    } finally {
      db.close()
      removeSqliteFiles(historyPath)
      removeSqliteFiles(sidecarPath)
    }
  })

  test('OpenCodeRecall reads normalized transcript windows', () => {
    const historyPath = `/tmp/opencode-recall-sdk-read-${crypto.randomUUID()}.db`
    const sidecarPath = `/tmp/opencode-recall-sdk-read-sidecar-${crypto.randomUUID()}.db`
    const db = new Database(historyPath)

    try {
      db.exec(`
        create table session (id text primary key, title text, directory text, time_updated integer);
        create table message (id text primary key, session_id text, data text, time_created integer, time_updated integer);
        create table part (id text primary key, message_id text, session_id text, data text, time_updated integer);
      `)
      insertTextPart(db, 'ses_read', 'Read SDK', 'msg_read', 'part_read', 1)

      const recall = new OpenCodeRecall({
        historyDbPath: historyPath,
        sidecarDbPath: sidecarPath,
        embeddingProvider: new ConstantEmbeddingProvider(),
      })

      try {
        const window = recall.read('ses_read')

        expect(window.sessionId).toBe('ses_read')
        expect(window.messages[0]?.parts[0]).toEqual({
          type: 'text',
          text: 'invoices cli location notes',
        })
        expect(recall.render('msg_read')).toContain('<hist sid="ses_read"')
      } finally {
        recall.close()
      }
    } finally {
      db.close()
      removeSqliteFiles(historyPath)
      removeSqliteFiles(sidecarPath)
    }
  })
})

class ConstantEmbeddingProvider implements EmbeddingProvider {
  public readonly model = 'test-model'

  public embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return Promise.resolve(texts.map(() => new Float32Array([1, 0, 0])))
  }
}

function insertTextPart(
  db: Database,
  sessionId: string,
  title: string,
  messageId: string,
  partId: string,
  timestamp: number,
): void {
  db.query('insert into session values (?, ?, ?, ?)').run(
    sessionId,
    title,
    '/projects/invoices-cli',
    timestamp,
  )
  db.query('insert into message values (?, ?, ?, ?, ?)').run(
    messageId,
    sessionId,
    JSON.stringify({ role: 'user' }),
    timestamp,
    timestamp,
  )
  db.query('insert into part values (?, ?, ?, ?, ?)').run(
    partId,
    messageId,
    sessionId,
    JSON.stringify({ type: 'text', text: 'invoices cli location notes' }),
    timestamp,
  )
}

function indexRow(
  sessionId: string,
  messageId: string,
  partId: string,
  timestamp: number,
): IndexSourceRow {
  return {
    sessionId,
    sessionTitle: `${sessionId} title`,
    directory: '/projects/invoices-cli',
    messageId,
    partId,
    role: 'user',
    timeCreated: timestamp,
    sourceUpdated: timestamp,
    text: 'invoices cli location notes',
    source: 'text',
  }
}

function removeSqliteFiles(path: string): void {
  rmSync(path, { force: true })
  rmSync(`${path}-shm`, { force: true })
  rmSync(`${path}-wal`, { force: true })
}

interface RecallEnvContext {
  readonly root: string
  readonly configDir: string
  readonly dataHome: string
}

const CONFIG_ENV_KEYS = [
  'OPENCODE_CONFIG_DIR',
  'XDG_DATA_HOME',
  'OPENCODE_DB_PATH',
  'OPENCODE_RECALL_DB_PATH',
  'OPENCODE_RECALL_OLLAMA_URL',
  'OPENCODE_RECALL_EMBED_MODEL',
] as const

function withRecallEnv<T>(callback: (context: RecallEnvContext) => T): T {
  const context = createRecallEnvContext()
  const previous = captureEnv()

  try {
    applyRecallEnv(context)
    return callback(context)
  } finally {
    restoreEnv(previous)
    rmSync(context.root, { recursive: true, force: true })
  }
}

async function withRecallEnvAsync<T>(
  callback: (context: RecallEnvContext) => Promise<T>,
): Promise<T> {
  const context = createRecallEnvContext()
  const previous = captureEnv()

  try {
    applyRecallEnv(context)
    return await callback(context)
  } finally {
    restoreEnv(previous)
    rmSync(context.root, { recursive: true, force: true })
  }
}

function createRecallEnvContext(): RecallEnvContext {
  const root = `/tmp/opencode-recall-config-${crypto.randomUUID()}`
  const configDir = `${root}/opencode-config`
  const dataHome = `${root}/data`
  mkdirSync(configDir, { recursive: true })
  mkdirSync(dataHome, { recursive: true })
  return { root, configDir, dataHome }
}

function applyRecallEnv(context: RecallEnvContext): void {
  process.env['OPENCODE_CONFIG_DIR'] = context.configDir
  process.env['XDG_DATA_HOME'] = context.dataHome
  delete process.env['OPENCODE_DB_PATH']
  delete process.env['OPENCODE_RECALL_DB_PATH']
  delete process.env['OPENCODE_RECALL_OLLAMA_URL']
  delete process.env['OPENCODE_RECALL_EMBED_MODEL']
}

function captureEnv(): Map<(typeof CONFIG_ENV_KEYS)[number], string | undefined> {
  return new Map(CONFIG_ENV_KEYS.map((key) => [key, process.env[key]]))
}

function restoreEnv(previous: Map<(typeof CONFIG_ENV_KEYS)[number], string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) {
      delete process.env[key]
      continue
    }

    process.env[key] = value
  }
}
