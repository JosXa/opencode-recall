import type { Plugin } from '@opencode/plugin'
import { afterEach, expect, test, vi } from 'vitest'
import { registerAutocomplete } from '../src/autocomplete.js'
import type { SuggestInput, SuggestOutput } from '../src/autocomplete-rpc.js'
import { executeNodeWorker } from '../src/node-worker-client.js'

const examples = [{ prompt: '#review then commit' }]
vi.mock('../src/node-worker-client.js', () => ({ executeNodeWorker: vi.fn() }))
afterEach(() => vi.mocked(executeNodeWorker).mockReset())

type Handler = (input: SuggestInput, call: { signal: AbortSignal }) => Promise<SuggestOutput>
async function harness() {
  vi.mocked(executeNodeWorker).mockResolvedValue(JSON.stringify(examples))
  let handlers: { suggest: Handler; refine: Handler; prepare: () => Promise<unknown> } | undefined
  const generate = vi.fn(async (_request: { prompt: string }) => ({ text: '{"continuation":"the tests"}' }))
  const next = vi.fn(async () => ({ text: '{"continuation":"review and commit the changes"}' }))
  const dispose = vi.fn()
  const context = {
    options: {}, generate: { text: generate }, session: { generate: next },
    rpc: { register: async (_definition: unknown, value: NonNullable<typeof handlers>) => {
      handlers = value
      return { dispose }
    } },
  } as unknown as Plugin.Context
  const stop = await registerAutocomplete(context, '/fixture')
  if (!handlers) throw new Error('RPC was not registered')
  return { ...handlers, generate, next, dispose, stop }
}
const input: SuggestInput = { sessionID: 'ses_current', situation: 'Tests pass', text: 'run ', mode: 'typing' }
const call = () => ({ signal: new AbortController().signal })

test('the first Luna completion finishes while history is still pending', async () => {
  const h = await harness()
  const worker = Promise.withResolvers<string>()
  vi.mocked(executeNodeWorker).mockReturnValue(worker.promise)
  try {
    const refined = h.refine(input, call())
    expect(await h.suggest(input, call())).toEqual({ text: 'run the tests' })
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(h.generate.mock.calls[0]?.[0].prompt).not.toContain('#review then commit')
    expect(executeNodeWorker).toHaveBeenCalledWith('/fixture', {
      kind: 'prompt-examples', args: { prefix: 'run' }, context: { sessionID: 'ses_current' },
    }, expect.any(AbortSignal))
    worker.resolve(JSON.stringify(examples))
    expect(await refined).toEqual({ text: 'run the tests' })
    expect(h.generate.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      model: { providerID: 'openai', id: 'gpt-6-luna-fast' }, prompt: expect.stringContaining('#review then commit'),
    }))
  } finally { await h.stop() }
})

test('cached prefix examples inform the fast call without a second paid generation', async () => {
  const h = await harness()
  try {
    await h.refine(input, call())
    await h.suggest({ ...input, text: 'run    ' }, call())
    expect(await h.refine({ ...input, text: 'run    ' }, call())).toEqual({ text: '' })
    expect(executeNodeWorker).toHaveBeenCalledTimes(1)
    expect(h.generate).toHaveBeenCalledTimes(2)
    expect(h.generate.mock.calls[1]?.[0].prompt).toContain('#review then commit')
    await h.suggest({ ...input, text: 'run the ' }, call())
    expect(h.generate.mock.calls[2]?.[0].prompt).toContain('#review then commit')
    await h.refine({ ...input, text: 'run the ' }, call())
    expect(executeNodeWorker).toHaveBeenCalledTimes(2)
    const long = { ...input, text: 'x'.repeat(256) + 'first' }
    await h.refine(long, call())
    await h.refine({ ...long, text: 'x'.repeat(256) + 'second' }, call())
    expect(executeNodeWorker).toHaveBeenCalledTimes(3)
  } finally { await h.stop() }
})

test('turn-end uses the session model and empty drafts never retrieve style', async () => {
  const h = await harness()
  try {
    expect(await h.suggest({ ...input, text: '', mode: 'next' }, call())).toEqual({ text: 'review and commit the changes' })
    expect(await h.refine({ ...input, text: '', mode: 'next' }, call())).toEqual({ text: '' })
    expect(await h.refine({ ...input, text: '   ' }, call())).toEqual({ text: '' })
    expect(h.next).toHaveBeenCalledOnce()
    expect(h.generate).not.toHaveBeenCalled()
    expect(executeNodeWorker).not.toHaveBeenCalled()
  } finally { await h.stop() }
})

test('an aborted refinement does not start paid generation after retrieval', async () => {
  const h = await harness()
  const controller = new AbortController()
  controller.abort()
  try {
    await expect(h.refine(input, { signal: controller.signal })).rejects.toThrow()
    await expect(h.suggest(input, { signal: controller.signal })).rejects.toThrow()
    expect(h.generate).not.toHaveBeenCalled()
  } finally { await h.stop() }
})

test('empty or failed retrieval keeps the fast completion and skips styled generation', async () => {
  const h = await harness()
  try {
    vi.mocked(executeNodeWorker).mockRejectedValueOnce(new Error('history offline'))
    expect(await h.refine(input, call())).toEqual({ text: '', notice: 'Recall history: history offline' })
    expect(await h.suggest(input, call())).toEqual({ text: 'run the tests', notice: 'Recall history: history offline' })
    vi.mocked(executeNodeWorker).mockResolvedValueOnce('[]')
    expect(await h.refine(input, call())).toEqual({ text: '' })
    expect(await h.refine(input, call())).toEqual({ text: '' })
    expect(h.generate).toHaveBeenCalledOnce()
    expect(executeNodeWorker).toHaveBeenCalledTimes(2)
  } finally { await h.stop() }
})

test('superseded drafts cancel retrieval; disposal bounds and cancels remaining workers', async () => {
  const h = await harness()
  const signals: AbortSignal[] = []
  vi.mocked(executeNodeWorker).mockImplementation((_directory, _request, signal) => {
    if (!signal) throw new Error('Worker cancellation signal is required')
    signals.push(signal)
    return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  })
  const controller = new AbortController()
  const superseded = h.refine(input, { signal: controller.signal })
  controller.abort()
  await expect(superseded).rejects.toThrow()
  const results = Promise.allSettled(Array.from({ length: 9 }, (_, index) => h.refine({ ...input, sessionID: `ses_${index}` }, call())))
  expect(signals[1]?.aborted).toBe(true)
  await h.stop()
  expect(signals.every(signal => signal.aborted)).toBe(true)
  expect((await results).every(result => result.status === 'rejected')).toBe(true)
  expect(h.dispose).toHaveBeenCalledOnce()
})

test('warming invalidates early matches so later refinements see updated history', async () => {
  const h = await harness()
  const warm = Promise.withResolvers<string>()
  let queries = 0
  vi.mocked(executeNodeWorker).mockImplementation(async (_directory, request) => {
    if (request.kind === 'prompt-examples' && request.args.sync) return warm.promise
    return ++queries === 1 ? '[]' : JSON.stringify(examples)
  })
  try {
    await h.prepare()
    await h.refine(input, call())
    warm.resolve('[]')
    await new Promise<void>(resolve => setImmediate(resolve))
    await h.refine(input, call())
    expect(queries).toBe(2)
    expect(h.generate.mock.calls[0]?.[0].prompt).toContain('#review then commit')
  } finally { await h.stop() }
})
