import { describe, expect, test } from 'vitest'

import { DEFAULT_FIND_SETTINGS, type JudgeConfig, judgeConfig } from '../src/config.js'
import {
  type FindDependencies,
  type FindHit,
  type FindRequest,
  findEvidence,
  fuseSessions,
  wantsBreadth,
} from '../src/find.js'
import {
  expandSegments,
  type FocusResult,
  focusedRead,
  segmentTranscript,
  selectScanned,
} from '../src/focus.js'
import type { FocusTranscript } from '../src/focus-transcript.js'
import { type DecisionRequest, type DecisionResult, mapConcurrent } from '../src/jev.js'
import { digestSession, excerpt, type SessionPart, selectPassages } from '../src/passages.js'
import { RecallRun, RecallRuns } from '../src/recall-run.js'
import { type ScannedSession, sessionDigestText } from '../src/scan.js'

const JUDGE = judgeConfig({ model: 'typesafe-ai/jev-latest' }).judge as JudgeConfig

const hit = (sid: string, partId: string, sourceId = 'v2'): FindHit => ({
  sid,
  sourceId,
  partId,
  directory: '/projects/recall',
  title: `title ${sid}`,
})

const part = (partId: string, role: string, text: string, minute: number): SessionPart => ({
  partId,
  messageId: `msg_${partId}`,
  role,
  timeCreated: Date.parse('2026-11-01T10:00:00.000Z') + minute * 60_000,
  text,
})

const scanned = (sid: string, text: string): ScannedSession => ({
  cursor: `v2::${sid}`,
  title: `title ${sid}`,
  directory: '/projects/recall',
  updatedAt: Date.parse('2026-11-10T10:00:00.000Z'),
  text,
})

const request = (overrides: Partial<FindRequest> = {}): FindRequest => ({
  queries: ['autocomplete'],
  criteria: ['topic'],
  window: {},
  ...overrides,
})

const answerAll =
  (answers: (request: DecisionRequest) => Record<string, number>) =>
  async (decision: DecisionRequest): Promise<DecisionResult> => {
    const probabilities = answers(decision)
    return {
      answers: decision.questions.map((question) => ({
        type: 'predicate',
        name: question.name,
        probability: probabilities[question.name] ?? 0,
      })),
      tokens: { input: 100 },
    }
  }

function stubbedDependencies(
  answers: (request: DecisionRequest) => Record<string, number>,
  overrides: Partial<FindDependencies> = {},
): FindDependencies & { readonly decisions: DecisionRequest[]; readonly scans: unknown[] } {
  const decisions: DecisionRequest[] = []
  const scans: unknown[] = []
  const decide = answerAll(answers)
  return {
    decisions,
    scans,
    judge: { ...JUDGE, focus: { ...JUDGE.focus, sessions: 0 } },
    run: new RecallRun(1_000_000),
    search: async () => ({
      lists: [
        [hit('ses_auto', 'prt_a1'), hit('ses_other', 'prt_o1')],
        [hit('ses_auto', 'prt_a2')],
      ],
    }),
    scan: async (window) => {
      scans.push(window)
      return { sessions: [], total: 0 }
    },
    digest: async (targets, terms) =>
      targets.map((target) =>
        digestSession(
          target.cursor,
          'v2',
          [
            part('prt_a0', 'user', 'Please add prompt autocomplete to the recall plugin', 0),
            part('prt_a1', 'assistant', 'Implemented ghost text autocomplete with right arrow accept', 5),
            part('prt_a2', 'assistant', 'Unrelated build log chatter about biome', 9),
          ],
          { queries: terms, hitPartIds: target.hitPartIds, limit: 8, chars: 600 },
        ),
      ),
    transcripts: async () => [],
    decide: async (decision) => {
      decisions.push(decision)
      return decide(decision)
    },
    ...overrides,
  }
}

