import { searchIndex } from './bundle'
import { computeDocumentHealth } from './health'
import { getDocument, toDocumentSummary } from './loader'
import { extractExportedSymbols } from './source'
import type { ExportedSymbolEntry } from './source'
import { validateSourceLinks } from './trace'
import type {
  ArtifactType,
  BlockKind,
  DocsIndex,
  RealizationStatus,
  ReviewStatus,
  SemanticBlock,
  SourceRefDecl,
  SpecIntent,
  Stability,
} from './types'

export interface QuerySpecsFilter {
  kind?: BlockKind
  intent?: SpecIntent
  stability?: Stability
  review?: ReviewStatus
  realization?: RealizationStatus
  suspect?: boolean
  hasFeedback?: boolean
  query?: string
  /** true のとき各ブロックの全文および realization 詳細配列まで含める（既定: false の軽量サマリ） */
  full?: boolean
}

function summarizeText(raw: string, maxChars: number): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, maxChars - 1)}…`
}

function extractHeadings(body: string, maxHeadings = 12): string[] {
  const headings: string[] = []
  for (const line of body.split('\n')) {
    const m = /^#{1,3}\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    headings.push(m[1]!.trim())
    if (headings.length >= maxHeadings) break
  }
  return headings
}

function toCompactBlock(index: DocsIndex, b: SemanticBlock) {
  return {
    id: b.id,
    kind: b.kind,
    docId: b.docId,
    docPath: index.byId.get(b.docId)?.path ?? '',
    startLine: b.startLine,
    endLine: b.endLine,
    ...(b.title ? { title: b.title } : {}),
    intent: b.intent,
    stability: b.stability,
    review: b.review,
    suspect: b.suspect,
    ...(b.realization ? { realizationStatus: b.realization.status } : {}),
    openFeedbackCount: b.feedback.filter((f) => !f.resolved).length,
    ...(b.derives.length > 0 ? { derives: b.derives } : {}),
    summary: summarizeText(b.rawBody, 180),
  }
}

function toMapDocEntry(d: DocsIndex['documents'][number], full: boolean) {
  const item: { id: string; title: string; description: string; headings: string[]; body?: string } = {
    id: d.id,
    title: d.title,
    description: d.description,
    headings: extractHeadings(d.body),
  }
  if (full) item.body = d.body
  return item
}

/**
 * プロジェクトの初期コンテキスト (Goal / Architecture / Decision Outcome / Domain 用語 / 統計) を構築する。
 * MCP (`get_project_map`) と CLI (`documi map`) が共通利用する。
 * 既定では Goal / Architecture を概要＋見出し一覧に圧縮し、コンテキスト肥大化を防ぐ（`full: true` で全文を含める）。
 */
export function buildProjectMap(index: DocsIndex, options: { full?: boolean } = {}) {
  const full = options.full === true
  const goals = index.documents.filter((d) => d.type === 'goal').map((d) => toMapDocEntry(d, full))
  const architecture = index.documents.filter((d) => d.type === 'architecture').map((d) => toMapDocEntry(d, full))
  const outcomes = [...index.blocksById.values()]
    .filter((b) => b.kind === 'outcome')
    .map((b) => {
      const doc = index.byId.get(b.docId)
      const item: { id: string; docId: string; date?: string; stability?: string; body: string } = {
        id: b.id,
        docId: b.docId,
        stability: b.stability,
        body: full ? b.rawBody : summarizeText(b.rawBody, 240),
      }
      if (doc?.date) item.date = doc.date
      return item
    })
  const terms = [...index.blocksById.values()]
    .filter((b) => b.kind === 'term')
    .map((b) => ({
      id: b.id,
      docId: b.docId,
      aliases: b.aliases ?? [],
      symbols: b.symbols ?? [],
      definition: full ? b.rawBody : summarizeText(b.rawBody, 160),
    }))

  const reviewSummary = { approved: 0, unreviewed: 0, stale: 0, suspect: 0, openFeedback: 0 }
  const realizationSummary: Record<RealizationStatus, number> = {
    unimplemented: 0,
    'in-progress': 0,
    implemented: 0,
    verified: 0,
    drifted: 0,
  }
  for (const b of index.blocksById.values()) {
    if (b.kind !== 'note') {
      reviewSummary[b.review]++
      if (b.suspect) reviewSummary.suspect++
    }
    if (b.realization) realizationSummary[b.realization.status]++
    reviewSummary.openFeedback += b.feedback.filter((f) => !f.resolved).length
  }

  const health = computeDocumentHealth(index)

  return {
    documentCount: index.documents.length,
    blockCount: index.blocksById.size,
    issueCount: index.issues.length + index.documents.reduce((acc, d) => acc + d.issues.length, 0),
    reviewSummary,
    realizationSummary,
    health,
    goals,
    architecture,
    decisionOutcomes: outcomes,
    terms,
  }
}

/**
 * ドキュメント一覧を取得する（任意で Artifact Type 絞り込み）。
 */
export function listDocuments(index: DocsIndex, type?: ArtifactType) {
  const docs = index.documents.filter((d) => !type || d.type === type)
  return { documents: docs.map(toDocumentSummary), count: docs.length }
}

/**
 * ドキュメント ID から本文・セマンティックブロック・関係・問題一覧を取得する。
 */
export function getDocumentDetail(index: DocsIndex, id: string) {
  const doc = getDocument(index, id)
  if (!doc) return null
  return {
    ...toDocumentSummary(doc),
    body: doc.body,
    blocks: doc.blocks,
    sourceRefs: doc.sourceRefs,
    outgoing: doc.outgoing,
    incoming: doc.incoming,
    issues: doc.issues,
  }
}

/**
 * ドキュメント ID またはブロック ID の参照関係 (外向き / 逆参照) を取得する。
 */
export function getNodeRelations(index: DocsIndex, id: string) {
  const doc = getDocument(index, id)
  if (doc) {
    return { id: doc.id, kind: 'doc' as const, outgoing: doc.outgoing, incoming: doc.incoming }
  }
  const block = index.blocksById.get(id)
  if (block) {
    const outgoing = index.edges.filter((e) => e.from === block.id)
    const incoming = index.edges.filter((e) => e.to === block.id)
    return { id: block.id, kind: 'block' as const, docId: block.docId, outgoing, incoming }
  }
  return null
}

/**
 * セマンティックブロックを多軸フィルタ検索する。
 * 既定では軽量サマリを返し、`full: true` 指定時のみ完全なブロック構造（realization 詳細配列含む）を返す。
 */
export function querySpecs(index: DocsIndex, filters: QuerySpecsFilter = {}) {
  const q = filters.query?.trim().toLowerCase()
  const matched = [...index.blocksById.values()].filter((b) => {
    if (filters.kind && b.kind !== filters.kind) return false
    if (filters.intent && b.intent !== filters.intent) return false
    if (filters.stability && b.stability !== filters.stability) return false
    if (filters.review && b.review !== filters.review) return false
    if (filters.realization && b.realization?.status !== filters.realization) return false
    if (filters.suspect !== undefined && b.suspect !== filters.suspect) return false
    if (filters.hasFeedback !== undefined) {
      const open = b.feedback.some((f) => !f.resolved)
      if (open !== filters.hasFeedback) return false
    }
    if (q && !b.id.toLowerCase().includes(q) && !b.rawBody.toLowerCase().includes(q)) return false
    return true
  })

  if (filters.full === true) {
    const withPaths = matched.map((b) => Object.assign({}, b, { docPath: index.byId.get(b.docId)?.path ?? '' }))
    return { blocks: withPaths, count: withPaths.length }
  }

  const compact = matched.map((b) => toCompactBlock(index, b))
  return { blocks: compact, count: compact.length }
}

/**
 * 指定した Spec ブロック ID またはドキュメント ID の実装・検証に必要な文脈を一括集約する。
 * 既定では上流 Goal を概要のみに圧縮し、対象ブロックの realization も要約する（`full: true` で完全展開）。
 */
export function getSpecContext(index: DocsIndex, id: string, options: { full?: boolean } = {}) {
  const full = options.full === true
  const block = index.blocksById.get(id)
  const doc = block ? index.byId.get(block.docId) : getDocument(index, id)
  if (!doc) return null

  const targetIds = new Set<string>([doc.id, ...(block ? [block.id] : doc.blocks.map((b) => b.id))])
  const relatedDocIds = new Set<string>()

  // 上流 (derives) を再帰的に辿る
  const queue = [...targetIds]
  const visited = new Set<string>()
  const upstreamGoals: { id: string; title: string; description: string; body?: string }[] = []
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (visited.has(cur)) continue
    visited.add(cur)
    for (const e of index.edges) {
      if (e.kind !== 'derives' || e.from !== cur) continue
      const targetDoc = index.byId.get(e.toDocId)
      if (targetDoc?.type === 'goal' && !upstreamGoals.some((g) => g.id === targetDoc.id)) {
        upstreamGoals.push({
          id: targetDoc.id,
          title: targetDoc.title,
          description: targetDoc.description,
          ...(full ? { body: targetDoc.body } : {}),
        })
      }
      queue.push(e.to, e.toDocId)
    }
  }

  // 直接繋がる Design / Contract / Verification / Decision を収集
  for (const e of index.edges) {
    if (targetIds.has(e.from) || targetIds.has(e.fromDocId)) relatedDocIds.add(e.toDocId)
    if (targetIds.has(e.to) || targetIds.has(e.toDocId)) relatedDocIds.add(e.fromDocId)
  }
  relatedDocIds.delete(doc.id)

  const relatedDocs = [...relatedDocIds]
    .map((rid) => index.byId.get(rid))
    .filter((d): d is NonNullable<typeof d> => Boolean(d))

  const outcomes: SemanticBlock[] = relatedDocs
    .filter((d) => d.type === 'decision')
    .flatMap((d) => d.blocks.filter((b) => b.kind === 'outcome'))

  const terms: SemanticBlock[] = [...index.blocksById.values()].filter(
    (b) =>
      b.kind === 'term' &&
      (doc.body.toLowerCase().includes(b.id.toLowerCase()) ||
        (b.aliases ?? []).some((a) => doc.body.toLowerCase().includes(a.toLowerCase()))),
  )

  const openFeedback = (block ? [block] : doc.blocks).flatMap((b) =>
    b.feedback.filter((f) => !f.resolved).map((f) => Object.assign({ blockId: b.id }, f)),
  )

  const compactTarget = block
    ? {
        id: block.id,
        kind: block.kind,
        docId: block.docId,
        docPath: doc.path,
        startLine: block.startLine,
        endLine: block.endLine,
        ...(block.title ? { title: block.title } : {}),
        intent: block.intent,
        stability: block.stability,
        review: block.review,
        suspect: block.suspect,
        derives: block.derives,
        rawBody: block.rawBody,
        ...(block.realization
          ? {
              realization: {
                status: block.realization.status,
                implementations: [...new Set(block.realization.implementations.map((a) => `${a.file}:${a.line}`))],
                verifications: [...new Set(block.realization.verifications.map((a) => `${a.file}:${a.line}`))],
                testCounts: {
                  passed: block.realization.testResults.filter((t) => t.status === 'passed').length,
                  failed: block.realization.testResults.filter((t) => t.status === 'failed').length,
                  skipped: block.realization.testResults.filter((t) => t.status === 'skipped').length,
                },
              },
            }
          : {}),
      }
    : { id: doc.id, type: doc.type, title: doc.title, description: doc.description }

  return {
    target: full ? (block ? { ...block, docPath: doc.path } : toDocumentSummary(doc)) : compactTarget,
    docPath: doc.path,
    ...(block ? { startLine: block.startLine, endLine: block.endLine } : {}),
    document: full
      ? toDocumentSummary(doc)
      : { id: doc.id, type: doc.type, title: doc.title, description: doc.description, path: doc.path },
    openFeedback,
    upstreamGoals,
    relatedDocuments: full
      ? relatedDocs.map(toDocumentSummary)
      : relatedDocs.map((d) => ({ id: d.id, type: d.type, title: d.title, description: d.description })),
    decisionOutcomes: outcomes.map((o) => ({ id: o.id, docId: o.docId, body: o.rawBody })),
    relevantTerms: terms.map((t) => ({
      id: t.id,
      aliases: t.aliases ?? [],
      symbols: t.symbols ?? [],
      body: full ? t.rawBody : summarizeText(t.rawBody, 160),
    })),
    sourceRefs: [...doc.sourceRefs, ...relatedDocs.flatMap((d) => d.sourceRefs)],
  }
}

/**
 * ドキュメントとセマンティックブロックを横断全文検索する。
 */
export function searchDocuments(
  index: DocsIndex,
  query: string,
  options: { type?: ArtifactType; limit?: number } = {},
) {
  const results = searchIndex(index, query, { type: options.type, limit: options.limit ?? 20 })
  return { query, results, count: results.length }
}

/**
 * 指定された SourceRef 一覧が参照するソースファイル群から、重複を除いて公開シンボル（class / interface / function 等）を AST 抽出する。
 */
export async function collectSourceRefExports(
  projectRoot: string,
  sourceRefs: SourceRefDecl[],
): Promise<Array<{ file: string; language: string; symbols: ExportedSymbolEntry[] }>> {
  const uniqueFiles = [...new Set(sourceRefs.map((r) => r.file))]
  const results: Array<{ file: string; language: string; symbols: ExportedSymbolEntry[] }> = []
  for (const file of uniqueFiles) {
    try {
      const extracted = await extractExportedSymbols(projectRoot, file)
      if (extracted.symbols.length > 0) {
        results.push({
          file: extracted.file,
          language: extracted.language,
          symbols: extracted.symbols,
        })
      }
    } catch {
      // 未対応拡張子や存在しないファイルは文脈集約を失敗させずスキップ
    }
  }
  return results
}

/**
 * ドキュメント構造・グラフ・MDX 安全性・ソース参照検証の結果ペイロードを構築する。
 */
export async function buildValidationPayload(index: DocsIndex, projectRoot?: string) {
  const docIssues = index.documents.flatMap((d) =>
    d.issues.map((issue) => ({
      docId: d.id,
      path: d.path,
      code: issue.code,
      message: issue.message,
      blockId: issue.blockId,
    })),
  )
  const sourceIssues = projectRoot ? (await validateSourceLinks(projectRoot, index)).issues : []
  const totalIssues = index.issues.length + docIssues.length + sourceIssues.length
  const health = computeDocumentHealth(index)
  return {
    ok: totalIssues === 0,
    indexIssues: index.issues,
    docIssues,
    sourceIssues,
    totalIssues,
    health,
  }
}
