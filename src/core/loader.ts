import type { Dirent } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseYamlFrontmatter, splitFrontmatter } from './frontmatter'
import { applyGitFreshness } from './git'
import { buildGraphAndValidate, stripDocExt, type RawDocEntry } from './graph'
import { extractMdxArtifacts } from './mdx'
import { applyReviewsAndSuspects, loadReviews } from './reviews'
import { sortDocuments } from './tree'
import { ARTIFACT_TYPE_ALIASES, TRACE_EDGE_KINDS, isArtifactType } from './types'
import type {
  ArtifactType,
  DocFormat,
  DocIssue,
  Document,
  DocsIndex,
  IndexIssue,
  SemanticBlock,
  TermSemanticBlock,
  TraceEdgeKind,
} from './types'

export { buildDocTree, toDocumentSummary } from './tree'

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
  const termsByName = new Map<string, TermSemanticBlock>()

  const relFiles = await collectMarkdownFiles(root, '', issues)
  // .mdx を .md より優先処理して同名衝突時に .mdx を採用する
  relFiles.sort((a, b) => {
    const idA = stripDocExt(a)
    const idB = stripDocExt(b)
    if (idA !== idB) return idA.localeCompare(idB)
    return a.endsWith('.mdx') ? -1 : 1
  })

  for (const relPath of relFiles) {
    const docId = stripDocExt(relPath)
    if (byId.has(docId)) {
      issues.push({
        code: 'duplicate-doc-id',
        message: `Duplicate document ID "${docId}" (${byId.get(docId)!.path} and ${relPath})`,
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
          message: `Duplicate block ID "${block.id}" (${prev.docId} and ${doc.id})`,
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
  await applyGitFreshness(index)

  return index
}

export function getDocument(index: DocsIndex, docId: string): Document | undefined {
  const normalized = normalizeDocId(docId)
  if (!normalized) return undefined
  return index.byId.get(normalized)
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
      message: `Failed to read directory ${absDir}: ${errorMessage(error)}`,
      path: relDir || '.',
    })
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (!relDir && entry.isDirectory() && entry.name === 'guard') continue
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
): Promise<RawDocEntry | undefined> {
  let source: string
  try {
    source = await readFile(path.join(root, relPath), 'utf-8')
  } catch (error) {
    indexIssues.push({
      code: 'read-error',
      message: `Failed to read file: ${errorMessage(error)}`,
      path: relPath,
    })
    return undefined
  }

  const format: DocFormat = relPath.toLowerCase().endsWith('.mdx') ? 'mdx' : 'markdown'
  const docIssues: DocIssue[] = []

  let rawFm: Record<string, unknown> = {}
  const fmRes = splitFrontmatter(source)
  if (fmRes.isErr()) {
    indexIssues.push({
      code: 'invalid-frontmatter',
      message: fmRes.error.message,
      path: relPath,
    })
    return undefined
  }
  const fm = fmRes.value
  const body = fm.body
  const bodyLineOffset = fm.bodyStartLine - 1
  if (fm.hasFrontmatter) {
    const parsedRes = parseYamlFrontmatter(fm.data)
    if (parsedRes.isErr()) {
      indexIssues.push({
        code: 'invalid-frontmatter',
        message: parsedRes.error.message,
        path: relPath,
      })
      return undefined
    }
    const parsed = parsedRes.value
    if (parsed === null || parsed === undefined) {
      rawFm = {}
    } else if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      rawFm = parsed as Record<string, unknown>
    } else {
      docIssues.push({ code: 'invalid-frontmatter', message: 'Frontmatter must be a YAML mapping/object' })
    }
  } else {
    docIssues.push({
      code: 'missing-frontmatter',
      message: 'Missing YAML frontmatter (artifact type inferred from path)',
    })
  }

  const extracted = extractMdxArtifacts(body, format, docId, bodyLineOffset)
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
      message: `Invalid artifact type: ${formatUnknown(rawType)} (inferring from path)`,
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
    message: 'Could not infer artifact type from frontmatter or path; defaulting to "guide"',
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
  issues.push({ code: 'missing-title', message: 'Missing title; falling back to filename' })
  return docId.split('/').pop() ?? docId
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

function parseDateField(value: unknown, issues: DocIssue[]): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  let normalized: string | undefined
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
      message: `date must be in YYYY-MM-DD (or YYYY-MM) format: ${formatUnknown(value)}`,
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
    return value.map((s) => s.trim()).filter(Boolean)
  }
  issues.push({ code: 'invalid-field', message: `${field} must be a string or an array of strings` })
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

function registerTerm(block: TermSemanticBlock, termsByName: Map<string, TermSemanticBlock>, issues: DocIssue[]): void {
  const names = [block.id, ...block.aliases]
  for (const name of names) {
    const key = name.toLowerCase()
    const existing = termsByName.get(key)
    if (existing && existing.id !== block.id) {
      issues.push({
        code: 'duplicate-term',
        message: `Duplicate term "${name}" defined in both "${existing.id}" and "${block.id}"`,
        blockId: block.id,
      })
      continue
    }
    termsByName.set(key, block)
  }
}

function normalizeDocId(raw: string): string | undefined {
  const cleaned = raw.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!cleaned || cleaned.includes('..') || cleaned.includes('\0')) return undefined
  return stripDocExt(cleaned)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
