import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { executeNodeWorker } from '../src/node-worker-client.js'

test.skipIf(process.platform === 'win32')(
  'a deadline stops the worker and its launcher descendants, even when SIGTERM is ignored',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-deadline-'))
    const pidFile = join(dir, 'child.pid')
    const child = `import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{}); writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setInterval(()=>{},1000)`
    writeFileSync(
      join(dir, 'node-worker.js'),
      `const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(child)}],{stdio:'inherit'});`,
    )
    try {
      const result = executeNodeWorker(
        dir,
        { kind: 'read', args: { cursor: 'ses_test' } },
        new AbortController().signal,
        1500,
      ).catch((error: unknown) => error)
      await expect.poll(() => existsSync(pidFile)).toBe(true)
      const pid = Number(readFileSync(pidFile, 'utf8'))
      expect(await result).toHaveProperty('message', 'opencode-recall Node worker timed out after 1500 ms')
      await expect.poll(() => running(pid)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
