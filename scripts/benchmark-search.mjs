// Build both checkouts first. Supply an existing sidecar; no history sync runs.
// node scripts/benchmark-search.mjs BASELINE_ROOT SIDECAR [QUERY ...]
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

if (process.argv[2] === '--worker') {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const { RecallSidecarIndex } = await import(pathToFileURL(resolve(input.root, 'dist/src/sidecar.js')))
  const started = performance.now()
  const index = new RecallSidecarIndex(input.path)
  try {
    const hits = index.searchWithEmbedding(input.query, { limit: 1000 }, input.model, new Float32Array(input.vector))
    console.log(JSON.stringify({ ms: performance.now() - started, maxRssKiB: process.resourceUsage().maxRSS,
      hits: hits.map(h => ({ id: h.partId, score: h.score })) }))
  } finally { index.close() }
} else {
  const [baseline, path, ...requested] = process.argv.slice(2)
  assert(baseline && path, 'Supply BASELINE_ROOT and SIDECAR')
  const current = fileURLToPath(new URL('..', import.meta.url))
  const { OllamaEmbeddingProvider } = await import(pathToFileURL(resolve(current, 'dist/src/embedding.js')))
  const provider = new OllamaEmbeddingProvider()
  try {
    const queries = requested.length ? requested : ['testing stuff', 'resurre', 'oc-sessions', 'database migration']
    for (const [i, query] of queries.entries()) {
      const [vector] = await provider.embed([query])
      const results = {}
      // Alternate order to avoid systematically favoring the warmer OS page cache.
      for (const name of i % 2 ? ['native', 'baseline'] : ['baseline', 'native']) {
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker'], {
          input: JSON.stringify({ root: name === 'native' ? current : baseline, path, query,
            model: provider.model, vector: Array.from(vector) }), encoding: 'utf8', timeout: 120_000,
        })
        assert.equal(child.status, 0, child.stderr)
        results[name] = JSON.parse(child.stdout)
      }
      const before = results.baseline, after = results.native
      const expected = new Map(before.hits.map(h => [h.id, h.score]))
      const top = before.hits.slice(0, 80), actual = new Set(after.hits.slice(0, 80).map(h => h.id))
      const overlap = top.filter(h => actual.has(h.id)).length / top.length
      const maxScoreError = Math.max(0, ...after.hits.filter(h => expected.has(h.id)).map(h => Math.abs(h.score - expected.get(h.id))))
      assert(overlap >= 0.99, `Top-80 overlap regressed: ${overlap}`)
      assert(maxScoreError < 0.00001, `Score drift: ${maxScoreError}`)
      console.log(JSON.stringify({ query, baselineMs: Math.round(before.ms), nativeMs: Math.round(after.ms),
        speedup: +(before.ms / after.ms).toFixed(2), baselineRssMiB: Math.round(before.maxRssKiB / 1024),
        nativeRssMiB: Math.round(after.maxRssKiB / 1024), top80Overlap: overlap, maxScoreError }))
    }
  } finally { provider.close() }
}
