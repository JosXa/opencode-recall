import type { KeyEvent } from '@opentui/core'
import {
  autocompleteErrorMessage,
  type RefineInput,
  type SuggestInput,
  type SuggestOutput,
} from './autocomplete-rpc.js'

export function acceptKey(
  event: Pick<KeyEvent, 'name' | 'shift' | 'ctrl' | 'meta'>,
): 'word' | 'all' | undefined {
  // Only the Right arrow accepts; OpenCode reserves Tab and the Emacs-style keys.
  if (event.shift || event.name.toLowerCase() !== 'right') return
  return event.ctrl || event.meta ? 'word' : 'all'
}

export interface PromptSnapshot extends SuggestInput {
  readonly scope: string
  readonly eligible: boolean
}

type Request = (input: SuggestInput, signal: AbortSignal) => Promise<SuggestOutput>
type Refinement = (input: RefineInput, signal: AbortSignal) => Promise<SuggestOutput>
type CachedOutput = SuggestOutput & { readonly separator: boolean }

type Candidate = {
  scope: string
  situation: string
  previousUser: string
  mode: SuggestInput['mode']
  text: string
  ends: readonly number[]
  separator: boolean
  refined: boolean
}

const trailingSpaces = / +$/u
const leadingSpaces = /^ +/u
const wordBoundary = /\s/u
const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' })

function separatingSpace(text: string, prefix: string): boolean {
  return text.charAt(prefix.replace(trailingSpaces, '').length) === ' '
}

function sameContext(previous: PromptSnapshot | undefined, state: PromptSnapshot): boolean {
  return (
    previous?.scope === state.scope &&
    previous.sessionID === state.sessionID &&
    previous.situation === state.situation &&
    previous.previousUser === state.previousUser &&
    previous.eligible === state.eligible
  )
}

function rebaseText(
  text: string,
  from: string,
  to: string,
  separator = separatingSpace(text, from),
): string {
  if (text.length === 0 || from === to || !text.startsWith(from)) return text
  const suffix = text.slice(from.length).replace(leadingSpaces, '')
  // Keep the generated word boundary when the last typed space is deleted.
  const gap = to.length > 0 && !to.endsWith(' ') && separator && suffix.length > 0 ? ' ' : ''
  return to + gap + suffix
}

function rebaseCandidate(candidate: Candidate, from: string, to: string): Candidate {
  const text = rebaseText(candidate.text, from, to, candidate.separator)
  const delta = text.length - candidate.text.length
  return {
    ...candidate,
    text,
    ends: candidate.ends.map((end) => (end > from.length ? end + delta : end)),
  }
}

const cacheKey = (state: PromptSnapshot) =>
  `${state.scope}\0${state.situation}\0${state.previousUser ?? ''}\0${state.mode}\0${state.text}`

function requestInput(state: PromptSnapshot): SuggestInput {
  return {
    sessionID: state.sessionID,
    situation: state.situation,
    previousUser: state.previousUser ?? '',
    text: state.text,
    mode: state.mode,
  }
}

function makeCandidate(
  state: PromptSnapshot,
  result: SuggestOutput,
  separator = separatingSpace(result.text, state.text),
): Candidate {
  const chunks = [result.text, ...(result.continuations ?? [])]
  return {
    scope: state.scope,
    situation: state.situation,
    previousUser: state.previousUser ?? '',
    mode: state.mode,
    text: chunks.join(''),
    ends: chunks.map((_chunk, index) => chunks.slice(0, index + 1).join('').length),
    separator,
    refined: result.refined === true,
  }
}

/** Owns request cancellation and render-only state; the editor is never passed in. */
export class AutocompleteController {
  readonly #request: Request
  readonly #refine: Refinement | undefined
  readonly #changed: () => void
  readonly #debounce: number
  #snapshot: PromptSnapshot | undefined
  #pending: AbortController | undefined
  #refinement: AbortController | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #candidate: Candidate | undefined
  #prefetch: { controller: AbortController; text: string } | undefined
  readonly #cache = new Map<string, CachedOutput>()
  #loading = false
  #error: string | undefined

  public constructor(request: Request, changed: () => void, debounce = 150, refine?: Refinement) {
    this.#request = request
    this.#refine = refine
    this.#changed = changed
    this.#debounce = debounce
  }

  public get loading(): boolean {
    return this.#loading
  }
  public get generating(): boolean {
    return this.#loading || !!this.#prefetch || !!this.#refinement
  }
  public get error(): string | undefined {
    return this.#error
  }
  public get suffix(): string {
    const state = this.#snapshot
    const candidate = this.#candidate
    return state?.eligible && candidate && this.#compatible(state)
      ? candidate.text.slice(
          state.text.length,
          candidate.ends.find((end) => end > state.text.length) ?? state.text.length,
        )
      : ''
  }

  /** Preview at most three upcoming sentences while acceptance advances only one. */
  public get preview(): string {
    return this.#continuation(3)
  }

