import { expect, test } from 'vitest'
import { generationGray, generationHint } from '../src/autocomplete-indicator.js'

test('a fixed bullet follows one space without entering the input or wrapping', () => {
  expect(generationHint('Review', 2)).toBe(' •')
  expect(generationHint('Review ', 1)).toBe('•')
  expect(generationHint('Review  ', 1)).toBe('•')
  expect(generationHint('Review', 1)).toBe('')
  expect(generationHint('Review ', 0)).toBe('')
  expect(generationHint('', 2)).toBe(' •')
})

test('brightness pulses gently in grayscale without changing the glyph or its size', () => {
  const muted = { r: 120 / 255, g: 120 / 255, b: 120 / 255 }
  expect(generationGray(0, muted)).toBe(90)
  expect(generationGray(600, muted)).toBe(120)
  expect(generationGray(1200, muted)).toBe(90)
  for (let elapsed = 0; elapsed <= 1200; elapsed += 100) {
    expect(generationGray(elapsed, muted)).toBeGreaterThanOrEqual(90)
    expect(generationGray(elapsed, muted)).toBeLessThanOrEqual(120)
    expect(generationHint('Review ', 1)).toBe('•')
  }
})
