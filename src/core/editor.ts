import type { Dirent } from 'node:fs'
import { access, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Result } from 'better-result'
import type { MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx'
import { stringify } from 'yaml'
import {
  DocPathOutsideRootError,
  EditConflictError,
  EditTargetNotFoundError,
  InvalidDocPathError,
  InvalidEditInputError,
  ProtectedPathWriteError,
  UnsafeMdxError,
  type EditDomainError,
  type UnclosedFrontmatterError,
} from './errors'
import { splitFrontmatter } from './frontmatter'
import { parseMarkdownAst } from './mdast-parser'
import { extractMdxArtifacts } from './mdx'
import { BLOCK_ID_PATTERN, isArtifactType, isDocScope, isNoteIntent, isSpecIntent, isStability } from './types'
import type {
  ArtifactType,
  BlockKind,
  DocFormat,
  DocScope,
  DocsIndex,
  NoteIntent,
  SpecIntent,
  Stability,
  TestLevel,
} from './types'

const BLOCK_TAG_NAME: Record<BlockKind, string> = {
  spec: 'Spec',
  constraint: 'Constraint',
  decision: 'Decision',
  test: 'Test',
  note: 'Note',
  term: 'TermDef',
  signal: 'Signal',
}

const IGNORED_CODE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.documi',
  '.next',
  '.turbo',
  'target',
  'build',
])

const CODE_EXTS = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'go',
  'rs',
  'py',
  'java',
  'kt',
  'kts',
  'swift',
  'rb',
  'php',
  'c',
  'h',
  'cpp',
  'cc',
  'hpp',
  'cs',
  'ex',
  'exs',
])

const MAX_RENAME_FILE_BYTES = 512 * 1024

interface GenericMdxNode {
  type: string
  name?: string | null
  depth?: number
  value?: string
  attributes?: Array<{ type: string; name?: string; value?: unknown }>
  children?: GenericMdxNode[]
  position?: {
    start?: { line?: number; offset?: number }
    end?: { line?: number; offset?: number }
  }
}

export interface UpdateBlockInput {
  id: string
  body: string
  title?: string
  summary?: string
  date?: string
  level?: TestLevel
  verifies?: string[]
  stability?: Stability
  intent?: SpecIntent | NoteIntent
  derives?: string[]
  supersedes?: string[]
  scope?: string
  aliases?: string[]
  antiTerms?: string[]
  context?: string
  symbols?: string[]
}

export interface AddBlockInput {
  docId: string
  kind: BlockKind
  id: string
  body: string
  afterHeading?: string
  title?: string
  summary?: string
  date?: string
  level?: TestLevel
  verifies?: string[]
  stability?: Stability
  intent?: SpecIntent | NoteIntent
  derives?: string[]
  supersedes?: string[]
  scope?: string
  aliases?: string[]
  antiTerms?: string[]
  context?: string
  symbols?: string[]
}

export interface UpsertTermInput {
  id: string
  definition: string
  aliases?: string[]
  antiTerms?: string[]
  context?: string
  symbols?: string[]
  docId?: string
}

export interface ScaffoldDocumentInput {
  path: string
  title: string
  /** 出力先マウント ID（省略時はプライマリマウントへ作成） */
  mount?: string
  type?: ArtifactType
  scope?: DocScope
  description?: string
  date?: string
  tags?: string[]
  derives?: string[]
  satisfies?: string[]
  verifies?: string[]
  body?: string
}

export interface RenameBlockInput {
  oldId: string
  newId: string
  dryRun?: boolean
}

export interface BlockEditResult {
  id: string
  docId: string
  path: string
  startLine: number
  endLine: number
}

export interface UpsertTermResult extends BlockEditResult {
  action: 'created' | 'updated'
}

export interface ScaffoldDocumentResult {
  docId: string
  path: string
}

interface RenameChangeEntry {
  path: string
  occurrences: number
}

export interface RenameBlockResult {
  dryRun: boolean
  oldId: string
  newId: string
  changes: RenameChangeEntry[]
}

