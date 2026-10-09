import { rm, writeFile } from 'node:fs/promises'
import { transformFileAsync } from '@babel/core'

// Emit the same universal Solid renderer as OpenTUI's transform, using Node.
const result = await transformFileAsync('dist/tui.jsx', {
  babelrc: false,
  configFile: false,
  presets: [['babel-preset-solid', { moduleName: '@opentui/solid', generate: 'universal' }]],
})
if (!result?.code) throw new Error('OpenTUI transform produced no code')
await writeFile('dist/tui.js', result.code)
await rm('dist/tui.jsx')
