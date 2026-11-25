import type { RagConfig } from './config'
import { createEmbeddingProvider } from './embeddings'
import type { EmbeddingProvider } from './embeddings'
import { getDocument } from './loader'
import { assembleGraphContext, reciprocalRankFusion, searchIndexBm25 } from './retrieval'
import type { RetrieveContextOptions, RetrieveContextResult, SearchHit } from './retrieval'
import type { ArtifactType, DocsIndex } from './types'
import { searchVectorStore } from './vector-store'

export interface HybridSearchOptions {
  type?: ArtifactType
  limit?: number
  ragConfig?: RagConfig
  projectRoot?: string
  /** テストやカスタム呼び出し向けの注入プロバイダ */
  provider?: EmbeddingProvider
  /** true のとき Embedding 失敗時にエラーを投げず BM25 結果へフォールバックする（既定: true） */
  fallbackOnError?: boolean
}

export interface HybridRetrieveOptions extends RetrieveContextOptions {
  ragConfig?: RagConfig
  projectRoot?: string
  provider?: EmbeddingProvider
  fallbackOnError?: boolean
}

function summarizeSnippet(raw: string, maxChars = 140): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, maxChars - 1)}…`
}

function buildHitFromChunkKey(
  index: DocsIndex,
  key: string,
  score: number,
  bm25ByKey: ReadonlyMap<string, SearchHit>,
): SearchHit | undefined {
  const existing = bm25ByKey.get(key)
  if (existing) {
    return { ...existing, score }
  }
  if (key.startsWith('block:')) {
    const blockId = key.slice('block:'.length)
    const block = index.blocksById.get(blockId)
    if (!block) return undefined
    const doc = getDocument(index, block.docId)
    if (!doc) return undefined
    return {
      kind: 'block',
      id: block.id,
      docId: doc.id,
      type: doc.type,
      title: block.title ? `${block.id} — ${block.title}` : block.id,
      blockKind: block.kind,
      snippet: summarizeSnippet(block.rawBody),
      score,
    }
  }
  if (key.startsWith('doc:')) {
    const docId = key.slice('doc:'.length)
    const doc = getDocument(index, docId)
    if (!doc) return undefined
    return {
      kind: 'doc',
      id: doc.id,
      docId: doc.id,
      type: doc.type,
      title: doc.title,
      snippet: summarizeSnippet(doc.description || doc.body),
      score,
    }
  }
  return undefined
}

/**
 * BM25（日英＋用語展開）とローカル Embedding ベクトル検索を RRF（Reciprocal Rank Fusion）で統合するハイブリッド検索。
 * Embedding プロバイダが利用できない場合は BM25 へ安全にフォールバックする。
 * @implements core.hybrid-rag
 */
export async function searchIndexHybrid(
  docsDir: string,
  index: DocsIndex,
  rawQuery: string,
  options: HybridSearchOptions = {},
): Promise<{
  hits: SearchHit[]
  expandedTerms: string[]
  mode: 'hybrid' | 'bm25'
  modelId?: string
  fallbackReason?: string
}> {
  const query = rawQuery.trim()
  if (!query) return { hits: [], expandedTerms: [], mode: 'bm25' }

  const limit = options.limit ?? 30
  const candidateLimit = Math.max(limit * 3, 40)
  const bm25 = searchIndexBm25(index, query, { type: options.type, limit: candidateLimit })
  const provider = options.provider ?? createEmbeddingProvider(options.ragConfig)

  const vectorRes = await searchVectorStore(docsDir, index, provider, query, {
    type: options.type,
    limit: candidateLimit,
    cachePath: options.ragConfig?.cachePath,
    projectRoot: options.projectRoot,
  })

  if (vectorRes.isErr()) {
    if (options.fallbackOnError === false) throw vectorRes.error
    return {
      hits: bm25.hits.slice(0, limit),
      expandedTerms: bm25.expandedTerms,
      mode: 'bm25',
      fallbackReason: vectorRes.error.message,
    }
  }

  const vectorHits = vectorRes.value
  const bm25ByKey = new Map<string, SearchHit>()
  const bm25Ranking: Array<{ key: string }> = []
  for (const hit of bm25.hits) {
    const key = `${hit.kind}:${hit.id}`
    bm25ByKey.set(key, hit)
    bm25Ranking.push({ key })
  }

  const fused = reciprocalRankFusion([bm25Ranking, vectorHits], 60)
  const merged: SearchHit[] = []
  for (const [key, rrfScore] of fused.entries()) {
    // 可読性のため 1000 倍スケールで丸める（例: 0.0328 -> 32.79）
    const score = Math.round(rrfScore * 1000 * 100) / 100
    const hit = buildHitFromChunkKey(index, key, score, bm25ByKey)
    if (hit) merged.push(hit)
  }
  merged.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))

  return {
    hits: merged.slice(0, limit),
    expandedTerms: bm25.expandedTerms,
    mode: 'hybrid',
    modelId: provider.id,
  }
}

/**
 * BM25 + ローカル Embedding (RRF) + 明示グラフ展開を文字数予算内で 1 発返却するハイブリッド GraphRAG。
 * @implements core.hybrid-rag
 */
export async function retrieveContextHybrid(
  docsDir: string,
  index: DocsIndex,
  rawQuery: string,
  options: HybridRetrieveOptions = {},
): Promise<RetrieveContextResult> {
  const query = rawQuery.trim()
  const limit = Math.max(1, Math.min(options.limit ?? 8, 30))
  const includeGraph = options.includeGraph !== false

  const hybrid = await searchIndexHybrid(docsDir, index, query, {
    type: options.type,
    limit: Math.min(limit * 2 + 4, 60),
    ragConfig: options.ragConfig,
    projectRoot: options.projectRoot,
    provider: options.provider,
    fallbackOnError: options.fallbackOnError,
  })

  const mode: RetrieveContextResult['mode'] =
    hybrid.mode === 'hybrid' ? (includeGraph ? 'hybrid+graph' : 'hybrid') : includeGraph ? 'bm25+graph' : 'bm25'

  return assembleGraphContext(index, query, hybrid.hits, hybrid.expandedTerms, {
    limit,
    budget: options.budget,
    includeGraph,
    mode,
    modelId: hybrid.modelId,
    fallbackReason: hybrid.fallbackReason,
  })
}
