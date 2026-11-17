import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse, registerDynamicLanguage } from '@ast-grep/napi'
import type { SgNode } from '@ast-grep/napi'
import goLang from '@ast-grep/lang-go'
import rustLang from '@ast-grep/lang-rust'
import pythonLang from '@ast-grep/lang-python'
import javaLang from '@ast-grep/lang-java'
import kotlinLang from '@ast-grep/lang-kotlin'
import swiftLang from '@ast-grep/lang-swift'

registerDynamicLanguage({
  go: goLang,
  rust: rustLang,
  python: pythonLang,
  java: javaLang,
  kotlin: kotlinLang,
  swift: swiftLang,
})

export class SourceError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message)
    this.name = 'SourceError'
  }
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
  truncated?: boolean
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

const TEXT_EXTS = new Set([
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
  'env',
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

interface LoadedSource {
  absPath: string
  relPath: string
  source: string
  ext: string
}

/** file をプロジェクトルート内に限定して安全に読み込む */
async function loadSourceFile(projectRoot: string, file: string): Promise<LoadedSource> {
  if (typeof file !== 'string' || file.trim() === '' || file.includes('\0')) {
    throw new SourceError('file パラメータが不正です', 400)
  }
  const rootReal = await fs.realpath(projectRoot)
  const abs = path.resolve(rootReal, file)
  if (abs !== rootReal && !abs.startsWith(rootReal + path.sep)) {
    throw new SourceError('パスがプロジェクトルート外を指しています', 400)
  }
  let real: string
  try {
    real = await fs.realpath(abs)
  } catch {
    throw new SourceError(`ファイルが見つかりません: ${file}`, 404)
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new SourceError('シンボリックリンクがプロジェクトルート外を指しています', 403)
  }

  const stat = await fs.stat(real)
  if (!stat.isFile()) throw new SourceError(`ファイルではありません: ${file}`, 400)
  if (stat.size > MAX_FILE_BYTES) throw new SourceError(`ファイルが大きすぎます (上限 ${MAX_FILE_BYTES / 1024}KB)`, 413)

  const buf = await fs.readFile(real)
  const head = buf.subarray(0, BINARY_SNIFF_BYTES)
  if (head.includes(0)) throw new SourceError('バイナリファイルは読み込めません', 400)

  return {
    absPath: real,
    relPath: path.relative(rootReal, real).split(path.sep).join('/'),
    source: buf.toString('utf8'),
    ext: path.extname(real).slice(1).toLowerCase(),
  }
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
export async function resolveSourceLines(projectRoot: string, file: string, linesParam: string): Promise<SourceResult> {
  const loaded = await loadSourceFile(projectRoot, file)
  if (!TEXT_EXTS.has(loaded.ext)) {
    throw new SourceError(`対応していない拡張子です: .${loaded.ext}`, 400)
  }
  const m = /^(\d+)(?:-(\d+))?$/.exec(linesParam.trim())
  if (!m) throw new SourceError(`lines の形式が不正です: ${linesParam}`, 400)
  const start = Number(m[1])
  const end = m[2] !== undefined ? Number(m[2]) : start
  if (start < 1 || end < start || end - start + 1 > MAX_RANGE_LINES) {
    throw new SourceError(`lines の範囲が不正です (1〜${MAX_RANGE_LINES} 行): ${linesParam}`, 400)
  }
  const total = totalLines(loaded.source)
  if (total === 0 || start > total) {
    throw new SourceError(`行範囲がファイルを超えています (全 ${total} 行): ${linesParam}`, 400)
  }

  // sliceLines が end > 実在行数も含めて切り詰め、truncated を設定する
  const { code, truncated } = sliceLines(loaded.source, start, end, total)
  return {
    file: loaded.relPath,
    language: EXT_TO_LANG.get(loaded.ext)?.display ?? loaded.ext,
    startLine: start,
    endLine: start + code.split('\n').length - 1,
    totalLines: total,
    code,
    truncated: truncated || undefined,
  }
}

interface Candidate {
  node: SgNode
  name: string
  qualifiedName: string
  kind: string
  kindRule: KindRule
}

function fieldText(node: SgNode, name: string): string | null {
  const f = (node as unknown as { field(n: string): SgNode | null }).field(name)
  return f ? f.text().trim() : null
}

/** impl Foo<T> / impl Trait for Foo のような修飾をベース型名に正規化する */
function cleanTypeName(text: string): string {
  const noGeneric = text.replace(/<[^>]*>/g, '').trim()
  const parts = noGeneric.split(/\s+/)
  return (parts[parts.length - 1] ?? noGeneric).replace(/^\*+/, '')
}

function goReceiverName(node: SgNode): string | null {
  const recv = (node as unknown as { field(n: string): SgNode | null }).field('receiver')
  if (!recv) return null
  const text = recv.text()
  const inner = text.replace(/^\(/, '').replace(/\)$/, '').trim()
  const tokens = inner.split(/\s+/).filter(Boolean)
  const typeToken = tokens[tokens.length - 1] ?? ''
  return cleanTypeName(typeToken)
}

/** スコープ名を取得する。name フィールドが無い言語 (Kotlin 等) は identifier 系の子ノードを使う */
function scopeNameText(node: SgNode, field: string): string | null {
  const f = fieldText(node, field)
  if (f) return f
  for (const c of node.children()) {
    if (c.kind() === field || (field === 'name' && String(c.kind()).endsWith('identifier'))) {
      const t = c.text().trim()
      if (t) return t
    }
  }
  return null
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
export async function resolveSourceSymbol(projectRoot: string, file: string, symbol: string): Promise<SourceResult> {
  const loaded = await loadSourceFile(projectRoot, file)
  const def = EXT_TO_LANG.get(loaded.ext)
  if (!def) {
    const supported = [...new Set(EXT_TO_LANG.keys())].sort().join(', ')
    throw new SourceError(`シンボル検索に対応していない拡張子です: .${loaded.ext} (対応: ${supported})`, 400)
  }
  if (!symbol || !symbol.trim()) throw new SourceError('symbol パラメータが必要です', 400)

  let root: ReturnType<typeof parse>
  try {
    root = parse(def.astLang as never, loaded.source)
  } catch (e) {
    throw new SourceError(`AST の解析に失敗しました: ${e instanceof Error ? e.message : String(e)}`, 422)
  }

  const candidates = collectCandidates(root, def)
  const found = findSymbol(candidates, symbol)
  if ('none' in found) {
    const similar = candidates.filter((c) => c.name === symbol.split('.').pop()).slice(0, 5)
    const hint = similar.length ? ` 候補: ${similar.map((c) => c.qualifiedName).join(', ')}` : ''
    throw new SourceError(`シンボルが見つかりません: ${symbol}${hint}`, 404)
  }
  if ('many' in found) {
    const list = found.many.map((c) => `${c.qualifiedName} (${c.kind}, L${c.node.range().start.line + 1})`).join('; ')
    throw new SourceError(`シンボルが曖昧です: ${symbol} — ${list}`, 409)
  }

  const c = found.one
  const { code, startLine } = nodeCode(loaded.source, c.node)
  const { code: finalCode, truncated } = capCode(code)
  return {
    file: loaded.relPath,
    language: def.display,
    symbol: { name: c.name, qualifiedName: c.qualifiedName === c.name ? undefined : c.qualifiedName, kind: c.kind },
    startLine,
    endLine: startLine + finalCode.split('\n').length - 1,
    totalLines: totalLines(loaded.source),
    code: finalCode,
    truncated: truncated || undefined,
  }
}

function capCode(code: string): { code: string; truncated: boolean } {
  const lines = code.split('\n')
  if (lines.length <= MAX_EXTRACT_LINES) return { code, truncated: false }
  return { code: lines.slice(0, MAX_EXTRACT_LINES).join('\n'), truncated: true }
}
