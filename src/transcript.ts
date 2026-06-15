export type HistoryFormat = 'chatml' | 'json' | 'markdown'

export type HistoryReadMode = 'around' | 'head' | 'next' | 'prev' | 'tail'

export type TranscriptRole = 'user' | 'assistant' | 'system' | 'tool'

export interface TranscriptTextPart {
  readonly type: 'text'
  readonly text: string
}

export interface TranscriptToolPart {
  readonly type: 'tool'
  readonly toolName: string
  readonly callId?: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly input: string
  readonly output?: string
  readonly inputTruncated: boolean
  readonly outputTruncated: boolean
  readonly originalInputChars: number
  readonly originalOutputChars?: number
}

export interface TranscriptFilePart {
  readonly type: 'file'
  readonly filename?: string
  readonly mime?: string
  readonly chars: number
  readonly omitted: true
}

export interface TranscriptPatchPart {
  readonly type: 'patch'
  readonly hash?: string
  readonly files: readonly string[]
}

export type TranscriptPart =
  | TranscriptFilePart
  | TranscriptPatchPart
  | TranscriptTextPart
  | TranscriptToolPart

export interface TranscriptMessage {
  readonly index: number
  readonly id: string
  readonly role: TranscriptRole
  readonly timeCreated: number
  readonly parts: readonly TranscriptPart[]
}

export interface TranscriptWindow {
  readonly sessionId: string
  readonly title?: string
  readonly directory: string
  readonly mode: HistoryReadMode
  readonly startIndex: number
  readonly endIndex: number
  readonly anchorIndex: number
  readonly previousCursor?: string
  readonly nextCursor?: string
  readonly anchorCursor: string
  readonly totalMessages: number
  readonly messages: readonly TranscriptMessage[]
}

export interface HistoryRenderer<Output = string> {
  readonly format: HistoryFormat
  render(window: TranscriptWindow): Output
}
