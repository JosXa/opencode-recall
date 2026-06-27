import { executeWorkerRequest } from './worker-actions.js'
import type { HistoryWorkerRequest, HistoryWorkerResponse } from './worker-protocol.js'

const response = await executeMain()
process.stdout.write(JSON.stringify(response))

async function executeMain(): Promise<HistoryWorkerResponse> {
  try {
    return { ok: true, data: await executeWorkerRequest(parseRequest(await readStdin())) }
  } catch (error) {
    return { ok: false, error: { message: errorMessage(error) } }
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return Buffer.concat(chunks).toString('utf-8')
}

function parseRequest(input: string): HistoryWorkerRequest {
  const parsed = JSON.parse(input) as unknown

  if (isHistoryWorkerRequest(parsed)) {
    return parsed
  }

  throw new Error('Invalid opencode-recall worker request')
}

function isHistoryWorkerRequest(value: unknown): value is HistoryWorkerRequest {
  if (!isHistoryWorkerRequestShape(value)) {
    return false
  }

  const kind = value.kind
  const args = value.args
  const context = value.context

  if (kind === 'read' || kind === 'read-window') {
    return isRecord(args)
  }

  return (
    (kind === 'search' || kind === 'session-index' || kind === 'session-save') &&
    isRecord(args) &&
    isRecord(context)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isHistoryWorkerRequestShape(value: unknown): value is {
  readonly kind?: unknown
  readonly args?: unknown
  readonly context?: unknown
} {
  return isRecord(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
