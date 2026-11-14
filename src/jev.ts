export interface JudgeModel {
  readonly providerID: string
  readonly id: string
}

export interface DecisionQuestion {
  readonly type: 'predicate'
  readonly name: string
  readonly instructions: string
}

export interface DecisionRequest {
  readonly model: JudgeModel
  readonly input: { readonly type: 'text'; readonly text: string }[]
  readonly questions: DecisionQuestion[]
}

export interface DecisionAnswer {
  readonly type: string
  readonly name: string
  readonly probability?: number
  readonly message?: string
}

export interface DecisionResult {
  readonly answers: readonly DecisionAnswer[]
  readonly tokens?: { readonly input?: number }
}

export type Decide = (request: DecisionRequest) => Promise<DecisionResult>

export interface JevBudget {
  spent: number
  readonly cap: number
}

export const CHARS_PER_JEV_TOKEN = 2.9
const QUESTION_TOKENS = 25

export class Jev {
  public calls = 0
  public inputTokens = 0
  public failures = 0
  public budgetSkips = 0
  public lastError: string | undefined
  readonly #model: JudgeModel
  readonly #decide: Decide
  readonly #budget: JevBudget
  readonly #now: () => number
  #inFlight = 0
  #busySince = 0
  #busyMs = 0

  public constructor(model: JudgeModel, decide: Decide, budget: JevBudget, now = Date.now) {
    this.#model = model
    this.#decide = decide
    this.#budget = budget
    this.#now = now
  }

  public async ask(
    texts: readonly string[],
    questions: readonly DecisionQuestion[],
  ): Promise<ReadonlyMap<string, number> | undefined> {
    const estimate = estimateTokens(texts, questions)
    if (this.#budget.spent + estimate > this.#budget.cap) {
      this.budgetSkips += 1
      return undefined
    }
    this.#budget.spent += estimate
    const request: DecisionRequest = {
      model: this.#model,
      input: texts.map((text) => ({ type: 'text', text })),
      questions: [...questions],
    }
    this.#begin()
    const result = await this.#decide(request)
      .catch(() => this.#decide(request))
      .catch((error: unknown) => {
        this.failures += 1
        this.lastError = error instanceof Error ? error.message : String(error)
        return undefined
      })
      .finally(() => this.#end())
    if (result === undefined) {
      this.#budget.spent -= estimate
      return undefined
    }
    const tokens = result.tokens?.input ?? estimate
    this.#budget.spent += tokens - estimate
    this.calls += 1
    this.inputTokens += tokens
    return new Map(
      result.answers.flatMap((answer) =>
        answer.probability === undefined ? [] : [[answer.name, answer.probability] as const],
      ),
    )
  }

  public footer(): string {
    return `[jev calls=${this.calls} input_tokens=${this.inputTokens} ms=${Math.round(this.#busyMs)}]`
  }

  public problems(): string | undefined {
    const problems = [
      ...(this.failures === 0
        ? []
        : [`${this.failures} judge calls failed (${this.lastError ?? 'unknown error'})`]),
      ...(this.budgetSkips === 0
        ? []
        : [
            `${this.budgetSkips} judge calls skipped: the run reached its ${this.#budget.cap}-token judge budget`,
          ]),
    ]
    return problems.length === 0 ? undefined : `judge problems: ${problems.join('; ')}`
  }

  #begin(): void {
    if (this.#inFlight === 0) this.#busySince = this.#now()
    this.#inFlight += 1
  }

  #end(): void {
    this.#inFlight -= 1
    if (this.#inFlight === 0) this.#busyMs += this.#now() - this.#busySince
  }
}

function estimateTokens(texts: readonly string[], questions: readonly DecisionQuestion[]): number {
  const chars = texts.reduce((total, text) => total + text.length, 0)
  return Math.ceil(chars / CHARS_PER_JEV_TOKEN) + questions.length * QUESTION_TOKENS
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await run(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane))
  return results
}
