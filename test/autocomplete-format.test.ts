import { expect, test } from 'vitest'
import { autocompleteFormat, constrainAutocompleteRequest } from '../src/autocomplete-format.js'

const request = (prompt: string, path = '/responses') => new Request(`https://example.com${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1', 'x-test': 'preserved' },
  body: JSON.stringify({ model: 'gpt-6.1-sol', input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    text: { verbosity: 'low' }, stream: true }),
})

test('only the exact pending autocomplete prompt receives the strict schema', async () => {
  const prompt = 'Recall autocomplete\n"which part of it exactly "'
  const original = request(prompt, '/v1/responses')
  const constrained = await constrainAutocompleteRequest(original, [prompt])
  expect(await constrained.json()).toEqual({
    model: 'gpt-6.1-sol', input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    text: { verbosity: 'low', format: autocompleteFormat }, stream: true,
  })
  expect(constrained.headers.get('x-test')).toBe('preserved')
  expect(constrained.headers.has('content-length')).toBe(false)
  expect((await original.json()).text).toEqual({ verbosity: 'low' })
})

test('unrelated generation, protocols and empty pending sets remain untouched', async () => {
  for (const [prompt, path, pending] of [
    ['Other plugin generation', '/responses', ['Autocomplete']],
    ['Autocomplete', '/messages', ['Autocomplete']],
    ['Autocomplete', '/responses', []],
  ] as const) {
    const original = request(prompt, path)
    expect(await constrainAutocompleteRequest(original, pending)).toBe(original)
    expect((await original.json()).text).toEqual({ verbosity: 'low' })
  }
})
