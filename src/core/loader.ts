import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ARTIFACT_TYPES,
  ARTIFACT_TYPE_DIRECTORIES,
  DOC_STATUSES,
  FILENAME_PATTERN,
  ID_PATTERN,
  documentRef,
  isArtifactType,
} from './types'
import type {
  ArtifactType,
  DocIssue,
  DocStatus,
  Document,
  DocsIndex,
  Glossary,
  IndexIssue,
  RelationTarget,
} from './types'
import { FrontmatterError, parseYamlFrontmatter, splitFrontmatter } from './frontmatter'
import { analyzeMdxBody } from './mdx'

interface ParsedFile {
  document?: Document
  fileIssue?: IndexIssue
}

/**
 * docs ディレクトリを走査し、全 Artifact を読み込んで
 * 解決済み Relations と逆参照を持つインデックスを構築する。
 * 読み込み不能なファイルは issues に記録し、処理を継続する。
 */
export async function loadDocuments(rootDir: string): Promise<DocsIndex> {
  const root = path.resolve(rootDir)
  const issues: IndexIssue[] = []
  const documents: Document[] = []
  const byRef = new Map<string, Document>()

  for (const type of ARTIFACT_TYPES) {
    const dir = path.join(root, ARTIFACT_TYPE_DIRECTORIES[type])
    const entries = await readDirSafe(dir, issues)
    if (!entries) continue

    const files = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) => !name.startsWith('.'))
      .sort()

    for (const name of files) {
      const relPath = `${ARTIFACT_TYPE_DIRECTORIES[type]}/${name}`
      const parsed = await parseDocumentFile(root, dir, name, type, relPath, issues)
      if (parsed.document) {
        const doc = parsed.document
        if (byRef.has(doc.ref)) {
          issues.push({
            code: 'duplicate-id',
            message: `ID ${doc.id} は ${type} 内で重複しています (${byRef.get(doc.ref)!.path} と ${relPath})`,
            path: relPath,
          })
          continue
        }
        documents.push(doc)
        byRef.set(doc.ref, doc)
      }
    }
  }

  const glossary = await loadGlossary(root, issues)
  resolveRelations(documents, byRef)
  sortDocuments(documents)

  return { rootDir: root, documents, byRef, glossary, issues }
}

export function getDocument(index: DocsIndex, type: string, id: string): Document | undefined {
  if (!isArtifactType(type) || !ID_PATTERN.test(id)) return undefined
  return index.byRef.get(documentRef(type, id))
}

async function readDirSafe(dir: string, issues: IndexIssue[]): Promise<import('node:fs').Dirent[] | undefined> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    issues.push({
      code: 'read-error',
      message: `ディレクトリを読み込めません: ${dir} (${errorMessage(error)})`,
      path: dir,
    })
    return undefined
  }
}

async function parseDocumentFile(
  root: string,
  dir: string,
  name: string,
  expectedType: ArtifactType,
  relPath: string,
  issues: IndexIssue[],
): Promise<ParsedFile> {
  const match = FILENAME_PATTERN.exec(name)
  if (!match) {
    issues.push({
      code: 'invalid-filename',
      message: `ファイル名が NNNNN-kebab-case-slug.md(x) 形式ではありません: ${name}`,
      path: relPath,
    })
    return {}
  }
  const [, id, slug, ext] = match as unknown as [string, string, string, 'md' | 'mdx']

  let source: string
  try {
    source = await readFile(path.join(dir, name), 'utf-8')
  } catch (error) {
    issues.push({
      code: 'read-error',
      message: `ファイルを読み込めません: ${errorMessage(error)}`,
      path: relPath,
    })
    return {}
  }

  let raw: unknown
  let body: string
  try {
    const fm = splitFrontmatter(source)
    raw = parseYamlFrontmatter(fm.data)
    body = fm.body
  } catch (error) {
    issues.push({
      code: 'invalid-frontmatter',
      message: error instanceof FrontmatterError ? error.message : errorMessage(error),
      path: relPath,
    })
    return {}
  }

  const docIssues: DocIssue[] = []
  const meta = buildMeta(raw, {
    type: expectedType,
    id,
    slug,
    format: ext === 'mdx' ? 'mdx' : 'markdown',
    path: relPath,
    body,
    issues: docIssues,
  })
  if (!meta) {
    for (const issue of docIssues) issues.push({ ...issue, path: relPath })
    issues.push({
      code: 'invalid-frontmatter',
      message: '必須フィールド (type/title/description/status) が不正です',
      path: relPath,
    })
    return {}
  }

  const { declaredRelations, relationIssues } = parseRelations(raw)
  docIssues.push(...relationIssues)

  if (meta.format === 'mdx') {
    for (const message of analyzeMdxBody(body)) {
      docIssues.push({ code: 'mdx-unsupported', message })
    }
  }

  const document: Document = {
    ...meta,
    declaredRelations,
    relations: [],
    incomingRelations: [],
    issues: docIssues,
  }
  return { document }
}

