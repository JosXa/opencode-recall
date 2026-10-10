import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { acceptKey, AutocompleteController, type PromptSnapshot } from '../src/autocomplete-controller.js'
import { normalizeSuggestion, normalizeSuggestions, suggestionPrompt } from '../src/autocomplete.js'
import { HistoryDatabase } from '../src/db.js'
import { HistorySources } from '../src/history-sources.js'
import { submittedText } from '../src/prompt-example.js'
import { Database } from '../src/sqlite.js'

const snapshot = (text = 'run ', extra: Partial<PromptSnapshot> = {}): PromptSnapshot => ({
  scope: 'session:reply', sessionID: 'ses_current', situation: 'The tests pass.', text, mode: 'typing', eligible: true, ...extra,
})

afterEach(() => vi.useRealTimers())

test('Tab accepts a suggestion while modified Tab stays with the host', () => {
  const key = { name: 'tab', shift: false, ctrl: false, meta: false }
  expect(acceptKey(key)).toBe('all')
  expect(acceptKey({ ...key, shift: true })).toBeUndefined()
  expect(acceptKey({ ...key, ctrl: true })).toBeUndefined()
  expect(acceptKey({ ...key, meta: true })).toBeUndefined()
  expect(acceptKey({ ...key, name: 'right' })).toBe('all')
  expect(acceptKey({ ...key, name: 'right', ctrl: true })).toBe('word')
})

test('generation preserves typed text and keeps next actions short', () => {
  const input = snapshot('run ')
  expect(normalizeSuggestion('run the tests\n', input)).toBe('run the tests')
  expect(normalizeSuggestion('run  the tests', input)).toBe('run the tests')
  expect(normalizeSuggestion('Run the tests', input)).toBe('')
  expect(normalizeSuggestion('run ', input)).toBe('')
  expect(normalizeSuggestion('run a\nb', input)).toBe('')
  expect(normalizeSuggestion('NONE', input)).toBe('')
  expect(normalizeSuggestion('run a b c d e f g h i j k l m', input)).toBe('')
  const next = snapshot('', { mode: 'next' })
  expect(normalizeSuggestion('  commit and push the changes\n', next)).toBe('commit and push the changes')
  expect(normalizeSuggestion('one two three four five six seven eight nine', next)).toBe('')
  expect(suggestionPrompt(input, [{ situation: 'Ready', prompt: 'ship it', directory: '/project' }])).toContain('ship it')
})

test('suffix JSON preserves periods and identifiers without echoing the draft', () => {
  expect(normalizeSuggestions('{"chunks":[" Add a regression test."," Then run the suite."]}', snapshot('Review the diff.')))
    .toEqual({ text: 'Review the diff. Add a regression test.', continuations: [' Then run the suite.'] })
  expect(normalizeSuggestions('{"chunks":["Add a regression test."]}', snapshot('Review the diff. ')))
    .toEqual({ text: 'Review the diff. Add a regression test.' })
  expect(normalizeSuggestions('{"chunks":["json scripts"]}', snapshot('package.'))).toEqual({ text: 'package.json scripts' })
  expect(normalizeSuggestions('{"chunks":["review the diff","Run the tests."]}', snapshot('', { mode: 'next' })))
    .toEqual({ text: 'review the diff', continuations: [' Run the tests.'] })
  for (const raw of ['garbage', '{"chunks":[]}', '{"chunks":["NONE"]}', '{"chunks":["a\\nb"]}', '{"chunks":[42]}'])
    expect(normalizeSuggestions(raw, snapshot())).toEqual({ text: '' })
  expect(normalizeSuggestions('{"chunks":["the tests","NONE","padding"]}', snapshot())).toEqual({ text: 'run the tests' })
})

test('Tab acceptance reveals cached chunks immediately while one bounded refill runs', async () => {
  vi.useFakeTimers()
  const refill = Promise.withResolvers<{ text: string; continuations: string[] }>()
  const request = vi.fn(async (input: { text: string }) => input.text === 'run '
    ? { text: 'run the tests.', continuations: [' Review the diff.', ' Then commit.'] }
    : refill.promise)
  const controller = new AutocompleteController(request, () => {})
  controller.update(snapshot())
  await vi.advanceTimersByTimeAsync(150)
  expect(controller.suffix).toBe('the tests.')
  controller.accepted('run the tests.')
  expect(controller.suffix).toBe(' Review the diff.')
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[1]?.[0]).toEqual({
    sessionID: 'ses_current',
    situation: 'The tests pass.',
    previousUser: '',
    text: 'run the tests. Review the diff. Then commit.',
    mode: 'typing',
  })
  controller.accepted('run the tests. Review the diff.')
  expect(controller.suffix).toBe(' Then commit.')
  controller.accepted('run the tests. Review the diff. Then commit.')
  controller.update(snapshot('run the tests. Review the diff. Then commit.'))
  expect(request).toHaveBeenCalledTimes(2)
  expect(controller.suffix).toBe('')
  refill.resolve({ text: 'run the tests. Review the diff. Then commit. Push the branch.', continuations: [' Watch CI.'] })
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.suffix).toBe(' Push the branch.')
  controller.dispose()
})

