import type { KeyEvent } from '@opentui/core'
import type { SuggestInput, SuggestOutput } from './autocomplete-rpc.js'

export function acceptKey(
  event: Pick<KeyEvent, 'name' | 'shift' | 'ctrl' | 'meta'>,
): 'word' | 'all' | undefined {
  if (event.shift) return
  const name = event.name.toLowerCase()
  if (name === 'tab' && !event.ctrl && !event.meta) return 'all'
  if (name === 'right') return event.ctrl || event.meta ? 'word' : 'all'
  if (name === 'f' && event.meta) return 'word'
  if (event.ctrl && (name === 'e' || name === 'f')) return 'all'
}

export interface PromptSnapshot extends SuggestInput {
  readonly scope: string
  readonly eligible: boolean
}

type Request = (input: SuggestInput, signal: AbortSignal) => Promise<SuggestOutput>

type Candidate = {
  scope: string
  situation: string
  previousUser: string
  mode: SuggestInput['mode']
  text: string
  ends: readonly number[]
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

function makeCandidate(state: PromptSnapshot, result: SuggestOutput): Candidate {
  const chunks = [result.text, ...(result.continuations ?? [])]
  return {
    scope: state.scope,
    situation: state.situation,
    previousUser: state.previousUser ?? '',
    mode: state.mode,
    text: chunks.join(''),
    ends: chunks.map((_chunk, index) => chunks.slice(0, index + 1).join('').length),
  }
}

/** Owns request cancellation and render-only state; the editor is never passed in. */
export class AutocompleteController {
  readonly #request: Request
  readonly #changed: () => void
  readonly #debounce: number
  #snapshot: PromptSnapshot | undefined
  #pending: AbortController | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #candidate: Candidate | undefined
  #prefetch: { controller: AbortController; text: string } | undefined
  readonly #cache = new Map<string, SuggestOutput>()
  #loading = false
  #error: string | undefined

  public constructor(request: Request, changed: () => void, debounce = 150) {
    this.#request = request
    this.#changed = changed
    this.#debounce = debounce
  }

  public get loading(): boolean {
    return this.#loading
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

  public update(state: PromptSnapshot): void {
    const previous = this.#snapshot
    if (
      previous?.scope === state.scope &&
      previous.situation === state.situation &&
      previous.previousUser === state.previousUser &&
      previous.text === state.text &&
      previous.eligible === state.eligible &&
      previous.mode === state.mode
    )
      return
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
      this.#changed()
      return
    }
    const key = cacheKey(state)
    const cached = this.#cache.get(key)
    if (cached) {
      this.#candidate = makeCandidate(state, cached)
      this.#changed()
      this.#prefetchMore()
      return
    }
    this.#candidate = undefined
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined
        const pending = new AbortController()
        this.#pending = pending
        this.#loading = true
        this.#changed()
        void this.#request(requestInput(state), pending.signal)
          .then((result) => {
            if (pending.signal.aborted || this.#pending !== pending) return
            if (this.#cache.size >= 20) this.#cache.delete(this.#cache.keys().next().value ?? '')
            this.#cache.set(key, result)
            this.#candidate = makeCandidate(state, result)
            this.#error = result.notice
          })
          .catch((error: unknown) => {
            if (!pending.signal.aborted)
              this.#error = error instanceof Error ? error.message : String(error)
          })
          .finally(() => {
            if (this.#pending !== pending) return
            this.#pending = undefined
            this.#loading = false
            this.#changed()
            this.#prefetchMore()
          })
      },
      state.mode === 'next' ? 0 : this.#debounce,
    )
    this.#changed()
  }

  /** Explicit word acceptance carries the remaining next action into typing. */
  public accepted(text: string): void {
    if (!(this.#snapshot && this.#candidate)) return
    this.#cancel()
    this.#snapshot = { ...this.#snapshot, text, mode: 'typing' }
    this.#candidate = { ...this.#candidate, mode: 'typing' }
    this.#prefetchMore()
    this.#changed()
  }

  public dismiss(): void {
    this.#cancel()
    this.#cancelPrefetch()
    this.#candidate = undefined
    if (this.#snapshot) this.#cache.set(cacheKey(this.#snapshot), { text: '' })
    this.#changed()
  }

  public dispose(): void {
    this.#cancel()
    this.#cancelPrefetch()
    this.#snapshot = undefined
  }

  #cancel(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#pending?.abort()
    this.#pending = undefined
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

  #append(state: PromptSnapshot, result: SuggestOutput): void {
    const current = this.#candidate
    if (!result.text || current?.text !== state.text) return
    const next = makeCandidate(state, result)
    this.#candidate = { ...next, mode: current.mode, ends: [...current.ends, ...next.ends] }
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
      this.#append(future, cached)
      return
    }
    const task = { controller: new AbortController(), text: current.text }
    this.#prefetch = task
    void this.#request(requestInput(future), task.controller.signal)
      .then((result) => {
        if (task.controller.signal.aborted || this.#prefetch !== task) return
        if (this.#cache.size >= 20) this.#cache.delete(this.#cache.keys().next().value ?? '')
        this.#cache.set(cacheKey(future), result)
        this.#append(future, result)
      })
      .catch((error: unknown) => {
        if (task.controller.signal.aborted) return
        this.#error = error instanceof Error ? error.message : String(error)
        this.#changed()
      })
      .finally(() => {
        if (this.#prefetch === task) this.#prefetch = undefined
      })
  }
}