  public get sentence(): string {
    return this.#continuation(1)
  }

  #continuation(limit: number): string {
    const state = this.#snapshot
    const candidate = this.#candidate
    if (!(state?.eligible && candidate && this.#compatible(state))) return ''
    const text = candidate.text
    let count = 0
    for (const part of sentences.segment(text)) {
      const end = part.index + part.segment.trimEnd().length
      // Do not split URL query strings or identifiers at punctuation inside a token.
      if (end <= state.text.length || (end !== text.length && !wordBoundary.test(text.charAt(end))))
        continue
      if (++count === limit) return text.slice(state.text.length, end)
    }
    return text.slice(state.text.length)
  }

  public update(state: PromptSnapshot): void {
    const previous = this.#snapshot
    const contextMatches = sameContext(previous, state)
    if (contextMatches && previous?.text === state.text && previous.mode === state.mode) return
    if (this.#carrySpaces(previous, state)) return
    this.#cancel()
    this.#snapshot = state
    // accepted() updates the snapshot itself; other text changes are manual edits.
    if (previous?.text !== state.text || !(state.eligible && this.#compatible(state)))
      this.#cancelPrefetch()
    this.#error = undefined
    if (!state.eligible) {
      this.#changed()
      return
    }
    if (this.suffix || this.#prefetch?.text === state.text) {
      if (
        this.#candidate &&
        previous?.text.replace(trailingSpaces, '') !== state.text.replace(trailingSpaces, '')
      )
        this.#candidate.separator = separatingSpace(this.#candidate.text, state.text)
      // Continuing to type along a ghost must still refine the newly written draft.
      this.#resumeRefinement(
        state,
        this.#candidate?.refined === true,
        previous?.text !== state.text,
      )
      this.#changed()
      return
    }
    const key = cacheKey(state)
    const cached = this.#cache.get(key)
    if (cached) {
      this.#candidate = makeCandidate(state, cached, cached.separator)
      this.#resumeRefinement(state, cached.refined === true)
      this.#changed()
      if (!this.#timer) this.#prefetchMore()
      return
    }
    this.#candidate = undefined
    this.#schedule(state)
    this.#changed()
  }

  #resumeRefinement(state: PromptSnapshot, refined: boolean, textChanged = false): void {
    if (state.mode === 'typing' && this.#refine && (!refined || textChanged))
      this.#schedule(state, true)
  }

  #schedule(state: PromptSnapshot, cachedSuggestion = false): void {
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined
        if (!cachedSuggestion) {
          const pending = new AbortController()
          this.#pending = pending
          this.#loading = true
          this.#changed()
          void this.#request(requestInput(state), pending.signal)
            .then((result) => {
              if (pending.signal.aborted || this.#pending !== pending) return
              this.#showResult(state, result)
            })
            .catch((error: unknown) => {
              if (!pending.signal.aborted) this.#error = autocompleteErrorMessage(error)
            })
            .finally(() => {
              if (this.#pending !== pending) return
              this.#pending = undefined
              this.#loading = false
              this.#changed()
              if (!this.#refinement) this.#prefetchMore()
            })
        }
        if (state.mode === 'typing' && this.#refine) {
          const refinement = new AbortController()
          this.#refinement = refinement
          void this.#refine({ ...requestInput(state), cachedSuggestion }, refinement.signal)
            .then((result) => {
              if (refinement.signal.aborted || this.#refinement !== refinement) return
              if (result.notice) this.#error = result.notice
              if (!result.text) return
              // Replace only unaccepted suggestions; acceptance cancels refinement.
              this.#cancelPrefetch()
              this.#pending?.abort()
              this.#pending = undefined
              this.#loading = false
              this.#showResult(state, result)
            })
            .catch((error: unknown) => {
              if (!refinement.signal.aborted) this.#error = autocompleteErrorMessage(error)
            })
            .finally(() => {
              if (this.#refinement !== refinement) return
              this.#refinement = undefined
              this.#changed()
              this.#prefetchMore()
            })
        }
        this.#changed()
      },
      state.mode === 'next' ? 0 : this.#debounce,
    )
  }

  /** Explicit word acceptance carries the remaining next action into typing. */
  public accepted(text: string): void {
    if (!(this.#snapshot && this.#candidate)) return
    this.#cancel()
    this.#snapshot = { ...this.#snapshot, text, mode: 'typing' }
    this.#candidate = {
      ...this.#candidate,
      mode: 'typing',
      separator: separatingSpace(this.#candidate.text, text),
    }
    this.#prefetchMore()
    this.#changed()
  }

  public dismiss(): void {
    this.#cancel()
    this.#cancelPrefetch()
    this.#candidate = undefined
    if (this.#snapshot) this.#remember(this.#snapshot, { text: '' })
    this.#changed()
  }

  public dispose(): void {
    this.#cancel()
    this.#cancelPrefetch()
    this.#snapshot = undefined
  }

  #carrySpaces(previous: PromptSnapshot | undefined, state: PromptSnapshot): boolean {
    if (!(previous && state.eligible && sameContext(previous, state))) return false
    const body = previous.text.replace(trailingSpaces, '')
    if (previous.text === state.text || state.text.replace(trailingSpaces, '') !== body)
      return false
    if (previous.mode !== state.mode && body.length > 0) return false
    // All edits to trailing spaces keep the pipeline and its original deadline.
    this.#carryCached(previous, state)
    this.#snapshot = state
    if (this.#candidate) {
      const future: PromptSnapshot = { ...previous, text: this.#candidate.text, mode: 'typing' }
      this.#candidate = {
        ...rebaseCandidate(this.#candidate, previous.text, state.text),
        mode: state.mode,
      }
      this.#carryCached(future, { ...state, text: this.#candidate.text, mode: 'typing' })
      if (this.#prefetch) this.#prefetch.text = this.#candidate.text
    }
    this.#changed()
    return true
  }

  #remember(
    state: PromptSnapshot,
    result: SuggestOutput,
    separator = separatingSpace(result.text, state.text),
  ): void {
    const key = cacheKey(state)
    if (this.#cache.size >= 20 && !this.#cache.has(key))
      this.#cache.delete(this.#cache.keys().next().value ?? '')
    this.#cache.set(key, { ...result, separator })
  }

  #showResult(state: PromptSnapshot, result: SuggestOutput): void {
    this.#remember(state, result)
    const current = this.#snapshot ?? state
    this.#remember(
      current,
      {
        ...result,
        text: rebaseText(result.text, state.text, current.text),
      },
      separatingSpace(result.text, state.text),
    )
    this.#candidate = {
      ...rebaseCandidate(makeCandidate(state, result), state.text, current.text),
      mode: current.mode,
    }
    this.#error = result.notice
  }

  #carryCached(from: PromptSnapshot, to: PromptSnapshot): void {
    const cached = this.#cache.get(cacheKey(from))
    if (cached)
      this.#remember(
        to,
        { ...cached, text: rebaseText(cached.text, from.text, to.text, cached.separator) },
        cached.separator,
      )
  }

  #cancel(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#pending?.abort()
    this.#pending = undefined
    this.#refinement?.abort()
    this.#refinement = undefined
    this.#loading = false
  }

  #cancelPrefetch(): void {
    this.#prefetch?.controller.abort()
    this.#prefetch = undefined
  }

  #compatible(state: PromptSnapshot): boolean {
    const value = this.#candidate
    return (
      !!value &&
      value.scope === state.scope &&
      value.situation === state.situation &&
      value.previousUser === (state.previousUser ?? '') &&
      value.mode === state.mode &&
      value.text.startsWith(state.text)
    )
  }

  #append(
    state: PromptSnapshot,
    result: SuggestOutput,
    prefix = state.text,
    separator = separatingSpace(result.text, state.text),
  ): void {
    const current = this.#candidate
    if (!result.text || current?.text !== prefix) return
    const next = rebaseCandidate(makeCandidate(state, result, separator), state.text, prefix)
    this.#candidate = {
      ...next,
      mode: current.mode,
      ends: [...current.ends, ...next.ends],
      // Preserve the original separator while later chunks are still unaccepted.
      separator: this.#snapshot?.text === prefix ? next.separator : current.separator,
      refined: current.refined,
    }
    this.#error = result.notice
    this.#changed()
  }

