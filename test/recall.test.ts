import { describe, expect, test } from 'bun:test'

import { decodeCursor } from '../src/cursor'
import type { SearchRow } from '../src/db'
import { OllamaEmbeddingProvider } from '../src/embedding'
import { rankSearchRows } from '../src/search'

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
