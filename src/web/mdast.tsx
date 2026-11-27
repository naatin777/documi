import { renderToString as renderKatexToString } from 'katex'
import type { BlockContent, DefinitionContent, List, ListItem, PhrasingContent, Root, RootContent, Table } from 'mdast'
import type { MdxJsxFlowElement, MdxJsxTextElement } from 'mdast-util-mdx'
import 'katex/dist/katex.min.css'
import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router'
import { parseMarkdownAst } from '../core/mdast-parser'
import { getMediaKind, isSafeExternalMediaUrl, resolveLocalMediaPath } from '../core/media'
import type { ChangedLineRange, DocFormat } from '../core/types'
import { encodeDocId, mediaUrl, type TermEntry } from './api'
import CodeBlock from './components/CodeBlock'
import {
  CalloutBlock,
  ColumnsBlock,
  DetailsBlock,
  StepsBlock,
  TabsBlock,
  TimelineBlock,
  type ColumnItem,
  type TabItem,
  type TimelineItemData,
} from './components/MdxBlocks'
import MermaidBlock from './components/MermaidBlock'
import { ConstraintBlock, NoteBlock, OutcomeBlock, SpecBlock, TermDefBlock } from './components/SemanticBlocks'
import SourceRef from './components/SourceRef'
import { TermInline } from './components/TermPopover'
import { uniqueHeadingId } from './headingIds'
import i18n from './i18n'

export type { DocFormat } from '../core/types'

export function parseMarkdown(body: string, format: DocFormat): Root {
  return parseMarkdownAst(body, format).tree
}

export interface RenderOptions {
  /** 現在表示中ドキュメントの親ディレクトリ (相対リンク解決用) */
  currentDir?: string
  /** Core で解決済みの本文リンク (rawPath -> targetDocId) マップ（クロスマウント相対リンク用） */
  resolvedLinks?: Readonly<Record<string, string>>
  /** Living Glossary の登録済み用語一覧 (自動リンク & ホバーポップオーバー用) */
  terms?: readonly TermEntry[]
  /** バンドル出力時に同梱されているドキュメント ID 集合 (ページ内アンカー変換用) */
  bundleDocIds?: ReadonlySet<string>
  /** バンドル出力時に見出し ID 衝突を防ぐためのプレフィックス */
  headingPrefix?: string
  /** true のとき <Tabs> を全タブ縦展開する (印刷・PDF バンドル用) */
  expandAllTabs?: boolean
  /** 最新変更箇所ハイライト対象の本文基準行レンジ一覧 */
  changedRanges?: readonly ChangedLineRange[]
}

export function bundleDocAnchor(docId: string): string {
  return `doc-${docId.replace(/[^a-zA-Z0-9_-]+/g, '-')}`
}

