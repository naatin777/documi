import { useMemo } from 'react'
import type { DocFormat } from '../../core/types'
import { parseMarkdown, renderMarkdown } from '../mdast'

interface MarkdownProps {
  body: string
  format?: DocFormat
}

export default function Markdown({ body, format = 'markdown' }: MarkdownProps) {
  const tree = useMemo(() => parseMarkdown(body, format), [body, format])
  return <div className="markdown">{renderMarkdown(tree)}</div>
}
