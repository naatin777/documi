import { History, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Document, DocumentHistory } from '../../core/types'
import type { TermEntry } from '../api'
import { formatDateTime, formatRelativeTime, formatShortDate } from '../time'
import Markdown from './Markdown'
import { PrintFooter, PrintHeader } from './PrintChrome'
import { DocReviewProvider } from './SemanticBlocks'

interface DocViewerProps {
  doc: Document
  terms?: readonly TermEntry[]
  onMutate: () => void
  history?: DocumentHistory | null
  highlightChanges?: boolean
  onToggleHighlight?: () => void
  onOpenHistory?: () => void
}

// @implements ui.doc-history
export default function DocViewer({
  doc,
  terms,
  onMutate,
  history,
  highlightChanges = true,
  onToggleHighlight,
  onOpenHistory,
}: DocViewerProps) {
  const { t, i18n } = useTranslation()
  const typeLabel = t(`types.singular.${doc.type}`)
  const freshness = history?.freshness ?? doc.freshness
  const changedRanges = highlightChanges && history ? history.changedRanges : undefined
  const hasLatestHighlights = Boolean(history && history.changedRanges.length > 0 && history.highlightBasis !== 'none')
  const commitCount = history?.commits.length ?? freshness?.commitCount ?? 0

  return (
    <article className="page doc-page">
      <PrintHeader label={typeLabel} title={doc.title} meta={doc.path} />
      <header className="doc-header">
        <div className="doc-badges">
          <span className={`badge badge-type type-${doc.type}`}>{typeLabel}</span>
          {doc.typeInferred && <span className="badge badge-format">{t('doc.inferred')}</span>}
          {doc.format === 'mdx' && <span className="badge badge-format">MDX</span>}
          {doc.blocks.length > 0 && (
            <span className="badge badge-id">{t('doc.blocksCount', { count: doc.blocks.length })}</span>
          )}
          {freshness?.workingStatus && (
            <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11.5px] font-semibold text-emerald-700 dark:text-emerald-400 print:hidden">
              {freshness.workingStatus === 'modified' ? t('doc.uncommittedModified') : t('doc.uncommittedNew')}
            </span>
          )}
        </div>
        <h1>{doc.title}</h1>
        {doc.description && <p className="doc-description">{doc.description}</p>}
        <div className="doc-meta">
          {doc.date && <span className="meta-item mono">{doc.date}</span>}
          {freshness?.createdAt && (
            <span className="meta-item" title={formatDateTime(freshness.createdAt)}>
              {t('doc.createdAt', { date: formatShortDate(freshness.createdAt) })}
            </span>
          )}
          {freshness?.updatedAt && (
            <span
              className="meta-item"
              title={[
                formatDateTime(freshness.updatedAt),
                freshness.lastCommitSha ? `${freshness.lastCommitSha} ${freshness.lastCommitSubject ?? ''}`.trim() : '',
              ]
                .filter(Boolean)
                .join(' — ')}
            >
              {t('doc.updatedAt', { time: formatRelativeTime(freshness.updatedAt, i18n.language) })}
            </span>
          )}
          {doc.tags.length > 0 && <span className="meta-item">tags: {doc.tags.join(', ')}</span>}
          <span className="meta-item mono">{doc.path}</span>
        </div>

        {(hasLatestHighlights || (onOpenHistory && commitCount > 0)) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 print:hidden">
            {hasLatestHighlights && history && (
              <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/8 px-2 py-1 text-[11.5px] text-fg-muted">
                <Sparkles
                  size={12}
                  strokeWidth={2}
                  className="shrink-0 text-sky-600 dark:text-sky-400"
                  aria-hidden="true"
                />
                <span className="truncate">
                  {history.highlightBasis === 'working'
                    ? t('doc.highlightWorking')
                    : history.highlightBasis === 'last-commit'
                      ? t('doc.highlightLastCommit', { sha: history.highlightCommit.shortSha })
                      : ''}
                  {history.highlightBasis === 'last-commit' && history.highlightCommit.subject
                    ? ` · ${history.highlightCommit.subject}`
                    : ''}
                </span>
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {hasLatestHighlights && onToggleHighlight && (
                <button
                  type="button"
                  aria-pressed={highlightChanges}
                  className={`inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] font-semibold transition-colors ${
                    highlightChanges
                      ? 'border-sky-500/50 bg-sky-500/12 text-sky-700 dark:text-sky-300'
                      : 'border-line bg-subtle text-fg-muted hover:bg-hover hover:text-fg'
                  }`}
                  onClick={onToggleHighlight}
                >
                  {t('doc.highlightToggle')}
                </button>
              )}
              {onOpenHistory && commitCount > 0 && (
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line bg-subtle px-2 py-1 text-[11.5px] font-semibold text-fg-muted hover:bg-hover hover:text-fg"
                  onClick={onOpenHistory}
                >
                  <History size={12} strokeWidth={1.85} aria-hidden="true" />
                  <span>{t('doc.openHistory', { count: commitCount })}</span>
                </button>
              )}
            </div>
          </div>
        )}
      </header>

      {doc.issues.length > 0 && (
        <section className="issues-panel">
          <h2>{t('doc.docIssues', { count: doc.issues.length })}</h2>
          <ul>
            {doc.issues.map((issue, i) => (
              <li key={i}>
                <code>{issue.code}</code> {issue.blockId && <code>{issue.blockId}</code>} {issue.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <DocReviewProvider blocks={doc.blocks} onMutate={onMutate}>
        <Markdown
          body={doc.body}
          format={doc.format}
          currentDir={doc.dir}
          terms={terms}
          changedRanges={changedRanges}
        />
      </DocReviewProvider>
      <PrintFooter meta={doc.id} />
    </article>
  )
}
