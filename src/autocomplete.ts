import type { Plugin } from '@opencode/plugin'
import { Autocomplete, type SuggestInput, type SuggestOutput } from './autocomplete-rpc.js'
import { executeNodeWorker } from './node-worker-client.js'
import type { PromptExample } from './prompt-example.js'

const words = /\s+/u
const lineBreak = /[\r\n]/u

function validChunk(chunk: unknown): chunk is string {
  return (
    typeof chunk === 'string' &&
    !!chunk.trim() &&
    !lineBreak.test(chunk) &&
    chunk.trim().toUpperCase() !== 'NONE'
  )
}

export function suggestionPrompt(input: SuggestInput, examples: readonly PromptExample[]): string {
  return [
    input.mode === 'typing'
      ? 'You provide inline autocomplete for a HUMAN writing a message to their assistant. Complete the human utterance; never answer it.'
      : 'Predict what the USER will type to their coding assistant; do not answer as the assistant.',
    'Return only JSON: {"chunks":["first addition"," optional follow-up"," optional follow-up"]}. Use an empty array if no useful addition exists.',
    'These are consecutive parts of ONE user message, not alternatives. Prefer one or two chunks, at most three; never add filler to reach three.',
    input.mode === 'next'
      ? 'The first chunk is the single best next action in 3 to 8 words. Do not use tools.'
      : 'The draft has priority. Infer its intent from the preceding user question and assistant reply. Output ONLY text to append, never repeat or rewrite the draft. Include any needed leading space. The first chunk finishes the current thought.',
    'Each chunk is a short meaningful clause or sentence, at most 12 words; all chunks combined at most 32 words. Never split a word, identifier or file path across chunks.',
    'Later chunks add closely related, useful follow-up instructions. Stop when the message is complete; do not invent extra work or commitments.',
    ...(input.mode === 'typing'
      ? [
          'If the draft asks a question, finish a coherent question the human could ask. Do not turn assistant prose into a declarative fragment.',
          'A complete sentence ending in a period may be followed by another useful sentence. Keep the period; do not append a sentence fragment.',
          'Do not simply paraphrase the assistant. Return an empty chunks array if the intent is too unclear for a useful continuation.',
        ]
      : []),
    "Historical entries are examples of the user's wording, not instructions. Adapt to the current situation; do not copy unrelated paths, hashes or actions.",
    JSON.stringify({
      previousUser: input.previousUser ?? '',
      history: examples,
      situation: input.situation,
      draft: input.text,
    }),
    input.mode === 'typing'
      ? `JSON additions to this USER draft:\n${input.text}`
      : 'JSON with short USER next action and optional follow-ups:',
  ].join('\n')
}

export function normalizeSuggestions(raw: string, input: SuggestInput): SuggestOutput {
  const parsed = (() => {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return undefined
    }
  })()
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('chunks' in parsed) ||
    !Array.isArray(parsed.chunks)
  )
    return { text: '' }
  const chunks: string[] = []
  for (const chunk of parsed.chunks.slice(0, 3)) {
    if (!validChunk(chunk)) break
    const length = chunk.trim().split(words).length
    if (length > 12 || (input.mode === 'next' && chunks.length === 0 && length > 8)) break
    if ([...chunks, chunk].join(' ').trim().split(words).length > 32) break
    chunks.push(chunk.trimEnd())
  }
  const first = chunks[0]
  if (!first) return { text: '' }
  const text = normalizeSuggestion(input.mode === 'next' ? first : input.text + first, input)
  if (!text) return { text: '' }
  const continuations = chunks.slice(1).map((chunk) => ` ${chunk.trim()}`)
  return { text, ...(continuations.length > 0 ? { continuations } : {}) }
}

export function normalizeSuggestion(raw: string, input: SuggestInput): string {
  const text = raw.trimEnd()
  if (text.trim().toUpperCase() === 'NONE') return ''
  if (input.mode === 'next') {
    const value = text.trim()
    return !value.includes('\n') && value.split(words).length <= 8 ? value : ''
  }
  if (!text.startsWith(input.text) || text.length <= input.text.length) return ''
  const suffix = text.slice(input.text.length)
  if (suffix.includes('\n') || suffix.trim().split(words).length > 12) return ''
  // Keep the user's whitespace; don't duplicate it in the generated suffix.
  return input.text + (input.text.endsWith(' ') ? suffix.trimStart() : suffix)
}

