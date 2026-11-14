import { expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from '../src/sqlite.js'
import { assistantText, deduplicate, isHumanPrompt, originalPrompt, rankPairs, readPairs, scoreCompletion, type PromptPair } from '../scripts/autocomplete-corpus.js'

const pair = (id: string, time: number, session = id): PromptPair => ({ id, time, session, source: 'v2', directory: '/test', prompt: 'run the tests', situation: 'The changes are ready.' })

test('use pre-expansion prompts and exclude automation prefixes', () => {
  expect(originalPrompt(JSON.stringify({ text: 'huge expansion', metadata: { 'opencode-snippets:submitted': { text: '#review' } } }))).toBe('#review')
  expect(isHumanPrompt('Use grounded-search to find prices')).toBe(false)
  expect(isHumanPrompt('run the regression tests')).toBe(true)
  expect(assistantText('{"content":[{"type":"text","text":"Ready"},{"type":"tool-call","text":"Ignore"}]}')).toBe('Ready')
})

test('deduplicate fork copies before choosing held-out targets', () => {
  expect(deduplicate([pair('later', 20), pair('earlier', 10)]).map((p) => p.id)).toEqual(['earlier'])
})

test('retrieval cannot see future examples or the held-out session', () => {
  const target = pair('target', 20, 'heldout')
  const pairs = [pair('past', 10), pair('future', 30), pair('same-session', 5, 'heldout')]
  expect(rankPairs(pairs, [[1, 0], [1, 0], [1, 0]], target, 'run', [1, 0]).map((p) => p.id)).toEqual(['past'])
})

test('rewrite or answering the user is not an accepted completion', () => {
  expect(scoreCompletion('run the', 'run the tests', 'I will run tests').valid).toBe(false)
  expect(scoreCompletion('run the', 'run the tests', 'run the tests').exact).toBe(true)
  expect(scoreCompletion('run th', 'run the tests', 'run the build').nextWord).toBe(true)
  expect(scoreCompletion('', 'run the tests', 'please run the tests and then describe every single output').valid).toBe(false)
})

test('native corpus joins the preceding assistant text to the original TUI prompt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'recall-autocomplete-'))
  const path = join(directory, 'source.db')
  const db = new Database(path)
  db.exec(`
    create table session_v2(id text, directory text, parent_id text, time_updated integer);
    create table session_message(id text, session_id text, type text, seq integer, time_created integer, data text);
    insert into session_v2 values('session', '/project', null, 5);
  `)
  const insert = db.query<unknown, [string, string, number, number, string]>(`insert into session_message values(?, 'session', ?, ?, ?, ?)`)
  insert.run('reply', 'assistant', 1, 1, JSON.stringify({ content: [{ type: 'text', text: 'The changes are ready.' }] }))
  insert.run('human', 'user', 2, 2, JSON.stringify({ agents: [], text: 'expanded', metadata: { 'opencode-snippets:submitted': { text: '#review' } } }))
  insert.run('automation', 'user', 3, 3, JSON.stringify({ text: 'Use grounded-search' }))
  db.close()
  try {
    const pairs = readPairs(path, 'v2', true)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ id: 'human', prompt: '#review', situation: 'The changes are ready.' })
  } finally {
    rmSync(directory, { recursive: true })
  }
})