test('editing or dismissing a chain cancels speculative work and ignores late responses', async () => {
  vi.useFakeTimers()
  const refill = Promise.withResolvers<{ text: string }>()
  const calls: AbortSignal[] = []
  const request = vi.fn(async (_input, signal: AbortSignal) => {
    calls.push(signal)
    return calls.length === 1 ? { text: 'run the tests.', continuations: [' Review the diff.'] } : refill.promise
  })
  const controller = new AutocompleteController(request, () => {})
  controller.update(snapshot())
  await vi.advanceTimersByTimeAsync(150)
  controller.accepted('run the tests.')
  controller.update(snapshot('something different'))
  expect(calls[1]?.aborted).toBe(true)
  refill.resolve({ text: 'run the tests. Review the diff. Push changes.' })
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.suffix).toBe('')
  controller.dispose()
})

test('backspacing cancels refill while retaining a compatible cached continuation', async () => {
  vi.useFakeTimers()
  const refill = Promise.withResolvers<{ text: string }>()
  const signals: AbortSignal[] = []
  const request = vi.fn(async (_input, signal: AbortSignal) => {
    signals.push(signal)
    return signals.length === 1 ? { text: 'run the tests.', continuations: [' Review the diff.'] } : refill.promise
  })
  const controller = new AutocompleteController(request, () => {})
  controller.update(snapshot())
  await vi.advanceTimersByTimeAsync(150)
  controller.accepted('run the tests.')
  controller.update(snapshot('run the test'))
  expect(signals[1]?.aborted).toBe(true)
  expect(controller.suffix).toBe('s.')
  refill.resolve({ text: 'run the tests. Review the diff. Push changes.' })
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.suffix).toBe('s.')
  controller.dispose()
})

test('a refill failure notifies the view after the cached chain is consumed', async () => {
  vi.useFakeTimers()
  const refill = Promise.withResolvers<{ text: string }>()
  const changed = vi.fn()
  const request = vi.fn(async (input: { text: string }) => input.text === 'run '
    ? { text: 'run the tests.' } : refill.promise)
  const controller = new AutocompleteController(request, changed)
  controller.update(snapshot())
  await vi.advanceTimersByTimeAsync(150)
  controller.accepted('run the tests.')
  expect(controller.suffix).toBe('')
  const notifications = changed.mock.calls.length
  refill.reject(new Error('Generation unavailable'))
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.error).toBe('Generation unavailable')
  expect(changed.mock.calls.length).toBeGreaterThan(notifications)
  controller.dispose()
})

test('typing is debounced and a fresh request supersedes an old response', async () => {
  vi.useFakeTimers()
  const calls: { signal: AbortSignal; resolve: (output: { text: string }) => void }[] = []
  const request = vi.fn((_input, signal: AbortSignal) => new Promise<{ text: string }>((resolve) => calls.push({ signal, resolve })))
  const controller = new AutocompleteController(request, () => {})
  controller.update(snapshot('r'))
  await vi.advanceTimersByTimeAsync(100)
  controller.update(snapshot('run '))
  await vi.advanceTimersByTimeAsync(149)
  expect(request).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(controller.loading).toBe(true)
  controller.update(snapshot('review '))
  expect(calls[0]?.signal.aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(150)
  calls[0]?.resolve({ text: 'run the tests' })
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.suffix).toBe('')
  calls[1]?.resolve({ text: 'review the diff' })
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.suffix).toBe('the diff')
  expect(controller.loading).toBe(false)
  controller.dispose()
})

