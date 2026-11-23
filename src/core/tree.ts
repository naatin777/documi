import { ARTIFACT_TYPES } from './types'
import type { DocTreeDir, DocTreeNode, Document, DocumentSummary } from './types'

export function toDocumentSummary(doc: Document): DocumentSummary {
  return {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    description: doc.description,
    ...(doc.date ? { date: doc.date } : {}),
    tags: doc.tags,
    path: doc.path,
    dir: doc.dir,
    format: doc.format,
    blockCount: doc.blocks.length,
    specCount: doc.blocks.filter((b) => b.kind === 'spec').length,
    issueCount: doc.issues.length,
    ...(doc.freshness ? { freshness: doc.freshness } : {}),
  }
}

function findOrCreateDir(parent: DocTreeDir, name: string, fullPath: string): DocTreeDir {
  const existing = parent.children.find((c): c is DocTreeDir => c.kind === 'dir' && c.name === name)
  if (existing) return existing
  const created: DocTreeDir = { kind: 'dir', name, path: fullPath, children: [] }
  parent.children.push(created)
  return created
}

/** ドキュメント一覧からディレクトリ階層ツリーを構築する */
export function buildDocTree(documents: readonly Document[]): DocTreeNode[] {
  const root: DocTreeDir = { kind: 'dir', name: '', path: '', children: [] }

  for (const doc of documents) {
    const segments = doc.id.split('/')
    let current = root
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!
      const dirPath = segments.slice(0, i + 1).join('/')
      current = findOrCreateDir(current, seg, dirPath)
    }
    current.children.push({
      kind: 'doc',
      name: segments[segments.length - 1]!,
      doc: toDocumentSummary(doc),
    })
  }

  sortTreeNodes(root.children)
  return root.children
}

function sortTreeNodes(nodes: DocTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const node of nodes) {
    if (node.kind === 'dir') sortTreeNodes(node.children)
  }
}

/** Artifact Type 順（ADR は決定日降順）でドキュメントを整列する */
export function sortDocuments(documents: Document[]): void {
  const order = new Map(ARTIFACT_TYPES.map((t, i) => [t, i]))
  documents.sort((a, b) => {
    const ta = order.get(a.type) ?? 99
    const tb = order.get(b.type) ?? 99
    if (ta !== tb) return ta - tb
    // ADR (decision) は新しい決定日 (date) が先頭に来るよう降順ソートする
    if (a.type === 'decision' && (a.date || b.date)) {
      if (a.date && b.date && a.date !== b.date) return b.date.localeCompare(a.date)
      if (a.date && !b.date) return -1
      if (!a.date && b.date) return 1
    }
    return a.id.localeCompare(b.id)
  })
}
