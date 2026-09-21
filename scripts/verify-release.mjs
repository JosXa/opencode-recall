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

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-opencode-v2\.[1-9]\d*$/.test(packageJson.version)) {
  throw new Error(`Version must use X.Y.Z-opencode-v2.N: ${packageJson.version}`)
}

if (expectedVersion !== packageJson.version) {
  throw new Error(`Expected version ${String(expectedVersion)} does not match ${packageJson.version}`)
}

console.log(`Release guards passed for ${packageJson.name}@${packageJson.version}`)