test('a matching continuation stays instant; menus, cursor moves and sessions suppress it', async () => {
  vi.useFakeTimers()
  const request = vi.fn(async () => ({ text: 'run the tests' }))
  const controller = new AutocompleteController(request, () => {})
  controller.update(snapshot())
  await vi.advanceTimersByTimeAsync(150)
  expect(controller.suffix).toBe('the tests')
  controller.update(snapshot('run the '))
  expect(controller.suffix).toBe('tests')
  await vi.advanceTimersByTimeAsync(150)
  expect(request).toHaveBeenCalledTimes(1)
  controller.update(snapshot('run the ', { eligible: false }))
  expect(controller.suffix).toBe('')
  controller.update(snapshot('run the '))
  expect(controller.suffix).toBe('tests')
  controller.dismiss()
  controller.update(snapshot('run the '))
  expect(controller.suffix).toBe('')
  controller.update(snapshot('run ', { scope: 'different:reply' }))
  expect(controller.suffix).toBe('')
  controller.dispose()
})

test('turn-end suggestions cancel as soon as typing starts and no-suggestion is cached', async () => {
  vi.useFakeTimers()
  const request = vi.fn(async (input: { text: string }) => ({ text: input.text ? '' : 'run the tests' }))
  const controller = new AutocompleteController(request, () => {})
  controller.update(snapshot('', { mode: 'next' }))
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.suffix).toBe('run the tests')
  controller.update(snapshot('r'))
  expect(controller.suffix).toBe('')
  await vi.advanceTimersByTimeAsync(150)
  controller.update(snapshot('r', { eligible: false }))
  controller.update(snapshot('r'))
  await vi.advanceTimersByTimeAsync(150)
  expect(request).toHaveBeenCalledTimes(2)
  controller.dispose()
})

test('explicit word acceptance preserves the rest of a next-action suggestion', async () => {
  vi.useFakeTimers()
  const request = vi.fn(async () => ({ text: 'review and commit the changes' }))
  const controller = new AutocompleteController(request, () => {})
  controller.update(snapshot('', { mode: 'next' }))
  await vi.advanceTimersByTimeAsync(0)
  controller.accepted('review')
  controller.update(snapshot('review'))
  expect(controller.suffix).toBe(' and commit the changes')
  controller.accepted('review and')
  controller.update(snapshot('review and'))
  expect(controller.suffix).toBe(' commit the changes')
  await vi.advanceTimersByTimeAsync(200)
  expect(request).toHaveBeenCalledTimes(1)
  controller.dispose()
})

test('streaming reply revisions invalidate requests, candidates and cached misses', async () => {
  vi.useFakeTimers()
  const request = vi.fn(async (input: { situation: string }) => ({ text: input.situation === 'final' ? 'run the tests' : '' }))
  const controller = new AutocompleteController(request, () => {})
  controller.update(snapshot())
  await vi.advanceTimersByTimeAsync(150)
  expect(controller.suffix).toBe('')
  controller.update(snapshot('run ', { situation: 'final' }))
  await vi.advanceTimersByTimeAsync(150)
  expect(controller.suffix).toBe('the tests')
  controller.update(snapshot('run ', { situation: 'new context' }))
  expect(controller.suffix).toBe('')
  await vi.advanceTimersByTimeAsync(150)
  expect(request).toHaveBeenCalledTimes(3)
  controller.dispose()
})

test('typing includes the original preceding question and does not reuse another question\'s candidate', async () => {
  vi.useFakeTimers()
  expect(submittedText({ 'opencode-snippets:submitted': { text: '#pr explain this' } }, 'Expanded skill')).toBe('#pr explain this')
  const request = vi.fn(async () => ({ text: 'and why does it need that section?' }))
  const controller = new AutocompleteController(request, () => {})
  const state = snapshot('and why ', { previousUser: 'what does pr do?' })
  expect(suggestionPrompt(state, [])).toContain('what does pr do?')
  expect(suggestionPrompt(state, [])).toContain('finish a coherent question')
  controller.update(state)
  await vi.advanceTimersByTimeAsync(150)
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ previousUser: 'what does pr do?' }), expect.any(AbortSignal))
  expect(controller.suffix).toBe('does it need that section?')
  controller.update({ ...state, previousUser: 'what does retro do?' })
  expect(controller.suffix).toBe('')
  await vi.advanceTimersByTimeAsync(150)
  expect(request).toHaveBeenCalledTimes(2)
  controller.dispose()
})

