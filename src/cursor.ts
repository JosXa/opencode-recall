import { Buffer } from 'node:buffer'

const MESSAGE_ID_PATTERN = /^msg_[A-Za-z0-9]+$/
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9]+$/

export interface HistoryCursor {
  readonly version: 1
  readonly messageId?: string
  readonly sessionId?: string
  readonly partId?: string
  readonly timeCreated?: number
}

export function encodeCursor(cursor: HistoryCursor): string {
  if (cursor.messageId === undefined) {
    return cursor.sessionId ?? ''
  }

  return cursor.messageId
}

export function decodeCursor(value: string): HistoryCursor {
  if (MESSAGE_ID_PATTERN.test(value)) {
    return { version: 1, messageId: value }
  }

  if (SESSION_ID_PATTERN.test(value)) {
    return { version: 1, sessionId: value }
  }

  const parsed = parseEncodedCursor(value)

  if (!isHistoryCursor(parsed)) {
    throw new Error('Invalid history cursor')
  }

  return parsed
}

function parseEncodedCursor(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new Error(
      'Invalid history cursor. Expected msg_..., ses_..., or an encoded cursor from history_search.',
    )
  }
}

function isHistoryCursor(value: unknown): value is HistoryCursor {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<HistoryCursor>
  return (
    candidate.version === 1 &&
    (candidate.messageId === undefined || typeof candidate.messageId === 'string') &&
    (typeof candidate.messageId === 'string' || typeof candidate.sessionId === 'string') &&
    (candidate.sessionId === undefined || typeof candidate.sessionId === 'string') &&
    (candidate.partId === undefined || typeof candidate.partId === 'string') &&
    (candidate.timeCreated === undefined || typeof candidate.timeCreated === 'number')
  )
}
