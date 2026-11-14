import { decodeCursor, qualifyCursor } from './cursor.js'
import type { HistorySources } from './history-sources.js'
import type { TranscriptMessage, TranscriptPart } from './transcript.js'

export interface FocusCaps {
  readonly textChars: number
  readonly toolChars: number
}

export interface FocusMessage {
  readonly index: number
  readonly cursor: string
  readonly text: string
}

export interface FocusTranscript {
  readonly sid: string
  readonly title?: string | undefined
  readonly directory: string
  readonly totalMessages: number
  readonly anchorIndex?: number | undefined
  readonly messages: readonly FocusMessage[]
}

const TOOL_INPUT_SHARE = 3

export function readFocusTranscripts(
  sources: HistorySources,
  cursors: readonly string[],
  caps: FocusCaps,
): FocusTranscript[] {
  const seen = new Set<string>()
  return cursors.flatMap((cursor) => {
    const window = sources.readContainingSession(cursor)
    const sid = qualifyCursor(window.sessionId, window.sourceId)
    if (seen.has(sid)) return []
    seen.add(sid)
    const anchored = decodeCursor(cursor).messageId !== undefined
    return [
      {
        sid,
        ...(window.title === undefined ? {} : { title: window.title }),
        directory: window.directory,
        totalMessages: window.totalMessages,
        ...(anchored ? { anchorIndex: window.anchorIndex } : {}),
        messages: window.messages
          .filter((message) => message.role !== 'system')
          .map((message) => ({
            index: message.index,
            cursor: qualifyCursor(message.id, message.sourceId),
            text: renderFocusMessage(message, caps),
          })),
      },
    ]
  })
}

function renderFocusMessage(message: TranscriptMessage, caps: FocusCaps): string {
  const textChars = caps.textChars
  const time = new Date(message.timeCreated).toISOString().slice(0, 16)
  const cursor = qualifyCursor(message.id, message.sourceId)
  return [
    `[#${message.index} ${message.role} ${cursor} ${time}]`,
    ...message.parts.map((part) => renderFocusPart(part, textChars, caps)),
  ].join('\n')
}

function renderFocusPart(part: TranscriptPart, textChars: number, caps: FocusCaps): string {
  switch (part.type) {
    case 'text':
      return clipText(part.text, textChars)
    case 'tool': {
      const input = clipLine(singleLine(part.input), Math.floor(caps.toolChars / TOOL_INPUT_SHARE))
      const output =
        part.output === undefined ? '' : ` → ${clipLine(singleLine(part.output), caps.toolChars)}`
      return `  ⚙ ${part.toolName}(${part.status}) ${input}${output}`
    }
    case 'file':
      return `  📎 ${part.filename ?? part.mime ?? 'file'}`
    case 'patch':
      return `  ✎ patch ${part.files.join(', ')}`
    default: {
      const exhaustive: never = part
      throw new Error(`Unsupported transcript part: ${String(exhaustive)}`)
    }
  }
}

const ESCAPE = String.fromCharCode(27)
const TERMINAL_ESCAPES = new RegExp(
  String.raw`${ESCAPE}\[[0-9;?]*[A-Za-z]|\^\[\[[0-9;?]*[A-Za-z]|(?:M-(?:\^.|.)){2,}`,
  'g',
)

function singleLine(text: string): string {
  return text.replaceAll(TERMINAL_ESCAPES, '').replaceAll(/\s+/g, ' ').trim()
}

function clipLine(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.ceil(limit * 0.75)
  return `${text.slice(0, head)} … ${text.slice(text.length - (limit - head))}`
}

export function clipText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = Math.ceil(limit * 0.75)
  const tail = limit - head
  return `${text.slice(0, head)}\n[… ${text.length - limit} chars omitted …]\n${text.slice(text.length - tail)}`
}
