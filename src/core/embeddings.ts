import { Result } from 'better-result'
import { DEFAULT_GEMINI_ENDPOINT, DEFAULT_GEMINI_MODEL, DEFAULT_OLLAMA_MODEL, DEFAULT_OPENAI_MODEL } from './config'
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

function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

interface ProviderPreset {
  model: string
  endpoint: string
  apiKeyEnv?: string
}

function resolveProviderPreset(provider: RagProvider, config: RagConfig): ProviderPreset {
  if (provider === 'ollama') {
    const base = (config.endpoint ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/+$/, '')
    const endpoint = /\/v1$/i.test(base) ? base : `${base}/v1`
    return {
      model: config.model ?? DEFAULT_OLLAMA_MODEL,
      endpoint,
      apiKeyEnv: config.apiKeyEnv,
    }
  }
  if (provider === 'gemini') {
    return {
      model: config.model ?? DEFAULT_GEMINI_MODEL,
      endpoint: (config.endpoint ?? DEFAULT_GEMINI_ENDPOINT).replace(/\/+$/, ''),
      apiKeyEnv: config.apiKeyEnv ?? 'GEMINI_API_KEY',
    }
  }
  return {
    model: config.model ?? DEFAULT_OPENAI_MODEL,
    endpoint: (config.endpoint ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKeyEnv: config.apiKeyEnv ?? 'OPENAI_API_KEY',
  }
}

/**
 * 統一 OpenAI 互換 HTTP Embedding プロバイダ。
 * Ollama (`/v1/embeddings`)・OpenAI・Gemini OpenAI 互換・LM Studio・vLLM 等を単一実装で扱う。
 * ローカルエンドポイント (`localhost` / `127.0.0.1` / `::1`) では API キーなしでも接続できる。
 * @implements core.hybrid-rag
 */
export function createEmbeddingProvider(
  config: RagConfig = {},
  options: { fetchFn?: typeof fetch } = {},
): EmbeddingProvider {
  const provider: RagProvider = config.provider ?? 'ollama'
  const { model, endpoint, apiKeyEnv } = resolveProviderPreset(provider, config)
  const fetchFn = options.fetchFn ?? fetch

  const embedBatch = async (texts: string[]): Promise<Result<Float32Array[], EmbeddingDomainError>> => {
    if (texts.length === 0) return Result.ok([])
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv]?.trim() : undefined
    if (!apiKey && apiKeyEnv && !isLocalEndpoint(endpoint)) {
      return Result.err(
        new EmbeddingRequestError({
          provider,
          model,
          message: `Missing API key: set ${apiKeyEnv} in .env or environment`,
        }),
      )
    }
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
          provider,
          model,
          message: `Failed to connect to ${provider} /embeddings: ${error instanceof Error ? error.message : String(error)}`,
        }),
    })
    if (resResult.isErr()) return resResult
    const res = resResult.value

    if (!res.ok) {
      return Result.err(
        new EmbeddingRequestError({
          provider,
          model,
          status: res.status,
          message: `${provider} /embeddings failed (${res.status}): ${await res.text()}`,
        }),
      )
    }
    const payload = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> }
    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
      return Result.err(
        new EmbeddingResponseError({
          provider,
          model,
          message: `Invalid response from ${provider} /embeddings (model=${model})`,
        }),
      )
    }
    const sorted = payload.data.toSorted((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const vectors: Float32Array[] = []
    for (const item of sorted) {
      if (!Array.isArray(item.embedding)) {
        return Result.err(
          new EmbeddingResponseError({
            provider,
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
    id: `${provider}:${model}`,
    provider,
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
