import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse, registerDynamicLanguage } from '@ast-grep/napi'
import type { SgNode } from '@ast-grep/napi'
import { Result } from 'better-result'
import {
  AmbiguousSymbolError,
  AstParseError,
  BinaryFileError,
  FileTooLargeError,
  InvalidLineRangeError,
  InvalidSourcePathError,
  InvalidSymbolQueryError,
  NotAFileError,
  PathOutsideRootError,
  SourceFileNotFoundError,
  SymbolNotFoundError,
  UnsupportedExtensionError,
  type ExtractExportsError,
  type LoadSourceError,
  type ResolveLinesError,
  type ResolveSymbolError,
} from './errors'

const DYNAMIC_LANG_NAMES = new Set(['go', 'rust', 'python', 'java', 'kotlin', 'swift'])
let dynamicLangsPromise: Promise<void> | undefined

/**
 * `@ast-grep/napi` の `registerDynamicLanguage` はプロセス内 1 回限りの初期化（Rust OnceLock）のため、
 * TS/JS 以外のファイルを初めて解析するタイミングで 6 言語を遅延ロードして一括登録する。
 * TS/JS のみのプロジェクトではこれらを一切読み込まない。
 */
async function ensureDynamicLanguage(astLang: string): Promise<void> {
  if (!DYNAMIC_LANG_NAMES.has(astLang)) return
  dynamicLangsPromise ??= (async () => {
    const [go, rust, python, java, kotlin, swift] = await Promise.all([
      import('@ast-grep/lang-go'),
      import('@ast-grep/lang-rust'),
      import('@ast-grep/lang-python'),
      import('@ast-grep/lang-java'),
      import('@ast-grep/lang-kotlin'),
      import('@ast-grep/lang-swift'),
    ])
    registerDynamicLanguage({
      go: go.default,
      rust: rust.default,
      python: python.default,
      java: java.default,
      kotlin: kotlin.default,
      swift: swift.default,
    })
  })()
  await dynamicLangsPromise
}

interface SourceSymbolInfo {
  name: string
  qualifiedName?: string
  kind: string
}

export interface SourceResult {
  file: string
  language: string
  symbol?: SourceSymbolInfo
  startLine: number
  endLine: number
  totalLines: number
  code: string
  truncated: boolean
}

export interface ExportedSymbolEntry {
  name: string
  qualifiedName?: string
  kind: string
  signature: string
  startLine: number
  endLine: number
}

export interface SourceExportsResult {
  file: string
  language: string
  totalLines: number
  symbols: ExportedSymbolEntry[]
}

const MAX_FILE_BYTES = 1024 * 1024
const MAX_EXTRACT_LINES = 400
const MAX_RANGE_LINES = 2000
const BINARY_SNIFF_BYTES = 8192

interface KindRule {
  kind: string
  label: string
  nameField?: string
  /** この kind を定義として出さず、qualified name のスコープとしてのみ使う */
  scopeOnly?: boolean
  /** この kind のシンボルは祖先スコープではなく独自の修飾名を持つ */
  qualifiedBy?: string
}

interface LangDef {
  /** ast-grep / tree-sitter の言語名 */
  astLang: string
  /** Shiki の言語名 */
  display: string
  exts: string[]
  kinds: KindRule[]
  /** qualified name を構成する祖先 kind → 名前を取るフィールド */
  scopes?: Record<string, string>
}

const TS_RULES: KindRule[] = [
  { kind: 'function_declaration', label: 'function' },
  { kind: 'generator_function_declaration', label: 'function' },
  { kind: 'class_declaration', label: 'class' },
  { kind: 'abstract_class_declaration', label: 'class' },
  { kind: 'interface_declaration', label: 'interface' },
  { kind: 'type_alias_declaration', label: 'type' },
  { kind: 'enum_declaration', label: 'enum' },
  { kind: 'internal_module', label: 'namespace' },
  { kind: 'module', label: 'namespace' },
  { kind: 'method_definition', label: 'method' },
]

const JS_RULES: KindRule[] = [
  { kind: 'function_declaration', label: 'function' },
  { kind: 'generator_function_declaration', label: 'function' },
  { kind: 'class_declaration', label: 'class' },
  { kind: 'method_definition', label: 'method' },
]

