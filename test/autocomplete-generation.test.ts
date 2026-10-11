import { Context, Effect } from 'effect'
import { expect, test, vi } from 'vitest'
import { autocompleteGeneration } from '../src/autocomplete-generation.js'

test.each(['text', 'session'] as const)('%s generation interrupts the native model operation', async kind => {
  const interrupted = vi.fn()
  const started = vi.fn()
  const operation = () => Effect.suspend(() => {
    started()
    return Effect.never
  }).pipe(Effect.onInterrupt(() => Effect.sync(interrupted)))
  const native = { text: vi.fn((_input: unknown) => operation()), session: vi.fn((_input: unknown) => operation()) }
  const generation = autocompleteGeneration(native, Context.makeUnsafe<unknown>(new Map<string, never>()))
  const controller = new AbortController()
  const pending = kind === 'text'
    ? generation.text({ prompt: 'Review', model: { providerID: 'openai', id: 'gpt-6-luna-fast', variant: 'style' } }, { signal: controller.signal })
    : generation.session({ sessionID: 'ses_cancellation', prompt: 'Review' }, { signal: controller.signal })
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(started).toHaveBeenCalledOnce())
  controller.abort()
  await rejected
  expect(interrupted).toHaveBeenCalledOnce()
  expect(native[kind].mock.calls[0]?.[0]).toMatchObject(kind === 'text'
    ? { prompt: 'Review', model: { providerID: 'openai', id: 'gpt-6-luna-fast', variant: 'style' } }
    : { prompt: 'Review', sessionID: 'ses_cancellation' })
})

test.each(['text', 'session'] as const)('already canceled %s generation never starts a native call', async kind => {
  const started = vi.fn()
  const operation = () => Effect.suspend(() => { started(); return Effect.never })
  const native = { text: operation, session: operation }
  const generation = autocompleteGeneration(native, Context.makeUnsafe<unknown>(new Map<string, never>()))
  const controller = new AbortController()
  controller.abort()
  const pending = kind === 'text'
    ? generation.text({ prompt: 'Review' }, { signal: controller.signal })
    : generation.session({ sessionID: 'ses_cancellation', prompt: 'Review' }, { signal: controller.signal })
  await expect(pending).rejects.toThrow()
  expect(started).not.toHaveBeenCalled()
})

test.each(['text', 'session'] as const)('%s generation returns successful native output unchanged', async kind => {
  const output = { text: '{"continuation":" the changes."}' }
  const native = { text: vi.fn((_input: unknown) => Effect.succeed(output)), session: vi.fn((_input: unknown) => Effect.succeed(output)) }
  const generation = autocompleteGeneration(native, Context.makeUnsafe<unknown>(new Map<string, never>()))
  const result = kind === 'text'
    ? await generation.text({ prompt: 'Review', model: null })
    : await generation.session({ sessionID: 'ses_cancellation', prompt: 'Review' })
  expect(result).toBe(output)
  expect(native[kind].mock.calls[0]?.[0]).toMatchObject(kind === 'text'
    ? { prompt: 'Review', model: undefined }
    : { prompt: 'Review', sessionID: 'ses_cancellation' })
})
