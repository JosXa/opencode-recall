import type { Plugin } from '@opencode/plugin'
import { afterEach, expect, test, vi } from 'vitest'
import { registerAutocomplete } from '../src/autocomplete.js'
import type { SuggestInput, SuggestOutput } from '../src/autocomplete-rpc.js'
import { executeNodeWorker } from '../src/node-worker-client.js'

vi.mock('../src/node-worker-client.js', () => ({ executeNodeWorker: vi.fn(async () => JSON.stringify([
  { situation: 'Tests pass', prompt: '#review then commit', directory: '/project' },
])) }))
afterEach(() => {
  vi.clearAllMocks()
  vi.mocked(executeNodeWorker).mockReset().mockResolvedValue(JSON.stringify([
    { situation: 'Tests pass', prompt: '#review then commit', directory: '/project' },
  ]))
})

type Handler = (input: SuggestInput, call: { signal: AbortSignal }) => Promise<SuggestOutput>
async function harness() {
  let suggest: Handler | undefined
  let prepare: (() => Promise<unknown>) | undefined
  const generate = vi.fn(async (_request: { prompt: string }) => ({ text: '{"continuation":"the tests"}' }))
  const next = vi.fn(async () => ({ text: '{"continuation":"review and commit the changes"}' }))
  const dispose = vi.fn()
  const context = {
    options: {}, generate: { text: generate }, session: { generate: next },
    rpc: { register: async (_definition: unknown, handlers: { suggest: Handler; prepare: () => Promise<unknown> }) => {
      suggest = handlers.suggest
      prepare = handlers.prepare
      return { dispose }
    } },
  } as unknown as Plugin.Context
  const stop = await registerAutocomplete(context, '/fixture')
  if (!suggest || !prepare) throw new Error('RPC was not registered')
  return { suggest, prepare, generate, next, dispose, stop }
}
const input: SuggestInput = { sessionID: 'ses_current', situation: 'Tests pass', text: 'run ', mode: 'typing' }

test('typing uses Luna and original history examples; examples are cached across drafts', async () => {
  const h = await harness()
  const signal = new AbortController().signal
  try {
    expect(await h.suggest(input, { signal })).toEqual({ text: 'run the tests' })
    await h.suggest({ ...input, text: 'run the ' }, { signal })
    expect(executeNodeWorker).toHaveBeenCalledTimes(1)
    expect(h.generate).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: 'openai', id: 'gpt-6-luna-fast' }, prompt: expect.stringContaining('#review then commit'),
    }), { signal: expect.any(AbortSignal) })
    expect(h.next).not.toHaveBeenCalled()
  } finally { await h.stop() }
  expect(h.dispose).toHaveBeenCalledOnce()
})

test('turn-end uses the session model with transient generation', async () => {
  const h = await harness()
  try {
    expect(await h.suggest({ ...input, text: '', mode: 'next' }, { signal: new AbortController().signal }))
      .toEqual({ text: 'review and commit the changes' })
    expect(h.next).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'ses_current' }), expect.anything())
    expect(h.generate).not.toHaveBeenCalled()
  } finally { await h.stop() }
})

test('an aborted draft does not start paid generation after retrieval completes', async () => {
  const h = await harness()
  const controller = new AbortController()
  controller.abort()
  try {
    await expect(h.suggest(input, { signal: controller.signal })).rejects.toThrow()
    expect(h.generate).not.toHaveBeenCalled()
  } finally { await h.stop() }
})

test('history failure is visible while Luna can still complete the draft', async () => {
  vi.mocked(executeNodeWorker).mockRejectedValueOnce(new Error('history offline'))
  const h = await harness()
  try {
    expect(await h.suggest(input, { signal: new AbortController().signal })).toEqual({
      text: 'run the tests', notice: 'Recall history: history offline',
    })
    expect(await h.suggest(input, { signal: new AbortController().signal })).toEqual({ text: 'run the tests' })
    expect(executeNodeWorker).toHaveBeenCalledTimes(2)
  } finally { await h.stop() }
})

test('RPC cancellation stops superseded home-screen retrieval workers', async () => {
  const calls: { signal: AbortSignal; result: ReturnType<typeof Promise.withResolvers<string>> }[] = []
  vi.mocked(executeNodeWorker).mockImplementation((_directory, _request, signal) => {
    if (!signal) throw new Error('Worker cancellation signal is required')
    const result = Promise.withResolvers<string>()
    signal.addEventListener('abort', () => result.reject(new Error('aborted')), { once: true })
    calls.push({ signal, result })
    return result.promise
  })
  const h = await harness()
  const controller = new AbortController()
  const first = h.suggest({ ...input, situation: '' }, { signal: controller.signal })
  controller.abort()
  await expect(first).rejects.toThrow()
  expect(calls[0]?.signal.aborted).toBe(true)
  const second = h.suggest({ ...input, situation: '', text: 'run the ' }, { signal: new AbortController().signal })
  calls[1]?.result.resolve('[]')
  await second
  await h.stop()
})

test('concurrent retrieval is bounded and all remaining workers stop on disposal', async () => {
  const signals: AbortSignal[] = []
  vi.mocked(executeNodeWorker).mockImplementation((_directory, _request, signal) => {
    if (!signal) throw new Error('Worker cancellation signal is required')
    signals.push(signal)
    return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
  })
  const h = await harness()
  const results = Promise.allSettled(Array.from({ length: 9 }, (_, index) =>
    h.suggest({ ...input, sessionID: `ses_${index}` }, { signal: new AbortController().signal })))
  expect(signals[0]?.aborted).toBe(true)
  await h.stop()
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  expect((await results).every((result) => result.status === 'rejected')).toBe(true)
})

test('history becomes available after warming instead of caching early empty results', async () => {
  const warm = Promise.withResolvers<string>()
  let queries = 0
  vi.mocked(executeNodeWorker).mockImplementation(async (_directory, request) => {
    if (request.kind === 'prompt-examples' && request.args.sync) return warm.promise
    return ++queries === 1 ? '[]' : JSON.stringify([{ situation: 'Tests pass', prompt: '#review then commit', directory: '/project' }])
  })
  const h = await harness()
  try {
    await h.prepare()
    await h.suggest(input, { signal: new AbortController().signal })
    expect(h.generate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ prompt: expect.not.stringContaining('#review') }))
    warm.resolve('[]')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await h.suggest({ ...input, text: 'run the ' }, { signal: new AbortController().signal })
    expect(queries).toBe(2)
    expect(h.generate).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: expect.stringContaining('#review') }), expect.anything())
  } finally { await h.stop() }
})