const GO_RULES: KindRule[] = [
  { kind: 'function_declaration', label: 'function', qualifiedBy: 'receiver' },
  { kind: 'method_declaration', label: 'method', qualifiedBy: 'receiver' },
  { kind: 'type_spec', label: 'type', nameField: 'name' },
]

const RUST_RULES: KindRule[] = [
  { kind: 'function_item', label: 'function' },
  { kind: 'struct_item', label: 'struct' },
  { kind: 'enum_item', label: 'enum' },
  { kind: 'union_item', label: 'union' },
  { kind: 'trait_item', label: 'trait' },
  { kind: 'type_item', label: 'type' },
  { kind: 'const_item', label: 'constant' },
  { kind: 'static_item', label: 'static' },
  { kind: 'impl_item', label: '', scopeOnly: true },
  { kind: 'mod_item', label: '', scopeOnly: true },
]

const PYTHON_RULES: KindRule[] = [
  { kind: 'function_definition', label: 'function' },
  { kind: 'class_definition', label: 'class' },
]

const JAVA_RULES: KindRule[] = [
  { kind: 'method_declaration', label: 'method' },
  { kind: 'constructor_declaration', label: 'constructor' },
  { kind: 'class_declaration', label: 'class' },
  { kind: 'interface_declaration', label: 'interface' },
  { kind: 'enum_declaration', label: 'enum' },
  { kind: 'record_declaration', label: 'record' },
  { kind: 'annotation_type_declaration', label: 'annotation' },
]

const KOTLIN_RULES: KindRule[] = [
  { kind: 'function_declaration', label: 'function' },
  { kind: 'class_declaration', label: 'class' },
  { kind: 'object_declaration', label: 'object' },
  { kind: 'property_declaration', label: 'property' },
]

const SWIFT_RULES: KindRule[] = [
  { kind: 'function_declaration', label: 'function' },
  { kind: 'class_declaration', label: 'class' },
  { kind: 'protocol_declaration', label: 'protocol' },
]

const LANGS: Record<string, LangDef> = {
  typescript: {
    astLang: 'TypeScript',
    display: 'typescript',
    exts: ['ts', 'mts', 'cts'],
    kinds: TS_RULES,
    scopes: {
      class_declaration: 'name',
      abstract_class_declaration: 'name',
      interface_declaration: 'name',
      internal_module: 'name',
      module: 'name',
    },
  },
  tsx: {
    astLang: 'Tsx',
    display: 'tsx',
    exts: ['tsx'],
    kinds: TS_RULES,
    scopes: {
      class_declaration: 'name',
      abstract_class_declaration: 'name',
      interface_declaration: 'name',
      internal_module: 'name',
      module: 'name',
    },
  },
  javascript: {
    astLang: 'JavaScript',
    display: 'javascript',
    exts: ['js', 'mjs', 'cjs'],
    kinds: JS_RULES,
    scopes: { class_declaration: 'name' },
  },
  go: {
    astLang: 'go',
    display: 'go',
    exts: ['go'],
    kinds: GO_RULES,
  },
  rust: {
    astLang: 'rust',
    display: 'rust',
    exts: ['rs'],
    kinds: RUST_RULES,
    scopes: { impl_item: 'type', mod_item: 'name', trait_item: 'name' },
  },
  python: {
    astLang: 'python',
    display: 'python',
    exts: ['py', 'pyi'],
    kinds: PYTHON_RULES,
    scopes: { class_definition: 'name' },
  },
  java: {
    astLang: 'java',
    display: 'java',
    exts: ['java'],
    kinds: JAVA_RULES,
    scopes: {
      class_declaration: 'name',
      interface_declaration: 'name',
      enum_declaration: 'name',
      record_declaration: 'name',
      annotation_type_declaration: 'name',
    },
  },
  kotlin: {
    astLang: 'kotlin',
    display: 'kotlin',
    exts: ['kt', 'kts'],
    kinds: KOTLIN_RULES,
    scopes: { class_declaration: 'name', object_declaration: 'name' },
  },
  swift: {
    astLang: 'swift',
    display: 'swift',
    exts: ['swift'],
    kinds: SWIFT_RULES,
    scopes: { class_declaration: 'name' },
  },
}