/**
 * docsDir 内の安全な .mdx / .md パスであることを検証する。
 * パストラバーサル、ルート外シンボリックリンク、および `guard/`・`.documi/`・`reviews.json` への書き込みを絶対拒否する。
 */
async function resolveSafeDocFile(
  docsDir: string,
  relPath: string,
): Promise<
  Result<{ absPath: string; relPath: string }, InvalidDocPathError | ProtectedPathWriteError | DocPathOutsideRootError>
> {
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!cleaned || cleaned.includes('\0') || path.isAbsolute(relPath)) {
    return Result.err(new InvalidDocPathError({ path: relPath, message: `Invalid document path: ${relPath}` }))
  }
  const segments = cleaned.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return Result.err(
      new DocPathOutsideRootError({
        path: relPath,
        reason: 'traversal',
        message: `Relative path traversal (..) is not allowed: ${relPath}`,
      }),
    )
  }
  if (
    segments.some((s) => s.toLowerCase() === '.documi' || s.toLowerCase() === 'guard') ||
    cleaned.toLowerCase().endsWith('reviews.json')
  ) {
    return Result.err(
      new ProtectedPathWriteError({
        path: relPath,
        message: 'Writing to docs/guard/, .documi/, or reviews.json is forbidden',
      }),
    )
  }
  if (!/\.(mdx|md)$/i.test(cleaned)) {
    return Result.err(
      new InvalidDocPathError({
        path: relPath,
        message: `Document path must end with .mdx or .md: ${relPath}`,
      }),
    )
  }

  const rootReal = await realpath(docsDir)
  const abs = path.resolve(rootReal, cleaned)
  if (abs !== rootReal && !abs.startsWith(rootReal + path.sep)) {
    return Result.err(
      new DocPathOutsideRootError({
        path: relPath,
        reason: 'traversal',
        message: 'Document path resolves outside docs directory',
      }),
    )
  }

  // 既存ファイルまたは最寄り既存親ディレクトリがシンボリックリンク脱出していないか確認
  let probe = abs
  while (true) {
    try {
      const realProbe = await realpath(probe)
      if (realProbe !== rootReal && !realProbe.startsWith(rootReal + path.sep)) {
        return Result.err(
          new DocPathOutsideRootError({
            path: relPath,
            reason: 'symlink',
            message: 'Symlink resolves outside docs directory',
          }),
        )
      }
      break
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }

  return Result.ok({ absPath: abs, relPath: cleaned })
}

/** 候補ソースに対して MDX 安全性（式・ESM・未許可コンポーネント・パースエラー）を事前検証する */
function validateSafeDocumentSource(
  source: string,
  format: DocFormat,
  docId: string,
): Result<void, UnsafeMdxError | UnclosedFrontmatterError> {
  const fmRes = splitFrontmatter(source)
  if (fmRes.isErr()) return fmRes
  const fm = fmRes.value
  const extracted = extractMdxArtifacts(fm.body, format, docId, fm.bodyStartLine - 1)
  const fatal = extracted.issues.filter(
    (issue) =>
      issue.code === 'mdx-parse-error' || issue.code === 'mdx-unsupported' || issue.code === 'invalid-block-id',
  )
  if (fatal.length > 0) {
    return Result.err(
      new UnsafeMdxError({
        docId,
        message: `MDX safety validation failed: ${fatal.map((f) => f.message).join('; ')}`,
      }),
    )
  }
  return Result.ok(undefined)
}

function escapeAttrValue(value: string): Result<string, InvalidEditInputError> {
  if (value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return Result.err(
      new InvalidEditInputError({ message: `Attribute value cannot contain newlines or double quotes: ${value}` }),
    )
  }
  return Result.ok(value)
}