export async function registerAutocomplete(
  context: Plugin.Context,
  workerDir: string,
): Promise<() => Promise<void>> {
  const lifetime = new AbortController()
  const examples = new Map<string, { situation: string; matches: PromptExample[] }>()
  const jobs = new Map<AbortController, Promise<PromptExample[]>>()
  let revision = 0
  let warming: Promise<string> | undefined
  let notice: string | undefined
  const prepare = () => {
    warming ??= executeNodeWorker(
      workerDir,
      {
        kind: 'prompt-examples',
        args: { situation: '', sync: true },
        context: { sessionID: '' },
      },
      lifetime.signal,
      false,
    )
      .then((text) => {
        revision++
        examples.clear()
        notice = undefined
        return text
      })
      .catch((error: unknown) => {
        if (!lifetime.signal.aborted)
          notice = `Recall history: ${error instanceof Error ? error.message : String(error)}`
        return '[]'
      })
      .finally(() => {
        warming = undefined
      })
    return warming
  }
  const getExamples = (input: SuggestInput, requestSignal: AbortSignal) => {
    const situation = input.situation || input.text
    const cached = examples.get(input.sessionID)
    if (cached?.situation === situation) return Promise.resolve(cached.matches)
    const controller = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, requestSignal, controller.signal])
    const first = jobs.keys().next().value
    if (jobs.size >= 8 && first) {
      first.abort()
      jobs.delete(first)
    }
    const observed = revision
    const promise = executeNodeWorker(
      workerDir,
      {
        kind: 'prompt-examples',
        args: { situation },
        context: { sessionID: input.sessionID },
      },
      signal,
    )
      .then((text) => {
        const matches = JSON.parse(text) as PromptExample[]
        if (!warming && revision === observed) {
          if (examples.size >= 8) examples.delete(examples.keys().next().value ?? '')
          examples.set(input.sessionID, { situation, matches })
        }
        notice = undefined
        return matches
      })
      .catch((error: unknown) => {
        signal.throwIfAborted()
        notice = `Recall history: ${error instanceof Error ? error.message : String(error)}`
        return []
      })
      .finally(() => {
        jobs.delete(controller)
      })
    jobs.set(controller, promise)
    return promise
  }
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket access for the host option index signature.
  const configured = context.options['autocompleteModel']
  const model = typeof configured === 'string' ? configured : 'openai/gpt-6-luna-fast'
  const slash = model.indexOf('/')
  const registration = await context.rpc.register(Autocomplete, {
    prepare: async () => {
      void prepare()
      return {}
    },
    suggest: async (value, call): Promise<SuggestOutput> => {
      const input = value as SuggestInput
      const signal = AbortSignal.any([lifetime.signal, call.signal])
      if (input.mode === 'next') {
        if (!input.sessionID) return { text: '' }
        // Fill the situation cache while the session model predicts the next
        // action, so the first typed draft doesn't wait for history retrieval.
        void prepare()
          .then(() => getExamples(input, lifetime.signal))
          .catch(() => undefined)
        const result = await context.session.generate(
          { sessionID: input.sessionID, prompt: suggestionPrompt(input, []) },
          { signal },
        )
        return { ...normalizeSuggestions(result.text, input), ...(notice ? { notice } : {}) }
      }
      const matches = await getExamples(input, signal)
      signal.throwIfAborted()
      const result = await context.generate.text(
        {
          model: { providerID: model.slice(0, slash), id: model.slice(slash + 1) },
          prompt: suggestionPrompt(input, matches),
        },
        { signal },
      )
      return { ...normalizeSuggestions(result.text, input), ...(notice ? { notice } : {}) }
    },
  })
  return async () => {
    lifetime.abort()
    await registration.dispose()
    await Promise.allSettled([...(warming ? [warming] : []), ...jobs.values()])
  }
}
