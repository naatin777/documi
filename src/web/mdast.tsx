import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkMdx from 'remark-mdx'
import type {
  BlockContent,
  DefinitionContent,
  List,
  ListItem,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from 'mdast'
import type {
  MdxJsxAttribute,
  MdxJsxFlowElement,
  MdxJsxTextElement,
} from 'mdast-util-mdx'
import type { DocFormat } from '../core/types'
import { uniqueHeadingId } from './headingIds'
import CodeBlock from './components/CodeBlock'
import MermaidBlock from './components/MermaidBlock'
import { CalloutBlock, StepsBlock, TabsBlock, type TabItem } from './components/MdxBlocks'
import SourceRef from './components/SourceRef'

export type { DocFormat } from '../core/types'

const processors = {
  markdown: unified().use(remarkParse).use(remarkGfm).use(remarkMath),
  mdx: unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkMdx),
} as const

export function parseMarkdown(body: string, format: DocFormat): Root {
  return processors[format].parse(body) as Root
}

interface Ctx {
  definitions: Map<string, { url: string; title?: string | null }>
  /** 同じ id を持つ見出しが複数出ないようにする (Outline 側と同じ採番) */
  headingIds: Set<string>
}

/** Markdown / MDX 本文を React ノードへ変換する。JSX は許可リストのみ描画する。 */
export function renderMarkdown(root: Root): ReactNode {
  const definitions = new Map<string, { url: string; title?: string | null }>()
  for (const child of root.children) {
    if (child.type === 'definition') {
      definitions.set(child.identifier, { url: child.url, title: child.title })
    }
  }
  const ctx: Ctx = { definitions, headingIds: new Set() }
  return renderBlocks(root.children, ctx)
}

export type AnyNode = RootContent | BlockContent | PhrasingContent | DefinitionContent | MdxJsxFlowElement | MdxJsxTextElement

function renderBlocks(nodes: readonly AnyNode[], ctx: Ctx): ReactNode {
  return nodes.map((node, i) => <Fragment key={i}>{renderBlock(node, ctx)}</Fragment>)
}

function renderInlines(nodes: readonly AnyNode[], ctx: Ctx): ReactNode {
  return nodes.map((node, i) => <Fragment key={i}>{renderInline(node, ctx)}</Fragment>)
}

function renderBlock(node: AnyNode, ctx: Ctx): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p>{renderInlines(node.children, ctx)}</p>
    case 'heading': {
      const Tag = `h${node.depth}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      const id = uniqueHeadingId(textOfMdast(node.children), ctx.headingIds)
      return (
        <Tag id={id}>{renderInlines(node.children, ctx)}</Tag>
      )
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
      return <MdxError message="式 { ... } は未対応です" source={node.value} />
    case 'mdxjsEsm':
      return <MdxError message="import / export 文は未対応です" source={node.value} />
    case 'definition':
      return null
    default:
      return <MdxError message={`未対応の構文です: ${node.type}`} />
  }
}

function renderInline(node: AnyNode, ctx: Ctx): ReactNode {
  switch (node.type) {
    case 'text':
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
      return <img src={node.url} alt={node.alt ?? ''} title={node.title ?? undefined} />
    case 'imageReference': {
      const def = ctx.definitions.get(node.identifier)
      if (!def) return null
      return <img src={def.url} alt={node.alt ?? ''} title={def.title ?? undefined} />
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
      return <code className="mdx-error-inline" title="式は未対応です">{`{${node.value}}`}</code>
    default:
      return null
  }
}

function renderLink(url: string, title: string | null | undefined, children: readonly AnyNode[], ctx: Ctx): ReactNode {
  const inner = renderInlines(children, ctx)
  const to = resolveInternalHref(url)
  if (to) return <Link to={to}>{inner}</Link>
  return (
    <a href={url} title={title ?? undefined} target="_blank" rel="noreferrer">
      {inner}
    </a>
  )
}

function resolveInternalHref(href: string): string | null {
  const page = /^\/pages\/([a-z]+)\/(\d{5})(?:[/?#]|$)/.exec(href)
  if (page) return `/pages/${page[1]}/${page[2]}`
  const ref = /^([a-z]+):(\d{5})$/.exec(href)
  if (ref) return `/pages/${ref[1]}/${ref[2]}`
  return null
}

function renderList(node: List, ctx: Ctx): ReactNode {
  const tight = node.spread !== true
  const items = node.children.map((item: ListItem, i: number) => (
    <li key={i}>{renderListItem(item, tight, ctx)}</li>
  ))
  return node.ordered ? (
    <ol start={node.start ?? undefined}>{items}</ol>
  ) : (
    <ul>{items}</ul>
  )
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
      <a className="footnote-backref" href={`#fnref-${node.identifier}`} aria-label="脚注に戻る">
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
      return { ok: false, error: 'スプレッド属性 {...} は未対応です' }
    }
    const a = attr as MdxJsxAttribute
    if (a.value == null) {
      props[a.name] = true
    } else if (typeof a.value === 'string') {
      props[a.name] = a.value
    } else {
      return { ok: false, error: `属性 ${a.name} の式は未対応です` }
    }
  }
  return { ok: true, props }
}

