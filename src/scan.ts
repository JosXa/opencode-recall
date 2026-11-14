import { homedir } from 'node:os'
import { type Jev, mapConcurrent } from './jev.js'
import type { DigestParts, SessionHeader } from './lexical-index.js'

export interface ScannedSession {
  readonly cursor: string
  readonly title: string
  readonly directory: string
  readonly updatedAt: number
  readonly text: string
}

export interface RankedSession extends ScannedSession {
  readonly probability: number
}

export interface ScanRanking {
  readonly ranked: readonly RankedSession[]
  readonly judged: number
}

const PROMPT_CHARS = 300
const ANSWER_CHARS = 300
const DIGEST_TOKEN_OVERHEAD = 30

export function sessionDigestText(
  header: SessionHeader,
  parts: DigestParts,
  chars: number,
): string | undefined {
  if (parts.promptCount === 0) return undefined
  const text = [
    `${new Date(header.updatedAt).toISOString().slice(0, 10)} · ${homeRelative(header.directory)} · "${header.title}" · ${parts.promptCount} prompts`,
    ...parts.prompts.map((prompt) => `User: ${flatten(prompt, PROMPT_CHARS)}`),
    ...(parts.answer === undefined ? [] : [`Last answer: ${flatten(parts.answer, ANSWER_CHARS)}`]),
  ].join('\n')
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`
}

export function estimateDigestTokens(text: string): number {
  return Math.ceil(text.length / 3) + DIGEST_TOKEN_OVERHEAD
}

export async function rankSessions(
  sessions: readonly ScannedSession[],
  criteria: readonly string[],
  jev: Jev,
  options: { readonly pack: number; readonly concurrency: number },
): Promise<ScanRanking> {
  const packs = Array.from({ length: Math.ceil(sessions.length / options.pack) }, (_, index) =>
    sessions.slice(index * options.pack, (index + 1) * options.pack),
  )
  const condition = criteria.join('; ')
  const results = await mapConcurrent(packs, options.concurrency, async (pack) => {
    const labels = pack.map((_, index) => `S${index + 1}`)
    const answers = await jev.ask(
      pack.map((session, index) => `<session id="${labels[index]}">\n${session.text}\n</session>`),
      labels.map((label) => ({
        type: 'predicate' as const,
        name: label,
        instructions: `Session ${label} matches all of: ${condition}. Judge only session ${label}.`,
      })),
    )
    if (answers === undefined) return []
    return pack.flatMap((session, index) => {
      const probability = answers.get(labels[index] ?? '')
      return probability === undefined ? [] : [{ ...session, probability }]
    })
  })
  const ranked = results.flat()
  return {
    ranked: ranked.sort(
      (left, right) => right.probability - left.probability || right.updatedAt - left.updatedAt,
    ),
    judged: ranked.length,
  }
}

function flatten(text: string, chars: number): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim()
  return flat.length <= chars ? flat : `${flat.slice(0, chars - 1)}…`
}

function homeRelative(directory: string): string {
  const home = homedir()
  return home.length > 1 && directory.startsWith(home)
    ? `~${directory.slice(home.length)}`
    : directory
}
