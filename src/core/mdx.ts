import { createHash } from 'node:crypto'
import type { MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx'
import { ALLOWED_MDX_COMPONENTS, parseMarkdownAst } from './mdast-parser'
import { BLOCK_ID_PATTERN, isNoteIntent, isSpecIntent, isStability } from './types'
import type {
  BlockKind,
  DocFormat,
  DocIssue,
  NoteIntent,
  SemanticBlock,
  SourceRefDecl,
  SpecIntent,
  Stability,
} from './types'

export { ALLOWED_MDX_COMPONENTS } from './mdast-parser'

const SEMANTIC_BLOCK_TAGS: Record<string, BlockKind> = {
  Spec: 'spec',
  Constraint: 'constraint',
  Outcome: 'outcome',
  Note: 'note',
  TermDef: 'term',
}

export interface ExtractedMdx {
  blocks: SemanticBlock[]
  sourceRefs: SourceRefDecl[]
  /** 本文中の通常 Markdown リンク先 URL */
  links: string[]
  /** 本文中の <Term name="..." /> 参照名 */
  termRefs: string[]
  /** 最初の H1 見出しテキスト (title 省略時の補完用) */
  firstHeading?: string
  issues: DocIssue[]
}

interface GenericNode {
  type: string
  name?: string | null
  depth?: number
  url?: string
  identifier?: string
  value?: string
  attributes?: Array<{ type: string; name?: string; value?: unknown }>
  children?: GenericNode[]
  position?: {
    start?: { line?: number; offset?: number }
    end?: { line?: number; offset?: number }
  }
}

/** 本文を正規化して SHA-256 ハッシュを算出する */
export function computeContentHash(rawBody: string): string {
  const normalized = rawBody.replace(/\r\n/g, '\n').trim()
  const hex = createHash('sha256').update(normalized, 'utf8').digest('hex')
  return `sha256:${hex}`
}

/**
 * Markdown / MDX 本文を AST (mdast) 解析し、
 * セマンティックブロック・SourceRef・内部リンク・用語参照・安全性 issue を一括抽出する。
 * コードは一切実行しない。
 */
export function extractMdxArtifacts(body: string, format: DocFormat, docId: string, lineOffset = 0): ExtractedMdx {
  const issues: DocIssue[] = []
  const { tree, parseError } = parseMarkdownAst(body, format)
  if (parseError) {
    issues.push({ code: 'mdx-parse-error', message: `MDX の構文解析に失敗しました: ${parseError}` })
  }

  const definitions = new Map<string, string>()
  for (const child of (tree as unknown as GenericNode).children ?? []) {
    if (child.type === 'definition' && child.identifier && child.url) {
      definitions.set(child.identifier.toLowerCase(), child.url)
    }
  }

  const blocks: SemanticBlock[] = []
  const sourceRefs: SourceRefDecl[] = []
  const links: string[] = []
  const termRefs: string[] = []
  let firstHeading: string | undefined
  let noteCounter = 0

  const unsupportedComponents = new Set<string>()
  let hasEsm = false
  let hasExpr = false

  const walk = (node: GenericNode) => {
    switch (node.type) {
      case 'heading': {
        if (node.depth === 1 && firstHeading === undefined) {
          const text = plainText(node.children ?? []).trim()
          if (text) firstHeading = text
        }
        break
      }
      case 'link': {
        if (typeof node.url === 'string' && node.url.trim() !== '') {
          links.push(node.url.trim())
        }
        break
      }
      case 'linkReference': {
        if (node.identifier) {
          const resolved = definitions.get(node.identifier.toLowerCase())
          if (resolved) links.push(resolved.trim())
        }
        break
      }
      case 'mdxjsEsm': {
        hasEsm = true
        return
      }
      case 'mdxFlowExpression':
      case 'mdxTextExpression': {
        hasExpr = true
        return
      }
      case 'mdxJsxFlowElement':
      case 'mdxJsxTextElement': {
        const jsx = node as unknown as MdxJsxFlowElement | MdxJsxTextElement
        const name = jsx.name
        if (name !== null && !ALLOWED_MDX_COMPONENTS.has(name)) {
          unsupportedComponents.add(name)
        } else if (name !== null) {
          const parsed = parseStringAttributes(jsx, issues)
          if (name === 'SourceRef') {
            extractSourceRef(parsed, node, sourceRefs, lineOffset)
          } else if (name === 'Term') {
            const termName = parsed.name?.trim()
            if (termName) termRefs.push(termName)
          } else if (name in SEMANTIC_BLOCK_TAGS) {
            const kind = SEMANTIC_BLOCK_TAGS[name]!
            const block = extractSemanticBlock(kind, parsed, node, body, docId, () => ++noteCounter, issues, lineOffset)
            if (block) blocks.push(block)
          }
        }
        break
      }
    }

    for (const child of node.children ?? []) {
      walk(child)
    }
  }

  walk(tree)

  if (hasEsm) {
    issues.push({ code: 'mdx-unsupported', message: 'ESM の import / export 文は未対応です' })
  }
  if (hasExpr) {
    issues.push({ code: 'mdx-unsupported', message: 'JSX 式 { ... } は未対応です' })
  }
  if (unsupportedComponents.size > 0) {
    const names = [...unsupportedComponents].map((n) => `<${n}>`).join(', ')
    issues.push({ code: 'mdx-unsupported', message: `未対応のコンポーネントです: ${names}` })
  }

  return { blocks, sourceRefs, links, termRefs, firstHeading, issues }
}

function parseStringAttributes(jsx: MdxJsxFlowElement | MdxJsxTextElement, issues: DocIssue[]): Record<string, string> {
  const props: Record<string, string> = {}
  for (const attr of jsx.attributes) {
    if (attr.type === 'mdxJsxExpressionAttribute') {
      issues.push({ code: 'mdx-unsupported', message: `<${jsx.name}> でスプレッド属性 {...} は未対応です` })
      continue
    }
    const a = attr
    if (a.value === null || a.value === undefined) {
      props[a.name] = 'true'
    } else if (typeof a.value === 'string') {
      props[a.name] = a.value
    } else {
      issues.push({
        code: 'mdx-unsupported',
        message: `<${jsx.name}> の属性 ${a.name} に JSX 式は使えません (文字列リテラルを使用してください)`,
      })
    }
  }
  return props
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function extractInnerBody(node: GenericNode, source: string): string {
  const children = node.children ?? []
  const firstStart = children[0]?.position?.start?.offset
  const lastEnd = children[children.length - 1]?.position?.end?.offset
  if (typeof firstStart === 'number' && typeof lastEnd === 'number' && lastEnd >= firstStart) {
    return source.slice(firstStart, lastEnd).trim()
  }
  return plainText(children).trim()
}

function extractSemanticBlock(
  kind: BlockKind,
  props: Record<string, string>,
  node: GenericNode,
  source: string,
  docId: string,
  nextNoteNum: () => number,
  issues: DocIssue[],
  lineOffset: number,
): SemanticBlock | null {
  const startLine = (node.position?.start?.line ?? 1) + lineOffset
  const endLine = (node.position?.end?.line ?? node.position?.start?.line ?? 1) + lineOffset
  const rawId = props.id?.trim()

  let id: string
  if (kind === 'note' && !rawId) {
    id = `${docId}#note-${nextNoteNum()}`
  } else if (!rawId) {
    issues.push({
      code: 'missing-block-id',
      message: `<${capitalizeKind(kind)}> (L${startLine}) に id 属性が必要です`,
    })
    return null
  } else if (!BLOCK_ID_PATTERN.test(rawId)) {
    issues.push({
      code: 'invalid-block-id',
      message: `ブロック ID が不正です: "${rawId}" (英字始まり、英数字と . _ - のみ使用可能)`,
      blockId: rawId,
    })
    return null
  } else {
    id = rawId
  }

  let intent: SpecIntent | NoteIntent = kind === 'note' ? 'informative' : 'normative'
  if (props.intent !== undefined) {
    if (kind === 'note') {
      if (isNoteIntent(props.intent)) {
        intent = props.intent
      } else {
        issues.push({
          code: 'invalid-block-attr',
          message: `<Note> の intent が不正です: ${props.intent} (idea / informative / rejected)`,
          blockId: id,
        })
      }
    } else if (isSpecIntent(props.intent)) {
      intent = props.intent
    } else {
      issues.push({
        code: 'invalid-block-attr',
        message: `<${capitalizeKind(kind)}> の intent が不正です: ${props.intent} (normative / idea / rejected)`,
        blockId: id,
      })
    }
  }

  let stability: Stability = 'evolving'
  if (props.stability !== undefined) {
    if (isStability(props.stability)) {
      stability = props.stability
    } else {
      issues.push({
        code: 'invalid-block-attr',
        message: `stability が不正です: ${props.stability} (stable / evolving / volatile)`,
        blockId: id,
      })
    }
  }

  const rawBody = extractInnerBody(node, source)
  const block: SemanticBlock = {
    id,
    kind,
    docId,
    startLine,
    endLine,
    contentHash: computeContentHash(rawBody),
    rawBody,
    title: props.title?.trim() || undefined,
    intent,
    stability,
    stabilitySource: 'mdx',
    review: 'unreviewed',
    suspect: false,
    suspectSources: [],
    feedback: [],
    derives: splitCsv(props.derives),
    supersedes: splitCsv(props.supersedes),
  }

  if (kind === 'constraint' && props.scope?.trim()) {
    block.scope = props.scope.trim()
  }
  if (kind === 'term') {
    const aliases = splitCsv(props.aliases)
    const symbols = splitCsv(props.symbols)
    if (aliases.length > 0) block.aliases = aliases
    if (symbols.length > 0) block.symbols = symbols
  }

  return block
}

function extractSourceRef(
  props: Record<string, string>,
  node: GenericNode,
  out: SourceRefDecl[],
  lineOffset: number,
): void {
  const file = props.file?.trim()
  if (!file) return
  out.push({
    file,
    symbol: props.symbol?.trim() || undefined,
    lines: props.lines?.trim() || undefined,
    satisfies: splitCsv(props.satisfies),
    verifies: splitCsv(props.verifies),
    startLine: (node.position?.start?.line ?? 1) + lineOffset,
  })
}

function capitalizeKind(kind: BlockKind): string {
  switch (kind) {
    case 'spec':
      return 'Spec'
    case 'constraint':
      return 'Constraint'
    case 'outcome':
      return 'Outcome'
    case 'note':
      return 'Note'
    case 'term':
      return 'TermDef'
  }
}

function plainText(nodes: readonly GenericNode[]): string {
  return nodes
    .map((n) => {
      if (typeof n.value === 'string') return n.value
      if (Array.isArray(n.children)) return plainText(n.children)
      return ''
    })
    .join('')
}
