import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf-8'))
const expectedVersion = process.env.EXPECTED_VERSION
const ref = process.env.GITHUB_REF

if (ref !== 'refs/heads/opencode-v2') {
  throw new Error(`Ref must be refs/heads/opencode-v2, received ${String(ref)}`)
}

if (packageJson.name !== '@josxa/opencode-recall') {
  throw new Error(`Package name must remain @josxa/opencode-recall, received ${packageJson.name}`)
}

if (!/^\d+\.\d+\.\d+-opencode-v2$/.test(packageJson.version)) {
  throw new Error(`Version must be a main-line version suffixed -opencode-v2: ${packageJson.version}`)
}

if (expectedVersion !== packageJson.version) {
  throw new Error(`Expected version ${String(expectedVersion)} does not match ${packageJson.version}`)
}

console.log(`Release guards passed for ${packageJson.name}@${packageJson.version}`)
