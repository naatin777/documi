import os from 'node:os'
import path from 'node:path'
import { Result } from 'better-result'
import { DEFAULT_OLLAMA_MODEL, DEFAULT_ONNX_DTYPE, DEFAULT_ONNX_MODEL, DEFAULT_OPENAI_MODEL } from './config'
import type { OnnxDtype, RagConfig, RagProvider } from './config'
import { EmbeddingInitError, EmbeddingRequestError, EmbeddingResponseError, type EmbeddingDomainError } from './errors'

interface EmbeddingDocumentInput {
  title: string
  text: string
}

export interface EmbeddingProvider {
  /** キャッシュ分離キー（例: "onnx:onnx-community/embeddinggemma-300m-ONNX:q4"） */
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

type FeatureExtractionOutput = {
  tolist(): unknown
}

type FeatureExtractor = (
  texts: string | string[],
  options?: { pooling?: 'mean' | 'last_token' | 'cls' | 'none'; normalize?: boolean },
) => Promise<FeatureExtractionOutput>

const onnxPipelineCache = new Map<string, Promise<Result<FeatureExtractor, EmbeddingInitError>>>()

async function loadOnnxExtractor(
  model: string,
  dtype: OnnxDtype,
  cacheDir: string,
): Promise<Result<FeatureExtractor, EmbeddingInitError>> {
  const cacheKey = `${model}|${dtype}|${cacheDir}`
  const existing = onnxPipelineCache.get(cacheKey)
  if (existing) return existing

  const promise = Result.tryPromise<FeatureExtractor, EmbeddingInitError>({
    try: async () => {
      const transformers = await import('@huggingface/transformers')
      transformers.env.cacheDir = cacheDir
      const pipe = await transformers.pipeline('feature-extraction', model, { dtype })
      return pipe
    },
    catch: (error) => {
      onnxPipelineCache.delete(cacheKey)
      return new EmbeddingInitError({
        provider: 'onnx',
        model,
        message: `ONNX Embedding モデル (${model}, dtype=${dtype}) の初期化に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      })
    },
  })

  onnxPipelineCache.set(cacheKey, promise)
  return promise
}

function extractMatrixRows(
  provider: string,
  model: string,
  raw: unknown,
  expectedCount: number,
): Result<Float32Array[], EmbeddingResponseError> {
  if (!Array.isArray(raw)) {
    return Result.err(
      new EmbeddingResponseError({ provider, model, message: 'Embedding 出力が配列形式ではありません' }),
    )
  }
  if (raw.length === 0) return Result.ok([])
  if (typeof raw[0] === 'number') {
    return Result.ok([normalizeVector(raw as number[])])
  }
  const rows = (raw as number[][]).map((row) => normalizeVector(row))
  if (rows.length !== expectedCount) {
    return Result.err(
      new EmbeddingResponseError({
        provider,
        model,
        message: `Embedding 返却件数が一致しません (expected=${expectedCount}, got=${rows.length})`,
      }),
    )
  }
  return Result.ok(rows)
}

/**
 * 組み込み ONNX (`@huggingface/transformers`) プロバイダ。外部デーモン不要でローカル完結する。
 * 既定モデル: `onnx-community/embeddinggemma-300m-ONNX` (`q4`)
 * @implements core.hybrid-rag
 */
function createOnnxEmbeddingProvider(options: {
  model?: string
  dtype?: OnnxDtype
  cacheDir?: string
}): EmbeddingProvider {
  const model = options.model ?? DEFAULT_ONNX_MODEL
  const dtype = options.dtype ?? DEFAULT_ONNX_DTYPE
  const cacheDir =
    options.cacheDir ?? process.env.DOCUMI_MODEL_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'documi', 'models')
  const pooling = model.toLowerCase().includes('qwen3-embedding') ? 'last_token' : 'mean'

  return {
    id: `onnx:${model}:${dtype}`,
    provider: 'onnx',
    model,
    async embedDocuments(items) {
      if (items.length === 0) return Result.ok([])
      return Result.gen(async function* () {
        const extractor = yield* Result.await(loadOnnxExtractor(model, dtype, cacheDir))
        const prompts = items.map((item) => formatEmbeddingPrompt(model, 'document', item.text, item.title))
        const output = yield* Result.await(
          Result.tryPromise({
            try: () => extractor(prompts, { pooling, normalize: true }),
            catch: (error) =>
              new EmbeddingRequestError({
                provider: 'onnx',
                model,
                message: `ONNX Embedding 推論に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
              }),
          }),
        )
        return extractMatrixRows('onnx', model, output.tolist(), items.length)
      })
    },
    async embedQuery(query) {
      return Result.gen(async function* () {
        const extractor = yield* Result.await(loadOnnxExtractor(model, dtype, cacheDir))
        const prompt = formatEmbeddingPrompt(model, 'query', query)
        const output = yield* Result.await(
          Result.tryPromise({
            try: () => extractor([prompt], { pooling, normalize: true }),
            catch: (error) =>
              new EmbeddingRequestError({
                provider: 'onnx',
                model,
                message: `ONNX Embedding 推論に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
              }),
          }),
        )
        const rows = yield* extractMatrixRows('onnx', model, output.tolist(), 1)
        return Result.ok(rows[0]!)
      })
    },
  }
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
          message: `Ollama /api/embed への接続に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
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
            message: `Ollama /api/embed の応答形式が不正です (model=${model})`,
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
              message: `Ollama /api/embeddings への接続に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
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
              message: `Ollama /api/embeddings が失敗しました (${legRes.status}): ${await legRes.text()}`,
            }),
          )
        }
        const legData = (await legRes.json()) as { embedding?: number[] }
        if (!Array.isArray(legData.embedding)) {
          return Result.err(
            new EmbeddingResponseError({
              provider: 'ollama',
              model,
              message: `Ollama /api/embeddings の応答形式が不正です (model=${model})`,
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
        message: `Ollama /api/embed が失敗しました (${res.status}): ${await res.text()}`,
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
          message: `OpenAI 互換 /embeddings への接続に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
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
          message: `OpenAI 互換 /embeddings が失敗しました (${res.status}): ${await res.text()}`,
        }),
      )
    }
    const payload = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> }
    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
      return Result.err(
        new EmbeddingResponseError({
          provider: 'openai',
          model,
          message: `OpenAI 互換 /embeddings の応答形式が不正です (model=${model})`,
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
            message: 'Embedding ベクトルが欠損しています',
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
  const provider: RagProvider = config.provider ?? 'onnx'
  if (provider === 'ollama') {
    return createOllamaEmbeddingProvider({
      model: config.model,
      endpoint: config.endpoint,
      fetchFn: options.fetchFn,
    })
  }
  if (provider === 'openai') {
    return createOpenAiEmbeddingProvider({
      model: config.model,
      endpoint: config.endpoint,
      apiKeyEnv: config.apiKeyEnv,
      fetchFn: options.fetchFn,
    })
  }
  return createOnnxEmbeddingProvider({
    model: config.model,
    dtype: config.dtype,
    cacheDir: config.cacheDir,
  })
}