  #prefetchMore(): void {
    const state = this.#snapshot
    const current = this.#candidate
    if (
      !(state?.eligible && current && this.#compatible(state)) ||
      this.#prefetch ||
      !current.text ||
      current.text.length > 4000
    )
      return
    // Short model replies need lookahead before the first Tab, not after it.
    // Longer replies refill once acceptance leaves three cached chunks.
    const remaining = current.ends.filter((end) => end > state.text.length).length
    if (remaining > 3 || (remaining === 3 && state.text.length < (current.ends[0] ?? 0))) return
    const future: PromptSnapshot = { ...state, text: current.text, mode: 'typing' }
    const cached = this.#cache.get(cacheKey(future))
    if (cached) {
      this.#append(future, cached, future.text, cached.separator)
      return
    }
    const task = { controller: new AbortController(), text: current.text }
    this.#prefetch = task
    void this.#request(requestInput(future), task.controller.signal)
      .then((result) => {
        if (task.controller.signal.aborted || this.#prefetch !== task) return
        this.#remember(future, result)
        this.#remember(
          { ...future, text: task.text },
          {
            ...result,
            text: rebaseText(result.text, future.text, task.text),
          },
          separatingSpace(result.text, future.text),
        )
        this.#append(future, result, task.text)
      })
      .catch((error: unknown) => {
        if (task.controller.signal.aborted) return
        this.#error = autocompleteErrorMessage(error)
        this.#changed()
      })
      .finally(() => {
        if (this.#prefetch === task) this.#prefetch = undefined
      })
  }
}
