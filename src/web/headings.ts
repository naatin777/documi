import { uniqueHeadingId, type Heading } from './headingIds'
import { parseMarkdown, textOfMdast, type AnyNode, type DocFormat } from './mdast'

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
        headings.push({ level: node.depth, text, id: uniqueHeadingId(text, seen) })
      }
      if ('children' in node && Array.isArray(node.children)) {
        walk(node.children as AnyNode[])
      }
    }
  }
  walk(root.children as AnyNode[])
  return headings
}
