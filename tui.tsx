/** @jsxImportSource @opentui/solid */
import { Plugin } from '@opencode/plugin/tui'
import type {
  BoxRenderable,
  EditBufferRenderable,
  KeyEvent,
  TextareaRenderable,
} from '@opentui/core'
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import {
  AutocompleteController,
  acceptKey,
  type PromptSnapshot,
} from './src/autocomplete-controller.js'
import { Autocomplete, type SuggestOutput } from './src/autocomplete-rpc.js'

const isPrompt = (editor: EditBufferRenderable | null | undefined): editor is TextareaRenderable =>
  !!editor &&
  !editor.isDestroyed &&
  'owner' in editor.traits &&
  editor.traits.owner === 'opencode' &&
  'role' in editor.traits &&
  editor.traits.role === 'prompt'

const reference = /(^|\s)[#@][^\s#@]*$/u
const command = /^\/\S*$/u
const wordChunk = /^\s*\S+/u

const foreign = (editor: TextareaRenderable, text: string) =>
  ('completer' in editor.traits && editor.traits.completer === 'snippets') ||
  (editor.traits.capture ?? []).includes('navigate') ||
  reference.test(text) ||
  command.test(text)

function eligible(editor: TextareaRenderable | undefined, text: string, next: boolean): boolean {
  return (
    !!editor &&
    !editor.hasSelection() &&
    editor.getTextRange(0, editor.cursorOffset).length === text.length &&
    !foreign(editor, text) &&
    text.length <= 4000 &&
    (text.length > 0 || next)
  )
}

export default Plugin.define({
  id: 'josxa.recall.autocomplete.tui',
  setup(context) {
    // Opt in explicitly: loading Recall for history must not start model requests.
    // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket access for the host option index signature.
    if (context.options['autocomplete'] !== true) return
    const rpc = context.client.rpc(Autocomplete)
    void rpc.prepare({}).catch((error: unknown) =>
      context.ui.toast.show({
        title: 'Recall autocomplete',
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      }),
    )
    const [status, setStatus] = createSignal('')
    const stopStatus = context.ui.slot({
      append: 'prompt.footer.status',
      render: () => <text fg={context.theme.text.muted}>{status()}</text>,
    })
    const stopPrompt = context.ui.slot({
      append: 'prompt.footer',
      render: (footer) => {
        const [ghost, setGhost] = createSignal('')
        const [position, setPosition] = createSignal({ top: 0, left: 0, width: 1 })
        let anchor: BoxRenderable | undefined
        let hidden:
          | { editor: TextareaRenderable; placeholder: TextareaRenderable['placeholder'] }
          | undefined
        let reported: string | undefined
        const restore = () => {
          if (hidden && !hidden.editor.isDestroyed && !hidden.editor.placeholder)
            hidden.editor.placeholder = hidden.placeholder
          hidden = undefined
        }
        const active = () => {
          if (footer.mode !== 'normal' || context.keymap.mode.current() !== 'base') return
          const editor = context.renderer.currentFocusedEditor
          if (isPrompt(editor)) return editor
        }
        const controller = new AutocompleteController(
          async (input, signal) => (await rpc.suggest(input, { signal })) as SuggestOutput,
          () => {
            sync()
            setStatus(controller.loading ? 'suggesting…' : '')
            if (controller.error && controller.error !== reported) {
              reported = controller.error
              context.ui.toast.show({
                title: 'Recall autocomplete',
                message: controller.error,
                variant: 'warning',
              })
            }
          },
        )
        const snapshot = (editor: TextareaRenderable | undefined): PromptSnapshot => {
          const sessionID = footer.sessionID ?? ''
          const messages = sessionID ? (context.data.session.message.list(sessionID) ?? []) : []
          const reply = messages.findLast(
            (message) =>
              message.type === 'assistant' && message.content.some((part) => part.type === 'text'),
          )
          const latest = messages.findLast(
            (message) => message.type === 'user' || message.type === 'assistant',
          )
          const situation =
            reply?.type === 'assistant'
              ? reply.content
                  .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                  .join('\n')
                  .slice(-2000)
              : ''
          const text = editor?.plainText ?? ''
          const idle = !sessionID || context.data.session.status(sessionID) === 'idle'
          return {
            scope: `${sessionID}:${reply?.id ?? 'home'}`,
            sessionID,
            situation,
            text,
            mode: text ? 'typing' : 'next',
            eligible: eligible(editor, text, latest?.type === 'assistant' && idle),
          }
        }
        function sync() {
          const editor = active()
          controller.update(snapshot(editor))
          const text = editor?.plainText ?? ''
          const suffix = controller.suffix
          setGhost(suffix)
          // The placeholder must be removed rather than painted over, including
          // transparent themes. Ghost text stays outside the edit buffer.
          if (hidden && (hidden.editor !== editor || !suffix || text)) restore()
          if (editor && suffix && !text && editor.placeholder && !hidden) {
            hidden = { editor, placeholder: editor.placeholder }
            editor.placeholder = null
          }
          if (!(editor && suffix && anchor)) return
          const cursor = editor.visualCursor
          setPosition({
            top: editor.y + cursor.visualRow - anchor.y,
            left: editor.x + cursor.visualCol - anchor.x,
            width: Math.max(1, editor.width - cursor.visualCol),
          })
        }
        const keypress = (event: KeyEvent) => {
          sync()
          const editor = active()
          if (!(editor && controller.suffix)) return
          const name = event.name?.toLowerCase()
          if (name === 'escape') {
            controller.dismiss()
            event.preventDefault()
            event.stopPropagation()
            return
          }
          const accept = acceptKey(event)
          if (!accept) {
            queueMicrotask(sync)
            return
          }
          const suffix = controller.suffix
          const chunk = accept === 'word' ? (suffix.match(wordChunk)?.[0] ?? suffix) : suffix
          editor.insertText(chunk)
          controller.accepted(editor.plainText)
          event.preventDefault()
          event.stopPropagation()
          sync()
        }
        const timer = setInterval(sync, 25)
        onMount(() => context.renderer.keyInput.prependListener('keypress', keypress))
        onCleanup(() => {
          clearInterval(timer)
          context.renderer.keyInput.removeListener('keypress', keypress)
          controller.dispose()
          restore()
          setStatus('')
        })
        return (
          <box
            ref={(box) => {
              anchor = box
            }}
            width={0}
            height={0}
          >
            <Show when={ghost()}>
              <box
                position="absolute"
                top={position().top}
                left={position().left}
                width={position().width}
                height={1}
                zIndex={50}
              >
                <text fg={context.theme.text.muted} wrapMode="none">
                  {ghost()}
                </text>
              </box>
            </Show>
          </box>
        )
      },
    })
    return () => {
      stopPrompt()
      stopStatus()
    }
  },
})
