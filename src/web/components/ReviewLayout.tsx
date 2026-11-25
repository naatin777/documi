import { useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { BlockKind } from '../../core/types'
import { api, encodeDocId, isStaticSite, type ReviewBlocksResponse, type TermEntry } from '../api'
import { toErrorMessage, useBlockDiffQuery, useBlocksQuery, useInvalidateDocs, useTermsQuery } from '../queries'
import DocPeekPane from './DocPeekPane'
import Markdown from './Markdown'

type ReviewFilter = 'attention' | 'feedback' | 'unreviewed' | 'approved' | 'all'
type KindFilter = 'all' | Exclude<BlockKind, 'note'>

const REVIEWABLE_KINDS: readonly Exclude<BlockKind, 'note'>[] = ['spec', 'outcome', 'constraint', 'term']

type ReviewBlockItem = ReviewBlocksResponse['blocks'][number]

function filterTabClass(active: boolean) {
  return `inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold ${
    active
      ? 'border-accent bg-accent text-surface'
      : 'border-line bg-sidebar text-fg-muted hover:border-accent hover:text-fg'
  }`
}

function kindChipClass(active: boolean) {
  return `inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-[11.5px] font-semibold ${
    active
      ? 'border-accent bg-accent-soft text-accent'
      : 'border-line bg-surface text-fg-muted hover:border-fg-muted hover:text-fg'
  }`
}

// @implements ui.human-review
export default function ReviewLayout() {
  const { t } = useTranslation()
  const invalidateDocs = useInvalidateDocs()
  const { data, error: queryError } = useBlocksQuery()
  const termsQuery = useTermsQuery()
  const terms = useMemo(() => termsQuery.data?.terms ?? [], [termsQuery.data])

  const [actionError, setActionError] = useState<string | null>(null)
  const [selectedFilter, setSelectedFilter] = useState<ReviewFilter | null>(null)
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [closedDiffIds, setClosedDiffIds] = useState<ReadonlySet<string>>(new Set())
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

  // 要確認が 0 件で未承認がある初期状態では、空画面にせず自動で未承認タブを開く
  const filter: ReviewFilter =
    selectedFilter ?? (attentionCount === 0 && (data?.counts.unreviewed ?? 0) > 0 ? 'unreviewed' : 'attention')

  const statusFiltered = useMemo(() => {
    if (!data) return []
    return data.blocks.filter((b) => {
      if (filter === 'attention') return b.review === 'stale' || b.suspect
      if (filter === 'feedback') return b.openFeedbackCount > 0
      if (filter === 'unreviewed') return b.review === 'unreviewed'
      if (filter === 'approved') return b.review === 'approved' && !b.suspect
      return true
    })
  }, [data, filter])

  const kindCounts = useMemo(() => {
    const counts: Record<KindFilter, number> = {
      all: statusFiltered.length,
      spec: 0,
      outcome: 0,
      constraint: 0,
      term: 0,
    }
    for (const b of statusFiltered) {
      if (b.kind !== 'note') counts[b.kind]++
    }
    return counts
  }, [statusFiltered])

  const filtered = useMemo(
    () => (kindFilter === 'all' ? statusFiltered : statusFiltered.filter((b) => b.kind === kindFilter)),
    [statusFiltered, kindFilter],
  )

  const runAction = async (blockId: string, fn: () => Promise<unknown>) => {
    setBusyId(blockId)
    setActionError(null)
    try {
      await fn()
      invalidateDocs()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  const handleToggleDiff = (blockId: string) => {
    const next = new Set(closedDiffIds)
    if (next.has(blockId)) next.delete(blockId)
    else next.add(blockId)
    setClosedDiffIds(next)
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
              <div className="my-4 mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label={t('review.filterAria')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'attention'}
                  className={filterTabClass(filter === 'attention')}
                  onClick={() => setSelectedFilter('attention')}
                >
                  {t('review.filters.attention')} <span className="text-[11px] opacity-80">{attentionCount}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'feedback'}
                  className={filterTabClass(filter === 'feedback')}
                  onClick={() => setSelectedFilter('feedback')}
                >
                  {t('review.filters.feedback')} <span className="text-[11px] opacity-80">{feedbackBlockCount}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'unreviewed'}
                  className={filterTabClass(filter === 'unreviewed')}
                  onClick={() => setSelectedFilter('unreviewed')}
                >
                  {t('review.filters.unreviewed')}{' '}
                  <span className="text-[11px] opacity-80">{data.counts.unreviewed}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'approved'}
                  className={filterTabClass(filter === 'approved')}
                  onClick={() => setSelectedFilter('approved')}
                >
                  {t('review.filters.approved')} <span className="text-[11px] opacity-80">{data.counts.approved}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'all'}
                  className={filterTabClass(filter === 'all')}
                  onClick={() => setSelectedFilter('all')}
                >
                  {t('review.filters.all')} <span className="text-[11px] opacity-80">{data.blocks.length}</span>
                </button>
              </div>

              {statusFiltered.length > 0 && (
                <div className="mb-4 flex flex-wrap items-center gap-1.5" aria-label={t('review.kindFilterAria')}>
                  <button
                    type="button"
                    className={kindChipClass(kindFilter === 'all')}
                    onClick={() => setKindFilter('all')}
                  >
                    {t('review.filters.all')}
                    <span className="mono text-[10.5px] opacity-75">{kindCounts.all}</span>
                  </button>
                  {REVIEWABLE_KINDS.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className={kindChipClass(kindFilter === kind)}
                      onClick={() => setKindFilter(kind)}
                    >
                      {kind.toUpperCase()}
                      <span className="mono text-[10.5px] opacity-75">{kindCounts[kind]}</span>
                    </button>
                  ))}
                </div>
              )}

              {filtered.length === 0 ? (
                <div className="rounded-[10px] border border-dashed border-line px-5 py-7 text-center text-fg-muted">
                  {filter === 'attention' ? (
                    <>
                      <p className="m-0 mb-3">{t('review.emptyAttention')}</p>
                      {data.counts.unreviewed > 0 && (
                        <button type="button" className="button" onClick={() => setSelectedFilter('unreviewed')}>
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
                      terms={terms}
                      busy={busyId === block.id}
                      diffOpen={block.review === 'stale' && !closedDiffIds.has(block.id)}
                      onApprove={() => void runAction(block.id, () => api.approveBlock(block.id))}
                      onUnapprove={() => void runAction(block.id, () => api.unapproveBlock(block.id))}
                      onAddFeedback={(body) => runAction(block.id, () => api.addFeedback(block.id, body))}
                      onResolveFeedback={(feedbackId, resolved) =>
                        void runAction(block.id, () => api.setFeedbackResolved(block.id, feedbackId, resolved))
                      }
                      onToggleDiff={() => handleToggleDiff(block.id)}
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
  terms,
  busy,
  diffOpen,
  onApprove,
  onUnapprove,
  onAddFeedback,
  onResolveFeedback,
  onToggleDiff,
  onPeek,
}: {
  block: ReviewBlockItem
  terms: readonly TermEntry[]
  busy: boolean
  diffOpen: boolean
  onApprove: () => void
  onUnapprove: () => void
  onAddFeedback: (body: string) => Promise<void>
  onResolveFeedback: (feedbackId: string, resolved: boolean) => void
  onToggleDiff: () => void
  onPeek: () => void
}) {
  const { t } = useTranslation()
  const readOnly = isStaticSite()
  const diffQuery = useBlockDiffQuery(block.id, diffOpen && block.review === 'stale')
  const diff = diffQuery.data
  const openFeedback = block.feedback.filter((f) => !f.resolved)
  const [showFeedback, setShowFeedback] = useState(openFeedback.length > 0)
  const [draft, setDraft] = useState('')

  const needsApprove = block.review !== 'approved' || block.suspect
  const canUnapprove = block.review === 'approved' || block.review === 'stale'
  const isAttention = block.review === 'stale' || block.suspect

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const body = draft.trim()
    if (!body) return
    await onAddFeedback(body)
    setDraft('')
  }

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
        <div className="flex flex-wrap items-center gap-1.5">
          {block.review === 'stale' && (
            <button type="button" className="sem-action-btn" onClick={onToggleDiff}>
              {diffOpen ? t('review.closeDiff') : t('review.diff')}
            </button>
          )}
          {(!readOnly || block.feedback.length > 0) && (
            <button
              type="button"
              className={`sem-action-btn${showFeedback || openFeedback.length > 0 ? ' has-feedback' : ''}`}
              disabled={busy}
              onClick={() => setShowFeedback((v) => !v)}
              title={t('review.feedbackButton')}
            >
              💬 {openFeedback.length > 0 ? openFeedback.length : ''}
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
          {!readOnly && canUnapprove && (
            <button type="button" className="sem-action-btn" disabled={busy} onClick={onUnapprove}>
              {t('review.unapprove')}
            </button>
          )}
          {!readOnly && needsApprove && (
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

      <div className="text-[13.5px] leading-[1.65] [&_.markdown_p:first-child]:mt-0 [&_.markdown_p:last-child]:mb-0">
        <Markdown
          body={block.rawBody}
          format={block.docFormat}
          currentDir={block.docDir}
          terms={terms}
          headingPrefix={`review-${block.id}`}
        />
      </div>

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

      {showFeedback && (
        <div className="sem-feedback-panel mt-2.5 rounded-md border border-line">
          {block.feedback.length > 0 && (
            <ul className="sem-feedback-list">
              {block.feedback.map((fb) => (
                <li key={fb.id} className={`sem-feedback-item${fb.resolved ? ' resolved' : ''}`}>
                  <div className="sem-feedback-text">{fb.body}</div>
                  <div className="sem-feedback-meta">
                    <span>{fb.author}</span>
                    {!readOnly && (
                      <button
                        type="button"
                        className="sem-feedback-toggle"
                        disabled={busy}
                        onClick={() => onResolveFeedback(fb.id, !fb.resolved)}
                      >
                        {fb.resolved ? t('blocks.reopenFeedback') : t('blocks.resolveFeedback')}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {!readOnly && (
            <form className="sem-feedback-form" onSubmit={(e) => void handleSubmit(e)}>
              <input
                type="text"
                className="sem-feedback-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t('blocks.feedbackPlaceholder')}
                disabled={busy}
              />
              <button type="submit" className="sem-action-btn sem-approve-btn" disabled={busy || !draft.trim()}>
                {t('common.submit')}
              </button>
            </form>
          )}
        </div>
      )}
    </section>
  )
}
