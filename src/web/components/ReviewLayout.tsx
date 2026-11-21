import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import type { BlockDiffResult } from '../../core/types'
import { api, encodeDocId, type ReviewBlocksResponse } from '../api'
import { useDocsRevision } from '../live'
import DocPeekPane from './DocPeekPane'

type ReviewFilter = 'attention' | 'feedback' | 'unreviewed' | 'approved' | 'all'

type ReviewBlockItem = ReviewBlocksResponse['blocks'][number]

// @implements ui.human-review
export default function ReviewLayout() {
  const { t } = useTranslation()
  const revision = useDocsRevision()
  const [data, setData] = useState<ReviewBlocksResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<ReviewFilter>('attention')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, BlockDiffResult>>({})
  const [openDiffIds, setOpenDiffIds] = useState<ReadonlySet<string>>(new Set())
  const [peekTarget, setPeekTarget] = useState<{ docId: string; focusBlockId: string } | null>(null)

  const load = useCallback(() => {
    api
      .blocks()
      .then((res) => {
        setData(res)
        setError(null)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
      })
  }, [])

  useEffect(() => {
    load()
  }, [load, revision])

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

  // 要確認が 0 件で未承認がある場合は初回だけ分かりやすく案内する
  const handleApprove = async (blockId: string) => {
    setBusyId(blockId)
    try {
      await api.approveBlock(blockId)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
      <main className="content">
        <article className="page review-page">
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
              <div className="review-filter-tabs" role="tablist" aria-label={t('review.filterAria')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'attention'}
                  className={`review-filter-tab${filter === 'attention' ? ' active' : ''}`}
                  onClick={() => setFilter('attention')}
                >
                  {t('review.filters.attention')} <span className="review-tab-count">{attentionCount}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'feedback'}
                  className={`review-filter-tab${filter === 'feedback' ? ' active' : ''}`}
                  onClick={() => setFilter('feedback')}
                >
                  {t('review.filters.feedback')} <span className="review-tab-count">{feedbackBlockCount}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'unreviewed'}
                  className={`review-filter-tab${filter === 'unreviewed' ? ' active' : ''}`}
                  onClick={() => setFilter('unreviewed')}
                >
                  {t('review.filters.unreviewed')} <span className="review-tab-count">{data.counts.unreviewed}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'approved'}
                  className={`review-filter-tab${filter === 'approved' ? ' active' : ''}`}
                  onClick={() => setFilter('approved')}
                >
                  {t('review.filters.approved')} <span className="review-tab-count">{data.counts.approved}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={filter === 'all'}
                  className={`review-filter-tab${filter === 'all' ? ' active' : ''}`}
                  onClick={() => setFilter('all')}
                >
                  {t('review.filters.all')} <span className="review-tab-count">{data.blocks.length}</span>
                </button>
              </div>

              {filtered.length === 0 ? (
                <div className="review-empty-state">
                  {filter === 'attention' ? (
                    <>
                      <p>{t('review.emptyAttention')}</p>
                      {data.counts.unreviewed > 0 && (
                        <button type="button" className="button" onClick={() => setFilter('unreviewed')}>
                          {t('review.checkUnreviewed', { count: data.counts.unreviewed })}
                        </button>
                      )}
                    </>
                  ) : (
                    <p>{t('review.emptyFiltered')}</p>
                  )}
                </div>
              ) : (
                <div className="review-inbox-list">
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

  return (
    <section
      className={`review-card${block.review === 'stale' ? ' is-stale' : ''}${block.suspect ? ' is-suspect' : ''}`}
    >
      <header className="review-card-head">
        <div className="review-card-id-group">
          <span className={`sem-kind sem-kind-${block.kind}`}>{block.kind.toUpperCase()}</span>
          <code className="sem-id">{block.id}</code>
          <span className={`sem-review-badge sem-review-${block.review}`}>
            {block.review === 'approved'
              ? t('blocks.approved')
              : block.review === 'stale'
                ? '↻ Stale'
                : t('blocks.unreviewed')}
          </span>
          {block.suspect && <span className="sem-review-badge sem-review-suspect">{t('blocks.suspect')}</span>}
          {block.realization && (
            <span className={`sem-realization-badge sem-real-${block.realization}`}>{block.realization}</span>
          )}
        </div>
        <div className="review-card-actions">
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
            className="sem-action-btn review-card-open-link"
          >
            {t('common.open')} ↗
          </Link>
          {needsApprove && (
            <button type="button" className="sem-action-btn sem-approve-btn" disabled={busy} onClick={onApprove}>
              {busy ? t('common.processing') : t('review.approve')}
            </button>
          )}
        </div>
      </header>

      <div className="review-card-doc">
        <Link to={`/docs/${encodeDocId(block.docId)}`}>{block.docTitle}</Link>
        <span className="mono">{block.docPath}</span>
      </div>

      <p className="review-card-body">{block.rawBody}</p>

      {block.suspect && block.suspectSources.length > 0 && (
        <div className="sem-suspect-banner">
          {t('review.suspectBanner', { sources: block.suspectSources.join(', ') })}
        </div>
      )}

      {diffOpen && diff && (
        <div className="sem-diff-box">
          {!diff.hasBase ? (
            <p className="muted">{t('review.noBaseSnapshot')}</p>
          ) : (
            <pre className="sem-diff-pre">
              {diff.lines.map((line, i) => (
                <div key={i} className={`diff-line diff-${line.type}`}>
                  <span className="diff-sign">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
                  <span>{line.text}</span>
                </div>
              ))}
            </pre>
          )}
        </div>
      )}

      {openFeedback.length > 0 && (
        <ul className="review-card-feedback">
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
