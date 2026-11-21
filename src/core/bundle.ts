import type { ArtifactType, DocsIndex, Document, RealizationSummary, ReviewStatus, SemanticBlock } from './types'

export interface BundleSelector {
  /** 'all' | 'dir:<prefix>' | 'goal:<docId>' | 'node:<id>' */
  scope?: string
  /** 明示指定されたドキュメント ID 一覧 */
  ids?: string[]
}

export interface ResolvedBundle {
  scopeLabel: string
  documents: Document[]
}

export interface SearchHit {
  kind: 'doc' | 'block'
  id: string
  docId: string
  type: ArtifactType
  title: string
  blockKind?: SemanticBlock['kind']
  snippet: string
  score: number
}

export interface TraceMatrixRow {
  specId: string
  docId: string
  docTitle: string
  intent: SemanticBlock['intent']
  stability: SemanticBlock['stability']
  review: ReviewStatus
  suspect: boolean
  orphan: boolean
  goals: Array<{ id: string; title: string }>
  designs: Array<{ id: string; type: ArtifactType; title: string }>
  verifications: Array<{ id: string; title: string }>
  realization?: RealizationSummary
}

/**
 * スコープまたは明示 ID リストからバンドル出力対象のドキュメント配列を解決する。
 */
export function resolveBundleDocuments(index: DocsIndex, selector: BundleSelector): ResolvedBundle {
  if (selector.ids && selector.ids.length > 0) {
    const docs: Document[] = []
    const seen = new Set<string>()
    for (const raw of selector.ids) {
      const id = raw.trim()
      if (!id || seen.has(id)) continue
      const doc = index.byId.get(id)
      if (doc) {
        seen.add(id)
        docs.push(doc)
      }
    }
    return { scopeLabel: `Selected (${docs.length} docs)`, documents: docs }
  }

  const scope = (selector.scope ?? 'all').trim()
  if (!scope || scope === 'all') {
    return { scopeLabel: 'All Documents', documents: [...index.documents] }
  }

  if (scope.startsWith('dir:')) {
    const prefix = scope.slice('dir:'.length).replace(/^\/+|\/+$/g, '')
    const docs = index.documents.filter((d) => d.dir === prefix || d.dir.startsWith(`${prefix}/`) || d.id === prefix)
    return { scopeLabel: `Directory: ${prefix || '/'}`, documents: docs }
  }

  if (scope.startsWith('goal:') || scope.startsWith('node:')) {
    const rootId = scope.slice(scope.indexOf(':') + 1).trim()
    const rootDoc =
      index.byId.get(rootId) ??
      (() => {
        const b = index.blocksById.get(rootId)
        return b ? index.byId.get(b.docId) : undefined
      })()
    if (!rootDoc) return { scopeLabel: `Scope: ${rootId}`, documents: [] }

    // 指定ノードから下流 (derives/satisfies/verifies の逆方向) および関連文書を収集
    const collectedDocIds = new Set<string>([rootDoc.id])
    const queue: string[] = [rootDoc.id, ...rootDoc.blocks.map((b) => b.id)]
    const visitedNodes = new Set<string>()

    while (queue.length > 0) {
      const cur = queue.shift()!
      if (visitedNodes.has(cur)) continue
      visitedNodes.add(cur)

      for (const edge of index.edges) {
        if (edge.kind === 'mentions') continue
        // 下流 -> 上流 (cur) のエッジを逆向きに辿る
        if (edge.to === cur || edge.toDocId === cur) {
          if (!collectedDocIds.has(edge.fromDocId)) {
            collectedDocIds.add(edge.fromDocId)
            const childDoc = index.byId.get(edge.fromDocId)
            if (childDoc) {
              queue.push(childDoc.id, ...childDoc.blocks.map((b) => b.id))
            }
          }
        }
      }
    }

    // 収集した文書から mentions されている domain (用語集) や decision も同梱
    for (const docId of Array.from(collectedDocIds)) {
      for (const edge of index.edges) {
        if (edge.fromDocId !== docId) continue
        const targetDoc = index.byId.get(edge.toDocId)
        if (targetDoc && (targetDoc.type === 'domain' || targetDoc.type === 'decision')) {
          collectedDocIds.add(targetDoc.id)
        }
      }
    }

    const docs = index.documents.filter((d) => collectedDocIds.has(d.id))
    return { scopeLabel: `${rootDoc.title} (${rootDoc.id})`, documents: docs }
  }

  return { scopeLabel: 'All Documents', documents: [...index.documents] }
}

/**
 * ドキュメントおよびセマンティックブロックを対象とした全文検索。
 */