function formatBlockMdx(
  kind: BlockKind,
  attrs: Array<[string, string | undefined]>,
  body: string,
): Result<string, InvalidEditInputError> {
  const tag = BLOCK_TAG_NAME[kind]
  const attrParts: string[] = []
  for (const [key, val] of attrs) {
    if (val === undefined || val === '') continue
    const escaped = escapeAttrValue(val)
    if (escaped.isErr()) return escaped
    attrParts.push(`${key}="${escaped.value}"`)
  }
  const openTag = attrParts.length > 0 ? `<${tag} ${attrParts.join(' ')}>` : `<${tag}>`
  const trimmedBody = body.replace(/\r\n/g, '\n').trim()
  if (!trimmedBody) {
    return Result.err(new InvalidEditInputError({ message: 'Block body cannot be empty' }))
  }
  const indented = trimmedBody
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : `  ${line}`))
    .join('\n')
  return Result.ok(`${openTag}\n${indented}\n</${tag}>`)
}

function findBlockJsxNode(
  body: string,
  format: DocFormat,
  kind: BlockKind,
  blockId: string,
): { startOffset: number; endOffset: number; existingAttrs: Record<string, string> } | undefined {
  const { tree } = parseMarkdownAst(body, format)
  const expectedTag = BLOCK_TAG_NAME[kind]
  let found: { startOffset: number; endOffset: number; existingAttrs: Record<string, string> } | undefined

  const walk = (node: GenericMdxNode): void => {
    if (found) return
    if ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && node.name === expectedTag) {
      const jsx = node as unknown as MdxJsxFlowElement | MdxJsxTextElement
      const attrs: Record<string, string> = {}
      for (const attr of jsx.attributes) {
        if (attr.type === 'mdxJsxExpressionAttribute') continue
        const a = attr
        if (typeof a.value === 'string') attrs[a.name] = a.value
      }
      if (attrs.id?.trim() === blockId) {
        const startOffset = node.position?.start?.offset
        const endOffset = node.position?.end?.offset
        if (typeof startOffset === 'number' && typeof endOffset === 'number') {
          found = { startOffset, endOffset, existingAttrs: attrs }
          return
        }
      }
    }
    for (const child of node.children ?? []) walk(child)
  }

  walk(tree)
  return found
}

function validateBlockAttributes(
  kind: BlockKind,
  input: { stability?: string; intent?: string },
): Result<void, InvalidEditInputError> {
  if (input.stability !== undefined && !isStability(input.stability)) {
    return Result.err(new InvalidEditInputError({ message: `Invalid stability: ${input.stability}` }))
  }
  if (input.intent !== undefined) {
    if (kind === 'note' ? !isNoteIntent(input.intent) : !isSpecIntent(input.intent)) {
      return Result.err(new InvalidEditInputError({ message: `Invalid intent: ${input.intent}` }))
    }
  }
  return Result.ok(undefined)
}

function computeLineRangeFromOffsets(
  normalized: string,
  startOffset: number,
  endOffset: number,
): {
  startLine: number
  endLine: number
} {
  const startLine = normalized.slice(0, startOffset).split('\n').length
  const endLine = normalized.slice(0, Math.max(startOffset, endOffset - 1)).split('\n').length
  return { startLine, endLine }
}

/**
 * 指定 ID のセマンティックブロックのみを AST オフセットでピンポイント更新する。
 * @implements core.mcp-surgical-edit
 */
