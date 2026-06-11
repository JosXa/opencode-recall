import { loadConfig } from './config'

export interface EmbeddingProvider {
  readonly model: string
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>
}

interface OllamaEmbedResponse {
  readonly embeddings?: unknown
}

interface OllamaTagsResponse {
  readonly models?: unknown
}

interface EmbeddingSuccess {
  readonly embeddings: readonly Float32Array[]
}

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'
const DEFAULT_EMBED_MODEL = 'all-minilm'
const MAX_EMBED_INPUT_CHARS = 256
const MIN_RETRY_INPUT_CHARS = 16
const OLLAMA_STARTUP_TIMEOUT_MS = 10_000
const OLLAMA_STARTUP_POLL_MS = 200

export interface OllamaEmbeddingProviderOptions {
  readonly baseUrl?: string
  readonly model?: string
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  public readonly model: string
  readonly #baseUrl: string
  #ready: Promise<void> | undefined
  #serverProcess: Bun.Subprocess | undefined

  public constructor(options: OllamaEmbeddingProviderOptions = {}) {
    const config =
      options.baseUrl === undefined && options.model === undefined
        ? loadConfig().embeddings
        : undefined
    const configuredModel = options.model ?? config?.model
    const configuredBaseUrl = options.baseUrl ?? config?.ollamaUrl
    this.model =
      configuredModel === undefined || configuredModel.length === 0
        ? DEFAULT_EMBED_MODEL
        : configuredModel
    this.#baseUrl =
      configuredBaseUrl === undefined || configuredBaseUrl.length === 0
        ? DEFAULT_OLLAMA_URL
        : configuredBaseUrl
  }

  public close(): void {
    this.#serverProcess?.kill()
    this.#serverProcess = undefined
  }

  public async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    if (texts.length === 0) {
      return []
    }

