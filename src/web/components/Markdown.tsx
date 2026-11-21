import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { DocFormat } from '../../core/types'
import type { TermEntry } from '../api'
import { parseMarkdown, renderMarkdown, type RenderOptions } from '../mdast'

interface MarkdownProps {
  body: string
  format?: DocFormat
  currentDir?: string
  terms?: readonly TermEntry[]
  bundleDocIds?: ReadonlySet<string>
  headingPrefix?: string
  expandAllTabs?: boolean
}

export default function Markdown({
  body,
  format = 'markdown',
  currentDir,
  terms,
  bundleDocIds,
  headingPrefix,
  expandAllTabs,
}: MarkdownProps) {
  // Subscribe to locale changes so localized MDX messages re-render immediately
  useTranslation()
  const tree = useMemo(() => parseMarkdown(body, format), [body, format])
  const options: RenderOptions = useMemo(
    () => ({ currentDir, terms, bundleDocIds, headingPrefix, expandAllTabs }),
    [currentDir, terms, bundleDocIds, headingPrefix, expandAllTabs],
  )
  return <div className="markdown">{renderMarkdown(tree, options)}</div>
}