export async function updateBlockInDocs(
  docsDir: string,
  index: DocsIndex,
  input: UpdateBlockInput,
): Promise<Result<BlockEditResult, EditDomainError>> {
  return Result.gen(async function* () {
    const block = index.blocksById.get(input.id)
    if (!block) {
      return Result.err(new EditTargetNotFoundError({ target: input.id, message: `Block not found: ${input.id}` }))
    }
    const doc = index.byId.get(block.docId)
    if (!doc) {
      return Result.err(
        new EditTargetNotFoundError({ target: block.docId, message: `Owner document not found: ${block.docId}` }),
      )
    }

    yield* validateBlockAttributes(block.kind, input)

    const docMountDir = index.mounts.find((m) => m.id === doc.mountId)?.dir ?? docsDir
    const { absPath } = yield* Result.await(resolveSafeDocFile(docMountDir, doc.mountRelPath || doc.path))
    const relPath = doc.path
    const raw = await readFile(absPath, 'utf-8')
    const normalized = raw.replace(/\r\n/g, '\n')
    const fm = yield* splitFrontmatter(normalized)

    const located = findBlockJsxNode(fm.body, doc.format, block.kind, block.id)
    if (!located) {
      return Result.err(
        new EditTargetNotFoundError({
          target: block.id,
          message: `Could not locate <${BLOCK_TAG_NAME[block.kind]} id="${block.id}"> in document`,
        }),
      )
    }

    const prev = located.existingAttrs
    const mergedAttrs: Array<[string, string | undefined]> = [
      ['id', block.id],
      ['title', input.title !== undefined ? input.title : prev.title],
      ['summary', input.summary !== undefined ? input.summary : prev.summary],
      ['date', input.date !== undefined ? input.date : prev.date],
      ['level', input.level !== undefined ? input.level : prev.level],
      ['intent', input.intent !== undefined ? input.intent : prev.intent],
      ['stability', input.stability !== undefined ? input.stability : prev.stability],
      ['scope', input.scope !== undefined ? input.scope : prev.scope],
      ['derives', input.derives !== undefined ? input.derives.join(', ') : prev.derives],
      ['verifies', input.verifies !== undefined ? input.verifies.join(', ') : prev.verifies],
      ['supersedes', input.supersedes !== undefined ? input.supersedes.join(', ') : prev.supersedes],
      ['aliases', input.aliases !== undefined ? input.aliases.join(', ') : prev.aliases],
      ['antiTerms', input.antiTerms !== undefined ? input.antiTerms.join(', ') : prev.antiTerms],
      ['context', input.context !== undefined ? input.context : prev.context],
      ['symbols', input.symbols !== undefined ? input.symbols.join(', ') : prev.symbols],
    ]

    const replacement = yield* formatBlockMdx(block.kind, mergedAttrs, input.body)
    const absStart = fm.bodyOffset + located.startOffset
    const absEnd = fm.bodyOffset + located.endOffset
    const nextSource = `${normalized.slice(0, absStart)}${replacement}${normalized.slice(absEnd)}`

    yield* validateSafeDocumentSource(nextSource, doc.format, doc.id)
    await writeFile(absPath, nextSource, 'utf-8')

    const { startLine, endLine } = computeLineRangeFromOffsets(nextSource, absStart, absStart + replacement.length)
    return Result.ok({ id: block.id, docId: doc.id, path: relPath, startLine, endLine })
  })
}

/**
 * 指定ドキュメント末尾（または指定見出し直下）にセマンティックブロックを 1 件追記する。
 * @implements core.mcp-surgical-edit
 */
