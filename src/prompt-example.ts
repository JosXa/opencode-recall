export interface PromptExample {
  readonly prompt: string
}

const whitespace = /\s+/gu

/** Query the start of the human draft, matching the prefixes already embedded in history. */
export function promptPrefix(text: string): string {
  return text.replace(whitespace, ' ').trim().slice(0, 256).trimEnd()
}

const automation =
  /^(?:use grounded-search|return your|you are |"?window:|reply (?:with|exactly)|"reply |<|capture-system-prompt|decide if the current title)/iu

export function isHumanPrompt(text: string): boolean {
  // Headless naming, scheduled research, and smoke tests are not writing style.
  return (
    text.trim().length > 0 &&
    text.length <= 4000 &&
    !automation.test(text.trim()) &&
    !text.includes('<system-reminder>')
  )
}

export function submittedPrompt(data: string, fallback: string): string {
  const parsed = JSON.parse(data) as { metadata?: Record<string, unknown> }
  return submittedText(parsed.metadata, fallback)
}

export function submittedText(
  metadata: Readonly<Record<string, unknown>> | undefined,
  fallback: string,
): string {
  const submitted = metadata?.['opencode-snippets:submitted']
  return submitted &&
    typeof submitted === 'object' &&
    'text' in submitted &&
    typeof submitted.text === 'string'
    ? submitted.text
    : fallback
}
