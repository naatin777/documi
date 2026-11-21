import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { ARTIFACT_TYPES, ARTIFACT_TYPE_ALIASES, TRACE_EDGE_KINDS, isArtifactType } from './types'
import type {
  ArtifactType,
  DocFormat,
  DocIssue,
  DocTreeDir,
  DocTreeNode,
  Document,
  DocumentSummary,
  DocsIndex,
  EdgeKind,
  GraphEdge,
  IndexIssue,
  ResolvedRelation,
  SemanticBlock,
  TraceEdgeKind,
} from './types'
import { FrontmatterError, parseYamlFrontmatter, splitFrontmatter } from './frontmatter'
import { extractMdxArtifacts } from './mdx'
import { applyReviewsAndSuspects, loadReviews } from './reviews'

interface RawDocEntry {
  doc: Document
  bodyLinks: string[]
  termRefs: string[]
}

/**
 * docs ディレクトリを再帰走査し、全ドキュメント・セマンティックブロック・
 * グラフエッジ（Rooted DAG + 本文リンク自動抽出）を構築する。
 * 個別ファイルの不備は issues に記録しつつ読み込みを継続する。
 */
export async function loadDocuments(rootDir: string): Promise<DocsIndex> {
  const root = path.resolve(rootDir)
  const issues: IndexIssue[] = []
  const entries: RawDocEntry[] = []
  const byId = new Map<string, Document>()
  const blocksById = new Map<string, SemanticBlock>()
  const termsByName = new Map<string, SemanticBlock>()

  const relFiles = await collectMarkdownFiles(root, '', issues)
  // .mdx を .md より優先処理して同名衝突時に .mdx を採用する
  relFiles.sort((a, b) => {
    const idA = stripExt(a)
    const idB = stripExt(b)
    if (idA !== idB) return idA.localeCompare(idB)
    return a.endsWith('.mdx') ? -1 : 1
  })

  for (const relPath of relFiles) {
    const docId = stripExt(relPath)
    if (byId.has(docId)) {
      issues.push({
        code: 'duplicate-doc-id',
        message: `ドキュメント ID "${docId}" が重複しています (${byId.get(docId)!.path} と ${relPath})`,
        path: relPath,
      })
      continue
    }

    const parsed = await parseDocumentFile(root, relPath, docId, issues)
    if (!parsed) continue

    const { doc } = parsed
    // ブロック ID のプロジェクト全体一意チェック & 用語登録
    const validBlocks: SemanticBlock[] = []
    for (const block of doc.blocks) {
      if (blocksById.has(block.id)) {
        const prev = blocksById.get(block.id)!
        doc.issues.push({
          code: 'duplicate-block-id',
          message: `ブロック ID "${block.id}" が重複しています (${prev.docId} と ${doc.id})`,
          blockId: block.id,
        })
        continue
      }
      blocksById.set(block.id, block)
      validBlocks.push(block)

      if (block.kind === 'term') {
        registerTerm(block, termsByName, doc.issues)
      }
    }
    doc.blocks = validBlocks

    byId.set(doc.id, doc)
    entries.push(parsed)
  }

  const edges = buildGraphAndValidate(entries, byId, blocksById, termsByName)
  const documents = entries.map((e) => e.doc)
  sortDocuments(documents)

  const index: DocsIndex = {
    rootDir: root,
    loadedAt: new Date().toISOString(),
    documents,
    byId,
    blocksById,
    termsByName,
    edges,
    issues,
  }

  const reviews = await loadReviews(root, issues)
  applyReviewsAndSuspects(index, reviews)

  return index
}

export function getDocument(index: DocsIndex, docId: string): Document | undefined {
  const normalized = normalizeDocId(docId)
  if (!normalized) return undefined
  return index.byId.get(normalized)
}

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
  }
}