export async function addBlockToDoc(
  docsDir: string,
  index: DocsIndex,
  input: AddBlockInput,
): Promise<Result<BlockEditResult, EditDomainError>> {
  return Result.gen(async function* () {
    if (!BLOCK_ID_PATTERN.test(input.id)) {
      return Result.err(
        new InvalidEditInputError({
          message: `Invalid block ID: "${input.id}" (must start with a letter and contain only letters, digits, ".", "_", "-")`,
        }),
      )
    }
    if (index.blocksById.has(input.id)) {
      return Result.err(new EditConflictError({ target: input.id, message: `Block ID "${input.id}" already exists` }))
    }

    const doc = index.byId.get(input.docId.replace(/^\/+|\/+$/g, '').replace(/\.(mdx|md)$/i, ''))
    if (!doc) {
      return Result.err(
        new EditTargetNotFoundError({ target: input.docId, message: `Document not found: ${input.docId}` }),
      )
    }

    yield* validateBlockAttributes(input.kind, input)

    const docMountDir = index.mounts.find((m) => m.id === doc.mountId)?.dir ?? docsDir
    const { absPath } = yield* Result.await(resolveSafeDocFile(docMountDir, doc.mountRelPath || doc.path))
    const relPath = doc.path
    const raw = await readFile(absPath, 'utf-8')
    const normalized = raw.replace(/\r\n/g, '\n')

    const blockText = yield* formatBlockMdx(
      input.kind,
      [
        ['id', input.id],
        ['title', input.title],
        ['summary', input.summary],
        ['date', input.date],
        ['level', input.level],
        ['intent', input.intent],
        ['stability', input.stability],
        ['scope', input.scope],
        ['derives', input.derives?.join(', ')],
        ['verifies', input.verifies?.join(', ')],
        ['supersedes', input.supersedes?.join(', ')],
        ['aliases', input.aliases?.join(', ')],
        ['antiTerms', input.antiTerms?.join(', ')],
        ['context', input.context],
        ['symbols', input.symbols?.join(', ')],
      ],
      input.body,
    )

    let nextSource: string
    let insertOffset: number

    if (input.afterHeading?.trim()) {
      const targetHeading = input.afterHeading.trim().toLowerCase()
      const fm = yield* splitFrontmatter(normalized)
      const lines = fm.body.split('\n')
      let matchLineIdx = -1
      for (let i = 0; i < lines.length; i++) {
        const m = /^#{1,6}\s+(.+?)\s*$/.exec(lines[i]!)
        if (m && m[1]!.trim().toLowerCase() === targetHeading) {
          matchLineIdx = i
          break
        }
      }
      if (matchLineIdx < 0) {
        return Result.err(
          new EditTargetNotFoundError({
            target: input.afterHeading,
            message: `Heading not found: "${input.afterHeading}"`,
          }),
        )
      }
      const beforeLines = lines.slice(0, matchLineIdx + 1).join('\n')
      const afterLines = lines.slice(matchLineIdx + 1).join('\n')
      const prefix = `${normalized.slice(0, fm.bodyOffset)}${beforeLines}\n\n`
      insertOffset = prefix.length
      const suffix = afterLines.startsWith('\n') ? `\n${afterLines}` : afterLines ? `\n\n${afterLines}` : '\n'
      nextSource = `${prefix}${blockText}${suffix}`
    } else {
      const trimmed = normalized.replace(/\n+$/, '')
      const prefix = `${trimmed}\n\n`
      insertOffset = prefix.length
      nextSource = `${prefix}${blockText}\n`
    }

    yield* validateSafeDocumentSource(nextSource, doc.format, doc.id)
    await writeFile(absPath, nextSource, 'utf-8')

    const { startLine, endLine } = computeLineRangeFromOffsets(
      nextSource,
      insertOffset,
      insertOffset + blockText.length,
    )
    return Result.ok({ id: input.id, docId: doc.id, path: relPath, startLine, endLine })
  })
}

/**
 * 用語集（既定: domain/glossary）に `<TermDef>` を追加または更新する。
 * @implements core.mcp-surgical-edit
 */
export async function upsertTermInDocs(
  docsDir: string,
  index: DocsIndex,
  input: UpsertTermInput,
): Promise<Result<UpsertTermResult, EditDomainError>> {
  return Result.gen(async function* () {
    if (!BLOCK_ID_PATTERN.test(input.id)) {
      return Result.err(new InvalidEditInputError({ message: `Invalid term ID: "${input.id}"` }))
    }
    const existing = index.blocksById.get(input.id)
    if (existing) {
      if (existing.kind !== 'term') {
        return Result.err(
          new EditConflictError({
            target: input.id,
            message: `ID "${input.id}" is already used by a ${existing.kind} block`,
          }),
        )
      }
      const updated = yield* Result.await(
        updateBlockInDocs(docsDir, index, {
          id: input.id,
          body: input.definition,
          aliases: input.aliases,
          antiTerms: input.antiTerms,
          context: input.context,
          symbols: input.symbols,
        }),
      )
      return Result.ok({ action: 'updated' as const, ...updated })
    }

    const preferredDocId = input.docId ?? 'domain/glossary'
    const targetDoc = index.byId.get(preferredDocId) ?? index.documents.find((d) => d.type === 'domain')
    if (!targetDoc) {
      return Result.err(
        new EditTargetNotFoundError({
          target: preferredDocId,
          message: `Glossary document not found (${preferredDocId})`,
        }),
      )
    }

    const created = yield* Result.await(
      addBlockToDoc(docsDir, index, {
        docId: targetDoc.id,
        kind: 'term',
        id: input.id,
        body: input.definition,
        aliases: input.aliases,
        antiTerms: input.antiTerms,
        context: input.context,
        symbols: input.symbols,
      }),
    )
    return Result.ok({ action: 'created' as const, ...created })
  })
}

