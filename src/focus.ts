import type { FocusSettings, JudgeConfig } from './config.js'
import { clipText, type FocusMessage, type FocusTranscript } from './focus-transcript.js'
import { CHARS_PER_JEV_TOKEN, type Decide, Jev, mapConcurrent } from './jev.js'
import type { RecallRun, SegmentScore } from './recall-run.js'

export interface Segment {
  readonly id: number
  readonly startIndex: number
  readonly endIndex: number
  readonly startCursor: string
  readonly text: string
}

export interface ScoredSegment extends Segment, SegmentScore {}

export interface FocusResult {
  readonly transcript: FocusTranscript
  readonly segments: number
  readonly all: readonly Segment[]
  readonly scored: readonly ScoredSegment[]
}

export interface FocusedReadDependencies {
  readonly judge: JudgeConfig
  readonly run: RecallRun
  readonly decide: Decide
  readonly transcripts: (cursors: readonly string[]) => Promise<readonly FocusTranscript[]>
  readonly read: (cursor: string) => Promise<string>
  readonly onJudgeDown: () => void
  readonly now?: () => number
}

export async function focusedRead(
  cursor: string,
  criteria: readonly string[],
  limit: number,
  deps: FocusedReadDependencies,
): Promise<string> {
  const jev = new Jev(
    deps.judge.model,
    deps.decide,
    deps.run.budget,
    deps.now ?? Date.now,
    deps.judge.timeoutMs,
  )
  const transcripts = await deps.transcripts([cursor])
  const results = await focusTranscripts(
    transcripts,
    criteria,
    deps.judge.focus,
    jev,
    deps.run,
    deps.judge.find.concurrency,
    deps.judge.focus.readScanTokens,
  )
  if (
    results.length > 0 &&
    (jev.failures > 0 || jev.budgetSpent) &&
    results.every((result) => result.scored.length === 0)
  ) {
    const fallback = `showing a plain window around ${cursor} instead of judged segments.`
    if (jev.failures > 0) deps.onJudgeDown()
    return [
      jev.footer(),
      jev.failures > 0 ? jev.unavailableNotice(fallback) : jev.budgetNotice(fallback),
      await deps.read(cursor),
    ].join('\n')
  }
  const problems = jev.problems()
  return [
    jev.footer(),
    ...results.map((result) =>
      renderFocusedRead(result, deps.judge.focus, limit, deps.judge.find.outputChars),
    ),
    ...(results.length === 0 ? [`No transcript found for ${cursor}.`] : []),
    ...(problems === undefined ? [] : [problems]),
  ].join('\n')
}

export async function focusTranscripts(
  transcripts: readonly FocusTranscript[],
  criteria: readonly string[],
  settings: FocusSettings,
  jev: Jev,
  run: RecallRun,
  concurrency: number,
  scanTokens: number = settings.maxScanTokens,
): Promise<FocusResult[]> {
  return Promise.all(
    transcripts.map(async (transcript) => {
      const segments = segmentTranscript(
        transcript.messages,
        settings.segmentTokens * CHARS_PER_JEV_TOKEN,
      )
      const scanned = selectScanned(
        segments,
        transcript.anchorIndex,
        scanTokens * CHARS_PER_JEV_TOKEN,
      )
      const key = JSON.stringify([transcript.sid, criteria, scanned.map((segment) => segment.id)])
      const cached = run.segmentScores.get(key)
      const pending = cached ?? scoreSegments(scanned, criteria, settings, jev, concurrency)
      if (cached === undefined) run.segmentScores.set(key, pending)
      const scores = await pending
      if (scores.size === 0) run.segmentScores.delete(key)
      return {
        transcript,
        segments: segments.length,
        all: segments,
        scored: scanned.flatMap((segment) => {
          const score = scores.get(segment.id)
          return score === undefined ? [] : [{ ...segment, ...score }]
        }),
      }
    }),
  )
}

export function segmentTranscript(
  messages: readonly FocusMessage[],
  limitChars: number,
): Segment[] {
  const limit = Math.max(1, Math.floor(limitChars))
  const segments: Segment[] = []
  let pending: { start: FocusMessage; end: FocusMessage; text: string } | undefined
  const flush = () => {
    if (pending === undefined) return
    segments.push({
      id: segments.length,
      startIndex: pending.start.index,
      endIndex: pending.end.index,
      startCursor: pending.start.cursor,
      text: pending.text,
    })
    pending = undefined
  }
  for (const message of messages) {
    for (const piece of splitText(message.text, limit)) {
      if (pending !== undefined && pending.text.length + piece.length + 1 > limit) flush()
      pending =
        pending === undefined
          ? { start: message, end: message, text: piece }
          : { ...pending, end: message, text: `${pending.text}\n${piece}` }
    }
  }
  flush()
  return segments
}

export function selectScanned(
  segments: readonly Segment[],
  anchorIndex: number | undefined,
  budgetChars: number,
): Segment[] {
  const kept = new Set<Segment>()
  let used = 0
  for (const segment of scanPriority(segments, anchorIndex)) {
    if (used + segment.text.length > budgetChars && used > 0) break
    used += segment.text.length
    kept.add(segment)
  }
  return segments.filter((segment) => kept.has(segment))
}

export function bestSegments(result: FocusResult, settings: FocusSettings): ScoredSegment[] {
  return [...result.scored]
    .filter((segment) => segment.evidence >= settings.minScore)
    .sort((left, right) => rank(right) - rank(left) || left.id - right.id)
    .slice(0, settings.segmentsPerSession)
    .sort((left, right) => left.id - right.id)
}