interface TermMatcher {
  byKey: Map<string, TermEntry>
  regex: RegExp
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildTermMatcher(terms?: readonly TermEntry[]): TermMatcher | undefined {
  if (!terms || terms.length === 0) return undefined
  const byKey = new Map<string, TermEntry>()
  const names: string[] = []
  for (const term of terms) {
    for (const candidate of [term.id, ...term.aliases]) {
      const trimmed = candidate.trim()
      if (trimmed.length < 2) continue
      const key = trimmed.toLowerCase()
      if (!byKey.has(key)) {
        byKey.set(key, term)
        names.push(trimmed)
      }
    }
  }
  if (names.length === 0) return undefined
  // 長い語を優先マッチさせる
  names.sort((a, b) => b.length - a.length)
  const parts = names.map((n) => {
    const escaped = escapeRegExp(n)
    // ASCII のみの用語は単語境界で部分一致の誤爆を防ぐ
    return /^[A-Za-z0-9._-]+$/.test(n) ? `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])` : escaped
  })
  return { byKey, regex: new RegExp(`(${parts.join('|')})`, 'g') }
}

interface Ctx {
  definitions: Map<string, { url: string; title?: string | null }>
  /** 同じ id を持つ見出しが複数出ないようにする (Outline 側と同じ採番) */
  headingIds: Set<string>
  currentDir: string
  resolvedLinks?: Readonly<Record<string, string>>
  termMatcher?: TermMatcher
  /** 見出し・リンク・TermDef 内部など自動リンクを抑制する領域 */
  suppressAutoLink: boolean
  bundleDocIds?: ReadonlySet<string>
  headingPrefix?: string
  expandAllTabs: boolean
  changedRanges?: readonly ChangedLineRange[]
}

function matchChangedKind(
  startLine: number | undefined,
  endLine: number | undefined,
  ranges?: readonly ChangedLineRange[],
): ChangedLineRange['kind'] | null {
  if (!ranges || ranges.length === 0 || startLine === undefined) return null
  const end = endLine ?? startLine
  let matched: ChangedLineRange['kind'] | null = null
  for (const r of ranges) {
    if (r.startLine <= end && r.endLine >= startLine) {
      if (r.kind === 'added') return 'added'
      matched = 'modified'
    }
  }
  return matched
}

/** Markdown / MDX 本文を React ノードへ変換する。JSX は許可リストのみ描画する。 */
export function renderMarkdown(root: Root, options: RenderOptions = {}): ReactNode {
  const definitions = new Map<string, { url: string; title?: string | null }>()
  for (const child of root.children) {
    if (child.type === 'definition') {
      definitions.set(child.identifier, { url: child.url, title: child.title })
    }
  }
  const ctx: Ctx = {
    definitions,
    headingIds: new Set(),
    currentDir: options.currentDir ?? '',
    resolvedLinks: options.resolvedLinks,
    termMatcher: buildTermMatcher(options.terms),
    suppressAutoLink: false,
    bundleDocIds: options.bundleDocIds,
    headingPrefix: options.headingPrefix,
    expandAllTabs: options.expandAllTabs === true,
    changedRanges: options.changedRanges,
  }
  return renderTopLevelBlocks(root.children, ctx)
}

export type AnyNode =
  | RootContent
  | BlockContent
  | PhrasingContent
  | DefinitionContent
  | MdxJsxFlowElement
  | MdxJsxTextElement

function renderTopLevelBlocks(nodes: readonly AnyNode[], ctx: Ctx): ReactNode {
  if (!ctx.changedRanges || ctx.changedRanges.length === 0) {
    return renderBlocks(nodes, ctx)
  }
  return nodes.map((node, i) => {
    const rendered = renderBlock(node, ctx)
    if (rendered === null || rendered === undefined) return <Fragment key={i} />
    const kind = matchChangedKind(node.position?.start.line, node.position?.end.line, ctx.changedRanges)
    if (!kind) return <Fragment key={i}>{rendered}</Fragment>
    return (
      <div key={i} className="md-changed-block" data-change-kind={kind}>
        {rendered}
      </div>
    )
  })
}

function renderBlocks(nodes: readonly AnyNode[], ctx: Ctx): ReactNode {
  return nodes.map((node, i) => <Fragment key={i}>{renderBlock(node, ctx)}</Fragment>)
}

function renderInlines(nodes: readonly AnyNode[], ctx: Ctx): ReactNode {
  return nodes.map((node, i) => <Fragment key={i}>{renderInline(node, ctx)}</Fragment>)
}

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

function renderBlock(node: AnyNode, ctx: Ctx): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p>{renderInlines(node.children, ctx)}</p>
    case 'heading': {
      const Tag = HEADING_TAGS[node.depth - 1] ?? 'h6'
      const rawId = uniqueHeadingId(textOfMdast(node.children), ctx.headingIds)
      const id = ctx.headingPrefix ? `${ctx.headingPrefix}-${rawId}` : rawId
      return <Tag id={id}>{renderInlines(node.children, { ...ctx, suppressAutoLink: true })}</Tag>
    }
    case 'blockquote':
      return <blockquote>{renderBlocks(node.children, ctx)}</blockquote>
    case 'list':
      return renderList(node, ctx)
    case 'code': {
      const lang = (node.lang ?? '').trim()
      if (lang.toLowerCase() === 'mermaid') return <MermaidBlock code={node.value} />
      return <CodeBlock code={node.value} lang={lang || null} />
    }
    case 'math':
      return <div className="katex-block" dangerouslySetInnerHTML={{ __html: renderKatex(node.value, true) }} />
    case 'thematicBreak':
      return <hr />
    case 'table':
      return renderTable(node, ctx)
    case 'html':
      // 生 HTML は実行せずソースをそのまま表示する
      return <pre className="md-raw">{node.value}</pre>
    case 'footnoteDefinition':
      return renderFootnoteDefinition(node, ctx)
    case 'mdxJsxFlowElement':
      return renderJsx(node, ctx, 'flow')
    case 'mdxFlowExpression':
      return <MdxError message={i18n.t('mdx.expressionUnsupported')} source={node.value} />
    case 'mdxjsEsm':
      return <MdxError message={i18n.t('mdx.esmUnsupported')} source={node.value} />
    case 'definition':
      return null
    default:
      return <MdxError message={i18n.t('mdx.syntaxUnsupported', { type: node.type })} />
  }
}

