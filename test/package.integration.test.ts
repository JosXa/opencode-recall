import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describe, expect, test } from 'vitest'

import { Database } from '../src/sqlite.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_TEST_TIMEOUT_MS = 120_000

describe('packed package', () => {
  test(
    'runs SDK workers from an unrelated cwd without tsx installed',
    () => {
      const testRoot = `/tmp/opencode-recall-packed-${crypto.randomUUID()}`
      const archivePath = join(testRoot, 'opencode-recall.tgz')
      const unpackRoot = join(testRoot, 'unpacked')
      const consumerRoot = join(testRoot, 'consumer-without-node-modules')
      const historyPath = join(testRoot, 'history.db')
      const sidecarPath = join(testRoot, 'sidecar.db')

      mkdirSync(unpackRoot, { recursive: true })
      mkdirSync(consumerRoot, { recursive: true })

      try {
        execFileSync('pnpm', ['run', 'build'], { cwd: REPOSITORY_ROOT, stdio: 'pipe' })
        execFileSync('pnpm', ['pack', '--out', archivePath], {
          cwd: REPOSITORY_ROOT,
          stdio: 'pipe',
        })
        execFileSync('tar', ['-xzf', archivePath, '-C', unpackRoot])

        const packedPackageDir = join(unpackRoot, 'package')
        const manifest = JSON.parse(readFileSync(join(packedPackageDir, 'package.json'), 'utf-8')) as {
          readonly dependencies?: Record<string, string>
        }
        expect(manifest.dependencies?.['tsx']).toBeUndefined()

        const db = new Database(historyPath)
        db.exec(`
          create table session (id text primary key, title text, directory text, time_updated integer);
          create table message (id text primary key, session_id text, data text, time_created integer, time_updated integer);
          create table part (id text primary key, message_id text, session_id text, data text, time_updated integer);
        `)
        db.query('insert into session values (?, ?, ?, ?)').run(
          'ses_packed',
          'Packed worker regression',
          '/projects/example',
          1,
        )
        db.query('insert into message values (?, ?, ?, ?, ?)').run(
          'msg_packed',
          'ses_packed',
          JSON.stringify({ role: 'user' }),
          1,
          1,
        )
        db.query('insert into part values (?, ?, ?, ?, ?)').run(
          'part_packed',
          'msg_packed',
          'ses_packed',
          JSON.stringify({ type: 'text', text: 'portable packaged recall worker' }),
          1,
        )
        db.close()

        const sdkUrl = pathToFileURL(join(packedPackageDir, 'dist/src/sdk.js')).href
        const stdout = execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
              import { renderHistoryWindow, searchHistory } from ${JSON.stringify(sdkUrl)}
              const options = {
                historyDbPath: ${JSON.stringify(historyPath)},
                sidecarDbPath: ${JSON.stringify(sidecarPath)},
                includeCurrentSession: true,
                semantic: false,
              }
              const search = await searchHistory('portable packaged', options)
              const transcript = renderHistoryWindow('ses_packed', options)
              process.stdout.write(JSON.stringify({ cursor: search.hits[0]?.cursor, transcript }))
            `,
          ],
          { cwd: consumerRoot, encoding: 'utf-8', env: process.env },
        )
        const result = JSON.parse(stdout) as { readonly cursor?: string; readonly transcript?: string }

        expect(result.cursor).toBe('msg_packed')
        expect(result.transcript).toContain('portable packaged recall worker')
      } finally {
        rmSync(testRoot, { recursive: true, force: true })
      }
    },
    PACKAGE_TEST_TIMEOUT_MS,
  )
})
