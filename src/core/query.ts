import { searchIndex } from './bundle'
import { computeDocumentHealth } from './health'
import { getDocument, toDocumentSummary } from './loader'
import { extractExportedSymbols } from './source'
import type { ExportedSymbolEntry } from './source'
import { validateSourceLinks } from './trace'
import type {
  ArtifactType,
  BlockKind,
  DecisionSemanticBlock,
  DocsIndex,
  RealizationStatus,
  ReviewStatus,
  SemanticBlock,
  SourceRefDecl,
  SpecIntent,
  Stability,
  TestSemanticBlock,
} from './types'

export interface QuerySpecsFilter {
  kind?: BlockKind
  intent?: SpecIntent
  stability?: Stability
  review?: ReviewStatus
  realization?: RealizationStatus
  suspect?: boolean
  /** 指定マウント ID のドキュメント配下ブロックのみに絞り込む */
  mount?: string
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
    ...(b.derives.length > 0 ? { derives: b.derives } : {}),
    ...(b.kind === 'test' && b.level ? { level: b.level } : {}),
    ...(b.kind === 'test' && b.verifies.length > 0 ? { verifies: b.verifies } : {}),
    summary: summarizeText(b.kind === 'decision' ? (b.summary ?? b.chosen ?? b.rawBody) : b.rawBody, 180),
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
 * プロジェクトの初期コンテキスト (Goal / System Design / Decision 結論 / Domain 用語 / 統計) を構築する。
 * MCP (`get_project_map`) と CLI (`documi map`) が共通利用する。
 * 既定では Goal / System Design を概要＋見出し一覧に圧縮し、コンテキスト肥大化を防ぐ（`full: true` で全文を含める）。
 */
export function buildProjectMap(index: DocsIndex, options: { full?: boolean } = {}) {
  const full = options.full === true
  const goals = index.documents.filter((d) => d.type === 'goal').map((d) => toMapDocEntry(d, full))
  const systemDesigns = index.documents
    .filter((d) => d.type === 'design' && d.scope === 'system')
    .map((d) => toMapDocEntry(d, full))
  // 常時 map に載せるのは独立 decision ファイル内の <Decision> のみ（design/spec 内マイクロ ADR は context/search でオンデマンド取得）
  const allDecisions = [...index.blocksById.values()]
    .filter((b): b is DecisionSemanticBlock => b.kind === 'decision' && index.byId.get(b.docId)?.type === 'decision')
    .map((b) => {
      const doc = index.byId.get(b.docId)
      const conclusion = b.summary ?? b.chosen ?? b.rawBody
      const item: {
        id: string
        docId: string
        date?: string
        stability?: string
        supersededBy?: string[]
        body: string
      } = {
        id: b.id,
        docId: b.docId,
        stability: b.stability,
        body: full ? b.rawBody : summarizeText(conclusion, 240),
      }
      if (b.supersededBy && b.supersededBy.length > 0) item.supersededBy = b.supersededBy
      const date = b.date ?? doc?.date
      if (date) item.date = date
      return item
    })
  const decisions = allDecisions.filter((o) => !o.supersededBy)
  const supersededDecisions = allDecisions.filter((o) => Boolean(o.supersededBy))
  const domainModels = index.documents
    .filter((d) => d.type === 'domain' && !d.blocks.every((b) => b.kind === 'term'))
    .map((d) => toMapDocEntry(d, full))
  const domainInvariants = [...index.blocksById.values()]
    .filter((b) => b.kind === 'constraint' && index.byId.get(b.docId)?.type === 'domain')
    .map((b) => {
      const item: { id: string; docId: string; scope?: string; body: string } = {
        id: b.id,
        docId: b.docId,
        body: full ? b.rawBody : summarizeText(b.rawBody, 200),
      }
      if (b.kind === 'constraint' && b.scope) item.scope = b.scope
      return item
    })
  const terms = [...index.blocksById.values()]
    .filter((b) => b.kind === 'term')
    .map((b) => {
      const item: {
        id: string
        docId: string
        aliases: string[]
        antiTerms: string[]
        context?: string
        symbols: string[]
        definition: string
      } = {
        id: b.id,
        docId: b.docId,
        aliases: b.aliases,
        antiTerms: b.antiTerms,
        symbols: b.symbols,
        definition: full ? b.rawBody : summarizeText(b.rawBody, 160),
      }
      if (b.context) item.context = b.context
      return item
    })

  const reviewSummary = { approved: 0, unreviewed: 0, stale: 0, suspect: 0 }
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
    systemDesigns,
    domainModels,
    domainInvariants,
    decisions,
    supersededDecisions,
    terms,
  }
}

