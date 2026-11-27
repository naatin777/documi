import { createHash } from 'node:crypto'
import type { MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx'
import { ALLOWED_MDX_COMPONENTS, parseMarkdownAst } from './mdast-parser'
import { BLOCK_ID_PATTERN, isNoteIntent, isSpecIntent, isStability, isTestLevel } from './types'
import type {
  BlockKind,
  DecisionRejectedOption,
  DocFormat,
  DocIssue,
  NoteIntent,
  SemanticBlock,
  SourceRefDecl,
  SpecIntent,
  Stability,
  TestLevel,
} from './types'

export { ALLOWED_MDX_COMPONENTS } from './mdast-parser'

const SEMANTIC_BLOCK_TAGS: Record<string, BlockKind> = {
  Spec: 'spec',
  Constraint: 'constraint',
  Decision: 'decision',
  Test: 'test',
  Note: 'note',
  TermDef: 'term',
}

export interface ExtractedMdx {
  blocks: SemanticBlock[]
  sourceRefs: SourceRefDecl[]
  /** 本文中の通常 Markdown リンク先 URL */
  links: string[]
  /** 本文中の Markdown メディア（画像・動画・音声）参照 URL */
  mediaRefs: string[]
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
    issues.push({ code: 'mdx-parse-error', message: `Failed to parse MDX syntax: ${parseError}` })
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
  const mediaRefs: string[] = []
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
      case 'image': {
        if (typeof node.url === 'string' && node.url.trim() !== '') {
          mediaRefs.push(node.url.trim())
        }
        break
      }
      case 'imageReference': {
        if (node.identifier) {
          const resolved = definitions.get(node.identifier.toLowerCase())
          if (resolved) mediaRefs.push(resolved.trim())
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
            extractSourceRef(parsed, node, sourceRefs, issues, lineOffset)
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
    issues.push({ code: 'mdx-unsupported', message: 'ESM import/export statements are not allowed in MDX' })
  }
  if (hasExpr) {
    issues.push({ code: 'mdx-unsupported', message: 'JSX expressions { ... } are not allowed in MDX' })
  }
  if (unsupportedComponents.size > 0) {
    const names = [...unsupportedComponents].map((n) => `<${n}>`).join(', ')
    issues.push({ code: 'mdx-unsupported', message: `Unsupported MDX component(s): ${names}` })
  }

  return { blocks, sourceRefs, links, mediaRefs, termRefs, firstHeading, issues }
}

function parseStringAttributes(jsx: MdxJsxFlowElement | MdxJsxTextElement, issues: DocIssue[]): Record<string, string> {
  const props: Record<string, string> = {}
  for (const attr of jsx.attributes) {
    if (attr.type === 'mdxJsxExpressionAttribute') {
      issues.push({ code: 'mdx-unsupported', message: `Spread attributes {...} are not allowed on <${jsx.name}>` })
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
        message: `JSX expressions are not allowed in attribute "${a.name}" on <${jsx.name}> (use string literals)`,
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
): SemanticBlock | undefined {
  const startLine = (node.position?.start?.line ?? 1) + lineOffset
  const endLine = (node.position?.end?.line ?? node.position?.start?.line ?? 1) + lineOffset
  const rawId = props.id?.trim()

  let id: string
  if (kind === 'note' && !rawId) {
    id = `${docId}#note-${nextNoteNum()}`
  } else if (!rawId) {
    issues.push({
      code: 'missing-block-id',
      message: `<${capitalizeKind(kind)}> (L${startLine}) requires an id attribute`,
    })
    return undefined
  } else if (!BLOCK_ID_PATTERN.test(rawId)) {
    issues.push({
      code: 'invalid-block-id',
      message: `Invalid block ID: "${rawId}" (must start with a letter and contain only letters, digits, ".", "_", "-")`,
      blockId: rawId,
    })
    return undefined
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
          message: `Invalid <Note> intent: ${props.intent} (expected: idea / informative / rejected)`,
          blockId: id,
        })
      }
    } else if (isSpecIntent(props.intent)) {
      intent = props.intent
    } else {
      issues.push({
        code: 'invalid-block-attr',
        message: `Invalid <${capitalizeKind(kind)}> intent: ${props.intent} (expected: normative / idea / rejected)`,
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
        message: `Invalid stability: ${props.stability} (expected: stable / evolving / volatile)`,
        blockId: id,
      })
    }
  }

  const rawBody = extractInnerBody(node, source)
  const base = {
    id,
    docId,
    startLine,
    endLine,
    contentHash: computeContentHash(rawBody),
    rawBody,
    title: props.title?.trim() || undefined,
    stability,
    review: 'unreviewed' as const,
    suspect: false,
    suspectSources: [] as string[],
    derives: splitCsv(props.derives),
    supersedes: splitCsv(props.supersedes),
  }

  if (kind === 'note') {
    const noteIntent: NoteIntent = isNoteIntent(intent) ? intent : 'informative'
    return { ...base, kind: 'note', intent: noteIntent }
  }

  const specIntent: SpecIntent = isSpecIntent(intent) ? intent : 'normative'
  if (kind === 'constraint') {
    const scope = props.scope?.trim()
    return { ...base, kind: 'constraint', intent: specIntent, ...(scope ? { scope } : {}) }
  }
  if (kind === 'term') {
    const context = props.context?.trim()
    return {
      ...base,
      kind: 'term',
      intent: specIntent,
      aliases: splitCsv(props.aliases),
      antiTerms: splitCsv(props.antiTerms),
      ...(context ? { context } : {}),
      symbols: splitCsv(props.symbols),
    }
  }
  if (kind === 'decision') {
    const summary = props.summary?.trim() || undefined
    const date = props.date?.trim() || undefined
    const details = extractDecisionSubElements(node, source)
    return {
      ...base,
      kind: 'decision',
      intent: specIntent,
      ...(summary ? { summary } : {}),
      ...(date ? { date } : {}),
      ...(details.context ? { context: details.context } : {}),
      ...(details.chosen ? { chosen: details.chosen } : {}),
      ...(details.rejected.length > 0 ? { rejected: details.rejected } : {}),
      ...(details.tradeoff ? { tradeoff: details.tradeoff } : {}),
    }
  }
  if (kind === 'test') {
    let level: TestLevel | undefined
    if (props.level !== undefined && props.level.trim() !== '') {
      if (isTestLevel(props.level.trim())) {
        level = props.level.trim() as TestLevel
      } else {
        issues.push({
          code: 'invalid-block-attr',
          message: `Invalid <Test> level: ${props.level} (expected: unit / integration / e2e / contract / manual)`,
          blockId: id,
        })
      }
    }
    return {
      ...base,
      kind: 'test',
      intent: specIntent,
      verifies: splitCsv(props.verifies),
      ...(level ? { level } : {}),
    }
  }
  return { ...base, kind: 'spec', intent: specIntent }
}

