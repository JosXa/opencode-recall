/** Use provider-enforced JSON for Responses autocomplete, including session next actions. */
export const autocompleteFormat = {
  type: 'json_schema',
  name: 'recall_autocomplete',
  strict: true,
  schema: {
    type: 'object',
    properties: { continuation: { type: 'string' } },
    required: ['continuation'],
    additionalProperties: false,
  },
}

export const autocompleteVariant = 'recall-autocomplete-json'

export async function constrainAutocompleteRequest(
  request: Request,
  prompts: readonly string[],
): Promise<Request> {
  if (prompts.length === 0 || !new URL(request.url).pathname.endsWith('/responses')) return request
  const raw = await request.clone().text()
  // Match our exact pending prompt so another plugin's concurrent generation is untouched.
  if (!prompts.some((prompt) => raw.includes(JSON.stringify(prompt)))) return request
  const body = JSON.parse(raw) as { text?: Record<string, unknown> }
  const headers = new Headers(request.headers)
  headers.delete('content-length')
  return new Request(request, {
    headers,
    body: JSON.stringify({ ...body, text: { ...body.text, format: autocompleteFormat } }),
  })
}
