import { BoxRenderable, TextareaRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { expect, test } from 'bun:test'
import { AutocompleteCaret } from '../src/autocomplete-caret.js'
import { AutocompleteGhost } from '../src/autocomplete-ghost.js'

async function mount(text: string) {
  const setup = await createTestRenderer({ width: 40, height: 8 })
  const box = new BoxRenderable(setup.renderer, { width: 30, flexDirection: 'column' })
  const editor = new TextareaRenderable(setup.renderer, {
    width: 30,
    minHeight: 1,
    maxHeight: 6,
    initialValue: text,
  })
  const ghost = new AutocompleteGhost(setup.renderer, {
    position: 'absolute',
    width: 1,
    height: 1,
    visible: false,
    fg: '#808080',
    zIndex: 50,
  })
  const caret = new AutocompleteCaret(setup.renderer, {
    position: 'absolute',
    width: 1,
    height: 1,
    content: '•',
    visible: false,
    fg: '#808080',
    zIndex: 51,
  })
  box.add(editor)
  box.add(ghost)
  box.add(caret)
  setup.renderer.root.add(box)
  editor.focus()
  editor.cursorOffset = text.length
  await setup.renderOnce()
  const rows = async () => {
    await setup.renderOnce()
    await setup.renderOnce()
    return setup
      .captureCharFrame()
      .split('\n')
      .map((row) => row.trimEnd())
  }
  return { ...setup, editor, ghost, caret, rows }
}

test('paints the first ghost row after the cursor and wraps later rows to the input edge', async () => {
  const { renderer, editor, ghost, rows } = await mount('Please review the')
  ghost.update(editor, ' pull/122/changes. First summarize the intent and motivation, then review')
  expect((await rows()).slice(0, 5)).toEqual([
    'Please review the pull/122/',
    'changes. First summarize the',
    'intent and motivation, then',
    'review',
    '',
  ])
  ghost.hide()
  expect((await rows()).slice(0, 2)).toEqual(['Please review the', ''])
  expect(editor.getMinHeight()).toEqual({ unit: 1, value: 1 })
  renderer.destroy()
})

test('paints the generation dot in the caret cell', async () => {
  const { renderer, editor, caret, rows } = await mount('Review')
  caret.update(editor, true)
  expect((await rows())[0]).toBe('Review•')
  caret.update(editor, false)
  expect((await rows())[0]).toBe('Review')
  renderer.destroy()
})
