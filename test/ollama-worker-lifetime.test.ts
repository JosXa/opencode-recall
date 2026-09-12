import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { executeNodeWorker } from '../src/node-worker-client.js'

test('cancelling a worker preserves its persistent Ollama server and other clients', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recall-ollama-lifetime-'))
  const port = await unusedPort()
  const baseUrl = `http://127.0.0.1:${port}`
  const workerPid = join(root, 'worker.pid')
  const serverPid = join(root, 'server.pid')
  const optionsPath = join(root, 'spawn-options.json')
  const pendingPath = join(root, 'embedding-pending')
  const concurrentPath = join(root, 'concurrent-pending')
  const serverPath = join(root, 'ollama.mjs')
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(serverPath, `
    import { createServer } from 'node:http'
    import { writeFileSync } from 'node:fs'
    writeFileSync(${JSON.stringify(serverPid)}, String(process.pid))
    createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/api/version') return response.end('{"version":"fixture"}')
      if (request.url === '/api/tags') return response.end('{"models":[{"name":"fixture:latest"}]}')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const input = JSON.parse(Buffer.concat(chunks).toString()).input
      if (input.includes('blocked worker')) {
        writeFileSync(${JSON.stringify(pendingPath)}, 'ready')
        return
      }
      // Keep an independent client's embedding request active during cancellation.
      writeFileSync(${JSON.stringify(concurrentPath)}, 'ready')
      setTimeout(() => response.end('{"embeddings":[[1,0]]}'), 1000)
    }).listen(${port}, '127.0.0.1')
  `)
  writeFileSync(join(root, 'node-worker.ts'), `
    import childProcess from 'node:child_process'
    import { writeFileSync } from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    const spawn = childProcess.spawn
    // Substitute only the Ollama executable, preserving the real provider's spawn options.
    // This also works on Windows without invoking a .cmd file through a shell.
    childProcess.spawn = (command, args, options) => {
      if (command !== 'ollama') return spawn(command, args, options)
      writeFileSync(${JSON.stringify(optionsPath)}, JSON.stringify({ detached: options.detached, windowsHide: options.windowsHide, stdio: options.stdio }))
      return spawn(process.execPath, [${JSON.stringify(serverPath)}], options)
    }
    syncBuiltinESMExports()
    writeFileSync(${JSON.stringify(workerPid)}, String(process.pid))
    // Exercise forced group termination on POSIX too; Windows kills the process directly.
    process.on('SIGTERM', () => {})
    const { OllamaEmbeddingProvider } = await import(${JSON.stringify(new URL('../src/embedding.ts', import.meta.url).href)})
    await new OllamaEmbeddingProvider({ baseUrl: ${JSON.stringify(baseUrl)}, model: 'fixture' }).embed(['blocked worker'])
  `)
  const abort = new AbortController()
  const result = executeNodeWorker(root, { kind: 'read', args: { cursor: 'ses_test' } }, abort.signal)
    .catch((error: unknown) => error)
  try {
    await Promise.race([
      expect.poll(() => existsSync(pendingPath), { timeout: 10_000 }).toBe(true),
      result.then(error => { throw error }),
    ])
    const worker = Number(readFileSync(workerPid, 'utf8'))
    const server = Number(readFileSync(serverPid, 'utf8'))
    const concurrent = fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      body: JSON.stringify({ input: ['another client'] }),
      signal: AbortSignal.timeout(5000),
    }).then(response => response.json()).catch((error: unknown) => error)
    await expect.poll(() => existsSync(concurrentPath)).toBe(true)
    abort.abort()
    expect(await result).toHaveProperty('message', 'opencode-recall Node worker was aborted')
    await expect.poll(() => running(worker), { timeout: 5000 }).toBe(false)
    expect(await concurrent).toEqual({ embeddings: [[1, 0]] })
    expect(running(server)).toBe(true)
    expect(await fetch(`${baseUrl}/api/version`).then(response => response.json()))
      .toEqual({ version: 'fixture' })
    expect(JSON.parse(readFileSync(optionsPath, 'utf8'))).toEqual({
      detached: true, windowsHide: true, stdio: 'ignore',
    })
  } finally {
    abort.abort()
    await result
    for (const file of [workerPid, serverPid]) {
      if (!existsSync(file)) continue
      const pid = Number(readFileSync(file, 'utf8'))
      if (running(pid)) process.kill(pid, 'SIGKILL')
      await expect.poll(() => running(pid), { timeout: 5000 }).toBe(false)
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
