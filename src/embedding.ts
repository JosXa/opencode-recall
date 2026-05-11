export interface EmbeddingProvider {
  readonly model: string
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>
}

interface OllamaEmbedResponse {
  readonly embeddings?: unknown
}

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'
const DEFAULT_EMBED_MODEL = 'mxbai-embed-large'

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  public readonly model: string
  readonly #baseUrl: string

  public constructor() {
    const { OPENCODE_RECALL_EMBED_MODEL: model, OPENCODE_RECALL_OLLAMA_URL: baseUrl } = process.env
    this.model = model === undefined || model.length === 0 ? DEFAULT_EMBED_MODEL : model
    this.#baseUrl = baseUrl === undefined || baseUrl.length === 0 ? DEFAULT_OLLAMA_URL : baseUrl
  }

  public async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    if (texts.length === 0) {
      return []
    }

    const response = await this.#requestEmbeddings(texts)

    if (!response.ok) {
      throw new Error(
        `${this.#setupInstructions()}\n\nOllama embedding request failed: ${response.status} ${response.statusText}: ${await response.text()}`,
      )
    }

    const body = (await response.json()) as OllamaEmbedResponse

    if (!Array.isArray(body.embeddings)) {
      throw new Error('Ollama embedding response did not include embeddings')
    }

    return body.embeddings.map((embedding) => {
      if (!(Array.isArray(embedding) && embedding.every((value) => typeof value === 'number'))) {
        throw new Error('Ollama embedding response included a non-numeric vector')
      }

      return new Float32Array(embedding)
    })
  }

  async #requestEmbeddings(texts: readonly string[]): Promise<Response> {
    try {
      return await fetch(`${this.#baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts, keep_alive: '5m' }),
      })
    } catch (error) {
      throw new Error(`${this.#setupInstructions()}\n\n${String(error)}`)
    }
  }

  #setupInstructions(): string {
    return [
      `opencode-recall semantic search requires Ollama at ${this.#baseUrl} with embedding model ${this.model}.`,
      'Install Ollama: https://ollama.com/download or your OS package manager.',
      'Start Ollama: `ollama serve` or `sudo systemctl enable --now ollama`.',
      `Install the embedding model: \`ollama pull ${this.model}\`.`,
      'Override with OPENCODE_RECALL_OLLAMA_URL and OPENCODE_RECALL_EMBED_MODEL if needed.',
    ].join('\n')
  }
}
