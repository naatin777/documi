import type { Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkMdx from 'remark-mdx'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { DocFormat } from './types'

/**
 * Documi が許可する MDX コンポーネント一覧。
 * サーバー側 AST 抽出 (`src/core/mdx.ts`) とブラウザ描画 (`src/web/mdast.tsx`) の双方で共有する。
 * NOTE: ブラウザバンドルから安全に import できるよう `node:*` 依存を持たない。
 */
export const ALLOWED_MDX_COMPONENTS: ReadonlySet<string> = new Set([
  // リッチ・視覚表現
  'Callout',
  'Tabs',
  'Tabs.Tab',
  'Tab',
  'Steps',
  'Steps.Step',
  'Step',
  'Details',
  'Columns',
  'Column',
  'Timeline',
  'Timeline.Item',
  'TimelineItem',
  'SourceRef',
  // セマンティックタグ
  'Spec',
  'Constraint',
  'Decision',
  'Context',
  'Chosen',
  'Rejected',
  'Tradeoff',
  'Test',
  'Note',
  'TermDef',
  'Term',
  'Signal',
])

const mdProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
const mdxProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkMdx)

/**
 * Markdown / MDX 本文を mdast AST へパースする。
 * MDX 構文エラー時は Markdown としてフォールバックし、エラーメッセージを返す。
 */
export function parseMarkdownAst(body: string, format: DocFormat): { tree: Root; parseError?: string } {
  if (format === 'mdx') {
    try {
      return { tree: mdxProcessor.parse(body) }
    } catch (error) {
      const parseError = error instanceof Error ? error.message : String(error)
      return { tree: mdProcessor.parse(body), parseError }
    }
  }
  return { tree: mdProcessor.parse(body) }
}
