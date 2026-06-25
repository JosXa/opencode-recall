import type {
  HistoryRenderer,
  TranscriptMessage,
  TranscriptPart,
  TranscriptWindow,
} from './transcript.js'

export class ChatmlRenderer implements HistoryRenderer<string> {
  public readonly format = 'chatml'

  public render(window: TranscriptWindow): string {
    const lines = [renderWindowStart(window)]

    for (const message of window.messages) {
      lines.push(renderMessage(message))
    }

    lines.push(renderNavigation(window), '</hist>')
    return lines.join('\n')
  }
}

function renderWindowStart(window: TranscriptWindow): string {
  const attrs = [
    attr('sid', window.sessionId),
    attr('dir', window.directory),
    attr('mode', window.mode),
    attr('range', `${window.startIndex}-${window.endIndex}`),
    attr('anchor', String(window.anchorIndex)),
    attr('total', String(window.totalMessages)),
  ]

  if (window.title !== undefined) {
    attrs.push(attr('title', window.title))
  }

  return `<hist ${attrs.join(' ')}>`
}

function renderMessage(message: TranscriptMessage): string {
  const lines = [
    `<|im_start|>${message.role} ${attr('name', message.id)} ${attr(
      'index',
      String(message.index),
    )} ${attr('time', new Date(message.timeCreated).toISOString())}`,
  ]

  for (const part of message.parts) {
    lines.push(renderPart(part))
  }

  lines.push('<|im_end|>')
  return lines.join('\n')
}

function renderPart(part: TranscriptPart): string {
  switch (part.type) {
    case 'file':
      return `<file_attachment ${attr('chars', String(part.chars))}${optionalAttr(
        'filename',
        part.filename,
      )}${optionalAttr('mime', part.mime)} omitted="true" />`
    case 'patch':
      return renderPatchPart(part.files, part.hash)
    case 'text':
      return part.text
    case 'tool':
      return renderToolPart(part)
    default: {
      const exhaustive: never = part
      throw new Error(`Unsupported transcript part: ${String(exhaustive)}`)
    }
  }
}

function renderPatchPart(files: readonly string[], hash: string | undefined): string {
  const hashAttr = optionalAttr('hash', hash)
  const fileLines = files.map((file) => `<file>${escapeText(file)}</file>`)
  return [`<patch${hashAttr}>`, ...fileLines, '</patch>'].join('\n')
}

function renderToolPart(part: Extract<TranscriptPart, { readonly type: 'tool' }>): string {
  const lines = [
    `<tool_call ${attr('name', part.toolName)} ${attr('status', part.status)}${optionalAttr(
      'call_id',
      part.callId,
    )}>`,
    renderPayloadStart('input', part.inputTruncated, part.originalInputChars),
    escapeText(part.input),
    '</input>',
  ]

  if (part.output !== undefined) {
    lines.push(
      renderPayloadStart(
        'output',
        part.outputTruncated,
        part.originalOutputChars ?? part.output.length,
      ),
      escapeText(part.output),
      '</output>',
    )
  }

  lines.push('</tool_call>')
  return lines.join('\n')
}

function renderPayloadStart(
  name: 'input' | 'output',
  truncated: boolean,
  originalChars: number,
): string {
  if (!truncated) {
    return `<${name}>`
  }

  return `<${name} ${attr('truncated', 'true')} ${attr('original_chars', String(originalChars))}>`
}

function renderNavigation(window: TranscriptWindow): string {
  const attrs = [attr('cur', window.anchorCursor)]

  if (window.previousCursor !== undefined) {
    attrs.push(attr('prev', window.previousCursor))
    attrs.push(attr('head', window.previousCursor))
  }

  if (window.nextCursor !== undefined) {
    attrs.push(attr('next', window.nextCursor))
    attrs.push(attr('tail', window.nextCursor))
  }

  return `<nav ${attrs.join(' ')} />`
}

function attr(name: string, value: string): string {
  return `${name}="${escapeAttr(value)}"`
}

function optionalAttr(name: string, value: string | undefined): string {
  if (value === undefined) {
    return ''
  }

  return ` ${attr(name, value)}`
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
}