test('native history finds original human prompts through synthetic turns and federates safely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recall-autocomplete-'))
  const path = join(root, 'history.db')
  const source = new Database(path)
  source.exec(`
    create table session_v2(id text primary key, parent_id text, title text, directory text, time_updated integer);
    create table session_message(id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);
    create index session_message_seq on session_message(session_id, seq);
    insert into session_v2 values ('ses_past', NULL, 'Past', '/project', 1),
      ('ses_auto', NULL, 'Automation', '/automation', 1), ('ses_current', NULL, 'Current', '/project', 1),
      ('ses_child', 'ses_past', 'Child', '/project', 1),
      ('ses_job', NULL, 'Scheduled job', '/projects/shepherd/topic-agent', 1);
    insert into session_message values
      ('msg_reply', 'ses_past', 'assistant', 1, 1, 1, '{"content":[{"type":"text","text":"Tests pass"}]}'),
      ('msg_idle', 'ses_past', 'idle', 2, 1, 1, '{}'),
      ('msg_user', 'ses_past', 'user', 3, 2, 2, '{"agents":[],"text":"Expanded review","metadata":{"opencode-snippets:submitted":{"text":"#review then commit"}}}'),
      ('msg_auto_reply', 'ses_auto', 'assistant', 1, 1, 1, '{"content":[{"type":"text","text":"Tests pass"}]}'),
      ('msg_auto_user', 'ses_auto', 'user', 2, 2, 2, '{"text":"automated message"}'),
      ('msg_current_reply', 'ses_current', 'assistant', 1, 1, 1, '{"content":[{"type":"text","text":"Tests pass"}]}'),
      ('msg_current_user', 'ses_current', 'user', 2, 2, 2, '{"agents":[],"text":"exclude current"}'),
      ('msg_child_reply', 'ses_child', 'assistant', 1, 1, 1, '{"content":[{"type":"text","text":"Tests pass"}]}'),
      ('msg_child_user', 'ses_child', 'user', 2, 2, 2, '{"agents":[],"text":"exclude child"}'),
      ('msg_job_reply', 'ses_job', 'assistant', 1, 1, 1, '{"content":[{"type":"text","text":"Tests pass"}]}'),
      ('msg_job_user', 'ses_job', 'user', 2, 2, 2, '{"agents":[],"text":"exclude scheduled job"}');
  `)
  const db = new HistoryDatabase(path)
  const history = new HistorySources({ sources: [{ id: 'fixture', path, indexPath: join(root, 'index.db') }] })
  const provider = { model: 'fixture', embed: async (texts: readonly string[]) => texts.map(() => new Float32Array([1, 0])) }
  try {
    expect(db.nextPrompt('msg_reply')).toBe('#review then commit')
    expect(db.nextPrompt('msg_auto_reply')).toBeUndefined()
    await history.sync(provider)
    const ordinary = await history.search('Tests pass', { limit: 40, excludeSubagents: true }, { semantic: true, lexical: false, sync: false }, provider)
    expect(ordinary.rows.some(row => row.sessionId === 'ses_job')).toBe(true)
    await expect(history.promptExamples('Tests pass', 'fixture::ses_current', {
      model: provider.model, embed: async () => { throw new Error('Ollama unavailable') },
    })).rejects.toThrow(/lexical/i)
    expect(await history.promptExamples('Tests pass', 'fixture::ses_current', provider)).toEqual([
      { situation: 'Tests pass', prompt: '#review then commit', directory: '/project' },
    ])
  } finally { history.close(); db.close(); source.close(); rmSync(root, { recursive: true, force: true }) }
})

test('legacy history excludes synthetic parts and automation prompts', () => {
  const root = mkdtempSync(join(tmpdir(), 'recall-autocomplete-legacy-'))
  const path = join(root, 'history.db')
  const source = new Database(path)
  source.exec(`
    create table session(id text primary key, title text, directory text, time_updated integer);
    create table message(id text primary key, session_id text, data text, time_created integer, time_updated integer);
    create table part(id text primary key, message_id text, session_id text, data text, time_updated integer);
    insert into session values ('ses_past', 'Past', '/project', 1);
    insert into message values ('msg_reply', 'ses_past', '{"role":"assistant"}', 1, 1), ('msg_user', 'ses_past', '{"role":"user"}', 2, 2);
    insert into part values ('part_wrapper', 'msg_user', 'ses_past', '{"type":"text","text":"wrapper","synthetic":true}', 2),
      ('part_user', 'msg_user', 'ses_past', '{"type":"text","text":"commit and push"}', 2);
  `)
  const history = new HistoryDatabase(path)
  try {
    expect(history.nextPrompt('msg_reply')).toBe('commit and push')
    source.exec(`update part set data = '{"type":"text","text":"Reply exactly OK"}' where id = 'part_user'`)
    expect(history.nextPrompt('msg_reply')).toBeUndefined()
  } finally { history.close(); source.close(); rmSync(root, { recursive: true, force: true }) }
})
