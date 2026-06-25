import { encodeCursor } from './cursor.js'
import type { PartRow, WindowRows } from './db.js'
import type { TranscriptMessage, TranscriptPart, TranscriptWindow } from './transcript.js'

const MAX_TOOL_INPUT_CHARS = 2_000
const MAX_TOOL_OUTPUT_CHARS = 6_000

interface OpenCodePart {
  readonly type?: unknown
  readonly text?: unknown
  readonly state?: unknown
  readonly tool?: unknown
  readonly callID?: unknown
  readonly filename?: unknown
  readonly mime?: unknown
  readonly files?: unknown
  readonly hash?: unknown
}

interface OpenCodeToolState {
  readonly input?: unknown
  readonly output?: unknown
  readonly status?: unknown
}

export function normalizeWindow(rows: WindowRows): TranscriptWindow {
  const partsByMessage = groupPartsByMessage(rows.parts)
  const messages = rows.messages.map<TranscriptMessage>((message) => ({
    index: message.messageIndex,
    id: message.messageId,
    role: normalizeRole(message.role),
    timeCreated: message.timeCreated,
    parts: normalizeParts(partsByMessage.get(message.messageId) ?? []),
  }))
  const first = rows.messages[0]
  const last = rows.messages.at(-1)
  const previousCursor =
    rows.hasPrevious && first !== undefined ? cursorFor(rows.sessionId, first) : undefined
  const nextCursor =
    rows.hasNext && last !== undefined ? cursorFor(rows.sessionId, last) : undefined
  const anchorMessage = rows.messages.find((message) => message.messageIndex === rows.anchorIndex)
  const anchorCursor =
    anchorMessage === undefined
      ? cursorFor(rows.sessionId, {
          messageId: rows.anchorMessageId,
          timeCreated: rows.anchorTimeCreated,
        })
      : cursorFor(rows.sessionId, anchorMessage)

  return {
    sessionId: rows.sessionId,
    title: rows.title,
    directory: rows.directory,
    mode: rows.mode,
    startIndex: first?.messageIndex ?? rows.anchorIndex,
    endIndex: last?.messageIndex ?? rows.anchorIndex,
    anchorIndex: rows.anchorIndex,
    anchorCursor,
    totalMessages: rows.totalMessages,
    messages,
    ...(previousCursor === undefined ? {} : { previousCursor }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  }
}

function groupPartsByMessage(parts: readonly PartRow[]): Map<string, PartRow[]> {
  const grouped = new Map<string, PartRow[]>()

  for (const part of parts) {
    const existing = grouped.get(part.messageId)

    if (existing === undefined) {
      grouped.set(part.messageId, [part])
      continue
    }

    existing.push(part)
  }

  return grouped
}

function normalizeParts(parts: readonly PartRow[]): TranscriptPart[] {
  return parts.flatMap((part) => normalizePart(part.data))
}

function normalizePart(data: string): TranscriptPart[] {
  const parsed: unknown = JSON.parse(data)

  if (!isRecord(parsed)) {
    return []
  }

  const part = parsed as OpenCodePart

  if (typeof part.type !== 'string') {
    return []
  }

  switch (part.type) {
    case 'file':
      return [normalizeFilePart(part, data.length)]
    case 'patch':
      return [normalizePatchPart(part)]
    case 'text':
      return typeof part.text === 'string' ? [{ type: 'text', text: part.text }] : []
    case 'tool':
      return [normalizeToolPart(part)]
    default:
      return []
  }
}

function normalizeToolPart(part: OpenCodePart): TranscriptPart {
  const state: OpenCodeToolState = isRecord(part.state) ? part.state : {}
  const input = stringifyUnknown(state.input ?? {})
  const output = typeof state.output === 'string' ? state.output : undefined
  const cappedInput = capText(input, MAX_TOOL_INPUT_CHARS)
  const cappedOutput = output === undefined ? undefined : capText(output, MAX_TOOL_OUTPUT_CHARS)
  const callId = typeof part.callID === 'string' ? part.callID : undefined
  const originalOutputChars = output?.length

  return {
    type: 'tool',
    toolName: typeof part.tool === 'string' ? part.tool : 'unknown',
    status: normalizeStatus(state.status),
    input: cappedInput.text,
    inputTruncated: cappedInput.truncated,
    outputTruncated: cappedOutput?.truncated ?? false,
    originalInputChars: input.length,
    ...(callId === undefined ? {} : { callId }),
    ...(cappedOutput === undefined ? {} : { output: cappedOutput.text }),
    ...(originalOutputChars === undefined ? {} : { originalOutputChars }),
  }
}

function normalizeFilePart(part: OpenCodePart, chars: number): TranscriptPart {
  const filename = typeof part.filename === 'string' ? part.filename : undefined
  const mime = typeof part.mime === 'string' ? part.mime : undefined

  return {
    type: 'file',
    chars,
    omitted: true,
    ...(filename === undefined ? {} : { filename }),
    ...(mime === undefined ? {} : { mime }),
  }
}

function normalizePatchPart(part: OpenCodePart): TranscriptPart {
  const partFiles = part.files
  const files = Array.isArray(partFiles)
    ? partFiles.filter((file): file is string => typeof file === 'string')
    : []
  const hash = typeof part.hash === 'string' ? part.hash : undefined

  return {
    type: 'patch',
    files,
    ...(hash === undefined ? {} : { hash }),
  }
}

function normalizeRole(role: string) {
  if (role === 'assistant' || role === 'system' || role === 'tool' || role === 'user') {
    return role
  }

  return 'assistant'
}

function normalizeStatus(value: unknown): 'pending' | 'running' | 'completed' | 'failed' {
  if (value === 'pending' || value === 'running' || value === 'completed' || value === 'failed') {
    return value
  }

  return 'completed'
}

function capText(
  text: string,
  maxChars: number,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false }
  }

  return { text: text.slice(0, maxChars), truncated: true }
}

function stringifyUnknown(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'null'
}

function cursorFor(
  sessionId: string,
  message: { readonly messageId: string; readonly timeCreated: number },
): string {
  return encodeCursor({
    version: 1,
    sessionId,
    messageId: message.messageId,
    timeCreated: message.timeCreated,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