export function expandSegments(
  result: FocusResult,
  best: readonly ScoredSegment[],
  neighbours: number,
): ScoredSegment[] {
  const ranges = best
    .map((segment) => ({
      first: Math.max(0, segment.id - neighbours),
      last: Math.min(result.all.length - 1, segment.id + neighbours),
      evidence: segment.evidence,
      final: segment.final,
    }))
    .sort((left, right) => left.first - right.first)
  const merged: (typeof ranges)[number][] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous !== undefined && range.first <= previous.last + 1) {
      merged[merged.length - 1] = {
        first: previous.first,
        last: Math.max(previous.last, range.last),
        evidence: Math.max(previous.evidence, range.evidence),
        final: Math.max(previous.final, range.final),
      }
      continue
    }
    merged.push(range)
  }
  return merged.flatMap((range) => {
    const covered = result.all.slice(range.first, range.last + 1)
    const [start] = covered
    const end = covered.at(-1)
    if (start === undefined || end === undefined) return []
    return [
      {
        id: start.id,
        startIndex: start.startIndex,
        endIndex: end.endIndex,
        startCursor: start.startCursor,
        text: covered.map((segment) => segment.text).join('\n'),
        evidence: range.evidence,
        final: range.final,
      },
    ]
  })
}

export function renderSegment(segment: ScoredSegment, chars: number): string {
  return [
    `  ▸ #${segment.startIndex}-#${segment.endIndex} p=${segment.evidence.toFixed(2)} final=${segment.final.toFixed(2)} ${segment.startCursor}`,
    clipText(segment.text, chars),
  ].join('\n')
}

export function renderFocusedRead(
  result: FocusResult,
  settings: FocusSettings,
  limit: number,
  outputChars: number,
): string {
  const { transcript } = result
  const ranked = [...result.scored]
    .filter((segment) => segment.evidence >= settings.minScore)
    .sort((left, right) => rank(right) - rank(left))
  const lines = [
    `## ${transcript.sid} · "${transcript.title ?? ''}" · ${transcript.directory} · ${transcript.totalMessages} msgs · scanned ${result.scored.length} of ${result.segments} segments, ${ranked.length} at p>=${settings.minScore}`,
  ]
  let budget = outputChars - (lines[0]?.length ?? 0)
  const shown = ranked
    .slice(0, limit)
    .filter((segment) => {
      const size = Math.min(segment.text.length, settings.segmentChars) + 80
      if (size > budget) return false
      budget -= size
      return true
    })
    .sort((left, right) => left.id - right.id)
  if (shown.length === 0) {
    lines.push('No segment matched. Nearest:')
    for (const segment of [...result.scored]
      .sort((left, right) => rank(right) - rank(left))
      .slice(0, 3))
      lines.push(
        `  #${segment.startIndex}-#${segment.endIndex} p=${segment.evidence.toFixed(2)} ${segment.startCursor}`,
      )
  }
  lines.push(...shown.map((segment) => renderSegment(segment, settings.segmentChars)))
  if (result.scored.length < result.segments) {
    lines.push(
      `unscanned: ${result.segments - result.scored.length} segments beyond the ${settings.maxScanTokens}-token scan budget; pass a message cursor near the topic to scan around it.`,
    )
  }
  return lines.join('\n')
}

async function scoreSegments(
  segments: readonly Segment[],
  criteria: readonly string[],
  settings: FocusSettings,
  jev: Jev,
  concurrency: number,
): Promise<ReadonlyMap<number, SegmentScore>> {
  const topic = criteria.join('; ')
  const windows = buildWindows(segments, settings.windowTokens * CHARS_PER_JEV_TOKEN)
  const results = await mapConcurrent(windows, concurrency, async (window) => {
    const labels = window.map((_, position) => `S${position + 1}`)
    const answers = await jev.ask(
      window.map(
        (segment, position) =>
          `<segment id="${labels[position]}" messages="${segment.startIndex}-${segment.endIndex}">\n${segment.text}\n</segment>`,
      ),
      labels.flatMap((label) => [
        {
          type: 'predicate' as const,
          name: label,
          instructions: `Segment ${label} itself contains information that directly answers or supports at least one of: ${topic}`,
        },
        {
          type: 'predicate' as const,
          name: `${label}_final`,
          instructions: `Segment ${label} states a final decision, conclusion, or result about: ${topic}`,
        },
      ]),
    )
    if (answers === undefined) return []
    return window.map(
      (segment, position) =>
        [
          segment.id,
          {
            evidence: answers.get(labels[position] ?? '') ?? 0,
            final: answers.get(`${labels[position]}_final`) ?? 0,
          },
        ] as const,
    )
  })
  return new Map(results.flat())
}

function buildWindows(segments: readonly Segment[], limitChars: number): Segment[][] {
  const windows: Segment[][] = []
  let current: Segment[] = []
  let size = 0
  for (const segment of segments) {
    if (current.length > 0 && size + segment.text.length > limitChars) {
      windows.push(current)
      current = []
      size = 0
    }
    current.push(segment)
    size += segment.text.length
  }
  if (current.length > 0) windows.push(current)
  return windows
}

function scanPriority(segments: readonly Segment[], anchorIndex: number | undefined): Segment[] {
  if (anchorIndex !== undefined) {
    const distance = (segment: Segment) =>
      Math.max(0, segment.startIndex - anchorIndex, anchorIndex - segment.endIndex)
    return [...segments].sort(
      (left, right) => distance(left) - distance(right) || right.id - left.id,
    )
  }
  const [first, ...rest] = segments
  return first === undefined ? [] : [first, ...rest.reverse()]
}

function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  return Array.from({ length: Math.ceil(text.length / limit) }, (_, piece) =>
    text.slice(piece * limit, (piece + 1) * limit),
  )
}

function rank(segment: SegmentScore): number {
  return segment.evidence * (0.8 + 0.2 * segment.final)
}
