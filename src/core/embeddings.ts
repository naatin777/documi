import { Result } from 'better-result'
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OPENAI_MODEL } from './config'
import type { RagConfig, RagProvider } from './config'
import { EmbeddingRequestError, EmbeddingResponseError, type EmbeddingDomainError } from './errors'

interface EmbeddingDocumentInput {
  title: string
  text: string
}

export interface EmbeddingProvider {
  /** キャッシュ分離キー（例: "ollama:embeddinggemma"） */
  readonly id: string
  readonly provider: RagProvider
  readonly model: string
  embedDocuments(items: readonly EmbeddingDocumentInput[]): Promise<Result<Float32Array[], EmbeddingDomainError>>
  embedQuery(query: string): Promise<Result<Float32Array, EmbeddingDomainError>>
}

export function normalizeVector(input: ArrayLike<number>): Float32Array {
  const out = new Float32Array(input.length)
  let sumSq = 0
  for (let i = 0; i < input.length; i++) {
    const v = input[i] ?? 0
    out[i] = v
    sumSq += v * v
  }
  const norm = Math.sqrt(sumSq)
  if (norm > 0) {
    for (let i = 0; i < out.length; i++) {
      out[i] = out[i]! / norm
    }
  }
  return out
}

export function dotProduct(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < len; i++) {
    sum += a[i]! * b[i]!
  }
  return sum
}

/**
 * モデル系列に応じた公式推奨プロンプト接頭辞を付与する。
 * EmbeddingGemma / Qwen3-Embedding / ruri-v3 は検索クエリと文書の接頭辞を使い分けることで精度が大きく向上する。
 */
export function formatEmbeddingPrompt(model: string, role: 'query' | 'document', text: string, title?: string): string {
  const low = model.toLowerCase()
  const cleanText = text.trim()
  const cleanTitle = title?.trim()

  if (low.includes('embeddinggemma')) {
    if (role === 'query') return `task: search result | query: ${cleanText}`
    return `title: ${cleanTitle || 'none'} | text: ${cleanText}`
  }

  if (low.includes('qwen3-embedding')) {
    if (role === 'query') {
      return `Instruct: Given a specification search query, retrieve relevant living specification passages\nQuery: ${cleanText}`
    }
    return cleanTitle ? `${cleanTitle}\n${cleanText}` : cleanText
  }

  if (low.includes('ruri')) {
    if (role === 'query') return `検索クエリ: ${cleanText}`
    return `検索文書: ${cleanTitle ? `${cleanTitle}\n` : ''}${cleanText}`
  }

  if (role === 'document' && cleanTitle) {
    return `${cleanTitle}\n${cleanText}`
  }
  return cleanText
}

/**
 * Ollama ローカル HTTP プロバイダ（`/api/embed` およびレガシー `/api/embeddings` 自動フォールバック）。
 * @implements core.hybrid-rag
 */
function createOllamaEmbeddingProvider(options: {
  model?: string
  endpoint?: string
  fetchFn?: typeof fetch
}): EmbeddingProvider {
  const model = options.model ?? DEFAULT_OLLAMA_MODEL
  const endpoint = (options.endpoint ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/+$/, '')
  const fetchFn = options.fetchFn ?? fetch

  const embedBatch = async (texts: string[]): Promise<Result<Float32Array[], EmbeddingDomainError>> => {
    if (texts.length === 0) return Result.ok([])
    const resResult = await Result.tryPromise({
      try: () =>
        fetchFn(`${endpoint}/api/embed`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, input: texts }),
        }),
      catch: (error) =>
        new EmbeddingRequestError({
          provider: 'ollama',
          model,
          message: `Failed to connect to Ollama /api/embed: ${error instanceof Error ? error.message : String(error)}`,
        }),
    })
    if (resResult.isErr()) return resResult
    const res = resResult.value

    if (res.ok) {
      const data = (await res.json()) as { embeddings?: number[][] }
      if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
        return Result.err(
          new EmbeddingResponseError({
            provider: 'ollama',
            model,
            message: `Invalid response from Ollama /api/embed (model=${model})`,
          }),
        )
      }
      return Result.ok(data.embeddings.map((row) => normalizeVector(row)))
    }

    // 古い Ollama バージョン向けフォールバック (/api/embeddings)
    if (res.status === 404) {
      const out: Float32Array[] = []
      for (const prompt of texts) {
        const legResResult = await Result.tryPromise({
          try: () =>
            fetchFn(`${endpoint}/api/embeddings`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model, prompt }),
            }),
          catch: (error) =>
            new EmbeddingRequestError({
              provider: 'ollama',
              model,
              message: `Failed to connect to Ollama /api/embeddings: ${error instanceof Error ? error.message : String(error)}`,
            }),
        })
        if (legResResult.isErr()) return legResResult
        const legRes = legResResult.value
        if (!legRes.ok) {
          return Result.err(
            new EmbeddingRequestError({
              provider: 'ollama',
              model,
              status: legRes.status,
              message: `Ollama /api/embeddings failed (${legRes.status}): ${await legRes.text()}`,
            }),
          )
        }
        const legData = (await legRes.json()) as { embedding?: number[] }
        if (!Array.isArray(legData.embedding)) {
          return Result.err(
            new EmbeddingResponseError({
              provider: 'ollama',
              model,
              message: `Invalid response from Ollama /api/embeddings (model=${model})`,
            }),
          )
        }
        out.push(normalizeVector(legData.embedding))
      }
      return Result.ok(out)
    }

    return Result.err(
      new EmbeddingRequestError({
        provider: 'ollama',
        model,
        status: res.status,
        message: `Ollama /api/embed failed (${res.status}): ${await res.text()}`,
      }),
    )
  }

  return {
    id: `ollama:${model}`,
    provider: 'ollama',
    model,
    embedDocuments(items) {
      return embedBatch(items.map((item) => formatEmbeddingPrompt(model, 'document', item.text, item.title)))
    },
    async embedQuery(query) {
      const rows = await embedBatch([formatEmbeddingPrompt(model, 'query', query)])
      return rows.map((list) => list[0]!)
    },
  }
}