const EXT_TO_LANG = new Map<string, LangDef>()
for (const def of Object.values(LANGS)) {
  for (const ext of def.exts) EXT_TO_LANG.set(ext, def)
}

export const TEXT_EXTS = new Set([
  ...EXT_TO_LANG.keys(),
  'md',
  'mdx',
  'markdown',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'xml',
  'html',
  'css',
  'scss',
  'less',
  'sql',
  'sh',
  'bash',
  'zsh',
  'fish',
  'txt',
  'ini',
  'cfg',
  'conf',
  'graphql',
  'gql',
  'proto',
  'diff',
  'patch',
  'csv',
  'lua',
  'rb',
  'php',
  'c',
  'h',
  'cpp',
  'cc',
  'cxx',
  'hpp',
  'cs',
  'fs',
  'ex',
  'exs',
  'erl',
  'hrl',
  'clj',
  'scala',
  'groovy',
  'gradle',
  'make',
  'mk',
  'dockerfile',
  'just',
  'nix',
  'zig',
  'dart',
  'r',
  'jl',
  'vim',
  'tf',
  'hcl',
])

export function detectSourceLanguage(ext: string): string {
  return EXT_TO_LANG.get(ext)?.display ?? (ext || 'text')
}

export interface LoadedSource {
  absPath: string
  relPath: string
  source: string
  ext: string
}

/** file をプロジェクトルート内に限定して安全に読み込む */
export async function loadSourceFile(
  projectRoot: string,
  file: string,
): Promise<Result<LoadedSource, LoadSourceError>> {
  if (typeof file !== 'string' || file.trim() === '' || file.includes('\0')) {
    return Result.err(
      new InvalidSourcePathError({ file: typeof file === 'string' ? file : '', message: 'Invalid file parameter' }),
    )
  }
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    return Result.err(
      new PathOutsideRootError({
        file,
        reason: 'traversal',
        message: 'Path resolves outside project root',
      }),
    )
  }
  const rootReal = await fs.realpath(projectRoot)
  const abs = path.resolve(rootReal, file)
  if (abs !== rootReal && !abs.startsWith(rootReal + path.sep)) {
    return Result.err(
      new PathOutsideRootError({
        file,
        reason: 'traversal',
        message: 'Path resolves outside project root',
      }),
    )
  }
  let real: string
  try {
    real = await fs.realpath(abs)
  } catch {
    return Result.err(new SourceFileNotFoundError({ file, message: `File not found: ${file}` }))
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    return Result.err(
      new PathOutsideRootError({
        file,
        reason: 'symlink',
        message: 'Symlink resolves outside project root',
      }),
    )
  }

  const stat = await fs.stat(real)
  if (!stat.isFile()) {
    return Result.err(new NotAFileError({ file, message: `Not a regular file: ${file}` }))
  }
  if (stat.size > MAX_FILE_BYTES) {
    return Result.err(
      new FileTooLargeError({
        file,
        maxBytes: MAX_FILE_BYTES,
        actualBytes: stat.size,
        message: `File exceeds size limit (${MAX_FILE_BYTES / 1024}KB)`,
      }),
    )
  }

  const buf = await fs.readFile(real)
  const head = buf.subarray(0, BINARY_SNIFF_BYTES)
  if (head.includes(0)) {
    return Result.err(new BinaryFileError({ file, message: 'Binary files are not supported' }))
  }

  return Result.ok({
    absPath: real,
    relPath: path.relative(rootReal, real).split(path.sep).join('/'),
    source: buf.toString('utf8'),
    ext: path.extname(real).slice(1).toLowerCase(),
  })
}

/** 実在する行数を返す。末尾の改行は余分な空行として数えない。 */
function totalLines(source: string): number {
  if (source === '') return 0
  return source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length
}

function sliceLines(source: string, start: number, end: number, total: number): { code: string; truncated: boolean } {
  const lines = source.split('\n')
  const cappedEnd = Math.min(end, total)
  const slice = lines.slice(start - 1, cappedEnd)
  const truncated = cappedEnd < end
  const code = slice.join('\n')
  if (code.split('\n').length <= MAX_EXTRACT_LINES) return { code, truncated }
  return { code: slice.slice(0, MAX_EXTRACT_LINES).join('\n'), truncated: true }
}

