import type { RGBA } from '@opentui/core'

/** The hint is render-only and never reserves another input row. */
export function generationHint(text: string, columns: number): string {
  const hint = text.endsWith(' ') ? '•' : ' •'
  return columns >= hint.length ? hint : ''
}

export function generationGray(elapsed: number, muted: Pick<RGBA, 'r' | 'g' | 'b'>): number {
  const gray = ((muted.r + muted.g + muted.b) / 3) * 255
  const pulse = (1 - Math.cos((elapsed / 1200) * 2 * Math.PI)) / 2
  return Math.round(gray * (0.75 + 0.25 * pulse))
}
