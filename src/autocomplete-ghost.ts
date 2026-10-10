import { type OptimizedBuffer, type TextareaRenderable, TextRenderable, Yoga } from '@opentui/core'

function origin(editor: TextareaRenderable) {
  const cursor = editor.visualCursor
  const extra = cursor.visualCol >= editor.width ? 1 : 0
  return { column: extra ? 0 : cursor.visualCol, row: cursor.visualRow + extra, extra }
}

/** Native wrapping keeps terminal columns, wide glyphs, and word boundaries consistent. */
export class AutocompleteGhost extends TextRenderable {
  #space: { editor: TextareaRenderable; minimum: Yoga.Value; reserved: number } | undefined

  get hasRoom() {
    const editor = this.#space?.editor
    return (
      !!editor &&
      !editor.isDestroyed &&
      this.visible &&
      editor.width > 0 &&
      origin(editor).row < editor.height
    )
  }

  hide() {
    this.visible = false
    this.#restore()
  }

  #restore() {
    const space = this.#space
    this.#space = undefined
    if (!space || space.editor.isDestroyed) return
    const node = space.editor.getLayoutNode()
    const current = node.getMinHeight()
    if (current.unit !== Yoga.Unit.Point || current.value !== space.reserved) return
    node.setMinHeight(space.minimum)
    space.editor.requestRender()
  }

  update(editor: TextareaRenderable, suffix: string) {
    if (this.#space?.editor !== editor) this.#restore()
    const node = editor.getLayoutNode()
    const minimum = this.#space?.minimum ?? node.getMinHeight()
    const maximum = node.getMaxHeight()
    const start = origin(editor)
    const width = Math.max(1, editor.width)
    // Keep the renderable's layout bounds over the input so the renderer visits
    // it; painting still reads the final editor coordinates after layout.
    this.left = editor.x - (this.parent?.x ?? 0)
    this.top = editor.y + start.row - (this.parent?.y ?? 0)
    this.width = width
    if (suffix !== this.plainText) this.content = suffix
    if (start.column !== this._firstLineOffset) {
      this._firstLineOffset = start.column
      this.textBufferView.setFirstLineOffset(start.column)
      this.updateTextInfo()
    }
    this.textBufferView.setWrapWidth(width)
    const lines = Math.min(
      3 - start.extra,
      this.textBufferView.measureForDimensions(width, 3)?.lineCount ?? 1,
    )
    // Reserve display rows inside the card, without inserting newlines into the prompt.
    const reserved = Math.min(
      maximum.unit === Yoga.Unit.Point ? maximum.value : editor.ctx.height,
      Math.max(
        minimum.unit === Yoga.Unit.Point ? minimum.value : 1,
        editor.virtualLineCount + lines - 1 + start.extra,
      ),
    )
    if (this.#space?.reserved !== reserved) {
      this.#space = { editor, minimum, reserved }
      editor.minHeight = reserved
    }
    this.visible = true
    this.height = Math.max(1, Math.min(lines, editor.height - start.row))
  }

  override destroy() {
    this.#restore()
    super.destroy()
  }

  override render(buffer: OptimizedBuffer) {
    const editor = this.#space?.editor
    if (!(editor && this.hasRoom)) return
    const start = origin(editor)
    const height = Math.min(3 - start.extra, editor.height - start.row)
    // Read coordinates after layout because reserving rows can move the prompt.
    // First-line offset controls wrapping, not painting. Subsequent rows start
    // at the input's left edge. This overlay must not capture mouse selections.
    this.textBufferView.setViewport(0, 0, editor.width, 1)
    buffer.pushScissorRect(
      editor.screenX + start.column,
      editor.screenY + start.row,
      editor.width - start.column,
      1,
    )
    buffer.drawTextBuffer(
      this.textBufferView,
      editor.screenX + start.column,
      editor.screenY + start.row,
    )
    buffer.popScissorRect()
    if (height > 1) {
      this.textBufferView.setViewport(0, 1, editor.width, height - 1)
      buffer.drawTextBuffer(this.textBufferView, editor.screenX, editor.screenY + start.row + 1)
    }
    this.markClean()
  }
}