/** `lines="10-40"` / `lines="10"` を解釈する (1始まり・両端含む) */
export async function resolveSourceLines(
  projectRoot: string,
  file: string,
  linesParam: string,
): Promise<Result<SourceResult, ResolveLinesError>> {
  return Result.gen(async function* () {
    const loaded = yield* Result.await(loadSourceFile(projectRoot, file))
    if (!TEXT_EXTS.has(loaded.ext)) {
      return Result.err(
        new UnsupportedExtensionError({
          file: loaded.relPath,
          ext: loaded.ext,
          message: `Unsupported file extension: .${loaded.ext}`,
        }),
      )
    }
    const m = /^(\d+)(?:-(\d+))?$/.exec(linesParam.trim())
    if (!m) {
      return Result.err(
        new InvalidLineRangeError({
          file: loaded.relPath,
          lines: linesParam,
          message: `Invalid lines format: ${linesParam}`,
        }),
      )
    }
    const start = Number(m[1])
    const end = m[2] !== undefined ? Number(m[2]) : start
    if (start < 1 || end < start || end - start + 1 > MAX_RANGE_LINES) {
      return Result.err(
        new InvalidLineRangeError({
          file: loaded.relPath,
          lines: linesParam,
          message: `Invalid line range (1-${MAX_RANGE_LINES} lines): ${linesParam}`,
        }),
      )
    }
    const total = totalLines(loaded.source)
    if (total === 0 || start > total) {
      return Result.err(
        new InvalidLineRangeError({
          file: loaded.relPath,
          lines: linesParam,
          message: `Line range exceeds file length (${total} lines): ${linesParam}`,
        }),
      )
    }

    // sliceLines が end > 実在行数も含めて切り詰め、truncated を設定する
    const { code, truncated } = sliceLines(loaded.source, start, end, total)
    return Result.ok({
      file: loaded.relPath,
      language: EXT_TO_LANG.get(loaded.ext)?.display ?? loaded.ext,
      startLine: start,
      endLine: start + code.split('\n').length - 1,
      totalLines: total,
      code,
      truncated,
    })
  })
}

interface Candidate {
  node: SgNode
  name: string
  qualifiedName: string
  kind: string
  kindRule: KindRule
}

function fieldText(node: SgNode, name: string): string | undefined {
  const f = (node as unknown as { field(n: string): SgNode | null }).field(name)
  return f ? f.text().trim() || undefined : undefined
}

/** impl Foo<T> / impl Trait for Foo のような修飾をベース型名に正規化する */
function cleanTypeName(text: string): string {
  const noGeneric = text.replace(/<[^>]*>/g, '').trim()
  const parts = noGeneric.split(/\s+/)
  return (parts[parts.length - 1] ?? noGeneric).replace(/^\*+/, '')
}

function goReceiverName(node: SgNode): string | undefined {
  const recv = (node as unknown as { field(n: string): SgNode | null }).field('receiver')
  if (!recv) return undefined
  const text = recv.text()
  const inner = text.replace(/^\(/, '').replace(/\)$/, '').trim()
  const tokens = inner.split(/\s+/).filter(Boolean)
  const typeToken = tokens[tokens.length - 1]
  if (!typeToken) return undefined
  return cleanTypeName(typeToken) || undefined
}

/** スコープ名を取得する。name フィールドが無い言語 (Kotlin 等) は identifier 系の子ノードを使う */
function scopeNameText(node: SgNode, field: string): string | undefined {
  const f = fieldText(node, field)
  if (f) return f
  for (const c of node.children()) {
    if (c.kind() === field || (field === 'name' && String(c.kind()).endsWith('identifier'))) {
      const t = c.text().trim()
      if (t) return t
    }
  }
  return undefined
}

