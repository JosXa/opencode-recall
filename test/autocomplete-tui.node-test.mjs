import assert from 'node:assert/strict'
import { test } from 'node:test'
import plugin from '../dist/tui.js'

const UNAVAILABLE = { type: 'rpc.unavailable', message: 'RPC is unavailable: josxa.recall.autocomplete' }
const settle = () => new Promise((resolve) => setImmediate(resolve))

async function advance(t, retries) {
  for (let retry = 0; retry < retries; retry++) {
    await settle()
    t.mock.timers.tick(2_000)
  }
  await settle()
}

test('built CLI stays silent when the server never registers Recall autocomplete', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0
  const result = plugin.setup({
    options: {},
    client: {
      rpc: () => ({
        prepare: async () => {
          attempts++
          throw UNAVAILABLE
        },
      }),
    },
    ui: {
      toast: { show: () => assert.fail('A server without Recall autocomplete must not produce a toast') },
      slot: () => assert.fail('A server without Recall autocomplete must not install the prompt slot'),
    },
  })
  await advance(t, 45)
  assert.equal(typeof result, 'function')
  assert.equal(attempts, 30)
  result()
})

for (const options of [{}, { autocomplete: true }, { autocomplete: false }]) {
  test(`built CLI stays silent when the server disables autocomplete (TUI options ${JSON.stringify(options)})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let attempts = 0
    const result = plugin.setup({
      options,
      client: {
        rpc: () => ({
          prepare: async () => {
            attempts++
            return { enabled: false }
          },
        }),
      },
      ui: {
        toast: { show: () => assert.fail('Disabled autocomplete must not produce a toast') },
        slot: () => assert.fail('Disabled autocomplete must not install the prompt slot'),
      },
    })
    await advance(t, 45)
    assert.equal(attempts, 1)
    result()
  })
}

test('built CLI installs autocomplete once a restarting server registers the RPC', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0
  const slots = []
  const result = plugin.setup({
    options: {},
    client: {
      rpc: () => ({
        prepare: async () => {
          attempts++
          if (attempts < 4) throw UNAVAILABLE
          return { enabled: true }
        },
      }),
    },
    ui: {
      toast: { show: () => assert.fail('A server that finishes starting must not report an error') },
      slot: (value) => { slots.push(value.append); return () => {} },
    },
  })
  await advance(t, 3)
  assert.equal(attempts, 4)
  assert.deepEqual(slots, ['prompt.footer'])
  result()
})

test('built CLI reports other preparation failures without retrying', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const toasts = []
  let attempts = 0
  const result = plugin.setup({
    options: {},
    client: {
      rpc: () => ({
        prepare: async () => {
          attempts++
          throw { type: 'rpc.defect', message: 'Autocomplete model is not configured.' }
        },
      }),
    },
    ui: { toast: { show: (value) => toasts.push(value) }, slot: () => assert.fail('Failed preparation must not install autocomplete') },
  })
  await advance(t, 3)
  assert.equal(attempts, 1)
  assert.deepEqual(toasts.map((toast) => toast.message), ['Autocomplete model is not configured.'])
  result()
})

test('disposing the built CLI while it waits for a restarting server stops the retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0
  const dispose = plugin.setup({
    options: {},
    client: {
      rpc: () => ({
        prepare: async () => {
          attempts++
          throw UNAVAILABLE
        },
      }),
    },
    ui: {
      toast: { show: () => assert.fail('Disposed plugins must not show toasts') },
      slot: () => assert.fail('Disposed plugins must not register slots'),
    },
  })
  await advance(t, 2)
  dispose()
  await advance(t, 40)
  assert.equal(attempts, 3)
})

test('built CLI waits for server preparation before installing its owned autocomplete slot', async () => {
  const preparation = Promise.withResolvers()
  const slots = []
  const cleanup = () => {}
  const result = plugin.setup({
    options: {},
    client: { rpc: () => ({ prepare: () => preparation.promise }) },
    ui: {
      toast: { show: () => assert.fail('Successful preparation must not report an error') },
      slot: (value) => { slots.push(value.append); return cleanup },
    },
  })
  assert.deepEqual(slots, [])
  preparation.resolve({ enabled: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(slots, ['prompt.footer'])
  assert.equal(typeof result, 'function')
  result()
})

test('disposing the built CLI while preparation is pending prevents late installation or toasts', async () => {
  for (const fail of [false, true]) {
    const preparation = Promise.withResolvers()
    const dispose = plugin.setup({
      options: {},
      client: { rpc: () => ({ prepare: () => preparation.promise }) },
      ui: {
        toast: { show: () => assert.fail('Disposed plugins must not show toasts') },
        slot: () => assert.fail('Disposed plugins must not register slots'),
      },
    })
    dispose()
    if (fail) preparation.reject({ type: 'rpc.unavailable', message: 'Server unavailable' })
    else preparation.resolve({ enabled: true })
    await new Promise((resolve) => setImmediate(resolve))
  }
})