/**
 * ドキュメント一覧を取得する（任意で Artifact Type 絞り込み）。
 */
export function listDocuments(index: DocsIndex, type?: ArtifactType, mount?: string) {
  const normalizedMount = mount?.trim() || undefined
  const docs = index.documents.filter(
    (d) => (!type || d.type === type) && (!normalizedMount || d.mountId === normalizedMount),
  )
  return { documents: docs.map(toDocumentSummary), count: docs.length }
}

/**
 * ドキュメント ID から本文・セマンティックブロック・関係・問題一覧を取得する。
 */
export function getDocumentDetail(index: DocsIndex, id: string) {
  const doc = getDocument(index, id)
  if (!doc) return undefined
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
  return undefined
}

interface ImpactDocumentEntry {
  id: string
  type: ArtifactType
  title: string
  path: string
  depth: number
  via: string[]
}

interface ImpactBlockEntry {
  id: string
  kind: BlockKind
  docId: string
  docPath: string
  stability: Stability
  review: ReviewStatus
  depth: number
  via: string[]
}

interface ImpactAnalysisResult {
  target: {
    id: string
    kind: 'doc' | 'block'
    docId: string
    docPath: string
    title: string
  }
  maxDepth: number
  affectedDocuments: ImpactDocumentEntry[]
  affectedBlocks: ImpactBlockEntry[]
  sourceRefs: Array<{
    file: string
    docId: string
    satisfies: string[]
    verifies: string[]
  }>
  codeAnchors: Array<{
    kind: 'implements' | 'verifies'
    specId: string
    file: string
    line: number
    testName?: string
  }>
}

/**
 * 指定ドキュメント ID またはブロック ID を変更した際に影響を受ける下流文書・ブロック・SourceRef・コード/テスト参照を再帰走査する。
 * @implements core.ai-cli
 */
