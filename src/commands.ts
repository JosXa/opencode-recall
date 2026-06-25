export const HISTORY_SEARCH_COMMAND = 'history_search'
export const HISTORY_READ_COMMAND = 'history_read'
export const RECALL_AGENT_NAME = 'recall'

export const RECALL_AGENT_DESCRIPTION =
  'Past OpenCode session recall. Source-grounded. Sole history-tool path; starts out with fresh context window. **Reinvoke** subagent for follow-ups/detail.'

export function commandNames(): readonly string[] {
  return [HISTORY_SEARCH_COMMAND, HISTORY_READ_COMMAND]
}
