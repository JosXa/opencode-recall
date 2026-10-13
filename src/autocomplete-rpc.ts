import { Rpc } from '@opencode/plugin/rpc'

export function autocompleteErrorMessage(error: unknown): string {
  // The native RPC client rejects with serialized objects rather than Error instances.
  if (typeof error === 'object' && error !== null) {
    if ('type' in error && error.type === 'rpc.unavailable')
      return 'Recall autocomplete is not enabled on the connected server. Enable it in that server’s Recall plugin settings and reopen OpenCode.'
    if ('message' in error && typeof error.message === 'string' && error.message.trim())
      return error.message
    return 'Recall autocomplete request failed.'
  }
  return String(error)
}

export interface SuggestInput {
  readonly sessionID: string
  readonly situation: string
  readonly previousUser?: string
  readonly text: string
  readonly mode: 'typing' | 'next'
}

export interface SuggestOutput {
  readonly text: string
  readonly continuations?: readonly string[]
  readonly notice?: string
  readonly refined?: boolean
}

export interface RefineInput extends SuggestInput {
  /** The visible suggestion was carried or cached, so no fresh fast call used these examples. */
  readonly cachedSuggestion?: boolean
}

const input = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionID: { type: 'string' },
    situation: { type: 'string', maxLength: 2000 },
    previousUser: { type: 'string', maxLength: 1000 },
    text: { type: 'string', maxLength: 4000 },
    mode: { type: 'string', enum: ['typing', 'next'] },
  },
  required: ['sessionID', 'situation', 'text', 'mode'],
} as const
const output = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    continuations: { type: 'array', maxItems: 7, items: { type: 'string' } },
    notice: { type: 'string' },
    refined: { type: 'boolean' },
  },
  required: ['text'],
} as const

export const Autocomplete = Rpc.define({
  id: 'josxa.recall.autocomplete',
  events: {},
  methods: {
    prepare: {
      input: { type: 'object', additionalProperties: false },
      output: { type: 'object', additionalProperties: false },
    },
    suggest: { input, output },
    refine: {
      input: {
        ...input,
        properties: { ...input.properties, cachedSuggestion: { type: 'boolean' } },
      },
      output,
    },
  },
})