interface MetaContext {
  type: ArtifactType
  id: string
  slug: string
  format: 'markdown' | 'mdx'
  path: string
  body: string
  issues: DocIssue[]
}

/** frontmatter を検証して DocumentMeta を構築する。必須項目が不正なら null。 */
function buildMeta(raw: unknown, ctx: MetaContext): Omit<Document, 'declaredRelations' | 'relations' | 'incomingRelations' | 'issues'> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    ctx.issues.push({ code: 'invalid-frontmatter', message: 'frontmatter はオブジェクトである必要があります' })
    return null
  }
  const fm = raw as Record<string, unknown>

  if (!isArtifactType(fm.type)) {
    ctx.issues.push({ code: 'invalid-type', message: `不正な type です: ${String(fm.type)}` })
    return null
  }
  if (fm.type !== ctx.type) {
    ctx.issues.push({
      code: 'type-mismatch',
      message: `frontmatter の type (${String(fm.type)}) がディレクトリ (${ctx.type}) と一致しません`,
    })
    return null
  }
  if (typeof fm.title !== 'string' || fm.title.trim() === '') {
    ctx.issues.push({ code: 'invalid-field', message: 'title は空でない文字列である必要があります' })
    return null
  }
  if (typeof fm.description !== 'string') {
    ctx.issues.push({ code: 'invalid-field', message: 'description は文字列である必要があります' })
    return null
  }
  if (typeof fm.status !== 'string' || !(DOC_STATUSES as readonly string[]).includes(fm.status)) {
    ctx.issues.push({ code: 'invalid-field', message: `status は ${DOC_STATUSES.join(' / ')} のいずれかである必要があります` })
    return null
  }

  const meta: Omit<Document, 'declaredRelations' | 'relations' | 'incomingRelations' | 'issues'> = {
    ref: documentRef(ctx.type, ctx.id),
    type: ctx.type,
    id: ctx.id,
    slug: ctx.slug,
    title: fm.title,
    description: fm.description,
    status: fm.status as DocStatus,
    tags: [],
    sources: [],
    format: ctx.format,
    path: ctx.path,
    body: ctx.body,
  }

  if (fm.tags !== undefined) {
    if (Array.isArray(fm.tags) && fm.tags.every((t) => typeof t === 'string')) {
      meta.tags = fm.tags as string[]
    } else {
      ctx.issues.push({ code: 'invalid-field', message: 'tags は文字列の配列である必要があります' })
    }
  }
  if (fm.sources !== undefined) {
    if (Array.isArray(fm.sources) && fm.sources.every((s) => typeof s === 'string')) {
      meta.sources = fm.sources as string[]
    } else {
      ctx.issues.push({ code: 'invalid-field', message: 'sources は文字列の配列である必要があります' })
    }
  }
  if (fm.subtype !== undefined) {
    if (typeof fm.subtype === 'string') meta.subtype = fm.subtype
    else ctx.issues.push({ code: 'invalid-field', message: 'subtype は文字列である必要があります' })
  }
  if (fm.perspective !== undefined) {
    if (typeof fm.perspective === 'string') meta.perspective = fm.perspective
    else ctx.issues.push({ code: 'invalid-field', message: 'perspective は文字列である必要があります' })
  }

  return meta
}

