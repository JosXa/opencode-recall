import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { RecallSidecarIndex } from '../src/sidecar.js'
import { Database } from '../src/sqlite.js'

test('native candidates preserve boosts, scopes, ties and zero-vector scores', () => {
  const root = mkdtempSync(join(tmpdir(), 'recall-native-'))
  const path = join(root, 'index.db')
  const index = new RecallSidecarIndex(path)
  const db = new Database(path)
  try {
    const insert = db.query(`insert into chunk
      (chunk_id, session_id, session_title, directory, message_id, part_id, role,
       time_created, source_updated, text, content_hash, model, dims, embedding)
      values (?, ?, 'title', ?, ?, ?, 'user', ?, 1, ?, 'hash', ?, ?, ?)`)
    const add = (id: string, vector: number[], text = '', time = 5, directory = '/project', model = 'test') => {
      insert.run(id, id, directory, id, id, time, text, model, vector.length,
        new Uint8Array(new Float32Array(vector).buffer))
    }
    add('semantic', [1, 0])
    add('boosted', [0.9, 0.43589], 'ÜBER testing')
    add('newer', [1, 0], '', 6)
    add('zero', [0, 0], 'über testing')
    add('excluded', [1, 0], '', 7)
    add('other-directory', [1, 0], '', 8, '/elsewhere')
    add('old', [1, 0], '', 1)
    add('future', [1, 0], '', 20)
    add('other-model', [1, 0], '', 5, '/project', 'other')
    add('other-dimensions', [1, 0, 0])
    const options = { limit: 3, after: 3, before: 10, directory: '/project', excludeSessionId: 'excluded' }
    const result = index.searchWithEmbedding('über testing', options, 'test', new Float32Array([1, 0]))
    expect(result.map(r => r.sessionId)).toEqual(['boosted', 'newer', 'semantic', 'zero'])
    expect(result[0]?.score).toBeCloseTo(1.1, 5)
    expect(result[3]?.score).toBeCloseTo(0.2, 5)
    expect(result.every(r => !('embedding' in r))).toBe(true)
    const zeros = index.searchWithEmbedding('', options, 'test', new Float32Array([0, 0]))
    expect(zeros.every(r => r.score === 0)).toBe(true)
    expect(index.searchWithEmbedding('', options, 'test', undefined)).toEqual([])
    // The next search must not reuse the previous query's keyword boosts.
    const next = index.searchWithEmbedding('', options, 'test', new Float32Array([1, 0]))
    expect(next[0]?.sessionId).toBe('newer')
  } finally {
    db.close()
    index.close()
    rmSync(root, { recursive: true, force: true })
  }
})
