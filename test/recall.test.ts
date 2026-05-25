import { describe, expect, test } from 'bun:test'

import { decodeCursor } from '../src/cursor'
import type { SearchRow } from '../src/db'
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
