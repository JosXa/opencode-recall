import { afterEach, expect, test, vi } from 'vitest'
import { AutocompleteController, type PromptSnapshot } from '../src/autocomplete-controller.js'
import type { SuggestInput, SuggestOutput } from '../src/autocomplete-rpc.js'
import { promptPrefix } from '../src/prompt-example.js'

afterEach(() => vi.useRealTimers())
const state = (text = 'Review'): PromptSnapshot => ({
  scope: 'reply', sessionID: 'session', situation: 'Ready', text, mode: 'typing', eligible: true,
})
const output = (text: string): SuggestOutput => ({ text, continuations: [' Next.', ' More.', ' Last.'] })
function harness() {
  vi.useFakeTimers()
  const fast = Promise.withResolvers<SuggestOutput>()
  const styled = Promise.withResolvers<SuggestOutput>()
  const request = vi.fn((_input: SuggestInput, _signal: AbortSignal) => fast.promise)
  const refine = vi.fn((_input: SuggestInput, _signal: AbortSignal) => styled.promise)
  const controller = new AutocompleteController(request, vi.fn(), 150, refine)
  return { fast, styled, request, refine, controller }
}

test('prefix keys normalize whitespace and stop at the same 256 characters as the embedding', () => {
  expect(promptPrefix('  Please\n review   ')).toBe('Please review')
  expect(promptPrefix('x'.repeat(256) + ' rest')).toBe('x'.repeat(256))
  expect(promptPrefix(' \n ')).toBe('')
})

test('fast results remain usable while style is pending and are refined when it arrives', async () => {
  const h = harness()
  h.controller.update(state())
  await vi.advanceTimersByTimeAsync(149)
  expect(h.request).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(h.request).toHaveBeenCalledOnce()
  expect(h.refine).toHaveBeenCalledOnce()
  h.fast.resolve(output('Review the changes.'))
  await vi.advanceTimersByTimeAsync(0)
  expect(h.controller.suffix).toBe(' the changes.')
  expect(h.controller.generating).toBe(true)
  expect(h.request).toHaveBeenCalledOnce()
  h.styled.resolve(output('Review for bugs please.'))
  await vi.advanceTimersByTimeAsync(0)
  expect(h.controller.suffix).toBe(' for bugs please.')
  expect(h.controller.generating).toBe(false)
  h.controller.dispose()
})

test('a refinement that finishes first cancels the fast call and cannot be overwritten', async () => {
  const h = harness()
  h.controller.update(state())
  await vi.advanceTimersByTimeAsync(150)
  h.styled.resolve(output('Review for bugs please.'))
  await vi.advanceTimersByTimeAsync(0)
  expect(h.request.mock.calls[0]?.[1].aborted).toBe(true)
  h.fast.resolve(output('Review the changes.'))
  await vi.advanceTimersByTimeAsync(0)
  expect(h.controller.suffix).toBe(' for bugs please.')
  h.controller.dispose()
})

test('acceptance cancels style refinement before it can replace the accepted message', async () => {
  const h = harness()
  h.controller.update(state())
  await vi.advanceTimersByTimeAsync(150)
  h.fast.resolve(output('Review the changes.'))
  await vi.advanceTimersByTimeAsync(0)
  h.controller.accepted('Review the changes.')
  expect(h.refine.mock.calls[0]?.[1].aborted).toBe(true)
  h.styled.resolve(output('Review for bugs please.'))
  await vi.advanceTimersByTimeAsync(0)
  expect(h.controller.suffix).toBe(' Next.')
  h.controller.dispose()
})

test('trailing-space edits preserve both calls and rebase style including last-space deletion', async () => {
  const h = harness()
  h.controller.update(state('Review '))
  await vi.advanceTimersByTimeAsync(150)
  h.fast.resolve(output('Review the changes.'))
  await vi.advanceTimersByTimeAsync(0)
  h.controller.update(state('Review   '))
  expect(h.controller.suffix).toBe('the changes.')
  h.controller.update(state('Review'))
  expect(h.controller.suffix).toBe(' the changes.')
  expect(h.refine.mock.calls[0]?.[1].aborted).toBe(false)
  h.styled.resolve(output('Review for bugs please.'))
  await vi.advanceTimersByTimeAsync(0)
  expect(h.controller.suffix).toBe(' for bugs please.')
  expect(h.request).toHaveBeenCalledOnce()
  expect(h.refine).toHaveBeenCalledOnce()
  h.controller.dispose()
})

test.each(['edit', 'dismiss', 'dispose', 'ineligible', 'context'])('%s cancels both calls and rejects stale refinement', async action => {
  const h = harness()
  h.controller.update(state())
  await vi.advanceTimersByTimeAsync(150)
  if (action === 'edit') h.controller.update(state('Check'))
  if (action === 'dismiss') h.controller.dismiss()
  if (action === 'dispose') h.controller.dispose()
  if (action === 'ineligible') h.controller.update({ ...state(), eligible: false })
  if (action === 'context') h.controller.update({ ...state(), situation: 'Another reply' })
  expect(h.request.mock.calls[0]?.[1].aborted).toBe(true)
  expect(h.refine.mock.calls[0]?.[1].aborted).toBe(true)
  h.styled.resolve(output('Review for bugs please.'))
  h.fast.resolve(output('Review the changes.'))
  await vi.advanceTimersByTimeAsync(0)
  expect(h.controller.suffix).toBe('')
  h.controller.dispose()
})

test.each(['empty', 'failure'])('%s refinement preserves the fast suggestion', async kind => {
  const h = harness()
  h.controller.update(state())
  await vi.advanceTimersByTimeAsync(150)
  h.fast.resolve(output('Review the changes.'))
  await vi.advanceTimersByTimeAsync(0)
  if (kind === 'empty') h.styled.resolve({ text: '' })
  if (kind === 'failure') h.styled.reject(new Error('Style unavailable'))
  await vi.advanceTimersByTimeAsync(0)
  expect(h.controller.suffix).toBe(' the changes.')
  expect(h.controller.generating).toBe(false)
  h.controller.dispose()
})
