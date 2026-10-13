import type { OptimizedBuffer, RenderContext, TextareaRenderable } from '@opentui/core'
import { describe, expect, test, vi } from 'vitest'

const view = vi.hoisted(() => ({
  setFirstLineOffset: vi.fn(),
  setWrapWidth: vi.fn(),
  setViewport: vi.fn(),
  measureForDimensions: vi.fn(() => ({ lineCount: 2, widthColsMax: 61 })),
}))
vi.mock('@opentui/core', () => ({
  Yoga: { Unit: { Point: 1 } },
  TextRenderable: class {
    textBufferView = view
    _firstLineOffset = 0
    visible = false
    content = ''
    get plainText() {
      return this.content
    }
    updateTextInfo() {}
    markClean() {}
    destroy() {}
  },
}))
import { AutocompleteGhost } from '../src/autocomplete-ghost.js'

function fixture(text?: string) {
  const node = {
    minimum: { unit: 1, value: 1 },
    getMinHeight() {
      return this.minimum
    },
    getMaxHeight: () => ({ unit: 1, value: 6 }),
    setMinHeight(value: { unit: number; value: number }) {
      this.minimum = value
    },
  }
  const editor = {
    plainText: text ?? '',
    ctx: { height: 30 },
    width: 61,
    height: 2,
    virtualLineCount: 1,
    screenX: 5,
    screenY: 10,
    x: 5,
    y: 10,
    isDestroyed: false,
    visualCursor: { visualCol: text?.length ?? 19, visualRow: 0 },
    getLayoutNode: () => node,
    requestRender: vi.fn(),
    set minHeight(value: number) {
      node.minimum = { unit: 1, value }
    },
  }
  const ghost = new AutocompleteGhost({} as RenderContext, {})
  const buffer = { pushScissorRect: vi.fn(), drawTextBuffer: vi.fn(), popScissorRect: vi.fn() }
  return {
    node,
    editor,
    nativeEditor: editor as unknown as TextareaRenderable,
    ghost,
    buffer,
    update: () => ghost.update(editor as unknown as TextareaRenderable, ' next sentence.'),
  }
}

describe('wrapped ghost layout', () => {
  test('uses the available host rows to preview more than three lines', () => {
    const f = fixture('')
    view.measureForDimensions.mockReturnValueOnce({ lineCount: 5, widthColsMax: 61 })
    f.ghost.update(f.nativeEditor, 'First sentence. Second sentence. Third sentence.')
    expect(f.node.minimum.value).toBe(5)
    expect(view.measureForDimensions).toHaveBeenLastCalledWith(61, 6)
    f.editor.height = 5
    f.ghost.render(f.buffer as unknown as OptimizedBuffer)
    expect(view.setViewport).toHaveBeenLastCalledWith(0, 1, 61, 4)
    expect(f.editor.plainText).toBe('')
    f.ghost.hide()
    expect(f.node.minimum.value).toBe(1)
  })
  test('reserves display rows and restores the original constraint on hide', () => {
    const f = fixture()
    f.update()
    expect(f.node.minimum.value).toBe(2)
    expect(view.setFirstLineOffset).toHaveBeenLastCalledWith(19)
    f.ghost.hide()
    expect(f.node.minimum).toEqual({ unit: 1, value: 1 })
  })
  test('caps reservation at the host maximum and preserves changes by the host', () => {
    const f = fixture()
    f.editor.virtualLineCount = 12
    f.update()
    expect(f.node.minimum.value).toBe(6)
    f.node.minimum = { unit: 1, value: 4 }
    f.ghost.hide()
    expect(f.node.minimum.value).toBe(4)
  })
  test('draws the first row after the cursor and following rows at the left edge', () => {
    const f = fixture()
    f.update()
    const buffer = { pushScissorRect: vi.fn(), popScissorRect: vi.fn(), drawTextBuffer: vi.fn() }
    f.ghost.render(buffer as unknown as OptimizedBuffer)
    expect(buffer.pushScissorRect).toHaveBeenCalledWith(24, 10, 42, 1)
    expect(buffer.drawTextBuffer.mock.calls.map((call) => call.slice(1))).toEqual([
      [24, 10],
      [5, 11],
    ])
    expect(view.setViewport).toHaveBeenLastCalledWith(0, 1, 61, 1)
    f.ghost.destroy()
    expect(f.node.minimum.value).toBe(1)
  })
  test('starts after a full input row without dropping the first ghost line', () => {
    const f = fixture()
    f.editor.visualCursor.visualCol = f.editor.width
    f.update()
    expect(f.node.minimum.value).toBe(3)
    f.editor.height = 3
    const buffer = { pushScissorRect: vi.fn(), popScissorRect: vi.fn(), drawTextBuffer: vi.fn() }
    f.ghost.render(buffer as unknown as OptimizedBuffer)
    expect(buffer.pushScissorRect).toHaveBeenCalledWith(5, 11, 61, 1)
    expect(buffer.drawTextBuffer.mock.calls.map((call) => call.slice(1))).toEqual([
      [5, 11],
      [5, 12],
    ])
    f.editor.height = 1
    expect(f.ghost.hasRoom).toBe(false)
  })
})

test('a completed next-action suggestion starts at the empty input left edge', () => {
  const { editor, nativeEditor, ghost, buffer } = fixture('')
  const suggestion = 'Please implement the actual rendering indicator.'
  ghost.update(nativeEditor, suggestion)
  ghost.render(buffer as unknown as OptimizedBuffer)
  expect(ghost.plainText).toBe(suggestion)
  expect(buffer.drawTextBuffer.mock.calls[0]?.slice(1)).toEqual([editor.screenX, editor.screenY])
  expect(editor.plainText).toBe('')
})

test('a typed trailing space does not acquire another display-only space', () => {
  const { editor, nativeEditor, ghost } = fixture('Review ')
  ghost.update(nativeEditor, 'the changes.')
  expect(ghost.plainText).toBe('the changes.')
  expect(editor.plainText).toBe('Review ')
})

test('the temporary dot cell disappears as soon as generation ends', () => {
  const { editor, nativeEditor, ghost } = fixture('')
  ghost.update(nativeEditor, 'Please review the changes.', true)
  expect(ghost.plainText).toBe(' Please review the changes.')
  ghost.update(nativeEditor, 'Please review the changes.', false)
  expect(ghost.plainText).toBe('Please review the changes.')
  expect(editor.plainText).toBe('')
})

test('a continuation keeps its actual word separator while the dot is visible', () => {
  const { nativeEditor, ghost } = fixture('Review')
  for (const busy of [true, false]) {
    ghost.update(nativeEditor, ' the changes.', busy)
    expect(ghost.plainText).toBe(' the changes.')
  }
})

test('a wrapped continuation does not reserve a dot cell on the next row', () => {
  const { editor, nativeEditor, ghost, buffer } = fixture('x'.repeat(61))
  editor.height = 3
  ghost.update(nativeEditor, 'the changes.', true)
  ghost.render(buffer as unknown as OptimizedBuffer)
  expect(ghost.plainText).toBe('the changes.')
  expect(buffer.drawTextBuffer.mock.calls[0]?.slice(1)).toEqual([editor.screenX, editor.screenY + 1])
})