/**
 * OpenAI 互換 HTTP プロバイダ（OpenAI / LM Studio / vLLM / LocalAI 等で利用可能）。
 * @implements core.hybrid-rag
 */
function createOpenAiEmbeddingProvider(options: {
  model?: string
  endpoint?: string
  apiKeyEnv?: string
  fetchFn?: typeof fetch
}): EmbeddingProvider {
  const model = options.model ?? DEFAULT_OPENAI_MODEL
  const endpoint = (options.endpoint ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
  const apiKeyEnv = options.apiKeyEnv ?? 'OPENAI_API_KEY'
  const fetchFn = options.fetchFn ?? fetch

  const embedBatch = async (texts: string[]): Promise<Result<Float32Array[], EmbeddingDomainError>> => {
    if (texts.length === 0) return Result.ok([])
    const apiKey = process.env[apiKeyEnv]?.trim()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    const resResult = await Result.tryPromise({
      try: () =>
        fetchFn(`${endpoint}/embeddings`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, input: texts }),
        }),
      catch: (error) =>
        new EmbeddingRequestError({
          provider: 'openai',
          model,
          message: `Failed to connect to OpenAI-compatible /embeddings: ${error instanceof Error ? error.message : String(error)}`,
        }),
    })
    if (resResult.isErr()) return resResult
    const res = resResult.value

    if (!res.ok) {
      return Result.err(
        new EmbeddingRequestError({
          provider: 'openai',
          model,
          status: res.status,
          message: `OpenAI-compatible /embeddings failed (${res.status}): ${await res.text()}`,
        }),
      )
    }
    const payload = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> }
    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
      return Result.err(
        new EmbeddingResponseError({
          provider: 'openai',
          model,
          message: `Invalid response from OpenAI-compatible /embeddings (model=${model})`,
        }),
      )
    }
    const sorted = payload.data.toSorted((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const vectors: Float32Array[] = []
    for (const item of sorted) {
      if (!Array.isArray(item.embedding)) {
        return Result.err(
          new EmbeddingResponseError({
            provider: 'openai',
            model,
            message: 'Missing embedding vector in response',
          }),
        )
      }
      vectors.push(normalizeVector(item.embedding))
    }
    return Result.ok(vectors)
  }

  return {
    id: `openai:${model}`,
    provider: 'openai',
    model,
    embedDocuments(items) {
      return embedBatch(items.map((item) => formatEmbeddingPrompt(model, 'document', item.text, item.title)))
    },
    async embedQuery(query) {
      const rows = await embedBatch([formatEmbeddingPrompt(model, 'query', query)])
      return rows.map((list) => list[0]!)
    },
  }
}

/**
 * 設定（`.documi.json` の `rag` セクションまたは CLI 引数）から適切な EmbeddingProvider を構築する。
 * @implements core.hybrid-rag
 */
export function createEmbeddingProvider(
  config: RagConfig = {},
  options: { fetchFn?: typeof fetch } = {},
): EmbeddingProvider {
  const provider: RagProvider = config.provider ?? 'ollama'
  if (provider === 'openai') {
    return createOpenAiEmbeddingProvider({
      model: config.model,
      endpoint: config.endpoint,
      apiKeyEnv: config.apiKeyEnv,
      fetchFn: options.fetchFn,
    })
  }
  return createOllamaEmbeddingProvider({
    model: config.model,
    endpoint: config.endpoint,
    fetchFn: options.fetchFn,
  })
}
