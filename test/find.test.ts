import { describe, expect, test } from 'vitest'

import { DEFAULT_FIND_SETTINGS } from '../src/config.js'
import {
  type DecisionRequest,
  type DecisionResult,
  type FindDependencies,
  type FindHit,
  findEvidence,
  fuseSessions,
  mapConcurrent,
} from '../src/find.js'
import { digestSession, excerpt, type SessionPart, selectPassages } from '../src/passages.js'

const hit = (sid: string, partId: string, sourceId = 'v2'): FindHit => ({
  sid,
  sourceId,
  partId,
  directory: '/projects/recall',
  title: `title ${sid}`,
  time: '2026-11-01T10:00:00.000Z',
})

const part = (partId: string, role: string, text: string, minute: number): SessionPart => ({
  partId,
  messageId: `msg_${partId}`,
  role,
  timeCreated: Date.parse('2026-11-01T10:00:00.000Z') + minute * 60_000,
  text,
})

function stubbedDependencies(
  answers: (request: DecisionRequest) => Record<string, number>,
  overrides: Partial<FindDependencies> = {},
): FindDependencies & { readonly decisions: DecisionRequest[] } {
  const decisions: DecisionRequest[] = []
  return {
    decisions,
    model: { providerID: 'typesafe-ai', id: 'jev-latest' },
    settings: DEFAULT_FIND_SETTINGS,
    search: async () => ({
      lists: [
        [hit('ses_auto', 'prt_a1'), hit('ses_other', 'prt_o1')],
        [hit('ses_auto', 'prt_a2')],
      ],
    }),
    digest: async (targets, queries) =>
      targets.map((target) =>
        digestSession(
          target.cursor,
          'v2',
          [
            part('prt_a0', 'user', 'Please add prompt autocomplete to the recall plugin', 0),
            part('prt_a1', 'assistant', 'Implemented ghost text autocomplete with right arrow accept', 5),
            part('prt_a2', 'assistant', 'Unrelated build log chatter about biome', 9),
          ],
          { queries, hitPartIds: target.hitPartIds, limit: 8, chars: 600 },
        ),
      ),
    decide: async (request) => {
      decisions.push(request)
      const probabilities = answers(request)
      const result: DecisionResult = {
        answers: request.questions.map((question) => ({
          type: 'predicate',
          name: question.name,
          probability: probabilities[question.name] ?? 0,
        })),
        tokens: { input: 100 },
      }
      return result
    },
    ...overrides,
  }
}

