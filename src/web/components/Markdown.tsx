import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChangedLineRange, DocFormat } from '../../core/types'
import type { TermEntry } from '../api'
import { parseMarkdown, renderMarkdown, type RenderOptions } from '../mdast'

interface MarkdownProps {
  body: string
  format?: DocFormat
  currentDir?: string
  resolvedLinks?: Readonly<Record<string, string>>
  terms?: readonly TermEntry[]
  bundleDocIds?: ReadonlySet<string>
  headingPrefix?: string
  expandAllTabs?: boolean
  changedRanges?: readonly ChangedLineRange[]
}

export default function Markdown({
  body,
  format = 'markdown',
  currentDir,
  resolvedLinks,
  terms,
  bundleDocIds,
  headingPrefix,
  expandAllTabs,
  changedRanges,
}: MarkdownProps) {
  // Subscribe to locale changes so localized MDX messages re-render immediately
  useTranslation()
  const tree = useMemo(() => parseMarkdown(body, format), [body, format])
  const options: RenderOptions = useMemo(
    () => ({ currentDir, resolvedLinks, terms, bundleDocIds, headingPrefix, expandAllTabs, changedRanges }),
    [currentDir, resolvedLinks, terms, bundleDocIds, headingPrefix, expandAllTabs, changedRanges],
  )
  return <div className="markdown">{renderMarkdown(tree, options)}</div>
}
