import type { JevBudget } from './jev.js'

export interface PooledSession {
  readonly cursor: string
  readonly title: string
  readonly directory: string
  readonly match: number
}

export class RecallRun {
  public readonly budget: JevBudget
  public readonly verdicts = new Map<string, number>()
  public readonly pool = new Map<string, PooledSession>()
  public readonly segmentScores = new Map<string, Promise<ReadonlyMap<number, SegmentScore>>>()

  public constructor(maxTokens: number) {
    this.budget = { spent: 0, cap: maxTokens }
  }

  #ready: Promise<void> | undefined

  public prepare(work: () => Promise<unknown>): Promise<void> {
    this.#ready ??= work().then(
      () => undefined,
      () => undefined,
    )
    return this.#ready
  }

  public get ready(): Promise<void> {
    return this.#ready ?? Promise.resolve()
  }

  public carried(limit: number): PooledSession[] {
    return [...this.pool.values()].sort((left, right) => right.match - left.match).slice(0, limit)
  }
}

export interface SegmentScore {
  readonly evidence: number
  readonly final: number
}

export class RecallRuns {
  readonly #runs = new Map<string, RecallRun>()
  readonly #maxTokens: number

  public constructor(maxTokens: number) {
    this.#maxTokens = maxTokens
  }

  public get(sessionID: string): RecallRun {
    const existing = this.#runs.get(sessionID)
    if (existing !== undefined) return existing
    const run = new RecallRun(this.#maxTokens)
    this.#runs.set(sessionID, run)
    return run
  }

  public end(sessionID: string): void {
    this.#runs.delete(sessionID)
  }

  public get size(): number {
    return this.#runs.size
  }
}
