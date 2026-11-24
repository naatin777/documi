import { searchIndexBm25 } from './retrieval'
import type { SearchHit } from './retrieval'
import type { ArtifactType, DocsIndex, Document } from './types'

export type { SearchHit }

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
 * ドキュメントおよびセマンティックブロックを対象とした全文検索（BM25 + 日英トークナイザ + 用語集同義語展開）。
 */
export function searchIndex(
  index: DocsIndex,
  rawQuery: string,
  options: { type?: ArtifactType; limit?: number } = {},
): SearchHit[] {
  return searchIndexBm25(index, rawQuery, options).hits
}