function computeQualified(node: SgNode, name: string, rule: KindRule, def: LangDef): string {
  if (rule.qualifiedBy === 'receiver') {
    const recv = goReceiverName(node)
    return recv ? `${recv}.${name}` : name
  }
  if (!def.scopes) return name
  const parts: string[] = [name]
  for (const anc of node.ancestors()) {
    const field = def.scopes[anc.kind()]
    if (!field) continue
    const scopeName = scopeNameText(anc, field)
    if (scopeName) parts.unshift(cleanTypeName(scopeName))
  }
  return parts.join('.')
}

function collectCandidates(root: ReturnType<typeof parse>, def: LangDef): Candidate[] {
  const out: Candidate[] = []
  const rootNode = (root as unknown as { root(): SgNode }).root()
  for (const rule of def.kinds) {
    if (rule.scopeOnly) continue
    const nodes = (rootNode as unknown as { findAll(m: unknown): SgNode[] }).findAll({ rule: { kind: rule.kind } })
    for (const node of nodes) {
      const name = scopeNameText(node, rule.nameField ?? 'name')
      if (!name) continue
      out.push({
        node,
        name,
        qualifiedName: computeQualified(node, name, rule, def),
        kind: rule.label,
        kindRule: rule,
      })
    }
  }
  return out
}

function findSymbol(
  candidates: Candidate[],
  symbol: string,
): { one: Candidate } | { many: Candidate[] } | { none: true } {
  const want = symbol.trim()
  const matches = candidates.filter((c) => {
    if (want.includes('.')) {
      return c.qualifiedName === want || c.qualifiedName.endsWith(`.${want}`)
    }
    return c.name === want || c.qualifiedName.endsWith(`.${want}`)
  })
  const unique = new Map<number, Candidate>()
  for (const m of matches) unique.set(m.node.range().start.index, m)
  const list = [...unique.values()]
  if (list.length === 1) return { one: list[0]! }
  if (list.length > 1) return { many: list }
  return { none: true }
}

/** export / decorator 等の修飾を含むため、該当する親ノードの範囲を使う */
function effectiveNode(node: SgNode): SgNode {
  const parent = node.ancestors()[0]
  if (parent && (parent.kind() === 'export_statement' || parent.kind() === 'decorated_definition')) {
    return parent
  }
  return node
}

function nodeCode(source: string, node: SgNode): { code: string; startLine: number; endLine: number } {
  const range = effectiveNode(node).range()
  // ast-grep の index は UTF-16 コードユニット単位のオフセット
  const code = source.slice(range.start.index, range.end.index)
  const startLine = range.start.line + 1
  return { code, startLine, endLine: startLine + code.split('\n').length - 1 }
}

/** `symbol="Registry.register"` を AST で解決する */
export async function resolveSourceSymbol(
  projectRoot: string,
  file: string,
  symbol: string,
): Promise<Result<SourceResult, ResolveSymbolError>> {
  return Result.gen(async function* () {
    const loaded = yield* Result.await(loadSourceFile(projectRoot, file))
    const def = EXT_TO_LANG.get(loaded.ext)
    if (!def) {
      const supported = [...new Set(EXT_TO_LANG.keys())].toSorted().join(', ')
      return Result.err(
        new UnsupportedExtensionError({
          file: loaded.relPath,
          ext: loaded.ext,
          message: `Unsupported extension for symbol lookup: .${loaded.ext} (supported: ${supported})`,
        }),
      )
    }
    if (!symbol || !symbol.trim()) {
      return Result.err(new InvalidSymbolQueryError({ file: loaded.relPath, message: 'symbol parameter is required' }))
    }

    let root: ReturnType<typeof parse>
    try {
      await ensureDynamicLanguage(def.astLang)
      root = parse(def.astLang as never, loaded.source)
    } catch (e) {
      return Result.err(
        new AstParseError({
          file: loaded.relPath,
          language: def.display,
          message: `Failed to parse AST: ${e instanceof Error ? e.message : String(e)}`,
        }),
      )
    }

    const candidates = collectCandidates(root, def)
    const found = findSymbol(candidates, symbol)
    if ('none' in found) {
      const similar = candidates
        .filter((c) => c.name === symbol.split('.').pop())
        .slice(0, 5)
        .map((c) => c.qualifiedName)
      const hint = similar.length ? ` (candidates: ${similar.join(', ')})` : ''
      return Result.err(
        new SymbolNotFoundError({
          file: loaded.relPath,
          symbol,
          candidates: similar,
          message: `Symbol not found: ${symbol}${hint}`,
        }),
      )
    }
    if ('many' in found) {
      const matches = found.many.map((c) => `${c.qualifiedName} (${c.kind}, L${c.node.range().start.line + 1})`)
      return Result.err(
        new AmbiguousSymbolError({
          file: loaded.relPath,
          symbol,
          matches,
          message: `Ambiguous symbol: ${symbol} — ${matches.join('; ')}`,
        }),
      )
    }

    const c = found.one
    const { code, startLine } = nodeCode(loaded.source, c.node)
    const { code: finalCode, truncated } = capCode(code)
    return Result.ok({
      file: loaded.relPath,
      language: def.display,
      symbol: { name: c.name, qualifiedName: c.qualifiedName === c.name ? undefined : c.qualifiedName, kind: c.kind },
      startLine,
      endLine: startLine + finalCode.split('\n').length - 1,
      totalLines: totalLines(loaded.source),
      code: finalCode,
      truncated,
    })
  })
}

