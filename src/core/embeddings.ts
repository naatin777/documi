import os from 'node:os'
import path from 'node:path'
import { DEFAULT_OLLAMA_MODEL, DEFAULT_ONNX_DTYPE, DEFAULT_ONNX_MODEL, DEFAULT_OPENAI_MODEL } from './config'
import type { OnnxDtype, RagConfig, RagProvider } from './config'

interface EmbeddingDocumentInput {
  title: string
  text: string
}

export interface EmbeddingProvider {
  /** キャッシュ分離キー（例: "onnx:onnx-community/embeddinggemma-300m-ONNX:q4"） */
  readonly id: string
  readonly provider: RagProvider
  readonly model: string
  embedDocuments(items: readonly EmbeddingDocumentInput[]): Promise<Float32Array[]>
  embedQuery(query: string): Promise<Float32Array>
}

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmbeddingError'
  }
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

const onnxPipelineCache = new Map<string, Promise<FeatureExtractor>>()

async function loadOnnxExtractor(model: string, dtype: OnnxDtype, cacheDir: string): Promise<FeatureExtractor> {
  const cacheKey = `${model}|${dtype}|${cacheDir}`
  const existing = onnxPipelineCache.get(cacheKey)
  if (existing) return existing

  const promise = (async () => {
    try {
      const transformers = await import('@huggingface/transformers')
      transformers.env.cacheDir = cacheDir
      const pipe = await transformers.pipeline('feature-extraction', model, { dtype })
      return pipe as unknown as FeatureExtractor
    } catch (error) {
      onnxPipelineCache.delete(cacheKey)
      throw new EmbeddingError(
        `ONNX Embedding モデル (${model}, dtype=${dtype}) の初期化に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })()

  onnxPipelineCache.set(cacheKey, promise)
  return promise
}

function extractMatrixRows(raw: unknown, expectedCount: number): Float32Array[] {
  if (!Array.isArray(raw)) {
    throw new EmbeddingError('Embedding 出力が配列形式ではありません')
  }
  if (raw.length === 0) return []
  if (typeof raw[0] === 'number') {
    return [normalizeVector(raw as number[])]
  }
  const rows = (raw as number[][]).map((row) => normalizeVector(row))
  if (rows.length !== expectedCount) {
    throw new EmbeddingError(`Embedding 返却件数が一致しません (expected=${expectedCount}, got=${rows.length})`)
  }
  return rows
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
      if (items.length === 0) return []
      const extractor = await loadOnnxExtractor(model, dtype, cacheDir)
      const prompts = items.map((item) => formatEmbeddingPrompt(model, 'document', item.text, item.title))
      const output = await extractor(prompts, { pooling, normalize: true })
      return extractMatrixRows(output.tolist(), items.length)
    },
    async embedQuery(query) {
      const extractor = await loadOnnxExtractor(model, dtype, cacheDir)
      const prompt = formatEmbeddingPrompt(model, 'query', query)
      const output = await extractor([prompt], { pooling, normalize: true })
      const rows = extractMatrixRows(output.tolist(), 1)
      return rows[0]!
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

  const embedBatch = async (texts: string[]): Promise<Float32Array[]> => {
    if (texts.length === 0) return []
    const res = await fetchFn(`${endpoint}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    })

    if (res.ok) {
      const data = (await res.json()) as { embeddings?: number[][] }
      if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
        throw new EmbeddingError(`Ollama /api/embed の応答形式が不正です (model=${model})`)
      }
      return data.embeddings.map((row) => normalizeVector(row))
    }

    // 古い Ollama バージョン向けフォールバック (/api/embeddings)
    if (res.status === 404) {
      const out: Float32Array[] = []
      for (const prompt of texts) {
        const legRes = await fetchFn(`${endpoint}/api/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt }),
        })
        if (!legRes.ok) {
          throw new EmbeddingError(`Ollama /api/embeddings が失敗しました (${legRes.status}): ${await legRes.text()}`)
        }
        const legData = (await legRes.json()) as { embedding?: number[] }
        if (!Array.isArray(legData.embedding)) {
          throw new EmbeddingError(`Ollama /api/embeddings の応答形式が不正です (model=${model})`)
        }
        out.push(normalizeVector(legData.embedding))
      }
      return out
    }

    throw new EmbeddingError(`Ollama /api/embed が失敗しました (${res.status}): ${await res.text()}`)
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
      return rows[0]!
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

  const embedBatch = async (texts: string[]): Promise<Float32Array[]> => {
    if (texts.length === 0) return []
    const apiKey = process.env[apiKeyEnv]?.trim()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    const res = await fetchFn(`${endpoint}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: texts }),
    })
    if (!res.ok) {
      throw new EmbeddingError(`OpenAI 互換 /embeddings が失敗しました (${res.status}): ${await res.text()}`)
    }
    const payload = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> }
    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
      throw new EmbeddingError(`OpenAI 互換 /embeddings の応答形式が不正です (model=${model})`)
    }
    const sorted = payload.data.toSorted((a, b) => (a.index ?? 0) - (b.index ?? 0))
    return sorted.map((item) => {
      if (!Array.isArray(item.embedding)) {
        throw new EmbeddingError('Embedding ベクトルが欠損しています')
      }
      return normalizeVector(item.embedding)
    })
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
      return rows[0]!
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
