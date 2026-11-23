import type { DocFormat } from '../core/types'
import { uniqueHeadingId, type Heading } from './headingIds'
import { parseMarkdown, textOfMdast, type AnyNode } from './mdast'

export type { Heading } from './headingIds'

/**
 * 本文を mdast として解析し、見出しを抽出する。
 * 本文レンダラと同じノード・同じ採番を使うため、Outline のリンク先 id が必ず一致する。
 */
export function extractHeadings(body: string, format: DocFormat = 'markdown'): Heading[] {
  const root = parseMarkdown(body, format)
  const headings: Heading[] = []
  const seen = new Set<string>()

  const walk = (nodes: readonly AnyNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'heading') {
        const text = textOfMdast(node.children)
        const line = node.position?.start.line
        headings.push({
          level: node.depth,
          text,
          id: uniqueHeadingId(text, seen),
          ...(line !== undefined ? { line } : {}),
        })
      }
      if ('children' in node && Array.isArray(node.children)) {
        walk(node.children)
      }
    }
  }
  walk(root.children)

  // 各見出しのセクション範囲（次の同レベル以上の見出しの直前行まで）を算出する
  for (let i = 0; i < headings.length; i++) {
    const current = headings[i]
    if (!current || current.line === undefined) continue
    let endLine = Number.MAX_SAFE_INTEGER
    for (let j = i + 1; j < headings.length; j++) {
      const next = headings[j]
      if (next && next.level <= current.level && next.line !== undefined) {
        endLine = Math.max(current.line, next.line - 1)
        break
      }
    }
    current.sectionEndLine = endLine
  }
  return headings
}
