import { createHash } from 'node:crypto'
import { Database } from '../src/sqlite.js'
import { isHumanPrompt, submittedPrompt } from '../src/prompt-example.js'

export { isHumanPrompt } from '../src/prompt-example.js'

export interface PromptPair {
  readonly id: string
  readonly source: string
  readonly session: string
  readonly directory: string
  readonly time: number
  readonly situation: string
  readonly prompt: string
}

const whitespace = /\s+/gu

export function compact(text: string): string {
  return text.replace(whitespace, ' ').trim()
}

export function originalPrompt(data: string): string {
  const parsed = JSON.parse(data) as { text?: string }
  return submittedPrompt(data, parsed.text ?? '')
}

export function assistantText(data: string): string {
  const parsed = JSON.parse(data) as { text?: string; content?: { type?: string; text?: string }[] }
  return typeof parsed.text === 'string' ? parsed.text : (parsed.content ?? [])
    .filter((part: { type?: string; text?: string }) => part.type === 'text')
    .map((part: { text?: string }) => part.text ?? '').join('\n')
}

// Forked sessions and migrations can repeat identical turns. Keep the earliest
// copy so evaluation never retrieves a future copy of its own held-out answer.
export function deduplicate(pairs: readonly PromptPair[]): PromptPair[] {
  const unique = new Map<string, PromptPair>()
  for (const pair of [...pairs].sort((a, b) => a.time - b.time)) {
    const key = createHash('sha256').update(`${compact(pair.situation)}\0${compact(pair.prompt)}`).digest('hex')
    if (!unique.has(key)) unique.set(key, pair)
  }
  return [...unique.values()]
}

interface SessionRow { id: string; directory: string }
interface MessageRow { id: string; time: number; data: string; type: string }
interface PartRow { message: string; data: string }

export function readPairs(path: string, source: string, native: boolean, limit = 500): PromptPair[] {
  const db = new Database(path, { readonly: true })
  try {
    const sessions = db.query<SessionRow, [number]>(`
      select id, directory from ${native ? 'session_v2' : 'session'}
      where parent_id is null
        and directory not like '%/shepherd/topic-agent%'
        and directory not like '%/oca/jobs/%'
      order by time_updated desc limit ?
    `).all(limit)
    return sessions.flatMap((session) => {
      const messages = db.query<MessageRow, [string]>(native ? `
        select id, time_created as time, data, type from session_message
        where session_id = ? and type in ('user', 'assistant') order by seq
      ` : `
        select id, time_created as time, data, json_extract(data, '$.role') as type
        from message where session_id = ? order by time_created, id
      `).all(session.id)
      const parts = native ? [] : db.query<PartRow, [string]>(`
        select message_id as message, data from part where session_id = ? order by id
      `).all(session.id)
      const texts = new Map<string, string[]>()
      for (const part of parts) {
        const parsed = JSON.parse(part.data) as { type?: string; text?: string; synthetic?: boolean; ignored?: boolean }
        if (parsed.type !== 'text' || parsed.synthetic || parsed.ignored) continue
        const list = texts.get(part.message) ?? []
        list.push(parsed.text ?? '')
        texts.set(part.message, list)
      }
      const state = { situation: '', pairs: [] as PromptPair[] }
      for (const message of messages) {
        if (message.type === 'assistant') {
          const text = native ? assistantText(message.data) : (texts.get(message.id) ?? []).join('\n')
          if (text.trim()) state.situation = compact(text).slice(-600)
          continue
        }
        if (message.type !== 'user' || !state.situation) continue
        const parsed = JSON.parse(message.data) as { agents?: unknown }
        // This is a proxy for TUI submission, not a host guarantee of authorship.
        if (native && !Array.isArray(parsed.agents)) continue
        const text = native ? originalPrompt(message.data) : (texts.get(message.id) ?? []).join('\n')
        if (!isHumanPrompt(text.trim())) continue
        state.pairs.push({ id: message.id, source, session: session.id, directory: session.directory,
          time: message.time, situation: state.situation, prompt: compact(text) })
      }
      return state.pairs
    })
  } finally {
    db.close()
  }
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  const sum = { dot: 0, aa: 0, bb: 0 }
  for (const [i, value] of a.entries()) {
    const other = b[i] ?? 0
    sum.dot += value * other
    sum.aa += value * value
    sum.bb += other * other
  }
  return sum.dot / (Math.sqrt(sum.aa * sum.bb) || 1)
}

export function rankPairs(pairs: readonly PromptPair[], vectors: readonly (readonly number[])[], target: PromptPair, typed: string, query: readonly number[]): PromptPair[] {
  return pairs.flatMap((pair, i) => {
    if (pair.time >= target.time || pair.session === target.session || pair.id === target.id) return []
    const prefix = typed.length > 0 && pair.prompt.toLowerCase().startsWith(typed.toLowerCase())
    return [{ pair, score: cosine(query, vectors[i] ?? []) + (prefix ? 0.25 : 0) + (pair.directory === target.directory ? 0.05 : 0) }]
  }).sort((a, b) => b.score - a.score || b.pair.time - a.pair.time).slice(0, 4).map(({ pair }) => pair)
}

export function scoreCompletion(typed: string, reference: string, output: string) {
  const valid = output.length > typed.length && output.startsWith(typed) && !output.includes('\n') && output.trim().split(/\s+/u).length <= (typed ? 12 : 8)
  const suffix = valid ? output.slice(typed.length) : ''
  const expected = reference.slice(typed.length)
  const overlap = [...suffix].findIndex((char, i) => char !== expected[i])
  const matching = overlap < 0 ? suffix.length : overlap
  const next = (text: string) => text.trimStart().split(/\s/u)[0]?.toLowerCase() ?? ''
  return { valid, exact: valid && output === reference, nextWord: valid && next(suffix) !== '' && next(suffix) === next(expected), matchingChars: matching }
}
