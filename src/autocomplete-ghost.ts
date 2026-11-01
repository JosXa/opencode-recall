import {
  type ColorInput,
  type OptimizedBuffer,
  parseColor,
  Renderable,
  type RenderableOptions,
  type RenderContext,
  type TextareaRenderable,
  TextBuffer,
  TextBufferView,
  Yoga,
} from '@opentui/core'

type HeightConstraint = ReturnType<TextareaRenderable['getMinHeight']>

function origin(editor: TextareaRenderable) {
  const cursor = editor.visualCursor
  const extra = cursor.visualCol >= editor.width ? 1 : 0
  return { column: extra ? 0 : cursor.visualCol, row: cursor.visualRow + extra, extra }
}

function heightInput(constraint: HeightConstraint) {
  if (constraint.unit === Yoga.Unit.Point) return constraint.value
  if (constraint.unit === Yoga.Unit.Percent) return `${constraint.value}%` as const
  return undefined
}

export interface AutocompleteGhostOptions extends RenderableOptions<AutocompleteGhost> {
  fg: ColorInput
}

/** Native wrapping keeps terminal columns, wide glyphs, and word boundaries consistent. */
export class AutocompleteGhost extends Renderable {
  readonly #text: TextBuffer
  readonly #firstRow: TextBufferView
  readonly #nextRows: TextBufferView
  #content = ''
  #firstLineOffset = 0
  #space: { editor: TextareaRenderable; minimum: HeightConstraint; reserved: number } | undefined

  constructor(ctx: RenderContext, { fg, ...options }: AutocompleteGhostOptions) {
    super(ctx, options)
    this.#text = TextBuffer.create(ctx.widthMethod, ctx.nativeScene)
    this.#firstRow = TextBufferView.create(this.#text)
    this.#nextRows = TextBufferView.create(this.#text)
    for (const view of this.#views) view.setWrapMode('word')
    this.#text.setDefaultFg(parseColor(fg))
  }

  get #views() {
    return [this.#firstRow, this.#nextRows]
  }

  get plainText() {
    return this.#content
  }

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
    const current = space.editor.getMinHeight()
    if (current.unit !== Yoga.Unit.Point || current.value !== space.reserved) return
    space.editor.minHeight = heightInput(space.minimum)
    space.editor.requestRender()
  }

  update(editor: TextareaRenderable, suffix: string, caretVisible = false) {
    if (this.#space?.editor !== editor) this.#restore()
    const minimum = this.#space?.minimum ?? editor.getMinHeight()
    const maximum = editor.getMaxHeight()
    const start = origin(editor)
    const width = Math.max(1, editor.width)
    // Keep the renderable's layout bounds over the input so the renderer visits
    // it; painting still reads the final editor coordinates after layout.
    this.left = editor.x - (this.parent?.x ?? 0)
    this.top = editor.y + start.row - (this.parent?.y ?? 0)
    this.width = width
    // Reserve a cell only for a visible dot on this row, never for an idle caret.
    const content = caretVisible && !start.extra && !suffix.startsWith(' ') ? ` ${suffix}` : suffix
    if (content !== this.#content) {
      this.#content = content
      this.#text.setText(content)
    }
    if (start.column !== this.#firstLineOffset) {
      this.#firstLineOffset = start.column
      for (const view of this.#views) view.setFirstLineOffset(start.column)
    }
    for (const view of this.#views) view.setWrapWidth(width)
    const maximumHeight = maximum.unit === Yoga.Unit.Point ? maximum.value : editor.ctx.height
    const available = Math.max(1, maximumHeight - editor.virtualLineCount + 1 - start.extra)
    const lines = Math.min(
      available,
      this.#firstRow.measureForDimensions(width, available)?.lineCount ?? 1,
    )
    // Reserve display rows inside the card, without inserting newlines into the prompt.
    const reserved = Math.min(
      maximumHeight,
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
    this.requestRender()
  }

  override destroy() {
    this.#restore()
    super.destroy()
  }

  protected override destroyOwnedResources() {
    for (const view of this.#views) view.destroy()
    this.#text.destroy()
    super.destroyOwnedResources()
  }

  override renderSelf(buffer: OptimizedBuffer) {
    const editor = this.#space?.editor
    if (!(editor && this.hasRoom)) return
    const start = origin(editor)
    const height = editor.height - start.row
    // Read coordinates after layout because reserving rows can move the prompt.
    // First-line offset controls wrapping, not painting. Subsequent rows start
    // at the input's left edge. This overlay must not capture mouse selections.
    this.#firstRow.setViewport(0, 0, editor.width, 1)
    buffer.pushScissorRect(
      editor.screenX + start.column,
      editor.screenY + start.row,
      editor.width - start.column,
      1,
    )
    buffer.drawTextBuffer(this.#firstRow, editor.screenX + start.column, editor.screenY + start.row)
    buffer.popScissorRect()
    if (height > 1) {
      this.#nextRows.setViewport(0, 1, editor.width, height - 1)
      buffer.drawTextBuffer(this.#nextRows, editor.screenX, editor.screenY + start.row + 1)
    }
  }
}