/**
 * 規約通りの YAML frontmatter を持つ新規 `.mdx` ドキュメントを作成する（既存ファイルの上書きは拒否）。
 * @implements core.mcp-surgical-edit
 */
export async function scaffoldDocument(
  docsDir: string,
  index: DocsIndex,
  input: ScaffoldDocumentInput,
): Promise<Result<ScaffoldDocumentResult, EditDomainError>> {
  return Result.gen(async function* () {
    const mountId = input.mount?.trim() || undefined
    let targetMount = index.mounts.find((m) => !m.prefixed) ?? index.mounts[0]
    if (mountId) {
      const matched = index.mounts.find((m) => m.id === mountId)
      if (!matched) {
        const available = index.mounts.map((m) => m.id).join(', ')
        return Result.err(
          new InvalidEditInputError({
            message: `Unknown docs mount "${mountId}" (available mounts: ${available})`,
          }),
        )
      }
      targetMount = matched
    }
    const targetDocsDir = targetMount?.dir ?? docsDir

    const normalizedPath = /\.(mdx|md)$/i.test(input.path.trim()) ? input.path.trim() : `${input.path.trim()}.mdx`
    const { absPath, relPath } = yield* Result.await(resolveSafeDocFile(targetDocsDir, normalizedPath))

    const exists = await access(absPath)
      .then(() => true)
      .catch(() => false)
    if (exists) {
      return Result.err(
        new EditConflictError({
          target: relPath,
          message: `File already exists (overwriting is forbidden): ${relPath}`,
        }),
      )
    }

    if (input.type !== undefined && !isArtifactType(input.type)) {
      return Result.err(new InvalidEditInputError({ message: `Invalid Artifact Type: ${String(input.type)}` }))
    }
    if (input.scope !== undefined && !isDocScope(input.scope)) {
      return Result.err(
        new InvalidEditInputError({ message: `Invalid scope: ${String(input.scope)} (expected: system)` }),
      )
    }
    if (input.date !== undefined && !/^\d{4}-\d{2}(?:-\d{2})?$/.test(input.date.trim())) {
      return Result.err(
        new InvalidEditInputError({
          message: `date must be in YYYY-MM-DD or YYYY-MM format: ${input.date}`,
        }),
      )
    }

    const fmObj: Record<string, unknown> = {}
    if (input.type) fmObj.type = input.type
    if (input.scope) fmObj.scope = input.scope
    fmObj.title = input.title.trim()
    if (input.description?.trim()) fmObj.description = input.description.trim()
    if (input.date?.trim()) fmObj.date = input.date.trim()
    if (input.tags && input.tags.length > 0) fmObj.tags = input.tags
    if (input.derives && input.derives.length > 0) fmObj.derives = input.derives
    if (input.satisfies && input.satisfies.length > 0) fmObj.satisfies = input.satisfies
    if (input.verifies && input.verifies.length > 0) fmObj.verifies = input.verifies

    const bodySection = input.body?.trim() ? `\n${input.body.replace(/\r\n/g, '\n').trim()}\n` : '\n'
    const source = `---\n${stringify(fmObj).trim()}\n---\n\n# ${input.title.trim()}\n${bodySection}`
    const logicalRelPath = targetMount?.prefixed ? `${targetMount.id}/${relPath}` : relPath
    const docId = logicalRelPath.replace(/\.(mdx|md)$/i, '')
    const format: DocFormat = relPath.toLowerCase().endsWith('.mdx') ? 'mdx' : 'markdown'

    yield* validateSafeDocumentSource(source, format, docId)
    await mkdir(path.dirname(absPath), { recursive: true })
    await writeFile(absPath, source, 'utf-8')

    return Result.ok({ docId, path: logicalRelPath })
  })
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** ブロック ID トークン境界（英数字 / . / _ / - の途中で誤爆させない） */
function buildIdTokenRegex(id: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(id)}(?![A-Za-z0-9._-])`, 'g')
}

function replaceInCsvAttr(
  tagText: string,
  attrNames: readonly string[],
  oldId: string,
  newId: string,
): {
  text: string
  count: number
} {
  let count = 0
  const idRe = buildIdTokenRegex(oldId)
  const attrPattern = new RegExp(`(\\b(?:${attrNames.join('|')})\\s*=\\s*")([^"]*)(")`, 'g')
  const text = tagText.replace(attrPattern, (_full, pre: string, val: string, post: string) => {
    const replaced = val.replace(idRe, () => {
      count++
      return newId
    })
    return `${pre}${replaced}${post}`
  })
  return { text, count }
}

