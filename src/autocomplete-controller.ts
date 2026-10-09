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

/** Owns request cancellation and render-only state; the editor is never passed in. */
export class AutocompleteController {
  readonly #request: Request
  readonly #changed: () => void
  readonly #debounce: number
  #snapshot: PromptSnapshot | undefined
  #pending: AbortController | undefined
  #timer: ReturnType<typeof setTimeout> | undefined
  #candidate:
    | {
        scope: string
        situation: string
        previousUser: string
        mode: SuggestInput['mode']
        text: string
      }
    | undefined
  readonly #cache = new Map<string, string>()
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
    return state?.eligible &&
      candidate?.scope === state.scope &&
      candidate.situation === state.situation &&
      candidate.previousUser === (state.previousUser ?? '') &&
      candidate.mode === state.mode &&
      candidate.text.startsWith(state.text)
      ? candidate.text.slice(state.text.length)
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
    this.#error = undefined
    if (!state.eligible) {
      this.#changed()
      return
    }
    if (this.suffix) {
      this.#changed()
      return
    }
    const key = `${state.scope}\0${state.situation}\0${state.previousUser ?? ''}\0${state.mode}\0${state.text}`
    if (this.#cache.has(key)) {
      this.#candidate = {
        scope: state.scope,
        situation: state.situation,
        previousUser: state.previousUser ?? '',
        mode: state.mode,
        text: this.#cache.get(key) ?? '',
      }
      this.#changed()
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
        void this.#request(
          {
            sessionID: state.sessionID,
            situation: state.situation,
            previousUser: state.previousUser ?? '',
            text: state.text,
            mode: state.mode,
          },
          pending.signal,
        )
          .then((result) => {
            if (pending.signal.aborted || this.#pending !== pending) return
            if (this.#cache.size >= 20) this.#cache.delete(this.#cache.keys().next().value ?? '')
            this.#cache.set(key, result.text)
            this.#candidate = {
              scope: state.scope,
              situation: state.situation,
              previousUser: state.previousUser ?? '',
              mode: state.mode,
              text: result.text,
            }
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
    this.#changed()
  }

  public dismiss(): void {
    this.#cancel()
    this.#candidate = undefined
    if (this.#snapshot)
      this.#cache.set(
        `${this.#snapshot.scope}\0${this.#snapshot.situation}\0${this.#snapshot.previousUser ?? ''}\0${this.#snapshot.mode}\0${this.#snapshot.text}`,
        '',
      )
    this.#changed()
  }

  public dispose(): void {
    this.#cancel()
    this.#snapshot = undefined
  }

  #cancel(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    this.#pending?.abort()
    this.#pending = undefined
    this.#loading = false
  }
}
