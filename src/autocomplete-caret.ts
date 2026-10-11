import { type OptimizedBuffer, type TextareaRenderable, TextRenderable } from '@opentui/core'

/** A status glyph in the native caret cell, with no editor or layout mutations. */
export class AutocompleteCaret extends TextRenderable {
  #editor: TextareaRenderable | undefined

  update(editor: TextareaRenderable | undefined, visible: boolean) {
    this.#editor = editor
    this.visible = !!editor && visible
    if (!(editor && visible)) return
    this.left = editor.x + editor.visualCursor.visualCol - (this.parent?.x ?? 0)
    this.top = editor.y + editor.visualCursor.visualRow - (this.parent?.y ?? 0)
    this.requestRender()
  }

  override render(buffer: OptimizedBuffer) {
    const editor = this.#editor
    if (!(this.visible && editor) || editor.isDestroyed) return
    const cursor = editor.visualCursor
    if (editor.width === 0 || cursor.visualRow >= editor.height) return
    // These are the same coordinates the editor uses for the hardware caret.
    // Read them after layout, including when ghost wrapping moves the prompt.
    buffer.drawText(
      '•',
      editor.screenX + cursor.visualCol,
      editor.screenY + cursor.visualRow,
      this.fg,
    )
    this.markClean()
  }
}
