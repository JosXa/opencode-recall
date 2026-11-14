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
const UNAVAILABLE_AFTER_FAILURES = 3
const ERROR_CHARS = 160

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
  readonly #timeoutMs: number
  #inFlight = 0
  #busySince = 0
  #busyMs = 0

  public constructor(
    model: JudgeModel,
    decide: Decide,
    budget: JevBudget,
    now: () => number,
    timeoutMs: number,
  ) {
    this.#model = model
    this.#decide = decide
    this.#budget = budget
    this.#now = now
    this.#timeoutMs = timeoutMs
  }

  public async ask(
    texts: readonly string[],
    questions: readonly DecisionQuestion[],
  ): Promise<ReadonlyMap<string, number> | undefined> {
    if (this.unavailable) {
      this.failures += 1
      return undefined
    }
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
    const result = await this.#attempt(request)
      .catch(() => this.#attempt(request))
      .catch((error: unknown) => {
        this.failures += 1
        const message = (error instanceof Error ? error.message : String(error)).replace(
          /\s+/g,
          ' ',
        )
        this.lastError =
          message.length > ERROR_CHARS ? `${message.slice(0, ERROR_CHARS - 1)}…` : message
        return undefined
      })
      .finally(() => this.#end())
    if (result === undefined) {
      this.#budget.spent -= estimate
      return undefined
    }
    const tokens = result.tokens ?? estimate
    this.#budget.spent += tokens - estimate
    this.calls += 1
    this.inputTokens += tokens
    return result.probabilities
  }

  async #attempt(request: DecisionRequest): Promise<JudgedAnswers> {
    const timer = new AbortController()
    const timeout = new Promise<never>((_, reject) => {
      const handle = setTimeout(
        () => reject(new Error(`decision call timed out after ${this.#timeoutMs} ms`)),
        this.#timeoutMs,
      )
      timer.signal.addEventListener('abort', () => clearTimeout(handle))
    })
    const call = Promise.resolve()
      .then(() => this.#decide(request))
      .then((result) => judgedAnswers(request, result))
    return Promise.race([call, timeout]).finally(() => timer.abort())
  }

  public get unavailable(): boolean {
    return this.calls === 0 && this.failures >= UNAVAILABLE_AFTER_FAILURES
  }

  public get budgetSpent(): boolean {
    return this.budgetSkips > 0 && this.calls === 0 && this.failures === 0
  }

  public budgetNotice(fallback: string): string {
    return `judge budget spent: the run reached its ${this.#budget.cap}-token judge budget; ${fallback}`
  }

  public unavailableNotice(fallback: string): string {
    return `judge unavailable: ${this.failures} of ${this.failures + this.calls} decision calls failed (${this.lastError ?? 'unknown error'}); ${fallback}`
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

interface JudgedAnswers {
  readonly probabilities: ReadonlyMap<string, number>
  readonly tokens: number | undefined
}

function judgedAnswers(request: DecisionRequest, result: unknown): JudgedAnswers {
  const response = result as Partial<DecisionResult> | undefined
  if (!Array.isArray(response?.answers)) throw new Error('decision response has no answers')
  const probabilities = new Map(
    response.answers.flatMap((answer) =>
      typeof answer?.probability === 'number' && answer.probability >= 0 && answer.probability <= 1
        ? [[answer.name, answer.probability] as const]
        : [],
    ),
  )
  const missing = request.questions.filter((question) => !probabilities.has(question.name))
  if (missing.length > 0) {
    throw new Error(
      `decision response lacks valid answers for ${missing.length} of ${request.questions.length} questions`,
    )
  }
  const tokens = response.tokens?.input
  return { probabilities, tokens: typeof tokens === 'number' ? tokens : undefined }
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