function renderAutoLinkedText(text: string, matcher: TermMatcher): ReactNode {
  matcher.regex.lastIndex = 0
  const out: ReactNode[] = []
  let lastIdx = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = matcher.regex.exec(text)) !== null) {
    const matched = match[0]
    const idx = match.index
    if (idx > lastIdx) out.push(text.slice(lastIdx, idx))
    const term = matcher.byKey.get(matched.toLowerCase())
    if (term) {
      out.push(
        <TermInline key={key++} name={term.id} term={term}>
          {matched}
        </TermInline>,
      )
    } else {
      out.push(matched)
    }
    lastIdx = idx + matched.length
  }
  if (lastIdx === 0) return text
  if (lastIdx < text.length) out.push(text.slice(lastIdx))
  return out
}

function renderInline(node: AnyNode, ctx: Ctx): ReactNode {
  switch (node.type) {
    case 'text':
      if (!ctx.suppressAutoLink && ctx.termMatcher) {
        return renderAutoLinkedText(node.value, ctx.termMatcher)
      }
      return node.value
    case 'emphasis':
      return <em>{renderInlines(node.children, ctx)}</em>
    case 'strong':
      return <strong>{renderInlines(node.children, ctx)}</strong>
    case 'delete':
      return <del>{renderInlines(node.children, ctx)}</del>
    case 'inlineCode':
      return <code>{node.value}</code>
    case 'inlineMath':
      return <span className="katex-inline" dangerouslySetInnerHTML={{ __html: renderKatex(node.value, false) }} />
    case 'break':
      return <br />
    case 'link':
      return renderLink(node.url, node.title, node.children, ctx)
    case 'linkReference': {
      const def = ctx.definitions.get(node.identifier)
      if (!def) return <span className="md-broken-ref">{renderInlines(node.children, ctx)}</span>
      return renderLink(def.url, def.title ?? node.label, node.children, ctx)
    }
    case 'image':
      return renderMedia(node.url, node.alt, node.title, ctx)
    case 'imageReference': {
      const def = ctx.definitions.get(node.identifier)
      if (!def) return <span className="md-broken-ref">{node.alt || node.label || node.identifier}</span>
      return renderMedia(def.url, node.alt, def.title, ctx)
    }
    case 'footnoteReference':
      return (
        <sup className="footnote-ref">
          <a href={`#fn-${node.identifier}`} id={`fnref-${node.identifier}`}>
            [{node.label ?? node.identifier}]
          </a>
        </sup>
      )
    case 'html':
      return node.value
    case 'mdxJsxTextElement':
      return renderJsx(node, ctx, 'text')
    case 'mdxTextExpression':
      return (
        <code className="mdx-error-inline" title={i18n.t('mdx.inlineExpressionUnsupported')}>
          {`{${node.value}}`}
        </code>
      )
    default:
      return null
  }
}

function renderMedia(
  rawUrl: string,
  alt: string | null | undefined,
  title: string | null | undefined,
  ctx: Ctx,
): ReactNode {
  const resolved = resolveLocalMediaPath(rawUrl, ctx.currentDir ?? '')
  let src: string | undefined
  if (resolved.ok) {
    src = mediaUrl(resolved.relPath)
  } else if (resolved.reason === 'external' && isSafeExternalMediaUrl(rawUrl)) {
    src = rawUrl.trim()
  }
  if (!src) {
    return <span className="md-broken-ref">{alt || rawUrl}</span>
  }

  const kind = getMediaKind(rawUrl)
  if (kind === 'video') {
    return (
      <video
        className="md-media md-video"
        src={src}
        controls
        playsInline
        preload="metadata"
        title={title ?? undefined}
        aria-label={alt || undefined}
      >
        <track kind="captions" />
      </video>
    )
  }
  if (kind === 'audio') {
    return (
      <audio
        className="md-media md-audio"
        src={src}
        controls
        preload="metadata"
        title={title ?? undefined}
        aria-label={alt || undefined}
      >
        <track kind="captions" />
      </audio>
    )
  }
  return <img className="md-media md-image" src={src} alt={alt ?? ''} title={title ?? undefined} loading="lazy" />
}