const FLOW_COMPONENTS = new Set(['Callout', 'Tabs', 'Steps', 'SourceRef'])
const ITEM_COMPONENTS = new Set(['Tabs.Tab', 'Tab', 'Steps.Step', 'Step'])

function renderJsx(node: JsxNode, ctx: Ctx, level: 'flow' | 'text'): ReactNode {
  const name = node.name
  if (name === null) {
    // フラグメントは子要素をそのまま描画する
    return level === 'flow'
      ? renderBlocks(node.children as AnyNode[], ctx)
      : renderInlines(node.children as AnyNode[], ctx)
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
          <CalloutBlock
            type={strProp(props, 'type')}
            title={strProp(props, 'title')}
          >
            {renderJsxChildren(node, ctx)}
          </CalloutBlock>
        )
      case 'Tabs':
        return renderTabs(node, ctx)
      case 'Steps':
        return renderSteps(node, ctx)
      case 'SourceRef':
        return (
          <SourceRef
            file={strProp(props, 'file')}
            symbol={strProp(props, 'symbol')}
            lines={strProp(props, 'lines')}
          />
        )
    }
  }

  if (ITEM_COMPONENTS.has(name)) {
    return <MdxError message={`<${name}> は対応する親コンポーネントの中でのみ使えます`} source={`<${name}>`} />
  }

  return <MdxError message={`未対応のコンポーネントです: <${name}>`} source={`<${name} ...>`} />
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
  for (const c of node.children) walk(c as { type: string; name?: string | null; children?: unknown[] })
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
  const items = collectJsxItems(node, ITEM_COMPONENTS).map((tab, i) => {
    const parsed = parseJsxProps(tab)
    if (!parsed.ok) {
      return { label: `エラー ${i + 1}`, content: <MdxError message={parsed.error} />, key: i }
    }
    const props = parsed.props
    const label = strProp(props, 'label') ?? strProp(props, 'title') ?? `タブ ${i + 1}`
    return { label, content: renderJsxChildren(tab, ctx), key: i }
  })
  if (items.length === 0) {
    return <MdxError message="<Tabs> には <Tabs.Tab> が必要です" source="<Tabs>" />
  }
  const tabs: TabItem[] = items.map((it) => ({ label: it.label, content: it.content }))
  return <TabsBlock tabs={tabs} />
}

function renderSteps(node: JsxNode, ctx: Ctx): ReactNode {
  const items = collectJsxItems(node, ITEM_COMPONENTS).map((step, i) => {
    const parsed = parseJsxProps(step)
    if (!parsed.ok) {
      return { title: `エラー ${i + 1}`, content: <MdxError message={parsed.error} /> }
    }
    const props = parsed.props
    const title = strProp(props, 'title') ?? strProp(props, 'label') ?? `ステップ ${i + 1}`
    return { title, content: renderJsxChildren(step, ctx) }
  })
  if (items.length === 0) {
    return <MdxError message="<Steps> には <Steps.Step> が必要です" source="<Steps>" />
  }
  return <StepsBlock steps={items} />
}

/* ---------- 補助 ---------- */

function renderKatex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false, strict: 'ignore' })
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
          return textOfMdast(node.children as AnyNode[])
        default:
          return ''
      }
    })
    .join('')
}
