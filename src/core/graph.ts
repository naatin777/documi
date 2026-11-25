import path from 'node:path'
import { TRACE_EDGE_KINDS } from './types'
import type { Document, EdgeKind, GraphEdge, ResolvedRelation, SemanticBlock } from './types'

export interface RawDocEntry {
  doc: Document
  bodyLinks: string[]
  termRefs: string[]
}

interface ResolvedTarget {
  ref: string
  kind: 'doc' | 'block'
  doc: Document
}

export function stripDocExt(filePath: string): string {
  return filePath.replace(/\.(mdx|md)$/i, '')
}

/**
 * 全ドキュメント・ブロック・SourceRef・本文リンク・用語参照からグラフエッジを構築し、
 * 双方向参照・循環参照・Rooted DAG (Goal 到達性) を検証する。
 */
export function buildGraphAndValidate(
  entries: RawDocEntry[],
  byId: Map<string, Document>,
  blocksById: Map<string, SemanticBlock>,
  termsByName: Map<string, SemanticBlock>,
): GraphEdge[] {
  const edges: GraphEdge[] = []
  const edgeKeys = new Set<string>()

  const addEdge = (
    from: string,
    fromDoc: Document,
    target: ResolvedTarget,
    kind: EdgeKind,
    reportSelf: boolean,
  ): void => {
    if (from === target.ref || (kind === 'mentions' && fromDoc.id === target.doc.id && target.kind === 'doc')) {
      if (reportSelf) {
        fromDoc.issues.push({ code: 'self-relation', message: `自己参照は許可されていません: ${target.ref}` })
      }
      return
    }
    const key = `${from}|${kind}|${target.ref}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)

    edges.push({
      from,
      fromDocId: fromDoc.id,
      to: target.ref,
      toDocId: target.doc.id,
      toKind: target.kind,
      kind,
    })
  }

  for (const { doc, bodyLinks, termRefs } of entries) {
    // 1. Frontmatter の意味付きエッジ
    for (const kind of TRACE_EDGE_KINDS) {
      for (const rawTarget of doc.declaredEdges[kind] ?? []) {
        const target = resolveTarget(rawTarget, doc, byId, blocksById)
        if (!target) {
          doc.issues.push({ code: 'missing-relation', message: `参照先が存在しません (${kind}): ${rawTarget}` })
          continue
        }
        addEdge(doc.id, doc, target, kind, true)
      }
    }

    // 2. セマンティックブロックの derives / supersedes
    for (const block of doc.blocks) {
      for (const rawTarget of block.derives) {
        const target = resolveTarget(rawTarget, doc, byId, blocksById)
        if (!target) {
          doc.issues.push({
            code: 'missing-relation',
            message: `参照先が存在しません (derives): ${rawTarget}`,
            blockId: block.id,
          })
          continue
        }
        addEdge(block.id, doc, target, 'derives', true)
      }
      for (const rawTarget of block.supersedes) {
        const target = resolveTarget(rawTarget, doc, byId, blocksById)
        if (!target) {
          doc.issues.push({
            code: 'missing-relation',
            message: `参照先が存在しません (supersedes): ${rawTarget}`,
            blockId: block.id,
          })
          continue
        }
        addEdge(block.id, doc, target, 'supersedes', true)
      }
    }

    // 3. SourceRef の satisfies / verifies
    for (const ref of doc.sourceRefs) {
      for (const rawTarget of ref.satisfies) {
        const target = resolveTarget(rawTarget, doc, byId, blocksById)
        if (!target) {
          doc.issues.push({
            code: 'missing-relation',
            message: `SourceRef の satisfies 先が存在しません: ${rawTarget}`,
          })
          continue
        }
        addEdge(doc.id, doc, target, 'satisfies', true)
      }
      for (const rawTarget of ref.verifies) {
        const target = resolveTarget(rawTarget, doc, byId, blocksById)
        if (!target) {
          doc.issues.push({ code: 'missing-relation', message: `SourceRef の verifies 先が存在しません: ${rawTarget}` })
          continue
        }
        addEdge(doc.id, doc, target, 'verifies', true)
      }
    }

    // 4. 本文 Markdown リンクから mentions エッジを自動抽出
    for (const href of bodyLinks) {
      if (isExternalOrAnchorHref(href)) continue
      const target = resolveTarget(href, doc, byId, blocksById)
      if (target) {
        addEdge(doc.id, doc, target, 'mentions', false)
      } else if (looksLikeInternalDocLink(href)) {
        doc.issues.push({ code: 'missing-relation', message: `本文リンクの参照先が存在しません: ${href}` })
      }
    }

    // 5. <Term name="..." /> から mentions エッジを自動抽出
    for (const termName of termRefs) {
      const term = termsByName.get(termName.toLowerCase())
      if (!term) {
        doc.issues.push({
          code: 'missing-term',
          message: `未定義の用語が参照されています: <Term name="${termName}" />`,
        })
        continue
      }
      const termDoc = byId.get(term.docId)
      if (termDoc) {
        addEdge(doc.id, doc, { ref: term.id, kind: 'block', doc: termDoc }, 'mentions', false)
      }
    }
  }

  // 文書単位の outgoing / incoming を集約
  populateDocumentRelations(edges, byId, blocksById)

  // Rooted DAG 検証: 循環検出 & Goal 到達性 (orphan-spec)
  detectCycles(edges, 'derives', byId)
  detectCycles(edges, 'supersedes', byId)
  validateGoalReachability(entries, edges, byId)

  return edges
}

function populateDocumentRelations(
  edges: GraphEdge[],
  byId: Map<string, Document>,
  blocksById: Map<string, SemanticBlock>,
): void {
  const outSeen = new Map<string, Set<string>>()
  const inSeen = new Map<string, Set<string>>()

  for (const edge of edges) {
    const fromDoc = byId.get(edge.fromDocId)
    const toDoc = byId.get(edge.toDocId)
    if (!fromDoc || !toDoc) continue

    const targetBlock = edge.toKind === 'block' ? blocksById.get(edge.to) : undefined
    const targetTitle = targetBlock?.title ?? (targetBlock ? `${targetBlock.id} (${toDoc.title})` : toDoc.title)

    const outKey = `${edge.kind}|${edge.to}`
    const oSet = outSeen.get(fromDoc.id) ?? new Set<string>()
    if (!oSet.has(outKey)) {
      oSet.add(outKey)
      outSeen.set(fromDoc.id, oSet)
      fromDoc.outgoing.push({
        ref: edge.to,
        targetKind: edge.toKind,
        docId: toDoc.id,
        type: toDoc.type,
        title: targetTitle,
        kind: edge.kind,
        path: toDoc.path,
      })
    }

    if (fromDoc.id !== toDoc.id) {
      const inKey = `${edge.kind}|${fromDoc.id}`
      const iSet = inSeen.get(toDoc.id) ?? new Set<string>()
      if (!iSet.has(inKey)) {
        iSet.add(inKey)
        inSeen.set(toDoc.id, iSet)
        toDoc.incoming.push({
          ref: fromDoc.id,
          targetKind: 'doc',
          docId: fromDoc.id,
          type: fromDoc.type,
          title: fromDoc.title,
          kind: edge.kind,
          path: fromDoc.path,
        })
      }
    }
  }

  for (const doc of byId.values()) {
    doc.outgoing.sort(compareRelation)
    doc.incoming.sort(compareRelation)
  }
}

function compareRelation(a: ResolvedRelation, b: ResolvedRelation): number {
  if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
  return a.ref.localeCompare(b.ref)
}

/** derives / supersedes エッジの循環参照を検出する */
function detectCycles(edges: GraphEdge[], kind: 'derives' | 'supersedes', byId: Map<string, Document>): void {
  const adj = new Map<string, { to: string; fromDocId: string }[]>()
  for (const e of edges) {
    if (e.kind !== kind) continue
    ;(adj.get(e.from) ?? (adj.set(e.from, []), adj.get(e.from)!)).push({ to: e.to, fromDocId: e.fromDocId })
  }

  const state = new Map<string, 'visiting' | 'done'>()
  const reported = new Set<string>()

  const dfs = (node: string) => {
    state.set(node, 'visiting')
    for (const next of adj.get(node) ?? []) {
      const s = state.get(next.to)
      if (s === 'visiting') {
        const key = `${next.fromDocId}|${kind}|${node}->${next.to}`
        if (!reported.has(key)) {
          reported.add(key)
          byId.get(next.fromDocId)?.issues.push({
            code: 'cycle-detected',
            message: `${kind} に循環参照が検出されました: ${node} → ${next.to}`,
          })
        }
      } else if (!s) {
        dfs(next.to)
      }
    }
    state.set(node, 'done')
  }

  for (const node of adj.keys()) {
    if (!state.has(node)) dfs(node)
  }
}

/**
 * Rooted DAG 検証:
 * intent="normative" のすべての <Spec> (および <Spec> を持たない spec 文書) が
 * derives を辿って 1 つ以上の goal に到達できるかを検証する。
 */
function validateGoalReachability(entries: RawDocEntry[], edges: GraphEdge[], byId: Map<string, Document>): void {
  const derivesAdj = new Map<string, { to: string; toDocId: string }[]>()
  for (const e of edges) {
    if (e.kind !== 'derives') continue
    ;(derivesAdj.get(e.from) ?? (derivesAdj.set(e.from, []), derivesAdj.get(e.from)!)).push({
      to: e.to,
      toDocId: e.toDocId,
    })
  }

  const canReachGoal = (startIds: string[]): boolean => {
    const visited = new Set<string>()
    const queue = [...startIds]
    while (queue.length > 0) {
      const cur = queue.shift()!
      if (visited.has(cur)) continue
      visited.add(cur)

      for (const next of derivesAdj.get(cur) ?? []) {
        const targetDoc = byId.get(next.toDocId)
        if (targetDoc?.type === 'goal') return true
        if (!visited.has(next.to)) queue.push(next.to)
        if (!visited.has(next.toDocId)) queue.push(next.toDocId)
      }
    }
    return false
  }

  for (const { doc } of entries) {
    const specBlocks = doc.blocks.filter((b) => b.kind === 'spec')
    if (specBlocks.length > 0) {
      for (const block of specBlocks) {
        if (block.intent !== 'normative') continue
        // ブロック自身の derives + 所属文書の derives の両方から Goal へ辿れるか確認
        if (!canReachGoal([block.id, doc.id])) {
          doc.issues.push({
            code: 'orphan-spec',
            message: `<Spec id="${block.id}"> が derives 経由で Goal に接続されていません`,
            blockId: block.id,
          })
        }
      }
    } else if (doc.type === 'spec') {
      if (!canReachGoal([doc.id])) {
        doc.issues.push({
          code: 'orphan-spec',
          message: `Spec 文書 "${doc.id}" が derives 経由で Goal に接続されていません`,
        })
      }
    }
  }
}

function resolveTarget(
  raw: string,
  fromDoc: Document,
  byId: Map<string, Document>,
  blocksById: Map<string, SemanticBlock>,
): ResolvedTarget | undefined {
  const cleaned = raw.trim().split('#')[0]?.split('?')[0]?.trim() ?? ''
  if (!cleaned) return undefined

  // 1. ブロック ID に完全一致
  const block = blocksById.get(cleaned)
  if (block) {
    const doc = byId.get(block.docId)
    if (doc) return { ref: block.id, kind: 'block', doc }
  }

  // 2. /docs/... プレフィックス除去
  const withoutRoute = cleaned.replace(/^\/(?:docs|pages)\//, '')
  const direct = byId.get(stripDocExt(withoutRoute))
  if (direct) return { ref: direct.id, kind: 'doc', doc: direct }

  // 3. 相対パス解決 (./foo.mdx, ../goals/core.mdx)
  if (cleaned.startsWith('./') || cleaned.startsWith('../') || /\.(md|mdx)$/i.test(cleaned)) {
    const joined = path.posix.normalize(path.posix.join(fromDoc.dir, cleaned))
    const relDoc = byId.get(stripDocExt(joined))
    if (relDoc) return { ref: relDoc.id, kind: 'doc', doc: relDoc }
  }

  return undefined
}

function isExternalOrAnchorHref(href: string): boolean {
  const t = href.trim()
  if (t.startsWith('#')) return true
  return /^(?:https?|mailto|tel|data|javascript):/i.test(t)
}

function looksLikeInternalDocLink(href: string): boolean {
  const t = href.trim().split('#')[0]?.split('?')[0] ?? ''
  return /\.(md|mdx)$/i.test(t) || t.startsWith('/docs/') || t.startsWith('/pages/')
}
