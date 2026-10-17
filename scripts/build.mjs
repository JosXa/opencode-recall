import { execFileSync } from 'node:child_process'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { transformFileAsync } from '@babel/core'

// Running OpenCode instances load this plugin from dist and reload it when dist changes, so dist
// must never disappear or hold half-written files. Build into a staging directory, then move each
// finished file over its old copy and delete files the new build no longer emits.
const out = 'dist'
const stage = 'dist.next'
await rm(stage, { recursive: true, force: true })

const tsc = join(
  dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
  'bin/tsc',
)
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', stage], {
  stdio: 'inherit',
})

// Emit the same universal Solid renderer as OpenTUI's transform, using Node.
const result = await transformFileAsync(join(stage, 'tui.jsx'), {
  babelrc: false,
  configFile: false,
  presets: [['babel-preset-solid', { moduleName: '@opentui/solid', generate: 'universal' }]],
})
if (!result?.code) throw new Error('OpenTUI transform produced no code')
await writeFile(join(stage, 'tui.js'), result.code)
await rm(join(stage, 'tui.jsx'))

const files = async (root) =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))

const built = await files(stage)
for (const file of built) {
  await mkdir(dirname(join(out, file)), { recursive: true })
  await rename(join(stage, file), join(out, file))
}
const current = new Set(built)
for (const file of await files(out)) {
  if (!current.has(file)) await rm(join(out, file))
}
await rm(stage, { recursive: true, force: true })