/** ドキュメント一覧からディレクトリ階層ツリーを構築する */
export function buildDocTree(documents: readonly Document[]): DocTreeNode[] {
  const root: DocTreeDir = { kind: 'dir', name: '', path: '', children: [] }

  const findOrCreateDir = (parent: DocTreeDir, name: string, fullPath: string): DocTreeDir => {
    const existing = parent.children.find((c): c is DocTreeDir => c.kind === 'dir' && c.name === name)
    if (existing) return existing
    const created: DocTreeDir = { kind: 'dir', name, path: fullPath, children: [] }
    parent.children.push(created)
    return created
  }

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

async function collectMarkdownFiles(root: string, relDir: string, issues: IndexIssue[]): Promise<string[]> {
  const absDir = relDir ? path.join(root, relDir) : root
  let entries: Dirent[]
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    issues.push({
      code: 'read-error',
      message: `ディレクトリを読み込めません: ${absDir} (${errorMessage(error)})`,
      path: relDir || '.',
    })
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const childRel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      const nested = await collectMarkdownFiles(root, childRel, issues)
      files.push(...nested)
    } else if (entry.isFile() && /\.(mdx|md)$/i.test(entry.name)) {
      files.push(childRel)
    }
  }
  return files
}

async function parseDocumentFile(
  root: string,
  relPath: string,
  docId: string,
  indexIssues: IndexIssue[],
): Promise<RawDocEntry | null> {
  let source: string
  try {
    source = await readFile(path.join(root, relPath), 'utf-8')
  } catch (error) {
    indexIssues.push({
      code: 'read-error',
      message: `ファイルを読み込めません: ${errorMessage(error)}`,
      path: relPath,
    })
    return null
  }

  const format: DocFormat = relPath.toLowerCase().endsWith('.mdx') ? 'mdx' : 'markdown'
  const docIssues: DocIssue[] = []

  let rawFm: Record<string, unknown> = {}
  let body = source
  try {
    const fm = splitFrontmatter(source)
    body = fm.body
    if (fm.hasFrontmatter) {
      const parsed = parseYamlFrontmatter(fm.data)
      if (parsed === null || parsed === undefined) {
        rawFm = {}
      } else if (typeof parsed === 'object' && !Array.isArray(parsed)) {
        rawFm = parsed as Record<string, unknown>
      } else {
        docIssues.push({ code: 'invalid-frontmatter', message: 'frontmatter は YAML オブジェクトである必要があります' })
      }
    } else {
      docIssues.push({
        code: 'missing-frontmatter',
        message: 'YAML frontmatter がありません (パスから型を推論しました)',
      })
    }
  } catch (error) {
    indexIssues.push({
      code: 'invalid-frontmatter',
      message: error instanceof FrontmatterError ? error.message : errorMessage(error),
      path: relPath,
    })
    return null
  }

  const extracted = extractMdxArtifacts(body, format, docId)
  docIssues.push(...extracted.issues)

  const { type, typeInferred } = resolveArtifactType(rawFm.type, docId, docIssues)
  const title = resolveTitle(rawFm.title, extracted.firstHeading, docId, docIssues)
  const description = typeof rawFm.description === 'string' ? rawFm.description : ''
  const date = parseDateField(rawFm.date, docIssues)
  const tags = parseStringListField(rawFm.tags, 'tags', docIssues)
  const declaredEdges = parseDeclaredEdges(rawFm, docIssues)

  const slashIdx = docId.lastIndexOf('/')
  const dir = slashIdx >= 0 ? docId.slice(0, slashIdx) : ''

  const doc: Document = {
    id: docId,
    type,
    typeInferred,
    title,
    description,
    ...(date ? { date } : {}),
    tags,
    format,
    path: relPath,
    dir,
    body,
    blocks: extracted.blocks,
    sourceRefs: extracted.sourceRefs,
    declaredEdges,
    outgoing: [],
    incoming: [],
    issues: docIssues,
  }

  return {
    doc,
    bodyLinks: extracted.links,
    termRefs: extracted.termRefs,
  }
}

function resolveArtifactType(
  rawType: unknown,
  docId: string,
  issues: DocIssue[],
): { type: ArtifactType; typeInferred: boolean } {
  if (rawType !== undefined) {
    if (isArtifactType(rawType)) {
      return { type: rawType, typeInferred: false }
    }
    issues.push({
      code: 'invalid-type',
      message: `不正な type です: ${String(rawType)} (パスから推論します)`,
    })
  }

  const segments = docId.split('/')
  // 1. 最上位ディレクトリ名から推論 (例: specs/auth -> spec)
  if (segments.length > 1) {
    const top = segments[0]!.toLowerCase()
    if (top in ARTIFACT_TYPE_ALIASES) {
      return { type: ARTIFACT_TYPE_ALIASES[top]!, typeInferred: true }
    }
  }
  // 2. ファイル名から推論 (例: auth/spec -> spec, glossary -> domain)
  const base = segments[segments.length - 1]!.toLowerCase()
  if (base in ARTIFACT_TYPE_ALIASES) {
    return { type: ARTIFACT_TYPE_ALIASES[base]!, typeInferred: true }
  }

  issues.push({
    code: 'inferred-default-type',
    message: 'frontmatter またはパスから type を判別できなかったため guide として扱います',
  })
  return { type: 'guide', typeInferred: true }
}