export function getImpactAnalysis(
  index: DocsIndex,
  id: string,
  options: { maxDepth?: number } = {},
): ImpactAnalysisResult | undefined {
  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 4, 12))
  const block = index.blocksById.get(id)
  const doc = block ? index.byId.get(block.docId) : getDocument(index, id)
  if (!doc) return undefined

  const seedNodes = new Set<string>(block ? [block.id] : [doc.id, ...doc.blocks.map((b) => b.id)])
  const docImpact = new Map<string, { depth: number; via: Set<string> }>()
  const blockImpact = new Map<string, { depth: number; via: Set<string> }>()

  // 逆向きエッジ索引: to -> edges[]
  const incomingByTarget = new Map<string, DocsIndex['edges']>()
  for (const edge of index.edges) {
    const list = incomingByTarget.get(edge.to) ?? []
    list.push(edge)
    incomingByTarget.set(edge.to, list)
  }

  const visited = new Map<string, number>()
  const queue: Array<{ nodeId: string; depth: number }> = []
  for (const seed of seedNodes) {
    visited.set(seed, 0)
    queue.push({ nodeId: seed, depth: 0 })
  }

  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift()!
    if (depth >= maxDepth) continue
    const nextDepth = depth + 1

    for (const edge of incomingByTarget.get(nodeId) ?? []) {
      const fromDoc = index.byId.get(edge.fromDocId)
      if (!fromDoc) continue

      if (edge.fromDocId !== doc.id) {
        const prev = docImpact.get(edge.fromDocId)
        if (!prev) {
          docImpact.set(edge.fromDocId, { depth: nextDepth, via: new Set([edge.kind]) })
        } else {
          if (nextDepth < prev.depth) prev.depth = nextDepth
          prev.via.add(edge.kind)
        }
      }

      const fromBlock = index.blocksById.get(edge.from)
      if (fromBlock && !seedNodes.has(fromBlock.id)) {
        const prev = blockImpact.get(fromBlock.id)
        if (!prev) {
          blockImpact.set(fromBlock.id, { depth: nextDepth, via: new Set([edge.kind]) })
        } else {
          if (nextDepth < prev.depth) prev.depth = nextDepth
          prev.via.add(edge.kind)
        }
      }

      const nextNodes = fromBlock ? [fromBlock.id] : [fromDoc.id, ...fromDoc.blocks.map((b) => b.id)]
      for (const nextId of nextNodes) {
        const prevDepth = visited.get(nextId)
        if (prevDepth === undefined || nextDepth < prevDepth) {
          visited.set(nextId, nextDepth)
          queue.push({ nodeId: nextId, depth: nextDepth })
        }
      }
    }
  }

  const affectedDocuments: ImpactDocumentEntry[] = [...docImpact.entries()]
    .map(([docId, info]) => {
      const d = index.byId.get(docId)!
      return {
        id: d.id,
        type: d.type,
        title: d.title,
        path: d.path,
        depth: info.depth,
        via: [...info.via].toSorted(),
      }
    })
    .toSorted((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))

  const affectedBlocks: ImpactBlockEntry[] = [...blockImpact.entries()]
    .map(([blockId, info]) => {
      const b = index.blocksById.get(blockId)!
      return {
        id: b.id,
        kind: b.kind,
        docId: b.docId,
        docPath: index.byId.get(b.docId)?.path ?? '',
        stability: b.stability,
        review: b.review,
        depth: info.depth,
        via: [...info.via].toSorted(),
      }
    })
    .toSorted((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))

  // 関連 SourceRef（対象文書 + 影響文書）とコード/テストアンカー（対象ブロック + 影響ブロック）を重複除去して収集
  const sourceRefSeen = new Set<string>()
  const sourceRefs: ImpactAnalysisResult['sourceRefs'] = []
  const relevantDocIds = [doc.id, ...affectedDocuments.map((d) => d.id)]
  for (const dId of relevantDocIds) {
    const d = index.byId.get(dId)
    if (!d) continue
    for (const ref of d.sourceRefs) {
      const key = `${d.id}|${ref.file}|${ref.satisfies.join(',')}|${ref.verifies.join(',')}`
      if (sourceRefSeen.has(key)) continue
      sourceRefSeen.add(key)
      sourceRefs.push({
        file: ref.file,
        docId: d.id,
        satisfies: ref.satisfies,
        verifies: ref.verifies,
      })
    }
  }

  const anchorSeen = new Set<string>()
  const codeAnchors: ImpactAnalysisResult['codeAnchors'] = []
  const relevantBlockIds = [...(block ? [block.id] : doc.blocks.map((b) => b.id)), ...affectedBlocks.map((b) => b.id)]
  for (const bId of relevantBlockIds) {
    const b = index.blocksById.get(bId)
    if (!b?.realization) continue
    for (const a of [...b.realization.implementations, ...b.realization.verifications]) {
      const key = `${a.kind}|${a.specId}|${a.file}|${a.line}`
      if (anchorSeen.has(key)) continue
      anchorSeen.add(key)
      codeAnchors.push({
        kind: a.kind,
        specId: a.specId,
        file: a.file,
        line: a.line,
        ...(a.testName ? { testName: a.testName } : {}),
      })
    }
  }

  return {
    target: {
      id: block ? block.id : doc.id,
      kind: block ? 'block' : 'doc',
      docId: doc.id,
      docPath: doc.path,
      title: block ? (block.title ?? block.id) : doc.title,
    },
    maxDepth,
    affectedDocuments,
    affectedBlocks,
    sourceRefs,
    codeAnchors,
  }
}

