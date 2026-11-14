import { expect, test } from 'vitest'
import { GenerationIndicator, generationGray } from '../src/autocomplete-indicator.js'

test('display waits for 500ms of idle typing independently of generation start', () => {
  const indicator = new GenerationIndicator()
  expect(indicator.update('Review', false, 0, false)).toBe(false)
  expect(indicator.update('Review', true, 150, false)).toBe(false)
  expect(indicator.update('Review', true, 499, false)).toBe(false)
  expect(indicator.update('Review', true, 500, false)).toBe(true)
  expect(indicator.update('Review', false, 501, false)).toBe(false)
})

test('trailing-space edits preserve the pending display deadline', () => {
  const indicator = new GenerationIndicator()
  indicator.update('Review', true, 0, false)
  expect(indicator.update('Review ', true, 300, false)).toBe(false)
  expect(indicator.update('Review   ', true, 400, false)).toBe(false)
  expect(indicator.update('Review', true, 499, false)).toBe(false)
  expect(indicator.update('Review ', true, 500, false)).toBe(true)
})

test('adding, deleting and replacing trailing spaces keep a visible pulse', () => {
  const indicator = new GenerationIndicator()
  indicator.update('Review ', true, 0, false)
  expect(indicator.update('Review ', true, 500, false)).toBe(true)
  for (const text of ['Review   ', 'Review ', 'Review', 'Review  ', 'Review'])
    expect(indicator.update(text, true, 600, false)).toBe(true)
})

test('whitespace-only drafts preserve the display deadline in both directions', () => {
  const indicator = new GenerationIndicator()
  indicator.update('', true, 0, false)
  expect(indicator.update('   ', true, 499, false)).toBe(false)
  expect(indicator.update('', true, 500, false)).toBe(true)
  expect(indicator.update(' ', true, 501, false)).toBe(true)
  expect(indicator.update('', true, 502, false)).toBe(true)
})

test('letter edits, internal spaces and line breaks still reset the display deadline', () => {
  for (const text of ['Review it', 'Revie', 'Re view', 'Review\n', 'Review\t']) {
    const indicator = new GenerationIndicator()
    indicator.update('Review ', true, 0, false)
    expect(indicator.update('Review ', true, 500, false)).toBe(true)
    expect(indicator.update(text, true, 600, false)).toBe(false)
    expect(indicator.update(text, true, 1099, false)).toBe(false)
    expect(indicator.update(text, true, 1100, false)).toBe(true)
  }
})

test('a key without a text edit restarts the display deadline', () => {
  const indicator = new GenerationIndicator()
  indicator.update('Review ', true, 0, false)
  expect(indicator.update('Review ', true, 500, false)).toBe(true)
  indicator.edited(600)
  expect(indicator.update('Review ', true, 600, false)).toBe(false)
  expect(indicator.update('Review ', true, 1099, false)).toBe(false)
  expect(indicator.update('Review ', true, 1100, false)).toBe(true)
})

test('the pulse follows pending work when no suggestion is available', () => {
  const indicator = new GenerationIndicator()
  indicator.update('Review', false, 0, false)
  expect(indicator.update('Review', false, 600, false)).toBe(false)
  expect(indicator.update('Review', true, 601, false)).toBe(true)
  expect(indicator.update('Review', false, 602, false)).toBe(false)
  expect(indicator.update('Review', true, 603, false)).toBe(true)
})

test('an available suggestion immediately hides the dot while refinement is pending', () => {
  const indicator = new GenerationIndicator()
  indicator.update('Review', true, 0, false)
  expect(indicator.update('Review', true, 500, false)).toBe(true)
  expect(indicator.update('Review', true, 501, true)).toBe(false)
  expect(indicator.update('Review', true, 1200, true)).toBe(false)
  expect(indicator.update('Review', true, 1201, false)).toBe(true)
})

test('cached suggestions suppress the dot during refill and trailing-space edits', () => {
  const indicator = new GenerationIndicator()
  indicator.update('Review', true, 0, true)
  for (const text of ['Review', 'Review ', 'Review   ', 'Review'])
    expect(indicator.update(text, true, 600, true)).toBe(false)
  expect(indicator.update('Review', false, 601, true)).toBe(false)
})

test('brightness visibly pulses in grayscale', () => {
  const muted = { r: 120 / 255, g: 120 / 255, b: 120 / 255 }
  expect(generationGray(0, muted)).toBe(48)
  expect(generationGray(300, muted)).toBe(84)
  expect(generationGray(600, muted)).toBe(120)
  expect(generationGray(1200, muted)).toBe(48)
  for (let elapsed = 0; elapsed <= 1200; elapsed += 100) {
    expect(generationGray(elapsed, muted)).toBeGreaterThanOrEqual(48)
    expect(generationGray(elapsed, muted)).toBeLessThanOrEqual(120)
  }
})
