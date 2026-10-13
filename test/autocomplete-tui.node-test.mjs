import assert from 'node:assert/strict'
import { test } from 'node:test'
import plugin from '../dist/tui.js'

test('built CLI reports an unavailable remote RPC once without installing autocomplete', async () => {
  const toasts = []
  let slots = 0
  const result = plugin.setup({
    options: { autocomplete: true },
    client: {
      rpc: () => ({
        prepare: async () => {
          throw { type: 'rpc.unavailable', message: 'RPC is unavailable: josxa.recall.autocomplete' }
        },
      }),
    },
    ui: { toast: { show: (value) => toasts.push(value) }, slot: () => { slots++; return () => {} } },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(typeof result, 'function')
  assert.equal(slots, 0)
  assert.equal(toasts.length, 1)
  assert.match(toasts[0].message, /not enabled on the connected server/)
  assert.doesNotMatch(toasts[0].message, /\[object Object\]/)
  result()
})

test('built CLI waits for server preparation before installing its owned autocomplete slot', async () => {
  const preparation = Promise.withResolvers()
  const slots = []
  const cleanup = () => {}
  const result = plugin.setup({
    options: { autocomplete: true },
    client: { rpc: () => ({ prepare: () => preparation.promise }) },
    ui: {
      toast: { show: () => assert.fail('Successful preparation must not report an error') },
      slot: (value) => { slots.push(value.append); return cleanup },
    },
  })
  assert.deepEqual(slots, [])
  preparation.resolve({})
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(slots, ['prompt.footer'])
  assert.equal(typeof result, 'function')
  result()
})

test('disposing the built CLI while preparation is pending prevents late installation or toasts', async () => {
  for (const fail of [false, true]) {
    const preparation = Promise.withResolvers()
    const dispose = plugin.setup({
      options: { autocomplete: true },
      client: { rpc: () => ({ prepare: () => preparation.promise }) },
      ui: {
        toast: { show: () => assert.fail('Disposed plugins must not show toasts') },
        slot: () => assert.fail('Disposed plugins must not register slots'),
      },
    })
    dispose()
    if (fail) preparation.reject({ type: 'rpc.unavailable', message: 'Server unavailable' })
    else preparation.resolve({})
    await new Promise((resolve) => setImmediate(resolve))
  }
})