function capCode(code: string): { code: string; truncated: boolean } {
  const lines = code.split('\n')
  if (lines.length <= MAX_EXTRACT_LINES) return { code, truncated: false }
  return { code: lines.slice(0, MAX_EXTRACT_LINES).join('\n'), truncated: true }
}

const MAX_SIGNATURE_CHARS = 140

/** 宣言ノードのヘッダ行から 1 行のコンパクトなシグネチャを抽出する */
function extractSignatureHeader(source: string, node: SgNode, kind: string): string {
  const target = effectiveNode(node)
  const range = target.range()
  const raw = source.slice(range.start.index, range.end.index).trim()

  // class / interface / enum / function / method / struct / trait 等は `{` 手前までをヘッダとして抜く
  let header = raw
  if (kind === 'type' || kind === 'constant' || kind === 'static' || kind === 'property') {
    const firstLine = raw.split('\n')[0] ?? raw
    header = firstLine.replace(/\s*=\s*\{[\s\S]*$/, ' = { … }').trim()
  } else {
    // 関数・クラス等は最初のトップレベル `{` または `:` (Python) の手前を切り出す
    let parenDepth = 0
    let angleDepth = 0
    let cutAt = -1
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!
      if (ch === '(') parenDepth++
      else if (ch === ')' && parenDepth > 0) parenDepth--
      else if (ch === '<') angleDepth++
      else if (ch === '>' && angleDepth > 0) angleDepth--
      else if (ch === '{' && parenDepth === 0 && angleDepth === 0) {
        cutAt = i
        break
      } else if (ch === '\n' && parenDepth === 0 && angleDepth === 0 && raw.slice(0, i).trimEnd().endsWith(':')) {
        cutAt = i
        break
      }
    }
    if (cutAt > 0) {
      header = raw.slice(0, cutAt).trim()
    }
  }

  const singleLine = header.replace(/\s+/g, ' ').trim()
  if (singleLine.length <= MAX_SIGNATURE_CHARS) return singleLine
  return `${singleLine.slice(0, MAX_SIGNATURE_CHARS - 1)}…`
}

function isExportedCandidate(c: Candidate, def: LangDef, source: string): boolean {
  const ancestors = c.node.ancestors()
  const parent = ancestors[0]
  const display = def.display

  if (display === 'typescript' || display === 'tsx' || display === 'javascript') {
    // クラスメソッドはトップレベルの公開シンボル一覧から除外し、class 宣言自体を 1 件として見せる
    if (c.kind === 'method') return false
    return parent?.kind() === 'export_statement'
  }
  if (display === 'go') {
    return /^[A-Z]/.test(c.name)
  }
  if (display === 'rust') {
    const text = source.slice(c.node.range().start.index, c.node.range().end.index).trimStart()
    return text.startsWith('pub ') || text.startsWith('pub(')
  }
  if (display === 'python') {
    if (c.name.startsWith('_')) return false
    // トップレベル定義のみ
    return ancestors.every((a) => a.kind() !== 'class_definition' && a.kind() !== 'function_definition')
  }
  if (display === 'java') {
    const text = source.slice(c.node.range().start.index, c.node.range().end.index).trimStart()
    return /\bpublic\b/.test(text.split('{')[0] ?? '')
  }
  // Kotlin / Swift: private / internal でないトップレベル定義
  const head = source.slice(c.node.range().start.index, c.node.range().end.index).split('{')[0] ?? ''
  if (/\b(?:private|fileprivate|internal|protected)\b/.test(head)) return false
  return true
}

