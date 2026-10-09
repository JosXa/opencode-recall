import { Rpc } from '@opencode/plugin/rpc'

export interface SuggestInput {
  readonly sessionID: string
  readonly situation: string
  readonly previousUser?: string
  readonly text: string
  readonly mode: 'typing' | 'next'
}

export interface SuggestOutput {
  readonly text: string
  readonly notice?: string
}

export const Autocomplete = Rpc.define({
  id: 'josxa.recall.autocomplete',
  events: {},
  methods: {
    prepare: {
      input: { type: 'object', additionalProperties: false },
      output: { type: 'object', additionalProperties: false },
    },
    suggest: {
      input: {
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
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' }, notice: { type: 'string' } },
        required: ['text'],
      },
    },
  },
})
