import { Buffer } from 'node:buffer'

export interface HistoryCursor {
  readonly version: 1
  readonly messageId: string
  readonly sessionId?: string
  readonly partId?: string
  readonly timeCreated?: number
}

export function encodeCursor(cursor: HistoryCursor): string {
  return cursor.messageId
}

export function decodeCursor(value: string): HistoryCursor {
  if (value.startsWith('msg_')) {
    return { version: 1, messageId: value }
  }

  const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))

  if (!isHistoryCursor(parsed)) {
    throw new Error('Invalid history cursor')
  }

  return parsed
}

function isHistoryCursor(value: unknown): value is HistoryCursor {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<HistoryCursor>
  return (
    candidate.version === 1 &&
    typeof candidate.messageId === 'string' &&
    (candidate.sessionId === undefined || typeof candidate.sessionId === 'string') &&
    (candidate.partId === undefined || typeof candidate.partId === 'string') &&
    (candidate.timeCreated === undefined || typeof candidate.timeCreated === 'number')
  )
}
