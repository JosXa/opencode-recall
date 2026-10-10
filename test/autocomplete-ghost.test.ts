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

function fixture() {
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
    ctx: { height: 30 },
    width: 61,
    height: 2,
    virtualLineCount: 1,
    screenX: 5,
    screenY: 10,
    x: 5,
    y: 10,
    isDestroyed: false,
    visualCursor: { visualCol: 19, visualRow: 0 },
    getLayoutNode: () => node,
    requestRender: vi.fn(),
    set minHeight(value: number) {
      node.minimum = { unit: 1, value }
    },
  }
  const ghost = new AutocompleteGhost({} as RenderContext, {})
  return {
    node,
    editor,
    ghost,
    update: () => ghost.update(editor as unknown as TextareaRenderable, ' next sentence.'),
  }
}

describe('wrapped ghost layout', () => {
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
