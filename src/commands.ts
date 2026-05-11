export const HISTORY_SEARCH_COMMAND = 'history_search'
export const HISTORY_READ_COMMAND = 'history_read'

export function commandNames(): readonly string[] {
  return [HISTORY_SEARCH_COMMAND, HISTORY_READ_COMMAND]
}
