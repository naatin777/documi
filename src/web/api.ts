import { hc } from 'hono/client'
import type { ClientResponse, InferResponseType } from 'hono/client'
import type { SearchHit } from '../core/bundle'
import type { CodeTreeNode } from '../core/code'
import type { ArtifactType, BlockKind, Document, DocTreeNode, Stability } from '../core/types'
import type { ApiRoutes } from '../server/app'
import type { StaticSearchEntry } from '../server/site'

interface DocumiStaticConfig {
  mode: 'static'
  basePath: string
  includeCode: boolean
  generatedAt: string
}

declare global {
  interface Window {
    __DOCUMI_STATIC__?: DocumiStaticConfig
  }
}

export function isStaticSite(): boolean {
  return typeof window !== 'undefined' && window.__DOCUMI_STATIC__?.mode === 'static'
}

export function staticAssetUrl(relPath: string): string {
  const base = (typeof window !== 'undefined' && window.__DOCUMI_STATIC__?.basePath) || './'
  const cleanBase = base.endsWith('/') ? base : `${base}/`
  const cleanRel = relPath.replace(/^\/+/, '')
  return `${cleanBase}${cleanRel}`
}

const rpc = hc<ApiRoutes>('/')

/** サーバー側 Hono ルート定義から自動推論されるレスポンス型（手書き二重管理なし） */
// Hono の JSONParsed は再帰型 DocTreeNode[] / CodeTreeNode[] を JSONValue へ丸めるため tree のみ復元する
type TreeResponse = Omit<InferResponseType<typeof rpc.api.tree.$get, 200>, 'tree'> & {
  tree: DocTreeNode[]
}
type CodeTreeResponse = Omit<InferResponseType<typeof rpc.api.code.tree.$get, 200>, 'tree'> & {
  tree: CodeTreeNode[]
}
type StatusResponse = InferResponseType<typeof rpc.api.status.$get, 200>
type OverviewResponse = InferResponseType<typeof rpc.api.overview.$get, 200>
type DocumentsResponse = InferResponseType<typeof rpc.api.documents.$get, 200>
type DocumentResponse = InferResponseType<(typeof rpc.api.documents)[':id{.+}']['$get'], 200>
type HistoryResponse = InferResponseType<typeof rpc.api.history.$get, 200>
type RevisionResponse = InferResponseType<typeof rpc.api.history.revision.$get, 200>
type TermsResponse = InferResponseType<typeof rpc.api.terms.$get, 200>
type SearchResponse = InferResponseType<typeof rpc.api.search.$get, 200>
type BundleResponse = InferResponseType<typeof rpc.api.bundle.$get, 200>
type BlockDiffResponse = InferResponseType<(typeof rpc.api.blocks)[':id']['diff']['$get'], 200>
type SourceResponse = InferResponseType<typeof rpc.api.source.$get, 200>
type SourceExportsResponse = InferResponseType<typeof rpc.api.source.exports.$get, 200>
type CodeFileResponse = InferResponseType<typeof rpc.api.code.file.$get, 200>
type IconManifestResponse = InferResponseType<typeof rpc.api.icons.manifest.$get, 200>

export type GraphResponse = InferResponseType<typeof rpc.api.graph.$get, 200>
export type GraphNodeItem = GraphResponse['nodes'][number]
export type GraphEdgeItem = GraphResponse['edges'][number]
export type TermEntry = TermsResponse['terms'][number]
export type ReviewBlocksResponse = InferResponseType<typeof rpc.api.blocks.$get, 200>

type SuccessJson<R> = R extends ClientResponse<infer T, infer S, 'json'> ? (S extends 200 | 201 ? T : never) : never

async function unwrap<R extends ClientResponse<unknown, number>>(promise: Promise<R>): Promise<SuccessJson<R>> {
  const res = await promise
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as SuccessJson<R>
}

async function fetchStaticJson<T>(relPath: string): Promise<T> {
  const res = await fetch(staticAssetUrl(relPath))
  if (!res.ok) {
    throw new Error(`静的データの読み込みに失敗しました (${res.status}): ${relPath}`)
  }
  return (await res.json()) as T
}

