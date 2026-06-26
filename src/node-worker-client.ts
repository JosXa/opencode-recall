import { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { HistoryWorkerRequest, HistoryWorkerResponse } from './worker-protocol.js'

const MAX_WORKER_OUTPUT_BYTES = 10 * 1024 * 1024

interface WorkerCommand {
  readonly command: string
  readonly args: readonly string[]
}

export function executeNodeWorker(
  packageDir: string,
  request: HistoryWorkerRequest,
  signal: AbortSignal,
): Promise<string> {
  const worker = resolveWorkerCommand(packageDir)

  return new Promise((resolve, reject) => {
    const child = spawn(worker.command, worker.args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false

    const settle = (result: { readonly value: string } | { readonly error: Error }) => {
      if (settled) {
        return
      }

      settled = true
      signal.removeEventListener('abort', abort)

      if ('error' in result) {
        reject(result.error)
        return
      }

      resolve(result.value)
    }

    const abort = () => {
      child.kill()
      settle({ error: new Error('opencode-recall Node worker was aborted') })
    }

    signal.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => settle({ error }))
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_WORKER_OUTPUT_BYTES) {
        child.kill()
        settle({ error: new Error('opencode-recall Node worker exceeded stdout limit') })
        return
      }

      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes <= MAX_WORKER_OUTPUT_BYTES) {
        stderr.push(chunk)
      }
    })
    child.on('close', (code) => {
      settle(parseWorkerResult(code, stdout, stderr))
    })
    child.stdin.end(JSON.stringify(request))
  })
}

export function executeNodeWorkerSync(packageDir: string, request: HistoryWorkerRequest): string {
  const worker = resolveWorkerCommand(packageDir)
  const result = spawnSync(worker.command, worker.args, {
    env: process.env,
    input: JSON.stringify(request),
    maxBuffer: MAX_WORKER_OUTPUT_BYTES,
  })

  if (result.error !== undefined) {
    throw result.error
  }

  const parsed = parseWorkerResult(result.status, [result.stdout], [result.stderr])

  if ('error' in parsed) {
    throw parsed.error
  }

  return parsed.value
}

function resolveWorkerCommand(packageDir: string): WorkerCommand {
  const builtWorkerPath = join(packageDir, 'src/node-worker.js')

  if (existsSync(builtWorkerPath)) {
    return { command: 'node', args: [builtWorkerPath] }
  }

  return { command: 'node', args: ['--import', 'tsx', join(packageDir, 'src/node-worker.ts')] }
}

function parseWorkerResult(
  code: number | null,
  stdout: readonly Buffer[],
  stderr: readonly Buffer[],
): { readonly value: string } | { readonly error: Error } {
  const stdoutText = Buffer.concat(stdout).toString('utf-8')
  const stderrText = Buffer.concat(stderr).toString('utf-8')

  if (code !== 0) {
    return {
      error: new Error(
        nonEmpty(stderrText) ?? nonEmpty(stdoutText) ?? `Node worker exited ${code}`,
      ),
    }
  }

  const response = parseWorkerResponse(stdoutText)

  if (response === undefined) {
    return { error: new Error(nonEmpty(stderrText) ?? 'Node worker returned invalid JSON') }
  }

  if (!response.ok) {
    return { error: new Error(response.error.message) }
  }

  return { value: response.data }
}

function parseWorkerResponse(value: string): HistoryWorkerResponse | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return isHistoryWorkerResponse(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isHistoryWorkerResponse(value: unknown): value is HistoryWorkerResponse {
  if (!isHistoryWorkerResponseShape(value) || typeof value.ok !== 'boolean') {
    return false
  }

  if (value.ok) {
    return typeof value.data === 'string'
  }

  const error = value.error
  return isHistoryWorkerErrorShape(error) && typeof error.message === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isHistoryWorkerResponseShape(value: unknown): value is {
  readonly ok?: unknown
  readonly data?: unknown
  readonly error?: unknown
} {
  return isRecord(value)
}

function isHistoryWorkerErrorShape(value: unknown): value is { readonly message?: unknown } {
  return isRecord(value)
}

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}
