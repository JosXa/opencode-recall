import { afterEach, expect, test, vi } from 'vitest'
import { AutocompleteController, type PromptSnapshot } from '../src/autocomplete-controller.js'
import { normalizeSuggestions } from '../src/autocomplete.js'

const snapshot = (text: string, mode: 'typing' | 'next' = 'typing'): PromptSnapshot => ({
  scope: 'session:reply', sessionID: 'ses_current', situation: 'Tests pass.',
  text, mode, eligible: true,
})
afterEach(() => vi.useRealTimers())

test('all prepared sentences are visible while each acceptance inserts only one', async () => {
  vi.useFakeTimers()
  const continuation = ' the changes for bugs. Check cancellation. Explain any issues.'
  const controller = new AutocompleteController(async input => input.text === 'Review'
    ? normalizeSuggestions(JSON.stringify({ continuation }), input)
    : new Promise<never>(() => {}), () => {})
  controller.update(snapshot('Review'))
  await vi.advanceTimersByTimeAsync(150)
  let text = 'Review'
  let remaining = continuation
  for (const sentence of [' the changes for bugs.', ' Check cancellation.', ' Explain any issues.']) {
    expect(controller.preview).toBe(remaining)
    expect(controller.sentence).toBe(sentence)
    text += controller.sentence
    controller.accepted(text)
    controller.update(snapshot(text))
    remaining = remaining.slice(sentence.length)
  }
  expect(controller.preview).toBe('')
  expect(controller.sentence).toBe('')
  expect(text).toBe('Review' + continuation)
  controller.dispose()
})

test('a long next-action sentence accepts across the old eight-word and sixteen-word chunks', async () => {
  vi.useFakeTimers()
  const first = 'Review the implementation for cancellation bugs and stale results while preserving the existing typing behavior and native menus.'
  const continuation = first + ' Add a regression test.'
  const controller = new AutocompleteController(async input => input.mode === 'next'
    ? normalizeSuggestions(JSON.stringify({ continuation }), input)
    : new Promise<never>(() => {}), () => {})
  controller.update(snapshot('', 'next'))
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.preview).toBe(continuation)
  expect(controller.sentence).toBe(first)
  controller.accepted(first)
  expect(controller.preview).toBe(' Add a regression test.')
  expect(controller.sentence).toBe(' Add a regression test.')
  controller.update({ ...snapshot(first), eligible: false })
  expect(controller.preview).toBe('')
  expect(controller.sentence).toBe('')
  controller.dispose()
})

test('word acceptance and trailing spaces retain the complete remaining preview', async () => {
  vi.useFakeTimers()
  const controller = new AutocompleteController(async input => input.text === 'Please review'
    ? { text: 'Please review the changes.', continuations: [' Check the tests.'] }
    : new Promise<never>(() => {}), () => {})
  controller.update(snapshot('Please review'))
  await vi.advanceTimersByTimeAsync(150)
  controller.update(snapshot('Please review  '))
  expect(controller.preview).toBe('the changes. Check the tests.')
  controller.accepted('Please review  the')
  expect(controller.preview).toBe(' changes. Check the tests.')
  expect(controller.sentence).toBe(' changes.')
  controller.dismiss()
  expect(controller.preview).toBe('')
  controller.dispose()
})

test('URL punctuation stays intact during sentence acceptance', async () => {
  vi.useFakeTimers()
  const first = ' open https://example.com/?page=2 and report the results.'
  const continuation = first + ' Check the redirects.'
  const controller = new AutocompleteController(async input => input.text === 'Please'
    ? normalizeSuggestions(JSON.stringify({ continuation }), input)
    : new Promise<never>(() => {}), () => {})
  controller.update(snapshot('Please'))
  await vi.advanceTimersByTimeAsync(150)
  expect(controller.preview).toBe(continuation)
  expect(controller.sentence).toBe(first)
  controller.dispose()
})
