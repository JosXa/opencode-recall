export interface PromptExample {
  readonly situation: string
  readonly prompt: string
  readonly directory: string
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
  const parsed = JSON.parse(data) as { metadata?: Record<string, { text?: string }> }
  return parsed.metadata?.['opencode-snippets:submitted']?.text ?? fallback
}