export function encodeDocId(docId: string): string {
  return docId
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

let cachedSearchIndex: Promise<StaticSearchEntry[]> | null = null
let cachedSourceIndex: Promise<Record<string, string>> | null = null
let cachedSourceExportsIndex: Promise<Record<string, string>> | null = null
let cachedCodeFileIndex: Promise<Record<string, string>> | null = null

function loadStaticSearchIndex(): Promise<StaticSearchEntry[]> {
  cachedSearchIndex ??= fetchStaticJson<{ entries: StaticSearchEntry[] }>('data/search-index.json').then(
    (d) => d.entries,
  )
  return cachedSearchIndex
}

function loadStaticSourceIndex(): Promise<Record<string, string>> {
  cachedSourceIndex ??= fetchStaticJson<Record<string, string>>('data/source-index.json')
  return cachedSourceIndex
}

function loadStaticSourceExportsIndex(): Promise<Record<string, string>> {
  cachedSourceExportsIndex ??= fetchStaticJson<Record<string, string>>('data/source-exports-index.json')
  return cachedSourceExportsIndex
}

function loadStaticCodeFileIndex(): Promise<Record<string, string>> {
  cachedCodeFileIndex ??= fetchStaticJson<Record<string, string>>('data/code/file-index.json')
  return cachedCodeFileIndex
}

async function searchStatic(q: string, type: ArtifactType | '' | undefined, limit: number): Promise<SearchResponse> {
  const trimmed = q.trim()
  if (!trimmed) return { query: q, results: [], count: 0, mode: 'bm25' }
  const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
  const entries = await loadStaticSearchIndex()
  const scored: SearchHit[] = []

  for (const entry of entries) {
    if (type && entry.type !== type) continue
    const idLower = entry.id.toLowerCase()
    const titleLower = entry.title.toLowerCase()
    const tagsLower = entry.tags.join(' ').toLowerCase()
    const textLower = entry.text.toLowerCase()
    const hay = `${idLower}\n${titleLower}\n${tagsLower}\n${textLower}`
    if (!tokens.every((tok) => hay.includes(tok))) continue

    let score = 0
    for (const tok of tokens) {
      if (idLower === tok) score += 100
      else if (idLower.includes(tok)) score += 45
      if (titleLower.includes(tok)) score += 40
      if (tagsLower.includes(tok)) score += 20
      if (textLower.includes(tok)) score += 10
    }

    const firstTok = tokens[0] ?? ''
    const pos = textLower.indexOf(firstTok)
    const snippet =
      pos >= 0
        ? entry.text
            .slice(Math.max(0, pos - 40), Math.min(entry.text.length, pos + 120))
            .replace(/\s+/g, ' ')
            .trim()
        : entry.text.slice(0, 140).replace(/\s+/g, ' ').trim()

    scored.push({
      kind: entry.kind,
      id: entry.id,
      docId: entry.docId,
      type: entry.type as ArtifactType,
      title: entry.title,
      ...(entry.blockKind ? { blockKind: entry.blockKind as BlockKind } : {}),
      snippet,
      score,
    })
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  const results = scored.slice(0, limit)
  return { query: q, results, count: results.length, mode: 'bm25' }
}

async function bundleStatic(params: { scope?: string; ids?: string[]; title?: string }): Promise<BundleResponse> {
  const [{ documents: allSummaries }, { terms }] = await Promise.all([
    fetchStaticJson<DocumentsResponse>('data/documents.json'),
    fetchStaticJson<TermsResponse>('data/terms.json'),
  ])

  let targetIds: string[]
  let scopeLabel = 'All Documents'
  if (params.ids && params.ids.length > 0) {
    targetIds = params.ids
    scopeLabel = `Selected (${params.ids.length})`
  } else if (params.scope?.startsWith('dir:')) {
    const dir = params.scope.slice(4).replace(/^\/+|\/+$/g, '')
    targetIds = allSummaries.filter((d) => d.dir === dir || d.dir.startsWith(`${dir}/`)).map((d) => d.id)
    scopeLabel = `${dir}/`
  } else if (params.scope?.startsWith('goal:')) {
    const goalId = params.scope.slice(5).trim()
    const graph = await fetchStaticJson<GraphResponse>('data/graph-all-docs.json')
    const related = new Set<string>([goalId])
    const queue = [goalId]
    while (queue.length > 0) {
      const cur = queue.shift()
      if (!cur) continue
      for (const edge of graph.edges) {
        if (edge.toDocId === cur && !related.has(edge.fromDocId)) {
          related.add(edge.fromDocId)
          queue.push(edge.fromDocId)
        }
      }
    }
    targetIds = allSummaries
      .filter((d) => related.has(d.id) || d.type === 'domain' || d.type === 'decision')
      .map((d) => d.id)
    scopeLabel = goalId
  } else {
    targetIds = allSummaries.map((d) => d.id)
  }

  const loaded = await Promise.all(
    targetIds.map(async (id) => {
      try {
        const res = await fetchStaticJson<{ document: Document }>(`data/documents/${encodeDocId(id)}.json`)
        return res.document
      } catch {
        return null
      }
    }),
  )
  const documents = loaded.filter((d): d is Document => d !== null)

  let blockCount = 0
  let approvedCount = 0
  let verifiedCount = 0
  for (const doc of documents) {
    for (const b of doc.blocks) {
      blockCount++
      if (b.review === 'approved') approvedCount++
      if (b.realization?.status === 'verified') verifiedCount++
    }
  }

  return {
    title: params.title?.trim() || scopeLabel,
    scopeLabel,
    generatedAt: window.__DOCUMI_STATIC__?.generatedAt ?? new Date().toISOString(),
    documents,
    terms,
    summary: {
      documentCount: documents.length,
      blockCount,
      approvedCount,
      verifiedCount,
    },
  }
}

export const api = {
  status: (): Promise<StatusResponse> =>
    isStaticSite() ? fetchStaticJson<StatusResponse>('data/status.json') : unwrap(rpc.api.status.$get()),
  overview: (): Promise<OverviewResponse> =>
    isStaticSite() ? fetchStaticJson<OverviewResponse>('data/overview.json') : unwrap(rpc.api.overview.$get()),
  tree: async (): Promise<TreeResponse> => {
    if (isStaticSite()) {
      return fetchStaticJson<TreeResponse>('data/tree.json')
    }
    const data = await unwrap(rpc.api.tree.$get())
    return { ...data, tree: data.tree as DocTreeNode[] }
  },
  documents: async (type?: ArtifactType): Promise<DocumentsResponse> => {
    if (isStaticSite()) {
      const data = await fetchStaticJson<DocumentsResponse>('data/documents.json')
      return type ? { documents: data.documents.filter((d) => d.type === type) } : data
    }
    return unwrap(rpc.api.documents.$get({ query: type ? { type } : {} }))
  },
  document: (docId: string): Promise<DocumentResponse> =>
    isStaticSite()
      ? fetchStaticJson<DocumentResponse>(`data/documents/${encodeDocId(docId)}.json`)
      : unwrap(rpc.api.documents[':id{.+}'].$get({ param: { id: encodeDocId(docId) } })),
  documentHistory: (docId: string, limit = 20): Promise<HistoryResponse> =>
    isStaticSite()
      ? fetchStaticJson<HistoryResponse>(`data/history/${encodeDocId(docId)}.json`)
      : unwrap(rpc.api.history.$get({ query: { id: docId, limit: String(limit) } })),
  documentRevision: (docId: string, commit: string): Promise<RevisionResponse> =>
    isStaticSite()
      ? fetchStaticJson<RevisionResponse>(`data/revisions/${encodeDocId(docId)}/${encodeURIComponent(commit)}.json`)
      : unwrap(rpc.api.history.revision.$get({ query: { id: docId, commit } })),
  graph: (layers: 'all' | 'trace' = 'all', granularity: 'docs' | 'blocks' = 'docs'): Promise<GraphResponse> =>
    isStaticSite()
      ? fetchStaticJson<GraphResponse>(`data/graph-${layers}-${granularity}.json`)
      : unwrap(rpc.api.graph.$get({ query: { layers, granularity } })),
  terms: (): Promise<TermsResponse> =>
    isStaticSite() ? fetchStaticJson<TermsResponse>('data/terms.json') : unwrap(rpc.api.terms.$get()),
  search: (q: string, type?: ArtifactType | '', limit = 30): Promise<SearchResponse> =>
    isStaticSite()
      ? searchStatic(q, type, limit)
      : unwrap(
          rpc.api.search.$get({
            query: {
              q,
              limit: String(limit),
              ...(type ? { type } : {}),
            },
          }),
        ),
  bundle: (params: { scope?: string; ids?: string[]; title?: string }): Promise<BundleResponse> =>
    isStaticSite()
      ? bundleStatic(params)
      : unwrap(
          rpc.api.bundle.$get({
            query: {
              ...(params.ids && params.ids.length > 0
                ? { ids: params.ids.join(',') }
                : params.scope
                  ? { scope: params.scope }
                  : {}),
              ...(params.title ? { title: params.title } : {}),
            },
          }),
        ),
  blocks: (): Promise<ReviewBlocksResponse> =>
    isStaticSite() ? fetchStaticJson<ReviewBlocksResponse>('data/blocks.json') : unwrap(rpc.api.blocks.$get()),
  blockDiff: (blockId: string): Promise<BlockDiffResponse> =>
    isStaticSite()
      ? fetchStaticJson<BlockDiffResponse>(`data/block-diffs/${encodeURIComponent(blockId)}.json`)
      : unwrap(rpc.api.blocks[':id'].diff.$get({ param: { id: encodeURIComponent(blockId) } })),
  approveBlock: (blockId: string, author?: string) => {
    if (isStaticSite()) return Promise.reject(new Error('静的サイトでは承認操作は利用できません'))
    return unwrap(
      rpc.api.blocks[':id'].approve.$post({
        param: { id: encodeURIComponent(blockId) },
        json: author ? { author } : {},
      }),
    )
  },
  unapproveBlock: (blockId: string) => {
    if (isStaticSite()) return Promise.reject(new Error('静的サイトでは承認取り消し操作は利用できません'))
    return unwrap(
      rpc.api.blocks[':id'].approve.$delete({
        param: { id: encodeURIComponent(blockId) },
      }),
    )
  },
  addFeedback: (blockId: string, body: string, author?: string) => {
    if (isStaticSite()) return Promise.reject(new Error('静的サイトではフィードバック投稿は利用できません'))
    return unwrap(
      rpc.api.blocks[':id'].feedback.$post({
        param: { id: encodeURIComponent(blockId) },
        json: author ? { body, author } : { body },
      }),
    )
  },
  setFeedbackResolved: (blockId: string, feedbackId: string, resolved: boolean) => {
    if (isStaticSite()) return Promise.reject(new Error('静的サイトでは更新操作は利用できません'))
    return unwrap(
      rpc.api.blocks[':id'].feedback[':feedbackId'].$patch({
        param: { id: encodeURIComponent(blockId), feedbackId: encodeURIComponent(feedbackId) },
        json: { resolved },
      }),
    )
  },
  setStability: (blockId: string, stability: Stability | null) => {
    if (isStaticSite()) return Promise.reject(new Error('静的サイトでは安定度変更は利用できません'))
    return unwrap(
      rpc.api.blocks[':id'].stability.$patch({
        param: { id: encodeURIComponent(blockId) },
        json: { stability },
      }),
    )
  },
  source: async (params: { file: string; symbol?: string; lines?: string }): Promise<SourceResponse> => {
    if (isStaticSite()) {
      const idx = await loadStaticSourceIndex()
      const key = `${params.file}|${params.symbol ?? ''}|${params.lines ?? ''}`
      const hash = idx[key]
      if (!hash) {
        throw new Error(`ソースコードは静的サイトに同梱されていません: ${params.file}`)
      }
      return fetchStaticJson<SourceResponse>(`data/sources/${hash}.json`)
    }
    return unwrap(
      rpc.api.source.$get({
        query: {
          file: params.file,
          ...(params.symbol ? { symbol: params.symbol } : {}),
          ...(params.lines ? { lines: params.lines } : {}),
        },
      }),
    )
  },
  sourceExports: async (file: string): Promise<SourceExportsResponse> => {
    if (isStaticSite()) {
      const idx = await loadStaticSourceExportsIndex()
      const hash = idx[file]
      if (!hash) {
        throw new Error(`公開シンボル一覧は静的サイトに同梱されていません: ${file}`)
      }
      return fetchStaticJson<SourceExportsResponse>(`data/source-exports/${hash}.json`)
    }
    return unwrap(rpc.api.source.exports.$get({ query: { file } }))
  },
  codeTree: async (): Promise<CodeTreeResponse> => {
    if (isStaticSite()) {
      return fetchStaticJson<CodeTreeResponse>('data/code/tree.json')
    }
    const data = await unwrap(rpc.api.code.tree.$get())
    return { ...data, tree: data.tree as CodeTreeNode[] }
  },
  codeFile: async (filePath: string): Promise<CodeFileResponse> => {
    if (isStaticSite()) {
      const idx = await loadStaticCodeFileIndex()
      const hash = idx[filePath]
      if (!hash) {
        throw new Error(`ソースファイルは静的サイトに同梱されていません: ${filePath}`)
      }
      return fetchStaticJson<CodeFileResponse>(`data/code/files/${hash}.json`)
    }
    return unwrap(rpc.api.code.file.$get({ query: { path: filePath } }))
  },
  iconManifest: (): Promise<IconManifestResponse> =>
    isStaticSite()
      ? fetchStaticJson<IconManifestResponse>('data/icons/manifest.json')
      : unwrap(rpc.api.icons.manifest.$get()),
}
