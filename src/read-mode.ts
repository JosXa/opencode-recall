import type { ReadMode } from './db.js'

export const FULL_MODE_RECOMMENDATION =
  'history_read mode=full is not supported for LLM-safe reading. Use mode=tail to read from the end, mode=head to read from the start, and page with the returned <nav prev="..."> or <nav next="..."> cursors.'

export function parseReadMode(value: string | undefined): ReadMode {
  if (value === undefined || value.length === 0) {
    return 'around'
  }

  if (value === 'full') {
    throw new Error(FULL_MODE_RECOMMENDATION)
  }

  if (
    value === 'around' ||
    value === 'head' ||
    value === 'next' ||
    value === 'prev' ||
    value === 'tail'
  ) {
    return value
  }

  return 'around'
}