function resolveTitle(rawTitle: unknown, firstHeading: string | undefined, docId: string, issues: DocIssue[]): string {
  if (typeof rawTitle === 'string' && rawTitle.trim() !== '') {
    return rawTitle.trim()
  }
  if (firstHeading) {
    return firstHeading
  }
  issues.push({ code: 'missing-title', message: 'title が指定されていないためファイル名を使用します' })
  return docId.split('/').pop() ?? docId
}

function parseDateField(value: unknown, issues: DocIssue[]): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  let normalized: string | null = null
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) {
      normalized = value.toISOString().slice(0, 10)
    }
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(trimmed)
    if (match) {
      const month = Number(match[2])
      const day = match[3] ? Number(match[3]) : 1
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        normalized = trimmed
      }
    }
  }
  if (!normalized) {
    issues.push({
      code: 'invalid-date',
      message: `date は YYYY-MM-DD (または YYYY-MM) 形式で指定してください: ${String(value)}`,
    })
    return undefined
  }
  return normalized
}

function parseStringListField(value: unknown, field: string, issues: DocIssue[]): string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : []
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return (value as string[]).map((s) => s.trim()).filter(Boolean)
  }
  issues.push({ code: 'invalid-field', message: `${field} は文字列または文字列の配列である必要があります` })
  return []
}

function parseDeclaredEdges(
  rawFm: Record<string, unknown>,
  issues: DocIssue[],
): Partial<Record<TraceEdgeKind, string[]>> {
  const declared: Partial<Record<TraceEdgeKind, string[]>> = {}
  for (const kind of TRACE_EDGE_KINDS) {
    const list = parseStringListField(rawFm[kind], kind, issues)
    if (list.length > 0) declared[kind] = list
  }
  return declared
}

function registerTerm(block: SemanticBlock, termsByName: Map<string, SemanticBlock>, issues: DocIssue[]): void {
  const names = [block.id, ...(block.aliases ?? [])]
  for (const name of names) {
    const key = name.toLowerCase()
    const existing = termsByName.get(key)
    if (existing && existing.id !== block.id) {
      issues.push({
        code: 'duplicate-term',
        message: `用語名 "${name}" が "${existing.id}" と "${block.id}" で重複しています`,
        blockId: block.id,
      })
      continue
    }
    termsByName.set(key, block)
  }
}

interface ResolvedTarget {
  ref: string
  kind: 'doc' | 'block'
  doc: Document
}

function buildGraphAndValidate(
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
): ResolvedTarget | null {
  const cleaned = raw.trim().split('#')[0]?.split('?')[0]?.trim() ?? ''
  if (!cleaned) return null

  // 1. ブロック ID に完全一致
  const block = blocksById.get(cleaned)
  if (block) {
    const doc = byId.get(block.docId)
    if (doc) return { ref: block.id, kind: 'block', doc }
  }

  // 2. /docs/... プレフィックス除去
  const withoutRoute = cleaned.replace(/^\/(?:docs|pages)\//, '')
  const direct = byId.get(stripExt(withoutRoute))
  if (direct) return { ref: direct.id, kind: 'doc', doc: direct }

  // 3. 相対パス解決 (./foo.mdx, ../goals/core.mdx)
  if (cleaned.startsWith('./') || cleaned.startsWith('../') || /\.(md|mdx)$/i.test(cleaned)) {
    const joined = path.posix.normalize(path.posix.join(fromDoc.dir, cleaned))
    const relDoc = byId.get(stripExt(joined))
    if (relDoc) return { ref: relDoc.id, kind: 'doc', doc: relDoc }
  }

  return null
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

function stripExt(filePath: string): string {
  return filePath.replace(/\.(mdx|md)$/i, '')
}

function normalizeDocId(raw: string): string | null {
  const cleaned = raw.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!cleaned || cleaned.includes('..') || cleaned.includes('\0')) return null
  return stripExt(cleaned)
}

function sortDocuments(documents: Document[]): void {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