    await this.#ensureReady()
    return this.#embedNormalized(texts.map(normalizeEmbedInput))
  }

  async #ensureReady(): Promise<void> {
    this.#ready ??= this.#ensureReadyOnce()
    return this.#ready
  }

  async #ensureReadyOnce(): Promise<void> {
    if (await this.#isServerReady()) {
      await this.#ensureModel()
      return
    }

    this.#startServer()
    const started = await this.#waitForServer()

    if (started) {
      await this.#ensureModel()
      return
    }

    throw new Error(
      `${this.#setupInstructions()}\n\nOllama did not become ready within ${OLLAMA_STARTUP_TIMEOUT_MS}ms after starting \`ollama serve\`.`,
    )
  }

  async #isServerReady(): Promise<boolean> {
    try {
      const response = await fetch(`${this.#baseUrl}/api/version`)
      return response.ok
    } catch {
      return false
    }
  }

  #startServer(): void {
    try {
      this.#serverProcess = Bun.spawn({
        cmd: ['ollama', 'serve'],
        env: { ...process.env, OLLAMA_HOST: ollamaHost(this.#baseUrl) },
        stdout: 'ignore',
        stderr: 'ignore',
      })
      this.#serverProcess.unref()
    } catch (error) {
      throw new Error(
        `${this.#setupInstructions()}\n\nFailed to start \`ollama serve\`: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async #waitForServer(): Promise<boolean> {
    const deadline = Date.now() + OLLAMA_STARTUP_TIMEOUT_MS

    while (Date.now() < deadline) {
      await Bun.sleep(OLLAMA_STARTUP_POLL_MS)

      if (await this.#isServerReady()) {
        return true
      }
    }

    return false
  }

  async #ensureModel(): Promise<void> {
    const response = await fetch(`${this.#baseUrl}/api/tags`)

    if (!response.ok) {
      throw new Error(
        `${this.#setupInstructions()}\n\nOllama model list failed: ${response.status} ${response.statusText}: ${await response.text()}`,
      )
    }

    const body = (await response.json()) as OllamaTagsResponse

    if (hasModel(body.models, this.model)) {
      return
    }

    await this.#pullModel()
  }

  async #pullModel(): Promise<void> {
    const response = await fetch(`${this.#baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, stream: false }),
    })

    if (response.ok) {
      return
    }

    throw new Error(
      `${this.#setupInstructions()}\n\nOllama model pull failed for ${this.model}: ${response.status} ${response.statusText}: ${await response.text()}`,
    )
  }

  async #embedNormalized(texts: readonly string[]): Promise<readonly Float32Array[]> {
    const response = await this.#requestEmbeddings(texts)

    if (response.ok) {
      return (await parseEmbeddingResponse(response)).embeddings
    }

    const responseText = await response.text()
    if (texts.length > 1 && isContextLengthError(responseText)) {
      const midpoint = Math.ceil(texts.length / 2)
      const left = await this.#embedNormalized(texts.slice(0, midpoint))
      const right = await this.#embedNormalized(texts.slice(midpoint))
      return [...left, ...right]
    }

    const [text] = texts
    if (text !== undefined && isContextLengthError(responseText)) {
      const shortened = shortenRetryInput(text)
      if (shortened !== text) {
        return this.#embedNormalized([shortened])
      }
    }

    throw new Error(
      `${this.#setupInstructions()}\n\nOllama embedding request failed: ${response.status} ${response.statusText}: ${responseText}`,
    )
  }

  async #requestEmbeddings(texts: readonly string[]): Promise<Response> {
    try {
      return await fetch(`${this.#baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts, keep_alive: '3m' }),
      })
    } catch (error) {
      throw new Error(
        `${this.#setupInstructions()}\n\n${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  #setupInstructions(): string {
    return [
      `opencode-recall semantic search requires Ollama at ${this.#baseUrl} with embedding model ${this.model}.`,
      'Install Ollama: https://ollama.com/download or your OS package manager.',
      'Start Ollama: `ollama serve` or `sudo systemctl enable --now ollama`.',
      `Install the embedding model: \`ollama pull ${this.model}\`.`,
      'Configure with <opencode-config>/recall.jsonc, or override with OPENCODE_RECALL_OLLAMA_URL and OPENCODE_RECALL_EMBED_MODEL.',
    ].join('\n')
  }
}

async function parseEmbeddingResponse(response: Response): Promise<EmbeddingSuccess> {
  const body = (await response.json()) as OllamaEmbedResponse

  if (!Array.isArray(body.embeddings)) {
    throw new Error('Ollama embedding response did not include embeddings')
  }

  return {
    embeddings: body.embeddings.map((embedding) => {
      if (Array.isArray(embedding) && embedding.every((value) => typeof value === 'number')) {
        return new Float32Array(embedding)
      }

      throw new Error('Ollama embedding response included a non-numeric vector')
    }),
  }
}

function isContextLengthError(responseText: string): boolean {
  return responseText.toLowerCase().includes('context length')
}

function shortenRetryInput(text: string): string {
  if (text.length <= MIN_RETRY_INPUT_CHARS) {
    return text
  }

  return text.slice(0, Math.max(MIN_RETRY_INPUT_CHARS, Math.floor(text.length / 2))).trim()
}

function ollamaHost(baseUrl: string): string {
  const url = new URL(baseUrl)
  return url.port.length === 0 ? url.hostname : `${url.hostname}:${url.port}`
}

function hasModel(models: unknown, model: string): boolean {
  if (!Array.isArray(models)) {
    return false
  }

  return models.some((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return false
    }

    const name = 'name' in entry ? entry.name : undefined
    const modelName = 'model' in entry ? entry.model : undefined
    return modelMatches(name, model) || modelMatches(modelName, model)
  })
}

function modelMatches(value: unknown, model: string): boolean {
  return typeof value === 'string' && (value === model || value.startsWith(`${model}:`))
}

function normalizeEmbedInput(text: string): string {
  const normalized = text.replaceAll(/\s+/gu, ' ').trim()
  return normalized.length > MAX_EMBED_INPUT_CHARS
    ? normalized.slice(0, MAX_EMBED_INPUT_CHARS)
    : normalized
}