function rewriteDocForRename(
  source: string,
  oldId: string,
  newId: string,
  isTerm: boolean,
): Result<{ next: string; count: number }, UnclosedFrontmatterError> {
  return Result.gen(function* () {
    let count = 0
    const normalized = source.replace(/\r\n/g, '\n')
    const fm = yield* splitFrontmatter(normalized)

    let nextFmPrefix = normalized.slice(0, fm.bodyOffset)
    if (fm.hasFrontmatter) {
      const idRe = buildIdTokenRegex(oldId)
      nextFmPrefix = nextFmPrefix.replace(
        /^(\s*(?:-\s*|(?:derives|satisfies|verifies|supersedes):\s*(?:\[[^\]]*\]|.*)))$/gm,
        (line) =>
          line.replace(idRe, () => {
            count++
            return newId
          }),
      )
    }

    let nextBody = fm.body
    // 1. MDX 属性 (id / derives / supersedes / satisfies / verifies / name)
    const attrNames = isTerm
      ? ['id', 'derives', 'supersedes', 'satisfies', 'verifies', 'name']
      : ['id', 'derives', 'supersedes', 'satisfies', 'verifies']
    const attrResult = replaceInCsvAttr(nextBody, attrNames, oldId, newId)
    nextBody = attrResult.text
    count += attrResult.count

    // 2. #block-<oldId> アンカー
    const anchorRe = new RegExp(`#block-${escapeRegExp(oldId)}(?![A-Za-z0-9._-])`, 'g')
    nextBody = nextBody.replace(anchorRe, () => {
      count++
      return `#block-${newId}`
    })

    return Result.ok({ next: `${nextFmPrefix}${nextBody}`, count })
  })
}

function rewriteCodeForRename(source: string, oldId: string, newId: string): { next: string; count: number } {
  let count = 0
  const escaped = escapeRegExp(oldId)
  // @implements <oldId> / @verifies <oldId>
  const anchorRe = new RegExp(`(@(?:implements|verifies)\\s+)${escaped}(?![A-Za-z0-9._-])`, 'g')
  let next = source.replace(anchorRe, (_m, prefix: string) => {
    count++
    return `${prefix}${newId}`
  })
  // test("[<oldId>] ...")
  const bracketRe = new RegExp(`\\[${escaped}\\]`, 'g')
  next = next.replace(bracketRe, () => {
    count++
    return `[${newId}]`
  })
  return { next, count }
}

