import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import {
  detectSourceLanguage,
  extractExportedSymbolsFromSource,
  loadSourceFile,
  SourceError,
  TEXT_EXTS,
} from './source'
import type { ExportedSymbolEntry } from './source'
import type { ArtifactType, DocsIndex } from './types'

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.documi',
  '.next',
  '.turbo',
  'target',
  'build',
  'public',
])

const SPECIAL_TEXT_NAMES = new Set(['dockerfile', 'makefile', 'justfile', 'license', 'gemfile', 'procfile'])

export interface CodeSpecLink {
  specId: string
  kind: 'implements' | 'verifies' | 'source-ref'
  docId: string
  docTitle: string
  line?: number
  symbol?: string
  testName?: string
}

interface CodeDocRef {
  docId: string
  docTitle: string
  docType: ArtifactType
  symbol?: string
  lines?: string
}

interface CodeTermLink {
  termId: string
  docId: string
  docTitle: string
  symbol: string
}

export interface CodeFileSummary {
  path: string
  name: string
  ext: string
  language: string
  specCount: number
  docRefCount: number
  termCount: number
  covered: boolean
}

export interface CodeTreeDir {
  kind: 'dir'
  name: string
  path: string
  coveredCount: number
  totalCount: number
  children: CodeTreeNode[]
}

interface CodeTreeFile {
  kind: 'file'
  name: string
  file: CodeFileSummary
}

export type CodeTreeNode = CodeTreeDir | CodeTreeFile

export interface CodeTreeResult {
  totalFiles: number
  coveredFiles: number
  tree: CodeTreeNode[]
  files: CodeFileSummary[]
}

export interface CodeFileResult {
  path: string
  language: string
  totalLines: number
  code: string
  specLinks: CodeSpecLink[]
  docRefs: CodeDocRef[]
  termLinks: CodeTermLink[]
  exportedSymbols: ExportedSymbolEntry[]
}

interface FileReverseIndex {
  specs: Map<string, CodeSpecLink[]>
  docs: Map<string, CodeDocRef[]>
  terms: Map<string, CodeTermLink[]>
}

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

function buildFileReverseIndex(index: DocsIndex): FileReverseIndex {
  const specs = new Map<string, CodeSpecLink[]>()
  const docs = new Map<string, CodeDocRef[]>()
  const terms = new Map<string, CodeTermLink[]>()

  const specSeen = new Set<string>()
  const addSpec = (file: string, link: CodeSpecLink) => {
    const f = normalizeRelPath(file)
    const key = `${f}|${link.specId}|${link.kind}|${link.line ?? ''}|${link.symbol ?? ''}`
    if (specSeen.has(key)) return
    specSeen.add(key)
    const list = specs.get(f) ?? []
    list.push(link)
    specs.set(f, list)
  }

  // 1. Realization anchors (@implements / @verifies / test("[id]"))
  for (const block of index.blocksById.values()) {
    const ownerDoc = index.byId.get(block.docId)
    if (!ownerDoc || !block.realization) continue
    for (const impl of block.realization.implementations) {
      addSpec(impl.file, {
        specId: block.id,
        kind: impl.fromDoc ? 'source-ref' : 'implements',
        docId: ownerDoc.id,
        docTitle: ownerDoc.title,
        line: impl.fromDoc ? undefined : impl.line,
      })
    }
    for (const ver of block.realization.verifications) {
      addSpec(ver.file, {
        specId: block.id,
        kind: ver.fromDoc ? 'source-ref' : 'verifies',
        docId: ownerDoc.id,
        docTitle: ownerDoc.title,
        line: ver.fromDoc ? undefined : ver.line,
        testName: ver.testName,
      })
    }
  }

  // 2. Document <SourceRef />
  const docRefSeen = new Set<string>()
  for (const doc of index.documents) {
    for (const ref of doc.sourceRefs) {
      const f = normalizeRelPath(ref.file)
      const key = `${f}|${doc.id}|${ref.symbol ?? ''}|${ref.lines ?? ''}`
      if (!docRefSeen.has(key)) {
        docRefSeen.add(key)
        const list = docs.get(f) ?? []
        list.push({
          docId: doc.id,
          docTitle: doc.title,
          docType: doc.type,
          ...(ref.symbol ? { symbol: ref.symbol } : {}),
          ...(ref.lines ? { lines: ref.lines } : {}),
        })
        docs.set(f, list)
      }
      for (const specId of ref.satisfies) {
        const specBlock = index.blocksById.get(specId)
        const specDoc = specBlock ? index.byId.get(specBlock.docId) : undefined
        if (specDoc) {
          addSpec(f, {
            specId,
            kind: 'source-ref',
            docId: specDoc.id,
            docTitle: specDoc.title,
            symbol: ref.symbol,
          })
        }
      }
      for (const specId of ref.verifies) {
        const specBlock = index.blocksById.get(specId)
        const specDoc = specBlock ? index.byId.get(specBlock.docId) : undefined
        if (specDoc) {
          addSpec(f, {
            specId,
            kind: 'verifies',
            docId: specDoc.id,
            docTitle: specDoc.title,
            symbol: ref.symbol,
          })
        }
      }
    }
  }

  // 3. Living Glossary <TermDef symbols="src/...#Symbol" />
  const seenTermBlock = new Set<string>()
  for (const term of index.termsByName.values()) {
    if (seenTermBlock.has(term.id)) continue
    seenTermBlock.add(term.id)
    const ownerDoc = index.byId.get(term.docId)
    if (!ownerDoc) continue
    for (const rawSym of term.symbols ?? []) {
      const [rawFile, symbol] = rawSym.split('#')
      if (!rawFile || !symbol) continue
      const f = normalizeRelPath(rawFile)
      const list = terms.get(f) ?? []
      list.push({
        termId: term.id,
        docId: ownerDoc.id,
        docTitle: ownerDoc.title,
        symbol,
      })
      terms.set(f, list)
    }
  }

  return { specs, docs, terms }
}