describe('history_find pipeline', () => {
  test('fuses hits into sessions by reciprocal rank and keeps every hit part', () => {
    const sessions = fuseSessions([
      [hit('ses_a', 'prt_1'), hit('ses_b', 'prt_2'), hit('ses_a', 'prt_3')],
      [hit('ses_b', 'prt_4')],
    ])
    expect(sessions.map((session) => session.cursor)).toEqual(['v2::ses_b', 'v2::ses_a'])
    expect(sessions[1]?.hitPartIds).toEqual(['prt_1', 'prt_3'])
    expect(sessions[1]?.fusion).toBeCloseTo(1 / 60)
    expect(sessions[0]?.fusion).toBeCloseTo(1 / 61 + 1 / 60)
  })

  test('judges each session once with criterion and passage predicates and packs matching evidence', async () => {
    const deps = stubbedDependencies((request) =>
      request.input[0]?.text.includes('title ses_auto') ? { c1: 0.94, p2: 0.91 } : { c1: 0.1 },
    )
    const output = await findEvidence(
      { queries: ['prompt autocomplete', 'ghost text', ' '], criteria: ['changes recall autocomplete'] },
      deps,
    )

    expect(deps.decisions).toHaveLength(2)
    expect(deps.decisions[0]?.questions.map((question) => question.name)).toEqual(['c1', 'p1', 'p2', 'p3'])
    expect(output).toContain('history_find: 1 of 2 judged sessions match all criteria (p>=0.5); 2 queries.')
    expect(output).toContain('## v2::ses_auto match=0.94 (c1=0.94)')
    expect(output).toContain('  - 0.91 v2::msg_prt_a1 assistant 2026-11-01T10:05: Implemented ghost text')
    expect(output).not.toContain('Unrelated build log')
    expect(output).toContain('held back: 0 matching sessions')
    expect(output).toContain('1 sessions below threshold')
    expect(output.split('\n').at(-1)).toMatch(/^\[jev calls=2 input_tokens=200 ms=\d+\]$/)
  })

  test('lists the nearest sessions with per-criterion probabilities when nothing matches', async () => {
    const deps = stubbedDependencies(() => ({ c1: 0.9, c2: 0.2 }))
    const output = await findEvidence({ queries: ['autocomplete'], criteria: ['topic', 'evidence'] }, deps)

    expect(output).toContain('No session matched every criterion. Nearest sessions:')
    expect(output).toContain('match=0.20 (c1=0.90 c2=0.20)')
  })

  test('retries a failed judge call once and reports sessions that stay unjudged', async () => {
    const deps = stubbedDependencies(() => ({ c1: 0.8 }))
    const attempts = new Map<string, number>()
    const flaky = stubbedDependencies(() => ({ c1: 0.8 }), {
      decide: async (request) => {
        const session = request.input[0]?.text.includes('title ses_auto') ? 'auto' : 'other'
        const attempt = (attempts.get(session) ?? 0) + 1
        attempts.set(session, attempt)
        if (session === 'other') throw new Error('429 rate limited')
        if (attempt === 1) throw new Error('transient')
        return deps.decide(request)
      },
    })
    const output = await findEvidence({ queries: ['autocomplete'], criteria: ['topic'] }, flaky)

    expect(output).toContain('history_find: 1 of 2 judged sessions match')
    expect(output).toContain('judge errors: 1 sessions unjudged (429 rate limited)')
    expect(output).toContain('[jev calls=1 input_tokens=100')
  })

  test('stops before judging when the search finds nothing', async () => {
    const deps = stubbedDependencies(() => ({}), {
      search: async () => ({ lists: [[]], notice: 'Semantic search unavailable.' }),
    })
    const output = await findEvidence({ queries: ['nothing'], criteria: ['topic'] }, deps)

    expect(deps.decisions).toHaveLength(0)
    expect(output).toContain('history_find: no hits for 1 queries.')
    expect(output).toContain('Semantic search unavailable.')
  })

  test('rejects calls without queries or criteria', async () => {
    const deps = stubbedDependencies(() => ({}))
    expect(await findEvidence({ queries: ['x'], criteria: [] }, deps)).toBe(
      'history_find needs at least one query and one criterion.',
    )
  })

  test('drops matching sessions that exceed the output budget and counts them', async () => {
    const deps = stubbedDependencies(() => ({ c1: 0.9, p1: 0.9, p2: 0.9, p3: 0.9 }), {
      settings: { ...DEFAULT_FIND_SETTINGS, outputChars: 900 },
    })
    const output = await findEvidence({ queries: ['autocomplete'], criteria: ['topic'] }, deps)

    expect(output).toContain('held back: 1 matching sessions (1 over the 900-char budget)')
  })

  test('runs at most the configured number of tasks at once', async () => {
    let active = 0
    let peak = 0
    const results = await mapConcurrent([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setImmediate(resolve))
      active -= 1
      return value * 2
    })
    expect(results).toEqual([2, 4, 6, 8, 10])
    expect(peak).toBe(2)
  })
})

describe('session passages', () => {
  test('prefers search hits and query term coverage and returns passages in time order', () => {
    const selected = selectPassages(
      [
        part('prt_1', 'user', 'unrelated greeting', 0),
        part('prt_2', 'assistant', 'the autocomplete ghost text works', 1),
        part('prt_3', 'assistant', 'autocomplete only', 2),
        part('prt_4', 'system', 'autocomplete ghost text system prompt', 3),
      ],
      { queries: ['autocomplete ghost text'], hitPartIds: ['prt_3'], limit: 2, chars: 200 },
    )
    expect(selected.map((item) => item.part.partId)).toEqual(['prt_2', 'prt_3'])
    expect(selected.map((item) => item.hit)).toEqual([false, true])
  })

  test('cuts long text around the densest term window', () => {
    const text = `${'filler '.repeat(200)}the decisive autocomplete fix landed here ${'tail '.repeat(200)}`
    const cut = excerpt(text, ['autocomplete', 'decisive'], 120)
    expect(cut.startsWith('…')).toBe(true)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).toContain('decisive autocomplete fix')
  })

  test('digests a session with dates, message count, first prompt and qualified cursors', () => {
    const digest = digestSession(
      'v2::ses_auto',
      'v2',
      [part('prt_a', 'user', 'add autocomplete', 0), part('prt_b', 'assistant', 'autocomplete done', 4)],
      { queries: ['autocomplete'], hitPartIds: [], limit: 4, chars: 200 },
    )
    expect(digest).toMatchObject({
      cursor: 'v2::ses_auto',
      started: '2026-11-01T10:00:00.000Z',
      updated: '2026-11-01T10:04:00.000Z',
      messages: 2,
      firstPrompt: 'add autocomplete',
    })
    expect(digest.passages.map((passage) => passage.cursor)).toEqual(['v2::msg_prt_a', 'v2::msg_prt_b'])
  })
})