/**
 * 読み込み済みソース文字列から export / 公開シンボル（class / interface / type / enum / function / const 等）を
 * `@ast-grep/napi` で自動抽出する。非対応拡張子や解析不能時は空配列を返す。
 * @implements core.ast-exports
 */
export async function extractExportedSymbolsFromSource(
  relPath: string,
  ext: string,
  source: string,
): Promise<SourceExportsResult> {
  const def = EXT_TO_LANG.get(ext)
  const lines = totalLines(source)
  if (!def) {
    return { file: relPath, language: detectSourceLanguage(ext), totalLines: lines, symbols: [] }
  }

  let root: ReturnType<typeof parse>
  try {
    await ensureDynamicLanguage(def.astLang)
    root = parse(def.astLang as never, source)
  } catch {
    return { file: relPath, language: def.display, totalLines: lines, symbols: [] }
  }

  const seen = new Map<number, ExportedSymbolEntry>()
  const candidates = collectCandidates(root, def)
  for (const c of candidates) {
    if (!isExportedCandidate(c, def, source)) continue
    const target = effectiveNode(c.node)
    const range = target.range()
    const startIdx = range.start.index
    if (seen.has(startIdx)) continue
    seen.set(startIdx, {
      name: c.name,
      ...(c.qualifiedName !== c.name ? { qualifiedName: c.qualifiedName } : {}),
      kind: c.kind,
      signature: extractSignatureHeader(source, c.node, c.kind),
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
    })
  }

  // TS/JS の `export const foo = ...` (アロー関数や公開定数) も拾う
  if (def.display === 'typescript' || def.display === 'tsx' || def.display === 'javascript') {
    const rootNode = (root as unknown as { root(): SgNode }).root()
    const exportStmts = (rootNode as unknown as { findAll(m: unknown): SgNode[] }).findAll({
      rule: { kind: 'export_statement' },
    })
    for (const stmt of exportStmts) {
      const range = stmt.range()
      if (seen.has(range.start.index)) continue
      const lex = stmt.children().find((ch) => ch.kind() === 'lexical_declaration')
      if (!lex) continue
      const declarator = lex.children().find((ch) => ch.kind() === 'variable_declarator')
      if (!declarator) continue
      const name = scopeNameText(declarator, 'name')
      if (!name) continue
      const valNode = (declarator as unknown as { field(n: string): SgNode | null }).field('value')
      const isFn = valNode?.kind() === 'arrow_function' || valNode?.kind() === 'function_expression'
      const kind = isFn ? 'function' : 'constant'
      seen.set(range.start.index, {
        name,
        kind,
        signature: extractSignatureHeader(source, lex, kind),
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
      })
    }
  }

  const symbols = [...seen.values()].toSorted((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name))
  return {
    file: relPath,
    language: def.display,
    totalLines: lines,
    symbols,
  }
}

/**
 * プロジェクトルート内のソースファイルから公開シンボル（class / interface / type / function 等）を AST 抽出する。
 * @implements core.ast-exports
 */
export async function extractExportedSymbols(
  projectRoot: string,
  file: string,
): Promise<Result<SourceExportsResult, ExtractExportsError>> {
  return Result.gen(async function* () {
    const loaded = yield* Result.await(loadSourceFile(projectRoot, file))
    if (!EXT_TO_LANG.has(loaded.ext)) {
      const supported = [...new Set(EXT_TO_LANG.keys())].toSorted().join(', ')
      return Result.err(
        new UnsupportedExtensionError({
          file: loaded.relPath,
          ext: loaded.ext,
          message: `Unsupported extension for symbol export extraction: .${loaded.ext} (supported: ${supported})`,
        }),
      )
    }
    return Result.ok(await extractExportedSymbolsFromSource(loaded.relPath, loaded.ext, loaded.source))
  })
}
