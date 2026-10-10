import type { RGBA } from '@opentui/core'

/** Reserve the caret cell even when the user already typed a trailing space. */
export function generationHint(columns: number): string {
  return columns >= 2 ? ' •' : ''
}

export const indicatorDebounceMs = 500

/** Display timing is independent of request debounce, cancellation, and caching. */
export class GenerationIndicator {
  #text: string | undefined
  #editedAt = 0

  edited(now: number) {
    this.#editedAt = now
  }

  update(text: string, columns: number, generating: boolean, now: number): string {
    if (text !== this.#text) {
      this.#text = text
      this.edited(now)
    }
    if (!generating || now - this.#editedAt < indicatorDebounceMs) return ''
    return generationHint(columns)
  }
}

export function generationGray(elapsed: number, muted: Pick<RGBA, 'r' | 'g' | 'b'>): number {
  const gray = ((muted.r + muted.g + muted.b) / 3) * 255
  const pulse = (1 - Math.cos((elapsed / 1200) * 2 * Math.PI)) / 2
  return Math.round(gray * (0.4 + 0.6 * pulse))
}