async function collectCodeFilesForRename(root: string, relDir: string, docsRel: string): Promise<string[]> {
  const absDir = relDir ? path.join(root, relDir) : root
  let entries: Dirent[]
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_CODE_DIRS.has(entry.name)) continue
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (docsRel && (rel === docsRel || rel.startsWith(`${docsRel}/`))) continue
    if (entry.isDirectory()) {
      out.push(...(await collectCodeFilesForRename(root, rel, docsRel)))
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toLowerCase()
      if (CODE_EXTS.has(ext)) out.push(rel)
    }
  }
  return out
}

/**
 * 全 docs/ および projectRoot 配下のコード・テストからブロック ID を一括リネームする。
 * `docs/guard/reviews.json` は一切変更しない。
 * @implements core.mcp-surgical-edit
 */
export async function renameBlockIdAcrossProject(
  docsDir: string,
  projectRoot: string | undefined,
  index: DocsIndex,
  input: RenameBlockInput,
): Promise<Result<RenameBlockResult, EditDomainError>> {
  return Result.gen(async function* () {
    const block = index.blocksById.get(input.oldId)
    if (!block) {
      return Result.err(
        new EditTargetNotFoundError({
          target: input.oldId,
          message: `Source block to rename not found: ${input.oldId}`,
        }),
      )
    }
    if (!BLOCK_ID_PATTERN.test(input.newId)) {
      return Result.err(new InvalidEditInputError({ message: `Invalid new block ID: "${input.newId}"` }))
    }
    if (input.oldId === input.newId) {
      return Result.err(new InvalidEditInputError({ message: 'oldId and newId must be different' }))
    }
    if (index.blocksById.has(input.newId)) {
      return Result.err(
        new EditConflictError({
          target: input.newId,
          message: `New block ID "${input.newId}" already exists`,
        }),
      )
    }

    const dryRun = input.dryRun === true
    const isTerm = block.kind === 'term'
    const pendingWrites: Array<{ absPath: string; displayPath: string; content: string; occurrences: number }> = []

    // 1. docs/ 配下の全ドキュメントを検査
    for (const doc of index.documents) {
      const docMountDir = index.mounts.find((m) => m.id === doc.mountId)?.dir ?? docsDir
      const { absPath } = yield* Result.await(resolveSafeDocFile(docMountDir, doc.mountRelPath || doc.path))
      const relPath = doc.path
      const raw = await readFile(absPath, 'utf-8')
      const { next, count } = yield* rewriteDocForRename(raw, input.oldId, input.newId, isTerm)
      if (count > 0) {
        yield* validateSafeDocumentSource(next, doc.format, doc.id)
        pendingWrites.push({ absPath, displayPath: `docs/${relPath}`, content: next, occurrences: count })
      }
    }

    // 2. projectRoot 配下のソース・テストを検査
    if (projectRoot) {
      const root = path.resolve(projectRoot)
      const docsRel = path.relative(root, path.resolve(docsDir)).split(path.sep).join('/')
      const codeFiles = await collectCodeFilesForRename(root, '', docsRel.startsWith('..') ? '' : docsRel)
      for (const relFile of codeFiles) {
        const abs = path.join(root, relFile)
        let text: string
        try {
          const st = await stat(abs)
          if (st.size > MAX_RENAME_FILE_BYTES) continue
          text = await readFile(abs, 'utf-8')
        } catch {
          continue
        }
        const { next, count } = rewriteCodeForRename(text, input.oldId, input.newId)
        if (count > 0) {
          pendingWrites.push({ absPath: abs, displayPath: relFile, content: next, occurrences: count })
        }
      }
    }

    if (!dryRun) {
      for (const item of pendingWrites) {
        await writeFile(item.absPath, item.content, 'utf-8')
      }
    }

    return Result.ok({
      dryRun,
      oldId: input.oldId,
      newId: input.newId,
      changes: pendingWrites
        .map((w) => ({ path: w.displayPath, occurrences: w.occurrences }))
        .toSorted((a, b) => a.path.localeCompare(b.path)),
    })
  })
}
