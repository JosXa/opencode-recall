import { expect, test } from 'vitest'
import { GenerationIndicator, generationGray, generationHint } from '../src/autocomplete-indicator.js'

test('the bullet always leaves the caret cell empty and never wraps', () => {
  expect(generationHint(2)).toBe(' •')
  expect(generationHint(1)).toBe('')
  expect(generationHint(0)).toBe('')
})

test('display waits for 500ms of idle typing independently of generation start', () => {
  const indicator = new GenerationIndicator()
  expect(indicator.update('Review', 20, false, 0)).toBe('')
  expect(indicator.update('Review', 20, true, 150)).toBe('')
  expect(indicator.update('Review', 20, true, 499)).toBe('')
  expect(indicator.update('Review', 20, true, 500)).toBe(' •')
  expect(indicator.update('Review', 20, false, 501)).toBe('')
})

test('trailing-space edits preserve the pending display deadline', () => {
  const indicator = new GenerationIndicator()
  indicator.update('Review', 20, true, 0)
  expect(indicator.update('Review ', 20, true, 300)).toBe('')
  expect(indicator.update('Review   ', 20, true, 400)).toBe('')
  expect(indicator.update('Review', 20, true, 499)).toBe('')
  expect(indicator.update('Review ', 20, true, 500)).toBe(' •')
})

test('adding, deleting and replacing trailing spaces keep a visible hint', () => {
  const indicator = new GenerationIndicator()
  indicator.update('Review ', 20, true, 0)
  expect(indicator.update('Review ', 20, true, 500)).toBe(' •')
  for (const text of ['Review   ', 'Review ', 'Review', 'Review  ', 'Review'])
    expect(indicator.update(text, 20, true, 600)).toBe(' •')
  expect(indicator.update('Review ', 1, true, 601)).toBe('')
  expect(indicator.update('Review', 20, true, 602)).toBe(' •')
})

test('whitespace-only drafts preserve the display deadline in both directions', () => {
  const indicator = new GenerationIndicator()
  indicator.update('', 20, true, 0)
  expect(indicator.update('   ', 20, true, 499)).toBe('')
  expect(indicator.update('', 20, true, 500)).toBe(' •')
  expect(indicator.update(' ', 20, true, 501)).toBe(' •')
  expect(indicator.update('', 20, true, 502)).toBe(' •')
})

test('letter edits, internal spaces and line breaks still reset the display deadline', () => {
  for (const text of ['Review it', 'Revie', 'Re view', 'Review\n', 'Review\t']) {
    const indicator = new GenerationIndicator()
    indicator.update('Review ', 20, true, 0)
    expect(indicator.update('Review ', 20, true, 500)).toBe(' •')
    expect(indicator.update(text, 20, true, 600)).toBe('')
    expect(indicator.update(text, 20, true, 1099)).toBe('')
    expect(indicator.update(text, 20, true, 1100)).toBe(' •')
  }
})

test('a key without a text edit restarts the display deadline', () => {
  const indicator = new GenerationIndicator()
  indicator.update('Review ', 20, true, 0)
  expect(indicator.update('Review ', 20, true, 500)).toBe(' •')
  indicator.edited(600)
  expect(indicator.update('Review ', 20, true, 600)).toBe('')
  expect(indicator.update('Review ', 20, true, 1099)).toBe('')
  expect(indicator.update('Review ', 20, true, 1100)).toBe(' •')
})

test('cached suggestions and completed work suppress the hint without affecting its timing', () => {
  const indicator = new GenerationIndicator()
  indicator.update('Review', 20, false, 0)
  expect(indicator.update('Review', 20, false, 600)).toBe('')
  expect(indicator.update('Review', 20, true, 601)).toBe(' •')
  expect(indicator.update('Review', 1, true, 602)).toBe('')
  expect(indicator.update('Review', 20, false, 603)).toBe('')
})

test('brightness visibly pulses in grayscale without changing the glyph or its size', () => {
  const muted = { r: 120 / 255, g: 120 / 255, b: 120 / 255 }
  expect(generationGray(0, muted)).toBe(48)
  expect(generationGray(300, muted)).toBe(84)
  expect(generationGray(600, muted)).toBe(120)
  expect(generationGray(1200, muted)).toBe(48)
  for (let elapsed = 0; elapsed <= 1200; elapsed += 100) {
    expect(generationGray(elapsed, muted)).toBeGreaterThanOrEqual(48)
    expect(generationGray(elapsed, muted)).toBeLessThanOrEqual(120)
    expect(generationHint(2)).toBe(' •')
  }
})