function extractDecisionSubElements(
  node: GenericNode,
  source: string,
): {
  context?: string
  chosen?: string
  rejected: DecisionRejectedOption[]
  tradeoff?: string
} {
  let context: string | undefined
  let chosen: string | undefined
  const rejected: DecisionRejectedOption[] = []
  let tradeoff: string | undefined

  const visit = (nodes: readonly GenericNode[]) => {
    for (const child of nodes) {
      if (child.type === 'mdxJsxFlowElement' || child.type === 'mdxJsxTextElement') {
        const tag = child.name
        if (tag === 'Context' || tag === 'Chosen' || tag === 'Rejected' || tag === 'Tradeoff') {
          const text = extractInnerBody(child, source)
          if (!text) continue
          if (tag === 'Context') {
            context = context ? `${context}\n${text}` : text
          } else if (tag === 'Chosen') {
            chosen = chosen ? `${chosen}\n${text}` : text
          } else if (tag === 'Rejected') {
            const optionAttr = child.attributes?.find((a) => a.name === 'option' && typeof a.value === 'string')
            const option = typeof optionAttr?.value === 'string' ? optionAttr.value.trim() : undefined
            rejected.push({ ...(option ? { option } : {}), reason: text })
          } else if (tag === 'Tradeoff') {
            tradeoff = tradeoff ? `${tradeoff}\n${text}` : text
          }
          continue
        }
      }
      if (child.children && child.children.length > 0) {
        visit(child.children)
      }
    }
  }
  visit(node.children ?? [])
  return { context, chosen, rejected, tradeoff }
}

function extractSourceRef(
  props: Record<string, string>,
  node: GenericNode,
  out: SourceRefDecl[],
  issues: DocIssue[],
  lineOffset: number,
): void {
  const file = props.file?.trim()
  if (!file) return
  const rawMode = props.mode?.trim()
  const base = {
    file,
    satisfies: splitCsv(props.satisfies),
    verifies: splitCsv(props.verifies),
    startLine: (node.position?.start?.line ?? 1) + lineOffset,
  }
  if (rawMode !== undefined && rawMode !== '') {
    if (rawMode === 'exports') {
      out.push({ ...base, mode: 'exports' })
      return
    }
    if (rawMode !== 'snippet') {
      issues.push({
        code: 'invalid-block-attr',
        message: `Invalid <SourceRef> mode: ${rawMode} (expected: snippet / exports)`,
      })
      return
    }
  }
  const symbol = props.symbol?.trim()
  if (symbol) {
    out.push({ ...base, mode: 'symbol', symbol })
    return
  }
  const lines = props.lines?.trim()
  if (lines) {
    out.push({ ...base, mode: 'lines', lines })
    return
  }
  issues.push({
    code: 'invalid-block-attr',
    message: `<SourceRef file="${file}"> requires one of mode="exports", symbol, or lines`,
  })
}

function capitalizeKind(kind: BlockKind): string {
  switch (kind) {
    case 'spec':
      return 'Spec'
    case 'constraint':
      return 'Constraint'
    case 'decision':
      return 'Decision'
    case 'test':
      return 'Test'
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