export function searchIndex(
  index: DocsIndex,
  rawQuery: string,
  options: { type?: ArtifactType; limit?: number } = {},
): SearchHit[] {
  const query = rawQuery.trim()
  if (!query) return []
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []

  const hits: SearchHit[] = []

  for (const doc of index.documents) {
    if (options.type && doc.type !== options.type) continue
    const titleLow = doc.title.toLowerCase()
    const idLow = doc.id.toLowerCase()
    const descLow = doc.description.toLowerCase()
    const tagsLow = doc.tags.join(' ').toLowerCase()
    const bodyLow = doc.body.toLowerCase()

    let score = 0
    let matchedAll = true
    for (const t of terms) {
      let termScore = 0
      if (titleLow.includes(t)) termScore += 10
      if (idLow.includes(t)) termScore += 8
      if (tagsLow.includes(t)) termScore += 6
      if (descLow.includes(t)) termScore += 5
      if (bodyLow.includes(t)) termScore += 2
      if (termScore === 0) {
        matchedAll = false
        break
      }
      score += termScore
    }
    if (matchedAll && score > 0) {
      hits.push({
        kind: 'doc',
        id: doc.id,
        docId: doc.id,
        type: doc.type,
        title: doc.title,
        snippet: extractSnippet(doc.description || doc.body, terms[0]!),
        score,
      })
    }

    for (const block of doc.blocks) {
      const bIdLow = block.id.toLowerCase()
      const bTitleLow = (block.title ?? '').toLowerCase()
      const bBodyLow = block.rawBody.toLowerCase()
      const bAliasLow = (block.aliases ?? []).join(' ').toLowerCase()

      let bScore = 0
      let bAll = true
      for (const t of terms) {
        let s = 0
        if (bIdLow.includes(t)) s += 12
        if (bAliasLow.includes(t)) s += 9
        if (bTitleLow.includes(t)) s += 8
        if (bBodyLow.includes(t)) s += 3
        if (s === 0) {
          bAll = false
          break
        }
        bScore += s
      }
      if (bAll && bScore > 0) {
        hits.push({
          kind: 'block',
          id: block.id,
          docId: doc.id,
          type: doc.type,
          title: block.title ? `${block.id} — ${block.title}` : block.id,
          blockKind: block.kind,
          snippet: extractSnippet(block.rawBody, terms[0]!),
          score: bScore + 1,
        })
      }
    }
  }

  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return hits.slice(0, options.limit ?? 30)
}

function extractSnippet(text: string, term: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const idx = flat.toLowerCase().indexOf(term)
  if (idx < 0) return flat.slice(0, 120)
  const start = Math.max(0, idx - 36)
  const end = Math.min(flat.length, idx + term.length + 84)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < flat.length ? '…' : ''
  return `${prefix}${flat.slice(start, end)}${suffix}`
}

/**
 * 全 <Spec> ブロックのトレーサビリティマトリクスを構築する。
 */
export function buildTraceMatrix(index: DocsIndex): TraceMatrixRow[] {
  const rows: TraceMatrixRow[] = []

  for (const doc of index.documents) {
    const orphanIds = new Set(doc.issues.filter((i) => i.code === 'orphan-spec' && i.blockId).map((i) => i.blockId!))

    for (const block of doc.blocks) {
      if (block.kind !== 'spec') continue

      // 上流 Goal を探索
      const goals = new Map<string, { id: string; title: string }>()
      const queue = [block.id, doc.id]
      const visited = new Set<string>()
      while (queue.length > 0) {
        const cur = queue.shift()!
        if (visited.has(cur)) continue
        visited.add(cur)
        for (const e of index.edges) {
          if (e.kind !== 'derives' || e.from !== cur) continue
          const targetDoc = index.byId.get(e.toDocId)
          if (targetDoc?.type === 'goal') {
            goals.set(targetDoc.id, { id: targetDoc.id, title: targetDoc.title })
          }
          queue.push(e.to, e.toDocId)
        }
      }

      // 下流の Design / Contract (satisfies) と Verification (verifies) を収集
      const designs = new Map<string, { id: string; type: ArtifactType; title: string }>()
      const verifications = new Map<string, { id: string; title: string }>()

      for (const e of index.edges) {
        if (e.to !== block.id && e.to !== doc.id) continue
        const fromDoc = index.byId.get(e.fromDocId)
        if (!fromDoc) continue
        if (
          e.kind === 'satisfies' &&
          (fromDoc.type === 'design' || fromDoc.type === 'contract' || fromDoc.type === 'architecture')
        ) {
          designs.set(fromDoc.id, { id: fromDoc.id, type: fromDoc.type, title: fromDoc.title })
        }
        if (e.kind === 'verifies' && fromDoc.type === 'verification') {
          verifications.set(fromDoc.id, { id: fromDoc.id, title: fromDoc.title })
        }
      }

      rows.push({
        specId: block.id,
        docId: doc.id,
        docTitle: doc.title,
        intent: block.intent,
        stability: block.stability,
        review: block.review,
        suspect: block.suspect,
        orphan: orphanIds.has(block.id),
        goals: [...goals.values()],
        designs: [...designs.values()],
        verifications: [...verifications.values()],
        realization: block.realization,
      })
    }
  }

  rows.sort((a, b) => a.specId.localeCompare(b.specId))
  return rows
}
