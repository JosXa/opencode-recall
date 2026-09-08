import { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import type { HistoryWorkerRequest, HistoryWorkerResponse } from './worker-protocol.js'

const MAX_WORKER_OUTPUT_BYTES = 10 * 1024 * 1024
const ABORT_KILL_GRACE_MS = 500

interface WorkerCommand {
  readonly command: string
  readonly args: readonly string[]
}

export function executeNodeWorker(
  workerDir: string,
  request: HistoryWorkerRequest,
  signal: AbortSignal,
): Promise<string> {
  const worker = resolveWorkerCommand(workerDir)

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
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined

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
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        // Cancellation must not leave a worker alive if it handles or ignores SIGTERM.
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, ABORT_KILL_GRACE_MS)
        forceKillTimer.unref()
      }
      settle({ error: new Error('opencode-recall Node worker was aborted') })
    }

    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
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
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
      settle(parseWorkerResult(code, stdout, stderr))
    })
    child.stdin.end(JSON.stringify(request))
  })
}

export class SessionWorkerAbortRegistry {
  readonly #active = new Map<string, Set<AbortController>>()

  run<T>(sessionID: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const controllers = this.#active.get(sessionID) ?? new Set<AbortController>()
    controllers.add(controller)
    this.#active.set(sessionID, controllers)

    return operation(controller.signal).finally(() => {
      controllers.delete(controller)
      if (controllers.size === 0) this.#active.delete(sessionID)
    })
  }

  interrupt(sessionID: string): void {
    for (const controller of this.#active.get(sessionID) ?? []) controller.abort()
  }

  dispose(): void {
    for (const controllers of this.#active.values()) {
      for (const controller of controllers) controller.abort()
    }
    this.#active.clear()
  }
}

export async function forwardSessionInterruptions(
  events: AsyncIterable<{ type: string; data?: unknown }>,
  workers: SessionWorkerAbortRegistry,
): Promise<void> {
  for await (const event of events) {
    if (event.type !== 'session.execution.interrupted') continue
    const data = event.data
    if (typeof data !== 'object' || data === null || !('sessionID' in data)) continue
    if (typeof data.sessionID === 'string') workers.interrupt(data.sessionID)
  }
}

export function executeNodeWorkerSync(workerDir: string, request: HistoryWorkerRequest): string {
  const worker = resolveWorkerCommand(workerDir)
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

function resolveWorkerCommand(workerDir: string): WorkerCommand {
  const builtWorkerPath = join(workerDir, 'node-worker.js')

  if (existsSync(builtWorkerPath)) {
    return { command: 'node', args: [builtWorkerPath] }
  }

  const sourceWorkerPath = join(workerDir, 'node-worker.ts')
  if (!existsSync(sourceWorkerPath)) {
    throw new Error(`opencode-recall worker entry not found in ${workerDir}`)
  }

  // Source checkouts need tsx, but resolve it here so Node never searches from the consumer cwd.
  const tsxLoaderPath = createRequire(import.meta.url).resolve('tsx')
  return { command: 'node', args: ['--import', tsxLoaderPath, sourceWorkerPath] }
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