const isAuto = (decision: DecisionRequest) =>
  decision.input[0]?.text.includes('title ses_auto') === true

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

  test('puts the judge footer first and packs the matching evidence', async () => {
    const deps = stubbedDependencies((decision) =>
      isAuto(decision) ? { c1: 0.94, p2: 0.91 } : { c1: 0.1 },
    )
    const output = await findEvidence(
      request({
        queries: ['prompt autocomplete', 'ghost text', ' '],
        criteria: ['changes recall autocomplete'],
      }),
      deps,
    )
    const lines = output.split('\n')

    expect(lines[0]).toMatch(/^\[jev calls=2 input_tokens=200 ms=\d+\]$/)
    expect(deps.decisions).toHaveLength(2)
    expect(deps.decisions[0]?.questions.map((question) => question.name)).toEqual([
      'c1',
      'p1',
      'p2',
      'p3',
    ])
    expect(lines[1]).toBe(
      'history_find: 1 of 2 judged sessions match all criteria (p>=0.5); 2 queries.',
    )
    expect(output).toContain('## v2::ses_auto match=0.94 (c1=0.94)')
    expect(output).toContain(
      '  - 0.91 v2::msg_prt_a1 assistant 2026-11-01T10:05: Implemented ghost text',
    )
    expect(output).not.toContain('Unrelated build log')
    expect(output).toContain('held back: 0 matching sessions')
    expect(output).toContain('1 sessions below threshold')
    expect(deps.scans).toHaveLength(0)
  })

  test('lists the nearest sessions with per-criterion probabilities when nothing matches', async () => {
    const deps = stubbedDependencies(() => ({ c1: 0.6, c2: 0.2 }))
    const output = await findEvidence(request({ criteria: ['topic', 'evidence'] }), deps)

    expect(output).toContain('No session matched every criterion. Nearest sessions:')
    expect(output).toContain('match=0.20 (c1=0.60 c2=0.20) partial 1/2')
  })

  test('packs sessions that clearly meet some criteria when each covers part of the request', async () => {
    const deps = stubbedDependencies((decision) =>
      isAuto(decision) ? { c1: 0.92, c2: 0.1, p2: 0.9 } : { c1: 0.1, c2: 0.95 },
    )
    const output = await findEvidence(
      request({ queries: ['autocomplete'], criteria: ['adds autocomplete', 'documents it'] }),
      deps,
    )

    expect(output).toContain(
      'history_find: 0 of 2 judged sessions match all criteria (p>=0.5), 2 more match some; 1 queries.',
    )
    expect(output).toContain('## v2::ses_other match=0.10 (c1=0.10 c2=0.95) partial 1/2')
    expect(output).toContain('## v2::ses_auto match=0.10 (c1=0.92 c2=0.10) partial 1/2')
    expect(output).toContain('  - 0.90 v2::msg_prt_a1')
    expect(output).not.toContain('Nearest sessions')
  })

  test('retries a failed judge call once and reports sessions that stay unjudged', async () => {
    const attempts = new Map<string, number>()
    const decide = answerAll(() => ({ c1: 0.8 }))
    const deps = stubbedDependencies(() => ({}), {
      decide: async (decision) => {
        const session = isAuto(decision) ? 'auto' : 'other'
        const attempt = (attempts.get(session) ?? 0) + 1
        attempts.set(session, attempt)
        if (session === 'other') throw new Error('429 rate limited')
        if (attempt === 1) throw new Error('transient')
        return decide(decision)
      },
    })
    const output = await findEvidence(request(), deps)

    expect(output).toContain('history_find: 1 of 2 judged sessions match')
    expect(output).toContain('unjudged: 1 sessions')
    expect(output).toContain('judge problems: 1 judge calls failed (429 rate limited)')
    expect(output.split('\n')[0]).toMatch(/^\[jev calls=1 input_tokens=100 /)
  })

  test('falls back to a recent-window scan when the search finds no matching session', async () => {
    const deps = stubbedDependencies(
      (decision) =>
        decision.questions.some((question) => question.name === 'S1')
          ? { S1: 0.9, S2: 0.05 }
          : { c1: 0.85 },
      {
        search: async () => ({ lists: [[]], notice: 'Semantic search unavailable.' }),
        scan: async () => ({
          sessions: [
            scanned('ses_scan', 'screenshot of the broken tmux status bar'),
            scanned('ses_noise', 'unrelated'),
          ],
          total: 2,
          after: Date.parse('2026-09-15T00:00:00.000Z'),
          before: Date.parse('2026-11-14T00:00:00.000Z'),
        }),
      },
    )
    const output = await findEvidence(request(), deps)

    expect(output).toContain('## v2::ses_scan match=0.85 (c1=0.85)')
    expect(output).toContain('via scan')
    expect(output).toContain(
      'scan: judged 2 of 2 sessions active 2026-09-15T00:00..2026-11-14T00:00, 1 candidates',
    )
    expect(output).toContain('Semantic search unavailable.')
  })

  test('scans the window without queries and asks for the relative window', async () => {
    const scans: unknown[] = []
    const deps = stubbedDependencies(
      (decision) =>
        decision.questions.some((question) => question.name === 'S1') ? { S1: 0.7 } : { c1: 0.7 },
      {
        search: async () => {
          throw new Error('search must not run without queries')
        },
        scan: async (window) => {
          scans.push(window)
          return { sessions: [scanned('ses_scan', 'yesterday work')], total: 1 }
        },
      },
    )
    const output = await findEvidence(request({ queries: [], window: { withinDays: 2 } }), deps)

    expect(scans).toEqual([{ withinDays: 2 }])
    expect(output).toContain('## v2::ses_scan match=0.70')
  })

  test('bounds only the scan by a relative window so slightly older search hits still compete', async () => {
    const searches: unknown[] = []
    const scans: unknown[] = []
    const deps = stubbedDependencies(() => ({ c1: 0.9 }), {
      search: async (_queries, window) => {
        searches.push(window)
        return { lists: [[hit('ses_old', 'prt_o1')]] }
      },
      scan: async (window) => {
        scans.push(window)
        return { sessions: [], total: 0 }
      },
    })
    await findEvidence(
      request({ window: { withinDays: 7, before: '2026-11-14T00:00:00Z' } }),
      deps,
    )

    expect(searches).toEqual([{ after: undefined, before: '2026-11-14T00:00:00Z' }])
    expect(scans).toEqual([{ withinDays: 7, before: '2026-11-14T00:00:00Z' }])
  })

  test('requires at least one criterion', async () => {
    const deps = stubbedDependencies(() => ({}))
    expect(await findEvidence(request({ criteria: [] }), deps)).toBe(
      'history_find needs at least one criterion.',
    )
  })

  test('drops matching sessions that exceed the output budget and counts them', async () => {
    const deps = stubbedDependencies(() => ({ c1: 0.9, p1: 0.9, p2: 0.9, p3: 0.9 }))
    const output = await findEvidence(request(), {
      ...deps,
      judge: { ...deps.judge, find: { ...DEFAULT_FIND_SETTINGS, outputChars: 900 } },
    })

    expect(output).toContain('held back: 1 matching sessions (1 over the 900-char budget)')
  })

  test('reuses cached verdicts and carries matches into the next call of the same run', async () => {
    const deps = stubbedDependencies((decision) => (isAuto(decision) ? { c1: 0.9 } : { c1: 0.1 }))
    await findEvidence(request(), deps)
    expect(deps.decisions).toHaveLength(2)

    const again = await findEvidence(request(), deps)
    expect(deps.decisions).toHaveLength(2)
    expect(again.split('\n')[0]).toMatch(/^\[jev calls=0 input_tokens=0 /)

    const carried = await findEvidence(request({ queries: ['different words'] }), {
      ...deps,
      search: async () => ({ lists: [[hit('ses_new', 'prt_n1')]] }),
    })
    expect(carried).toContain('## v2::ses_auto match=0.90 (c1=0.90)')
    expect(carried).toContain('via carried')
  })

  test('skips judge calls beyond the run token budget and says so', async () => {
    const deps = stubbedDependencies(() => ({ c1: 0.9 }), { run: new RecallRun(10) })
    const output = await findEvidence(request(), deps)

    expect(deps.decisions).toHaveLength(0)
    expect(output).toContain('judge calls skipped: the run reached its 10-token judge budget')
  })

  test('adds focused transcript segments above the judged passages of top matches', async () => {
    const transcript: FocusTranscript = {
      sid: 'v2::ses_auto',
      title: 'title ses_auto',
      directory: '/projects/recall',
      totalMessages: 2,
      messages: [
        { index: 0, cursor: 'v2::msg_1', text: '[#0 user v2::msg_1] why does tab not accept?' },
        {
          index: 1,
          cursor: 'v2::msg_2',
          text: '[#1 assistant v2::msg_2] Tab is reserved for agent switching, so Right accepts.',
        },
      ],
    }
    const requested: string[][] = []
    const deps = stubbedDependencies(
      (decision) => {
        if (decision.questions.some((question) => question.name === 'S1'))
          return { S1: 0.95, S1_final: 0.9 }
        return isAuto(decision) ? { c1: 0.9, p2: 0.8 } : { c1: 0.1 }
      },
      {
        transcripts: async (cursors) => {
          requested.push([...cursors])
          return [transcript]
        },
      },
    )
    const output = await findEvidence(request(), {
      ...deps,
      judge: { ...deps.judge, focus: JUDGE.focus },
    })

    expect(requested).toEqual([['v2::msg_prt_a1']])
    expect(output).toContain('  ▸ #0-#1 p=0.95 final=0.90 v2::msg_1')
    expect(output).toContain('Tab is reserved for agent switching')
    expect(output).toContain('  - 0.80 v2::msg_prt_a1')
  })

  test('focuses the nearest sessions when none matches so buried evidence still surfaces', async () => {
    const requested: string[][] = []
    const deps = stubbedDependencies(
      (decision) => {
        if (decision.questions.some((question) => question.name === 'S1'))
          return { S1: 0.92, S1_final: 0.5 }
        return isAuto(decision) ? { c1: 0.3 } : { c1: 0.05 }
      },
      {
        transcripts: async (cursors) => {
          requested.push([...cursors])
          return [
            {
              sid: 'v2::ses_auto',
              directory: '/projects/recall',
              totalMessages: 1,
              messages: [
                {
                  index: 0,
                  cursor: 'v2::msg_9',
                  text: '[#0 assistant v2::msg_9] Cleanup ages busy panes to idle after 10 minutes.',
                },
              ],
            },
          ]
        },
      },
    )
    const output = await findEvidence(request(), {
      ...deps,
      judge: { ...deps.judge, focus: JUDGE.focus },
    })

    expect(requested).toEqual([['v2::ses_auto']])
    expect(output).toContain('No session matched every criterion. Nearest sessions:')
    expect(output).toContain('  ▸ #0-#0 p=0.92 final=0.50 v2::msg_9')
  })

  test('scans the fallback window when the best search match is weak', async () => {
    const deps = stubbedDependencies((decision) => (isAuto(decision) ? { c1: 0.6 } : { c1: 0.1 }))
    const output = await findEvidence(request(), deps)

    expect(output).toContain('history_find: 1 of 2 judged sessions match')
    expect(deps.scans).toEqual([{ withinDays: JUDGE.scan.fallbackDays }])
  })

  test('orders close top matches by one pairwise decision and shows its probability', async () => {
    const isPick = (decision: DecisionRequest) =>
      decision.questions.some((question) => question.instructions.startsWith('Of the 2 sessions'))
    const deps = stubbedDependencies((decision) => {
      if (isPick(decision)) return { S1: 0.2, S2: 0.85 }
      return isAuto(decision) ? { c1: 0.92 } : { c1: 0.88 }
    })
    const output = await findEvidence(request(), deps)

    expect(deps.decisions.filter(isPick)).toHaveLength(1)
    expect(output.indexOf('## v2::ses_other')).toBeLessThan(output.indexOf('## v2::ses_auto'))
    expect(output).toContain('## v2::ses_other match=0.88 (c1=0.88) best=0.85')
    expect(output).toContain('## v2::ses_auto match=0.92 (c1=0.92) best=0.20')
  })

  test('skips the pairwise pick when the best match leads clearly', async () => {
    const deps = stubbedDependencies((decision) => (isAuto(decision) ? { c1: 0.95 } : { c1: 0.7 }))
    const output = await findEvidence(request(), deps)

    expect(deps.decisions).toHaveLength(2)
    expect(output).not.toContain('best=')
  })

  test('detects requests that span many sessions', () => {
    expect(wantsBreadth(['The session is one step in the timeline of the tmux setup'])).toBe(true)
    expect(wantsBreadth(['Liste aller Änderungen'])).toBe(true)
    expect(wantsBreadth(['The session fixes the right arrow accept'])).toBe(false)
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

  test('forgets a recall run when its session ends', () => {
    const runs = new RecallRuns(100)
    const run = runs.get('ses_recall')
    run.verdicts.set('key', 1)
    expect(runs.get('ses_recall')).toBe(run)
    runs.end('ses_recall')
    expect(runs.get('ses_recall').verdicts.size).toBe(0)
  })

  test('prepares a recall run once and survives a failed index sync', async () => {
    const run = new RecallRun(100)
    let syncs = 0
    const failingSync = async () => {
      syncs += 1
      throw new Error('index locked')
    }
    await run.prepare(failingSync)
    await run.prepare(failingSync)
    await expect(run.ready).resolves.toBeUndefined()
    expect(syncs).toBe(1)
  })
})

describe('focused reads', () => {
  test('expands the best segments with their neighbours and merges overlapping ranges', () => {
    const all = Array.from({ length: 6 }, (_, id) => ({
      id,
      startIndex: id * 2,
      endIndex: id * 2 + 1,
      startCursor: `v2::msg_${id}`,
      text: `segment ${id}`,
    }))
    const result: FocusResult = {
      transcript: { sid: 'v2::ses_x', directory: '/', totalMessages: 12, messages: [] },
      segments: all.length,
      all,
      scored: [],
    }
    const expanded = expandSegments(
      result,
      [
        { ...all[2]!, evidence: 0.9, final: 0.2 },
        { ...all[3]!, evidence: 0.7, final: 0.8 },
      ],
      1,
    )

    expect(expanded).toEqual([
      {
        id: 1,
        startIndex: 2,
        endIndex: 9,
        startCursor: 'v2::msg_1',
        text: 'segment 1\nsegment 2\nsegment 3\nsegment 4',
        evidence: 0.9,
        final: 0.8,
      },
    ])
  })

  test('segments transcripts and scans the segments nearest the anchor first', () => {
    const messages = Array.from({ length: 6 }, (_, index) => ({
      index,
      cursor: `msg_${index}`,
      text: `message ${index} ${'x'.repeat(80)}`,
    }))
    const segments = segmentTranscript(messages, 200)
    expect(segments.map((segment) => [segment.startIndex, segment.endIndex])).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ])
    expect(selectScanned(segments, 4, 200).map((segment) => segment.id)).toEqual([2])
    expect(selectScanned(segments, undefined, 400).map((segment) => segment.id)).toEqual([0, 2])
  })

  test('history_read with criteria returns matching segments after the judge footer', async () => {
    const output = await focusedRead('v2::ses_auto', ['why Tab was not used'], 5, {
      judge: JUDGE,
      run: new RecallRun(1_000_000),
      decide: answerAll(() => ({ S1: 0.9, S1_final: 0.2 })),
      transcripts: async () => [
        {
          sid: 'v2::ses_auto',
          title: 'Autocomplete',
          directory: '/projects/recall',
          totalMessages: 1,
          messages: [{ index: 0, cursor: 'v2::msg_1', text: 'Tab is reserved for agents.' }],
        },
      ],
    })
    const lines = output.split('\n')

    expect(lines[0]).toMatch(/^\[jev calls=1 input_tokens=100 /)
    expect(lines[1]).toBe(
      '## v2::ses_auto · "Autocomplete" · /projects/recall · 1 msgs · scanned 1 of 1 segments, 1 at p>=0.5',
    )
    expect(output).toContain('Tab is reserved for agents.')
  })
})

describe('session scan digests', () => {
  test('renders the date, directory, title, sampled prompts and last answer', () => {
    const text = sessionDigestText(
      {
        sessionId: 'ses_a',
        title: 'Fix tmux',
        directory: '/projects/dots',
        updatedAt: Date.parse('2026-11-12T08:00:00.000Z'),
      },
      { promptCount: 3, prompts: ['first  prompt', 'later prompt'], answer: 'done' },
      900,
    )
    expect(text).toBe(
      '2026-11-12 · /projects/dots · "Fix tmux" · 3 prompts\nUser: first prompt\nUser: later prompt\nLast answer: done',
    )
    expect(
      sessionDigestText(
        { sessionId: 'ses_b', title: '', directory: '/', updatedAt: 0 },
        { promptCount: 0, prompts: [] },
        900,
      ),
    ).toBeUndefined()
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
      [
        part('prt_a', 'user', 'add autocomplete', 0),
        part('prt_b', 'assistant', 'autocomplete done', 4),
      ],
      { queries: ['autocomplete'], hitPartIds: [], limit: 4, chars: 200 },
    )
    expect(digest).toMatchObject({
      cursor: 'v2::ses_auto',
      started: '2026-11-01T10:00:00.000Z',
      updated: '2026-11-01T10:04:00.000Z',
      messages: 2,
      firstPrompt: 'add autocomplete',
    })
    expect(digest.passages.map((passage) => passage.cursor)).toEqual([
      'v2::msg_prt_a',
      'v2::msg_prt_b',
    ])
  })
})