function isReadableCodeFile(name: string): boolean {
  const lower = name.toLowerCase()
  if (SPECIAL_TEXT_NAMES.has(lower)) return true
  const ext = path.extname(lower).slice(1)
  return ext !== '' && TEXT_EXTS.has(ext)
}

async function collectProjectCodeFiles(root: string, relDir: string, docsRel: string): Promise<string[]> {
  const absDir = relDir ? path.join(root, relDir) : root
  let entries: Dirent[]
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch {
    return []
  }

  const out: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (docsRel && (rel === docsRel || rel.startsWith(`${docsRel}/`))) continue
    if (entry.isDirectory()) {
      const nested = await collectProjectCodeFiles(root, rel, docsRel)
      out.push(...nested)
    } else if (entry.isFile() && isReadableCodeFile(entry.name)) {
      out.push(rel)
    }
  }
  return out
}

function finalizeDirCounts(node: CodeTreeDir): { covered: number; total: number } {
  let covered = 0
  let total = 0
  node.children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const child of node.children) {
    if (child.kind === 'dir') {
      const sub = finalizeDirCounts(child)
      covered += sub.covered
      total += sub.total
    } else {
      total += 1
      if (child.file.covered) covered += 1
    }
  }
  node.coveredCount = covered
  node.totalCount = total
  return { covered, total }
}

/**
 * projectRoot 配下のソースファイルツリーと仕様紐づけサマリを構築する。
 * @implements ui.code-explorer
 */