function renderLink(url: string, title: string | null | undefined, children: readonly AnyNode[], ctx: Ctx): ReactNode {
  const inner = renderInlines(children, { ...ctx, suppressAutoLink: true })
  const resolved = resolveInternalTarget(url, ctx.currentDir, ctx.resolvedLinks)
  if (resolved) {
    if (ctx.bundleDocIds?.has(resolved.docId)) {
      const anchor = resolved.hash ? `#${resolved.hash}` : `#${bundleDocAnchor(resolved.docId)}`
      return (
        <a href={anchor} title={title ?? undefined}>
          {inner}
        </a>
      )
    }
    const suffix = resolved.hash ? `#${resolved.hash}` : ''
    return <Link to={`/docs/${encodeDocId(resolved.docId)}${suffix}`}>{inner}</Link>
  }
  if (!isSafeHref(url)) return <span className="md-broken-ref">{inner}</span>
  if (url.trim().startsWith('#')) {
    return (
      <a href={url} title={title ?? undefined}>
        {inner}
      </a>
    )
  }
  return (
    <a href={url} title={title ?? undefined} target="_blank" rel="noreferrer">
      {inner}
    </a>
  )
}

/** リンク先のスキームを制限する (相対パス・アンカーは許可) */
function isSafeHref(href: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href.trim())?.[1]
  if (!scheme) return true
  return ['http', 'https', 'mailto', 'tel'].includes(scheme.toLowerCase())
}

