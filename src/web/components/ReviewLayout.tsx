import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { BlockDiffResult } from '../../core/types'
import { api, encodeDocId, isStaticSite, type ReviewBlocksResponse } from '../api'
import { toErrorMessage, useBlocksQuery, useInvalidateDocs } from '../queries'
import DocPeekPane from './DocPeekPane'

type ReviewFilter = 'attention' | 'feedback' | 'unreviewed' | 'approved' | 'all'

type ReviewBlockItem = ReviewBlocksResponse['blocks'][number]

function filterTabClass(active: boolean) {
  return `inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold ${
    active
      ? 'border-accent bg-accent text-surface'
      : 'border-line bg-sidebar text-fg-muted hover:border-accent hover:text-fg'
  }`
}

// @implements ui.human-review
export default function ReviewLayout() {
  const { t } = useTranslation()
  const invalidateDocs = useInvalidateDocs()
  const { data, error: queryError } = useBlocksQuery()
  const [actionError, setActionError] = useState<string | null>(null)
  const [filter, setFilter] = useState<ReviewFilter>('attention')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, BlockDiffResult>>({})
  const [openDiffIds, setOpenDiffIds] = useState<ReadonlySet<string>>(new Set())
  const [peekTarget, setPeekTarget] = useState<{ docId: string; focusBlockId: string } | null>(null)
  const error = actionError ?? toErrorMessage(queryError)

  const attentionCount = useMemo(
    () => (data ? data.blocks.filter((b) => b.review === 'stale' || b.suspect).length : 0),
    [data],
  )
  const feedbackBlockCount = useMemo(
    () => (data ? data.blocks.filter((b) => b.openFeedbackCount > 0).length : 0),
    [data],
  )

  const filtered = useMemo(() => {
    if (!data) return []
    return data.blocks.filter((b) => {
      if (filter === 'attention') return b.review === 'stale' || b.suspect
      if (filter === 'feedback') return b.openFeedbackCount > 0
      if (filter === 'unreviewed') return b.review === 'unreviewed'
      if (filter === 'approved') return b.review === 'approved' && !b.suspect
      return true
    })
  }, [data, filter])

  const handleApprove = async (blockId: string) => {
    setBusyId(blockId)
    setActionError(null)
    try {
      await api.approveBlock(blockId)
      invalidateDocs()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const handleToggleDiff = async (blockId: string) => {
    const next = new Set(openDiffIds)
    if (next.has(blockId)) {
      next.delete(blockId)
      setOpenDiffIds(next)
      return
    }
    next.add(blockId)
    setOpenDiffIds(next)
    if (!diffs[blockId]) {
      try {
        const res = await api.blockDiff(blockId)
        setDiffs((prev) => ({ ...prev, [blockId]: res }))
      } catch {
        // Diff 取得失敗時は無視
      }
    }
  }

  return (
    <>
      <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface max-desktop:flex-none max-desktop:overflow-visible">
        <article className="page">
          <header className="doc-header">
            <div className="doc-badges">
              <span className="badge badge-type">{t('review.badge')}</span>
            </div>
            <h1>{t('review.title')}</h1>
            <p className="doc-description">{t('review.description')}</p>
          </header>

          {error && <p className="error-text">{error}</p>}

          {data && (
            <>
              <div className="my-4 mb-5 flex flex-wrap gap-1.5" role="tablist" aria-label={t('review.filterAria')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'attention'}
                  className={filterTabClass(filter === 'attention')}
                  onClick={() => setFilter('attention')}
                >
                  {t('review.filters.attention')} <span className="text-[11px] opacity-80">{attentionCount}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'feedback'}
                  className={filterTabClass(filter === 'feedback')}
                  onClick={() => setFilter('feedback')}
                >
                  {t('review.filters.feedback')} <span className="text-[11px] opacity-80">{feedbackBlockCount}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'unreviewed'}
                  className={filterTabClass(filter === 'unreviewed')}
                  onClick={() => setFilter('unreviewed')}
                >
                  {t('review.filters.unreviewed')}{' '}
                  <span className="text-[11px] opacity-80">{data.counts.unreviewed}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'approved'}
                  className={filterTabClass(filter === 'approved')}
                  onClick={() => setFilter('approved')}
                >
                  {t('review.filters.approved')} <span className="text-[11px] opacity-80">{data.counts.approved}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'all'}
                  className={filterTabClass(filter === 'all')}
                  onClick={() => setFilter('all')}
                >
                  {t('review.filters.all')} <span className="text-[11px] opacity-80">{data.blocks.length}</span>
                </button>
              </div>

              {filtered.length === 0 ? (
                <div className="rounded-[10px] border border-dashed border-line px-5 py-7 text-center text-fg-muted">
                  {filter === 'attention' ? (
                    <>
                      <p className="m-0 mb-3">{t('review.emptyAttention')}</p>
                      {data.counts.unreviewed > 0 && (
                        <button type="button" className="button" onClick={() => setFilter('unreviewed')}>
                          {t('review.checkUnreviewed', { count: data.counts.unreviewed })}
                        </button>
                      )}
                    </>
                  ) : (
                    <p className="m-0">{t('review.emptyFiltered')}</p>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {filtered.map((block) => (
                    <ReviewInboxCard
                      key={block.id}
                      block={block}
                      busy={busyId === block.id}
                      diffOpen={openDiffIds.has(block.id)}
                      diff={diffs[block.id]}
                      onApprove={() => void handleApprove(block.id)}
                      onToggleDiff={() => void handleToggleDiff(block.id)}
                      onPeek={() => setPeekTarget({ docId: block.docId, focusBlockId: block.id })}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </article>
      </main>
      {peekTarget && (
        <DocPeekPane
          docId={peekTarget.docId}
          focusBlockId={peekTarget.focusBlockId}
          onClose={() => setPeekTarget(null)}
        />
      )}
    </>
  )
}

function ReviewInboxCard({
  block,
  busy,
  diffOpen,
  diff,
  onApprove,
  onToggleDiff,
  onPeek,
}: {
  block: ReviewBlockItem
  busy: boolean
  diffOpen: boolean
  diff?: BlockDiffResult
  onApprove: () => void
  onToggleDiff: () => void
  onPeek: () => void
}) {
  const { t } = useTranslation()
  const openFeedback = block.feedback.filter((f) => !f.resolved)
  const needsApprove = block.review !== 'approved' || block.suspect
  const isAttention = block.review === 'stale' || block.suspect

  return (
    <section
      className={`rounded-[10px] border bg-sidebar px-4 py-3.5 ${isAttention ? 'border-amber-600' : 'border-line'}`}
    >
      <header className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={`sem-kind sem-kind-${block.kind}`}>{block.kind.toUpperCase()}</span>
          <code className="sem-id">{block.id}</code>
          <span className={`sem-review-badge sem-review-${block.review}`}>
            {block.review === 'approved'
              ? t('blocks.approved')
              : block.review === 'stale'
                ? t('blocks.staleShort')
                : t('blocks.unreviewed')}
          </span>
          {block.suspect && <span className="sem-review-badge sem-review-suspect">{t('blocks.suspect')}</span>}
          {block.realization && (
            <span className={`sem-realization-badge sem-real-${block.realization}`}>
              {t(`status.realization.${block.realization}`)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {block.review === 'stale' && (
            <button type="button" className="sem-action-btn" onClick={onToggleDiff}>
              {diffOpen ? t('review.closeDiff') : t('review.diff')}
            </button>
          )}
          <button type="button" className="sem-action-btn" onClick={onPeek}>
            {t('review.peekSideBySide')}
          </button>
          <Link
            to={`/docs/${encodeDocId(block.docId)}#block-${encodeURIComponent(block.id)}`}
            className="sem-action-btn no-underline"
          >
            {t('common.open')} ↗
          </Link>
          {!isStaticSite() && needsApprove && (
            <button type="button" className="sem-action-btn sem-approve-btn" disabled={busy} onClick={onApprove}>
              {busy ? t('common.processing') : t('review.approve')}
            </button>
          )}
        </div>
      </header>

      <div className="mb-2 flex items-baseline gap-2 text-[12.5px]">
        <Link to={`/docs/${encodeDocId(block.docId)}`} className="font-semibold text-fg no-underline hover:underline">
          {block.docTitle}
        </Link>
        <span className="mono text-[11px] text-fg-muted">{block.docPath}</span>
      </div>

      <p className="m-0 text-[13.5px] leading-[1.65] whitespace-pre-wrap">{block.rawBody}</p>

      {block.suspect && block.suspectSources.length > 0 && (
        <div className="sem-suspect-banner mt-2 rounded-md border">
          {t('review.suspectBanner', { sources: block.suspectSources.join(', ') })}
        </div>
      )}

      {diffOpen && diff && (
        <div className="sem-diff-panel mt-2.5 overflow-hidden rounded-md border border-line">
          {!diff.hasBase ? (
            <p className="sem-diff-empty muted">{t('review.noBaseSnapshot')}</p>
          ) : (
            <pre className="sem-diff-lines">
              {diff.lines.map((line, i) => (
                <div
                  key={i}
                  className={`sem-diff-line ${line.type === 'add' ? 'sem-diff-add' : line.type === 'del' ? 'sem-diff-del' : ''}`}
                >
                  <span className="sem-diff-mark">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
                  <span>{line.text}</span>
                </div>
              ))}
            </pre>
          )}
        </div>
      )}

      {openFeedback.length > 0 && (
        <ul className="m-0 mt-2.5 flex list-none flex-col gap-1 rounded-md border border-line bg-surface px-3 py-2 text-[12.5px]">
          {openFeedback.map((fb) => (
            <li key={fb.id}>
              <strong>{fb.author}:</strong> {fb.body}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
