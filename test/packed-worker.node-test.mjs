import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))

test('packed worker runs from an unrelated cwd without consumer tsx', () => {
  const root = mkdtempSync(join(tmpdir(), 'opencode-recall-packed-'))
  const packDir = join(root, 'pack')
  const consumerDir = join(root, 'consumer')
  mkdirSync(packDir)
  mkdirSync(consumerDir)

  try {
    run('pnpm', ['pack', '--pack-destination', packDir], PROJECT_ROOT)
    const archive = join(packDir, 'josxa-opencode-recall-1.1.0-opencode-v2.tgz')
    run('tar', ['-xzf', archive, '-C', root], PROJECT_ROOT)

    const workerClientUrl = pathToFileURL(
      join(root, 'package/dist/src/node-worker-client.js'),
    ).href
    const workerDir = join(root, 'package/dist/src')
    const runner = join(consumerDir, 'run.mjs')
    writeFileSync(
      runner,
      `import { executeNodeWorker } from ${JSON.stringify(workerClientUrl)}\n` +
        `try {\n` +
        `  await executeNodeWorker(${JSON.stringify(workerDir)}, { kind: 'read', args: { cursor: 'invalid' } }, new AbortController().signal)\n` +
        `} catch (error) {\n` +
        `  const message = error instanceof Error ? error.message : String(error)\n` +
        `  if (message.includes('tsx') || message.includes('ERR_MODULE_NOT_FOUND')) throw error\n` +
        `  process.stdout.write('worker-started')\n` +
        `}\n`,
    )

    const result = spawnSync('node', [runner], {
      cwd: consumerDir,
      encoding: 'utf-8',
      env: { ...process.env, NODE_PATH: '' },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'worker-started')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf-8', env: process.env })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}
