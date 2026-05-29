import { rmSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import type { IndexSourceRow } from '../src/db'
import { OllamaEmbeddingProvider } from '../src/embedding'
import { RecallSidecarIndex } from '../src/sidecar'

const REAL_OLLAMA_ENABLED = process.env['OPENCODE_RECALL_REAL_OLLAMA'] === '1'
const realOllamaTest = REAL_OLLAMA_ENABLED ? test : test.skip
const INTEGRATION_TIMEOUT_MS = 180_000

describe('real Ollama integration', () => {
  realOllamaTest(
    'starts Ollama and runs sidecar sync/search through the real embedding provider',
    async () => {
      const baseUrl = await unusedOllamaBaseUrl()
      const dbPath = `/tmp/opencode-recall-ollama-${crypto.randomUUID()}.db`
      const provider = new OllamaEmbeddingProvider({ baseUrl })
      const index = new RecallSidecarIndex(dbPath)
      const rows = indexRows()

      expect(await serverResponds(baseUrl)).toBe(false)

      try {
        const syncResult = await index.sync(() => rows, provider, () => rows.map((row) => row.partId))
        const results = await index.search('invoices cli', { limit: 5 }, provider)

        expect(await serverResponds(baseUrl)).toBe(true)
        expect(syncResult.lockAcquired).toBe(true)
        expect(syncResult.indexedRows).toBe(rows.length)
        expect(results.some((row) => row.text.includes('invoices cli'))).toBe(true)
      } finally {
        index.close()
        provider.close()
        rmSync(dbPath, { force: true })
        rmSync(`${dbPath}-shm`, { force: true })
        rmSync(`${dbPath}-wal`, { force: true })
      }
    },
    INTEGRATION_TIMEOUT_MS,
  )
})

function indexRows(): IndexSourceRow[] {
  const now = Date.now()
  return Array.from({ length: 96 }, (_, index) => ({
    sessionId: 'ses_real_ollama_integration',
    sessionTitle: 'Invoices CLI implementation notes',
    directory: '/projects/invoices-cli',
    messageId: `msg_real_ollama_${index}`,
    partId: `part_real_ollama_${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    timeCreated: now + index,
    sourceUpdated: now + index,
    source: 'text',
    text: `invoices cli high level integration row ${index} ${'token '.repeat(80)}`,
  }))
}

async function unusedOllamaBaseUrl(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 19_000 + Math.floor(Math.random() * 1_000)
    const baseUrl = `http://127.0.0.1:${port}`

    if (!(await serverResponds(baseUrl))) {
      return baseUrl
    }
  }

  throw new Error('Could not find an unused local port for the Ollama integration test')
}

async function serverResponds(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/version`)
    return response.ok
  } catch {
    return false
  }
}
