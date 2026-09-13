import { existsSync } from 'node:fs'
import {
  canonicalPath,
  defaultIndexPath,
  hostDatabasePath,
  loadConfig,
  type RecallSource,
} from './config.js'
import { qualifyCursor, SOURCE_ID_PATTERN } from './cursor.js'

export interface SourceOptions {
  readonly sources?: readonly RecallSource[] | undefined
  readonly historyDbPath?: string | undefined
  readonly sidecarDbPath?: string | undefined
}

export interface ResolvedSource {
  readonly id: string
  readonly path: string
  readonly indexPath: string
}

export function resolveSources(options: SourceOptions = {}): ResolvedSource[] {
  const config = loadConfig().database
  const explicitPath = options.historyDbPath !== undefined || options.sidecarDbPath !== undefined
  const configured = options.sources ?? (explicitPath ? undefined : config.sources)
  const path = options.historyDbPath ?? config.path
  const raw: readonly RecallSource[] = configured ?? [
    {
      id: 'default',
      path,
      indexPath:
        options.sidecarDbPath ??
        (options.historyDbPath === undefined ? config.indexPath : defaultIndexPath(path)),
    },
    // The former attachment option now gets its own event cursor and index.
    ...(!explicitPath && config.legacyPath !== undefined
      ? [{ id: 'legacy', path: config.legacyPath }]
      : []),
  ]
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error('database.sources must be a non-empty array')
  const sources = raw.map(normalizeSource)
  validateSources(sources)
  return sources
}

function validateSources(sources: readonly ResolvedSource[]): void {
  const ids = new Set<string>()
  const paths = new Set<string>()
  const indexes = new Set<string>()
  for (const source of sources) {
    if (ids.has(source.id)) throw new Error(`Duplicate Recall source id: ${source.id}`)
    if (paths.has(source.path)) throw new Error(`Duplicate Recall source database: ${source.path}`)
    if (indexes.has(source.indexPath))
      throw new Error(`Recall sources cannot share a sidecar: ${source.indexPath}`)
    ids.add(source.id)
    paths.add(source.path)
    indexes.add(source.indexPath)
  }
  for (const index of indexes) {
    if (paths.has(index)) throw new Error(`Recall sidecar aliases a source database: ${index}`)
  }
}

export function sourceAvailable(source: ResolvedSource): boolean {
  return existsSync(source.path)
}

function normalizeSource(source: RecallSource): ResolvedSource {
  if (typeof source?.id !== 'string' || !SOURCE_ID_PATTERN.test(source.id))
    throw new Error('Recall source id must contain only letters, digits, _ or -')
  if (typeof source.path !== 'string' || source.path.trim() === '')
    throw new Error(`Recall source ${source.id} requires a path`)
  if (
    source.indexPath !== undefined &&
    (typeof source.indexPath !== 'string' || source.indexPath.trim() === '')
  )
    throw new Error(`Recall source ${source.id} requires a non-empty indexPath`)
  return {
    id: source.id,
    path: canonicalPath(source.path),
    indexPath: canonicalPath(source.indexPath ?? defaultIndexPath(source.path)),
  }
}

export function currentSessionCursor(value: string, options: SourceOptions): string {
  if (value.includes('::') || value === '') return value
  const sources = resolveSources(options)
  const host = sources.find((source) => source.path === hostDatabasePath())
  return qualifyCursor(value, host?.id)
}