function parseRelations(
  raw: unknown,
): { declaredRelations: Partial<Record<ArtifactType, string[]>>; relationIssues: DocIssue[] } {
  const relationIssues: DocIssue[] = []
  const declared: Partial<Record<ArtifactType, string[]>> = {}
  const fm = raw as Record<string, unknown>
  const rel = fm.relations
  if (rel === undefined || rel === null) return { declaredRelations: declared, relationIssues }

  if (typeof rel !== 'object' || Array.isArray(rel)) {
    relationIssues.push({ code: 'invalid-relations', message: 'relations はオブジェクトである必要があります' })
    return { declaredRelations: declared, relationIssues }
  }

  for (const [key, value] of Object.entries(rel as Record<string, unknown>)) {
    if (!isArtifactType(key)) {
      relationIssues.push({ code: 'invalid-relation-type', message: `不正な relation type: ${key}` })
      continue
    }
    if (!Array.isArray(value)) {
      relationIssues.push({ code: 'invalid-relations', message: `relations.${key} は配列である必要があります` })
      continue
    }
    const ids: string[] = []
    const seen = new Set<string>()
    for (const entry of value) {
      if (typeof entry !== 'string' || !ID_PATTERN.test(entry)) {
        relationIssues.push({
          code: 'invalid-relation-id',
          message: `relations.${key} に不正な ID があります: ${String(entry)}`,
        })
        continue
      }
      if (seen.has(entry)) {
        relationIssues.push({ code: 'duplicate-relation', message: `relations.${key} に重複した ID があります: ${entry}` })
        continue
      }
      seen.add(entry)
      ids.push(entry)
    }
    if (ids.length > 0) declared[key] = ids
  }
  return { declaredRelations: declared, relationIssues }
}

function resolveRelations(documents: Document[], byRef: Map<string, Document>): void {
  const VERIFICATION_TARGET_TYPES: ArtifactType[] = ['requirement', 'design', 'architecture', 'contract']

  for (const doc of documents) {
    const resolved: RelationTarget[] = []
    const kept: Partial<Record<ArtifactType, string[]>> = {}

    for (const [type, ids] of Object.entries(doc.declaredRelations) as [ArtifactType, string[]][]) {
      for (const id of ids) {
        const ref = documentRef(type, id)
        if (ref === doc.ref) {
          doc.issues.push({ code: 'self-relation', message: `自己参照は許可されていません: ${ref}` })
          continue
        }
        const target = byRef.get(ref)
        if (!target) {
          doc.issues.push({ code: 'missing-relation', message: `参照先が存在しません: ${ref}` })
          continue
        }
        resolved.push(toRelationTarget(target))
        ;(kept[type] ??= []).push(id)
      }
    }
    doc.declaredRelations = kept
    doc.relations = resolved

    if (doc.type === 'design' && !(doc.declaredRelations.requirement?.length)) {
      doc.issues.push({ code: 'design-requires-requirement', message: 'Design は少なくとも1つの Requirement を参照する必要があります' })
    }
    if (
      doc.type === 'verification' &&
      !VERIFICATION_TARGET_TYPES.some((t) => (doc.declaredRelations[t]?.length ?? 0) > 0)
    ) {
      doc.issues.push({
        code: 'verification-requires-target',
        message: 'Verification は Requirement / Design / Architecture / Contract のいずれかを参照する必要があります',
      })
    }
  }

  for (const doc of documents) {
    for (const rel of doc.relations) {
      const target = byRef.get(rel.ref)
      if (target) target.incomingRelations.push(toRelationTarget(doc))
    }
  }
  for (const doc of documents) {
    doc.incomingRelations.sort((a, b) => a.ref.localeCompare(b.ref))
  }
}

function toRelationTarget(doc: Document): RelationTarget {
  return { ref: doc.ref, type: doc.type, id: doc.id, title: doc.title, status: doc.status, path: doc.path }
}

function sortDocuments(documents: Document[]): void {
  const order = new Map(ARTIFACT_TYPES.map((t, i) => [t, i]))
  documents.sort((a, b) => {
    const ta = order.get(a.type) ?? 99
    const tb = order.get(b.type) ?? 99
    if (ta !== tb) return ta - tb
    return a.id.localeCompare(b.id)
  })
}

async function loadGlossary(root: string, issues: IndexIssue[]): Promise<Glossary | null> {
  const file = path.join(root, 'glossary.md')
  let source: string
  try {
    source = await readFile(file, 'utf-8')
  } catch {
    return null
  }

  let title = 'Glossary'
  let description = ''
  let body = source
  try {
    const fm = splitFrontmatter(source)
    const raw = parseYamlFrontmatter(fm.data)
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>
      if (typeof obj.title === 'string' && obj.title !== '') title = obj.title
      if (typeof obj.description === 'string') description = obj.description
    }
    body = fm.body
  } catch (error) {
    issues.push({
      code: 'invalid-frontmatter',
      message: `glossary.md: ${error instanceof FrontmatterError ? error.message : errorMessage(error)}`,
      path: 'glossary.md',
    })
  }
  return { title, description, path: 'glossary.md', body }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