export async function buildCodeTree(projectRoot: string, index: DocsIndex): Promise<CodeTreeResult> {
  const root = path.resolve(projectRoot)
  const docsRel = normalizeRelPath(path.relative(root, index.rootDir))
  const safeDocsRel = docsRel.startsWith('..') ? '' : docsRel

  const relFiles = (await collectProjectCodeFiles(root, '', safeDocsRel)).toSorted((a, b) => a.localeCompare(b))
  const rev = buildFileReverseIndex(index)

  const files: CodeFileSummary[] = []
  const rootDir: CodeTreeDir = { kind: 'dir', name: '', path: '', coveredCount: 0, totalCount: 0, children: [] }

  const findOrCreateDir = (parent: CodeTreeDir, name: string, fullPath: string): CodeTreeDir => {
    const existing = parent.children.find((c): c is CodeTreeDir => c.kind === 'dir' && c.name === name)
    if (existing) return existing
    const created: CodeTreeDir = { kind: 'dir', name, path: fullPath, coveredCount: 0, totalCount: 0, children: [] }
    parent.children.push(created)
    return created
  }

  for (const relPath of relFiles) {
    const name = path.posix.basename(relPath)
    const ext = path.extname(name).slice(1).toLowerCase()
    const specLinks = rev.specs.get(relPath) ?? []
    const docRefs = rev.docs.get(relPath) ?? []
    const termLinks = rev.terms.get(relPath) ?? []
    const uniqueSpecIds = new Set(specLinks.map((s) => s.specId))
    const covered = uniqueSpecIds.size > 0 || docRefs.length > 0 || termLinks.length > 0

    const summary: CodeFileSummary = {
      path: relPath,
      name,
      ext,
      language: detectSourceLanguage(ext),
      specCount: uniqueSpecIds.size,
      docRefCount: docRefs.length,
      termCount: termLinks.length,
      covered,
    }
    files.push(summary)

    const segments = relPath.split('/')
    let current = rootDir
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!
      current = findOrCreateDir(current, seg, segments.slice(0, i + 1).join('/'))
    }
    current.children.push({ kind: 'file', name, file: summary })
  }

  const { covered, total } = finalizeDirCounts(rootDir)
  return {
    totalFiles: total,
    coveredFiles: covered,
    tree: rootDir.children,
    files,
  }
}

/**
 * 指定 POSIX 相対パスのソースファイル全文と、紐づく Spec・ドキュメント・用語の逆リンクを返す。
 * 境界違反 (`projectRoot` 外) は 403、未存在は 404、バイナリ・サイズ超過・非対応拡張子は 400 を送出する。
 * @implements ui.code-explorer
 */
export async function readCodeFile(projectRoot: string, index: DocsIndex, filePath: string): Promise<CodeFileResult> {
  if (typeof filePath !== 'string' || filePath.trim() === '' || filePath.includes('\0')) {
    throw new SourceError('path パラメータが不正です', 400)
  }
  if (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes('..')) {
    throw new SourceError('パスがプロジェクトルート外を指しています', 403)
  }

  let loaded
  try {
    loaded = await loadSourceFile(projectRoot, filePath)
  } catch (e) {
    if (e instanceof SourceError) {
      if (e.status === 413) throw new SourceError(e.message, 400)
      if (e.message.includes('ルート外')) throw new SourceError(e.message, 403)
      throw e
    }
    throw e
  }

  const baseName = path.posix.basename(loaded.relPath).toLowerCase()
  if (!SPECIAL_TEXT_NAMES.has(baseName) && (!loaded.ext || !TEXT_EXTS.has(loaded.ext))) {
    throw new SourceError(`対応していない拡張子です: .${loaded.ext || '(none)'}`, 400)
  }

  const rev = buildFileReverseIndex(index)
  const specLinks = [...(rev.specs.get(loaded.relPath) ?? [])].toSorted((a, b) => {
    if ((a.line ?? Infinity) !== (b.line ?? Infinity)) return (a.line ?? Infinity) - (b.line ?? Infinity)
    return a.specId.localeCompare(b.specId)
  })
  const docRefs = [...(rev.docs.get(loaded.relPath) ?? [])].toSorted((a, b) => a.docId.localeCompare(b.docId))
  const termLinks = [...(rev.terms.get(loaded.relPath) ?? [])].toSorted((a, b) => a.termId.localeCompare(b.termId))

  const totalLines =
    loaded.source === ''
      ? 0
      : loaded.source.endsWith('\n')
        ? loaded.source.split('\n').length - 1
        : loaded.source.split('\n').length

  const { symbols: exportedSymbols } = extractExportedSymbolsFromSource(loaded.relPath, loaded.ext, loaded.source)

  return {
    path: loaded.relPath,
    language: detectSourceLanguage(loaded.ext),
    totalLines,
    code: loaded.source,
    specLinks,
    docRefs,
    termLinks,
    exportedSymbols,
  }
}