function normalizePosix(dir: string, rel: string): string {
  const baseParts = dir ? dir.split('/').filter(Boolean) : []
  const relParts = rel.split('/')
  const out = [...baseParts]
  for (const part of relParts) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

function resolveInternalTarget(
  href: string,
  currentDir: string,
  resolvedLinks?: Readonly<Record<string, string>>,
): { docId: string; hash?: string } | null {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#')) return null

  const [rawPath, hash] = trimmed.split('#')
  if (!rawPath) return null

  // Core が解決済みのリンク（クロスマウント相対パス等）を最優先
  const coreDocId = resolvedLinks?.[rawPath]
  if (coreDocId) return { docId: coreDocId, hash }

  // doc:<docId> 明示スキーム（複数マウント間のクロスリンク等）
  if (rawPath.startsWith('doc:')) {
    const docId = rawPath
      .slice(4)
      .replace(/^\/+/, '')
      .replace(/\.(mdx|md)$/i, '')
    return docId && !docId.includes('..') ? { docId, hash } : null
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null

  if (rawPath.startsWith('/docs/')) {
    const docId = rawPath.slice('/docs/'.length).replace(/\.(mdx|md)$/i, '')
    return docId ? { docId, hash } : null
  }

  if (rawPath.startsWith('./') || rawPath.startsWith('../') || /\.(mdx|md)$/i.test(rawPath)) {
    const docId = normalizePosix(currentDir, rawPath).replace(/\.(mdx|md)$/i, '')
    return docId ? { docId, hash } : null
  }

  return null
}

function renderList(node: List, ctx: Ctx): ReactNode {
  const tight = node.spread !== true
  const items = node.children.map((item: ListItem, i: number) => <li key={i}>{renderListItem(item, tight, ctx)}</li>)
  return node.ordered ? <ol start={node.start ?? undefined}>{items}</ol> : <ul>{items}</ul>
}

function renderListItem(item: ListItem, tight: boolean, ctx: Ctx): ReactNode {
  return item.children.map((child, i) => {
    if (tight && child.type === 'paragraph') {
      return <Fragment key={i}>{renderInlines(child.children, ctx)}</Fragment>
    }
    return <Fragment key={i}>{renderBlock(child, ctx)}</Fragment>
  })
}

function renderTable(node: Table, ctx: Ctx): ReactNode {
  const [head, ...body] = node.children
  const alignOf = (i: number) => node.align?.[i] ?? undefined
  return (
    <table>
      {head && (
        <thead>
          <tr>
            {head.children.map((cell, i) => (
              <th key={i} style={alignOf(i) ? { textAlign: alignOf(i)! } : undefined}>
                {renderInlines(cell.children, ctx)}
              </th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {body.map((row, i) => (
          <tr key={i}>
            {row.children.map((cell, j) => (
              <td key={j} style={alignOf(j) ? { textAlign: alignOf(j)! } : undefined}>
                {renderInlines(cell.children, ctx)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function renderFootnoteDefinition(node: Extract<AnyNode, { type: 'footnoteDefinition' }>, ctx: Ctx): ReactNode {
  return (
    <div className="footnote-def" id={`fn-${node.identifier}`}>
      {renderBlocks(node.children, ctx)}
      <a className="footnote-backref" href={`#fnref-${node.identifier}`} aria-label={i18n.t('mdx.backToFootnote')}>
        ↩
      </a>
    </div>
  )
}

/* ---------- MDX JSX (ホワイトリスト) ---------- */

type JsxNode = MdxJsxFlowElement | MdxJsxTextElement
type JsxProps = Record<string, string | boolean>

type ParsedProps = { ok: true; props: JsxProps } | { ok: false; error: string }

function parseJsxProps(node: JsxNode): ParsedProps {
  const props: JsxProps = {}
  for (const attr of node.attributes) {
    if (attr.type === 'mdxJsxExpressionAttribute') {
      return { ok: false, error: i18n.t('mdx.spreadUnsupported') }
    }
    const a = attr
    if (a.value == null) {
      props[a.name] = true
    } else if (typeof a.value === 'string') {
      props[a.name] = a.value
    } else {
      return { ok: false, error: i18n.t('mdx.attrExpressionUnsupported', { name: a.name }) }
    }
  }
  return { ok: true, props }
}

const FLOW_COMPONENTS = new Set([
  'Callout',
  'Tabs',
  'Steps',
  'Details',
  'Columns',
  'Timeline',
  'SourceRef',
  'Spec',
  'Constraint',
  'Outcome',
  'Note',
  'TermDef',
  'Term',
])
const TAB_ITEM_COMPONENTS = new Set(['Tabs.Tab', 'Tab'])
const STEP_ITEM_COMPONENTS = new Set(['Steps.Step', 'Step'])
const COLUMN_ITEM_COMPONENTS = new Set(['Column'])
const TIMELINE_ITEM_COMPONENTS = new Set(['Timeline.Item', 'TimelineItem'])
const ITEM_COMPONENTS = new Set([
  ...TAB_ITEM_COMPONENTS,
  ...STEP_ITEM_COMPONENTS,
  ...COLUMN_ITEM_COMPONENTS,
  ...TIMELINE_ITEM_COMPONENTS,
])

function renderJsx(node: JsxNode, ctx: Ctx, level: 'flow' | 'text'): ReactNode {
  const name = node.name
  if (name === null) {
    return level === 'flow' ? renderBlocks(node.children, ctx) : renderInlines(node.children, ctx)
  }

  const parsed = parseJsxProps(node)
  if (!parsed.ok) {
    return <MdxError message={parsed.error} source={`<${name} ...>`} />
  }
  const props = parsed.props

  if (FLOW_COMPONENTS.has(name)) {
    switch (name) {
      case 'Callout':
        return (
          <CalloutBlock type={strProp(props, 'type')} title={strProp(props, 'title')}>
            {renderJsxChildren(node, ctx)}
          </CalloutBlock>
        )
      case 'Tabs':
        return renderTabs(node, ctx)
      case 'Steps':
        return renderSteps(node, ctx)
      case 'Details':
        return (
          <DetailsBlock
            title={strProp(props, 'title') ?? strProp(props, 'summary') ?? 'Details'}
            defaultOpen={Boolean(props.open) || ctx.expandAllTabs}
          >
            {renderJsxChildren(node, ctx)}
          </DetailsBlock>
        )
      case 'Columns':
        return renderColumns(node, ctx)
      case 'Timeline':
        return renderTimeline(node, ctx)
      case 'SourceRef':
        return (
          <SourceRef
            file={strProp(props, 'file')}
            symbol={strProp(props, 'symbol')}
            lines={strProp(props, 'lines')}
            mode={strProp(props, 'mode')}
            satisfies={strProp(props, 'satisfies')}
            verifies={strProp(props, 'verifies')}
          />
        )
      case 'Spec':
        return (
          <SpecBlock
            id={strProp(props, 'id')}
            intent={strProp(props, 'intent')}
            stability={strProp(props, 'stability')}
            derives={strProp(props, 'derives')}
            title={strProp(props, 'title')}
          >
            {renderJsxChildren(node, ctx)}
          </SpecBlock>
        )
      case 'Constraint':
        return (
          <ConstraintBlock
            id={strProp(props, 'id')}
            scope={strProp(props, 'scope')}
            stability={strProp(props, 'stability')}
            title={strProp(props, 'title')}
          >
            {renderJsxChildren(node, ctx)}
          </ConstraintBlock>
        )
      case 'Outcome':
        return (
          <OutcomeBlock
            id={strProp(props, 'id')}
            supersedes={strProp(props, 'supersedes')}
            stability={strProp(props, 'stability')}
            title={strProp(props, 'title')}
          >
            {renderJsxChildren(node, ctx)}
          </OutcomeBlock>
        )
      case 'Note':
        return (
          <NoteBlock intent={strProp(props, 'intent')} title={strProp(props, 'title')}>
            {renderJsxChildren(node, ctx)}
          </NoteBlock>
        )
      case 'TermDef':
        return (
          <TermDefBlock
            id={strProp(props, 'id')}
            aliases={strProp(props, 'aliases')}
            symbols={strProp(props, 'symbols')}
          >
            {renderJsxChildren(node, { ...ctx, suppressAutoLink: true })}
          </TermDefBlock>
        )
      case 'Term': {
        const termName = strProp(props, 'name')
        const term = termName ? ctx.termMatcher?.byKey.get(termName.toLowerCase()) : undefined
        const hasChildren = node.children.length > 0
        return (
          <TermInline name={termName} term={term}>
            {hasChildren ? renderJsxChildren(node, { ...ctx, suppressAutoLink: true }) : undefined}
          </TermInline>
        )
      }
    }
  }

  if (ITEM_COMPONENTS.has(name)) {
    return <MdxError message={i18n.t('mdx.parentRequired', { name })} source={`<${name}>`} />
  }

  return <MdxError message={i18n.t('mdx.componentUnsupported', { name })} source={`<${name} ...>`} />
}

function strProp(props: JsxProps, key: string): string | undefined {
  const v = props[key]
  return typeof v === 'string' ? v : undefined
}

/** コンテナ要素の子孫から指定名の JSX 要素だけを集める (paragraph 等で包まれていても拾う) */
function collectJsxItems(node: JsxNode, names: ReadonlySet<string>): JsxNode[] {
  const found: JsxNode[] = []
  const walk = (n: { type: string; name?: string | null; children?: unknown[] }) => {
    if ((n.type === 'mdxJsxFlowElement' || n.type === 'mdxJsxTextElement') && n.name && names.has(n.name)) {
      found.push(n as JsxNode)
      return
    }
    for (const c of n.children ?? []) walk(c as { type: string; name?: string | null; children?: unknown[] })
  }
  for (const c of node.children) walk(c)
  return found
}

/** JSX 要素の子を、単一段落なら inline、それ以外は block として描画する */
function renderJsxChildren(node: JsxNode, ctx: Ctx): ReactNode {
  const children = node.children as AnyNode[]
  if (children.length === 1 && children[0]!.type === 'paragraph') {
    return renderInlines((children[0] as { children: AnyNode[] }).children, ctx)
  }
  if (children.every((c) => isPhrasing(c))) {
    return renderInlines(children, ctx)
  }
  return renderBlocks(children, ctx)
}

function isPhrasing(node: AnyNode): boolean {
  return (
    node.type === 'text' ||
    node.type === 'emphasis' ||
    node.type === 'strong' ||
    node.type === 'delete' ||
    node.type === 'inlineCode' ||
    node.type === 'break' ||
    node.type === 'link' ||
    node.type === 'linkReference' ||
    node.type === 'image' ||
    node.type === 'imageReference' ||
    node.type === 'footnoteReference' ||
    node.type === 'html' ||
    node.type === 'mdxJsxTextElement' ||
    node.type === 'mdxTextExpression'
  )
}

function renderTabs(node: JsxNode, ctx: Ctx): ReactNode {
  const items = collectJsxItems(node, TAB_ITEM_COMPONENTS).map((tab, i) => {
    const parsed = parseJsxProps(tab)
    if (!parsed.ok) {
      return {
        label: i18n.t('mdx.errorIndexed', { index: i + 1 }),
        content: <MdxError message={parsed.error} />,
        key: i,
      }
    }
    const props = parsed.props
    const label = strProp(props, 'label') ?? strProp(props, 'title') ?? i18n.t('mdx.tabIndexed', { index: i + 1 })
    return { label, content: renderJsxChildren(tab, ctx), key: i }
  })
  if (items.length === 0) {
    return <MdxError message={i18n.t('mdx.tabsRequireTab')} source="<Tabs>" />
  }
  const tabs: TabItem[] = items.map((it) => ({ label: it.label, content: it.content }))
  return <TabsBlock tabs={tabs} expandAll={ctx.expandAllTabs} />
}

function renderSteps(node: JsxNode, ctx: Ctx): ReactNode {
  const items = collectJsxItems(node, STEP_ITEM_COMPONENTS).map((step, i) => {
    const parsed = parseJsxProps(step)
    if (!parsed.ok) {
      return { title: i18n.t('mdx.errorIndexed', { index: i + 1 }), content: <MdxError message={parsed.error} /> }
    }
    const props = parsed.props
    const title = strProp(props, 'title') ?? strProp(props, 'label') ?? i18n.t('mdx.stepIndexed', { index: i + 1 })
    return { title, content: renderJsxChildren(step, ctx) }
  })
  if (items.length === 0) {
    return <MdxError message={i18n.t('mdx.stepsRequireStep')} source="<Steps>" />
  }
  return <StepsBlock steps={items} />
}

function renderColumns(node: JsxNode, ctx: Ctx): ReactNode {
  const items: ColumnItem[] = collectJsxItems(node, COLUMN_ITEM_COMPONENTS).map((col) => {
    const parsed = parseJsxProps(col)
    if (!parsed.ok) {
      return { content: <MdxError message={parsed.error} /> }
    }
    return {
      title: strProp(parsed.props, 'title'),
      content: renderJsxChildren(col, ctx),
    }
  })
  if (items.length === 0) {
    return <MdxError message="<Columns> requires one or more <Column> children" source="<Columns>" />
  }
  return <ColumnsBlock columns={items} />
}

function renderTimeline(node: JsxNode, ctx: Ctx): ReactNode {
  const items: TimelineItemData[] = collectJsxItems(node, TIMELINE_ITEM_COMPONENTS).map((item, i) => {
    const parsed = parseJsxProps(item)
    if (!parsed.ok) {
      return { title: i18n.t('mdx.errorIndexed', { index: i + 1 }), content: <MdxError message={parsed.error} /> }
    }
    const title = strProp(parsed.props, 'title') ?? strProp(parsed.props, 'label') ?? `#${i + 1}`
    return {
      title,
      date: strProp(parsed.props, 'date'),
      content: renderJsxChildren(item, ctx),
    }
  })
  if (items.length === 0) {
    return <MdxError message="<Timeline> requires one or more <Timeline.Item> children" source="<Timeline>" />
  }
  return <TimelineBlock items={items} />
}

/* ---------- 補助 ---------- */

function renderKatex(tex: string, displayMode: boolean): string {
  try {
    return renderKatexToString(tex, { displayMode, throwOnError: false, strict: 'ignore' })
  } catch {
    return tex
  }
}

function MdxError({ message, source }: { message: string; source?: string }) {
  return (
    <div className="mdx-error">
      {source && <code className="mdx-error-src">{source}</code>}
      <span>{message}</span>
    </div>
  )
}

/** mdast ノードからプレーンテキストを再帰的に取り出す (見出しスラッグ・Outline 用) */
export function textOfMdast(nodes: readonly AnyNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
        case 'inlineCode':
          return node.value
        case 'image':
        case 'imageReference':
          return ''
        case 'break':
          return ' '
        case 'footnoteReference':
          return node.label ?? ''
        case 'emphasis':
        case 'strong':
        case 'delete':
        case 'link':
        case 'linkReference':
        case 'mdxJsxFlowElement':
        case 'mdxJsxTextElement':
          return textOfMdast(node.children)
        default:
          return ''
      }
    })
    .join('')
}