/**
 * セマンティックブロックを多軸フィルタ検索する。
 * 既定では軽量サマリを返し、`full: true` 指定時のみ完全なブロック構造（realization 詳細配列含む）を返す。
 */
export function querySpecs(index: DocsIndex, filters: QuerySpecsFilter = {}) {
  const q = filters.query?.trim().toLowerCase()
  const mount = filters.mount?.trim() || undefined
  const matched = [...index.blocksById.values()].filter((b) => {
    if (mount && index.byId.get(b.docId)?.mountId !== mount) return false
    if (filters.kind && b.kind !== filters.kind) return false
    if (filters.intent && b.intent !== filters.intent) return false
    if (filters.stability && b.stability !== filters.stability) return false
    if (filters.review && b.review !== filters.review) return false
    if (filters.realization && b.realization?.status !== filters.realization) return false
    if (filters.suspect !== undefined && b.suspect !== filters.suspect) return false
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
  if (!doc) return undefined

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

  // 独立 decision 文書および対象文書・関連文書内の現行インライン <Decision>（マイクロ ADR）を収集（廃止済みは除外）
  const decisionBlocks = [doc, ...relatedDocs]
    .flatMap((d) =>
      d.blocks.filter(
        (b): b is DecisionSemanticBlock => b.kind === 'decision' && !(b.supersededBy && b.supersededBy.length > 0),
      ),
    )
    .filter((b, i, arr) => arr.findIndex((x) => x.id === b.id) === i)

  // 対象 Spec / 文書を verifies する <Test> 保証シナリオを収集
  const specTargetIds = new Set<string>(targetIds)
  for (const b of doc.blocks) {
    if (b.kind === 'spec' && (!block || b.id === block.id)) specTargetIds.add(b.id)
  }
  const testBlocks = [...index.blocksById.values()]
    .filter((b): b is TestSemanticBlock => b.kind === 'test' && b.verifies.some((v) => specTargetIds.has(v)))
    .map((t) => {
      const entry: { id: string; docId: string; level?: string; verifies: string[]; body: string } = {
        id: t.id,
        docId: t.docId,
        verifies: t.verifies,
        body: full ? t.rawBody : summarizeText(t.rawBody, 240),
      }
      if (t.level) entry.level = t.level
      return entry
    })

  const terms = [...index.blocksById.values()]
    .filter((b) => b.kind === 'term')
    .filter(
      (b) =>
        doc.body.toLowerCase().includes(b.id.toLowerCase()) ||
        b.aliases.some((a) => doc.body.toLowerCase().includes(a.toLowerCase())),
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
    upstreamGoals,
    relatedDocuments: full
      ? relatedDocs.map(toDocumentSummary)
      : relatedDocs.map((d) => ({ id: d.id, type: d.type, title: d.title, description: d.description })),
    decisions: decisionBlocks.map((o) => {
      const entry: { id: string; docId: string; summary?: string; body: string } = {
        id: o.id,
        docId: o.docId,
        body: full ? o.rawBody : summarizeText(o.summary ?? o.chosen ?? o.rawBody, 240),
      }
      if (o.summary) entry.summary = o.summary
      return entry
    }),
    tests: testBlocks,
    relevantTerms: terms.map((t) => ({
      id: t.id,
      aliases: t.aliases,
      symbols: t.symbols,
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
  options: { type?: ArtifactType; mount?: string; limit?: number } = {},
) {
  const mount = options.mount?.trim() || undefined
  const limit = options.limit ?? 20
  const raw = searchIndex(index, query, { type: options.type, limit: mount ? Math.max(limit * 4, 100) : limit })
  const results = mount ? raw.filter((r) => index.byId.get(r.docId)?.mountId === mount).slice(0, limit) : raw
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
    const extracted = await extractExportedSymbols(projectRoot, file)
    if (extracted.isOk() && extracted.value.symbols.length > 0) {
      results.push({
        file: extracted.value.file,
        language: extracted.value.language,
        symbols: extracted.value.symbols,
      })
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
