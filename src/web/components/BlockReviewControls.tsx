import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { STABILITIES } from '../../core/types'
import type { BlockDiffResult, SemanticBlock, Stability } from '../../core/types'
import { api, isStaticSite } from '../api'

/** ブロック単位の承認・Diff・Stability 変更・Realization 詳細・AI 向けフィードバック操作 UI */
export default function BlockReviewControls({ block, onMutate }: { block: SemanticBlock; onMutate: () => void }) {
  const { t } = useTranslation()
  const readOnly = isStaticSite()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [diff, setDiff] = useState<BlockDiffResult | null>(null)
  const [showFeedback, setShowFeedback] = useState(false)
  const [showTrace, setShowTrace] = useState(false)
  const [draft, setDraft] = useState('')

  const openCount = block.feedback.filter((f) => !f.resolved).length
  const realization = block.realization

  const handleApprove = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.approveBlock(block.id)
      setShowDiff(false)
      setDiff(null)
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleUnapprove = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.unapproveBlock(block.id)
      setShowDiff(false)
      setDiff(null)
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleToggleDiff = async () => {
    if (showDiff) {
      setShowDiff(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api.blockDiff(block.id)
      setDiff(res)
      setShowDiff(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleCycleStability = async () => {
    const idx = STABILITIES.indexOf(block.stability)
    const next: Stability = STABILITIES[(idx + 1) % STABILITIES.length]!
    setBusy(true)
    setError(null)
    try {
      await api.setStability(block.id, next)
      onMutate()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleSubmitFeedback = async (e: FormEvent) => {
    e.preventDefault()
    if (!draft.trim()) return
    setBusy(true)
    setError(null)
    try {
      await api.addFeedback(block.id, draft.trim())
      setDraft('')
      onMutate()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleResolveFeedback = async (feedbackId: string, resolved: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await api.setFeedbackResolved(block.id, feedbackId, resolved)
      onMutate()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const needsApproval = block.review !== 'approved' || block.suspect
  const canUnapprove = block.review === 'approved' || block.review === 'stale'

  return (
    <>
      <div className="sem-review-bar">
        <span
          className={`sem-review-badge sem-review-${block.review}`}
          title={
            block.approvedAt
              ? t('blocks.approvedTooltip', {
                  by: block.approvedBy ?? '',
                  commit: block.approvedCommit ?? 'uncommitted',
                  at: block.approvedAt,
                })
              : t('blocks.unreviewedTooltip')
          }
        >
          {block.review === 'approved' && t('blocks.approved')}
          {block.review === 'unreviewed' && t('blocks.unreviewed')}
          {block.review === 'stale' && t('blocks.stale')}
        </span>

        {block.suspect && (
          <span
            className="sem-review-badge sem-review-suspect"
            title={t('blocks.suspectTooltip', { sources: block.suspectSources.join(', ') })}
          >
            {t('blocks.suspect')}
          </span>
        )}

        {realization && (
          <button
            type="button"
            className={`sem-realization-badge sem-real-${realization.status}`}
            onClick={() => setShowTrace((v) => !v)}
            title={t('blocks.realizationTooltip')}
          >
            {realization.status === 'verified' &&
              t('blocks.verified', {
                passed: realization.testResults.filter((tr) => tr.status === 'passed').length,
                total: realization.testResults.length,
              })}
            {realization.status === 'implemented' &&
              t('blocks.implemented', { count: realization.implementations.length })}
            {realization.status === 'in-progress' && t('blocks.inProgress')}
            {realization.status === 'unimplemented' && t('blocks.unimplemented')}
            {realization.status === 'drifted' && t('blocks.drifted')}
          </button>
        )}

        {readOnly ? (
          <span className={`sem-pill sem-pill-${block.stability}`}>{t(`status.stability.${block.stability}`)}</span>
        ) : (
          <button
            type="button"
            className={`sem-action-btn sem-pill-${block.stability}`}
            disabled={busy}
            onClick={() => void handleCycleStability()}
            title={t('blocks.stabilityTooltip')}
          >
            {t(`status.stability.${block.stability}`)}
          </button>
        )}

        {block.review === 'stale' && (
          <button
            type="button"
            className={`sem-action-btn${showDiff ? ' active' : ''}`}
            disabled={busy}
            onClick={() => void handleToggleDiff()}
          >
            {t('review.diff')}
          </button>
        )}

        {(!readOnly || block.feedback.length > 0) && (
          <button
            type="button"
            className={`sem-action-btn${showFeedback || openCount > 0 ? ' has-feedback' : ''}`}
            disabled={busy}
            onClick={() => setShowFeedback((v) => !v)}
          >
            💬 {openCount > 0 ? openCount : ''}
          </button>
        )}

        {!readOnly && canUnapprove && (
          <button type="button" className="sem-action-btn" disabled={busy} onClick={() => void handleUnapprove()}>
            {t('review.unapprove')}
          </button>
        )}

        {!readOnly && needsApproval && (
          <button
            type="button"
            className="sem-action-btn sem-approve-btn"
            disabled={busy}
            onClick={() => void handleApprove()}
          >
            {t('review.approve')}
          </button>
        )}
      </div>

      {block.suspect && block.suspectSources.length > 0 && (
        <div className="sem-suspect-banner">
          {t('blocks.suspectBannerPrefix')}
          {block.suspectSources.map((s) => (
            <code key={s}>{s}</code>
          ))}
          {t('blocks.suspectBannerSuffix')}
        </div>
      )}

      {error && <div className="sem-review-error">{error}</div>}

      {showTrace && realization && (
        <div className="sem-trace-panel">
          {realization.reasons.length > 0 && (
            <div className="sem-trace-reasons">
              {realization.reasons.map((r, i) => (
                <div key={i} className="error-text">
                  • {r}
                </div>
              ))}
            </div>
          )}
          <div className="sem-trace-group">
            <span className="sem-meta-label">
              {t('blocks.implementations', { count: realization.implementations.length })}
            </span>
            {realization.implementations.length === 0 ? (
              <span className="muted">{t('common.none')}</span>
            ) : (
              <ul className="sem-trace-list">
                {realization.implementations.map((a, i) => (
                  <li key={i} className="mono">
                    <Link
                      to={`/code?${new URLSearchParams({ file: a.file, ...(a.fromDoc ? {} : { line: String(a.line) }) }).toString()}`}
                    >
                      {a.file}:L{a.line}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="sem-trace-group">
            <span className="sem-meta-label">{t('blocks.tests', { count: realization.verifications.length })}</span>
            {realization.verifications.length === 0 ? (
              <span className="muted">{t('common.none')}</span>
            ) : (
              <ul className="sem-trace-list">
                {realization.verifications.map((a, i) => (
                  <li key={i} className="mono">
                    <Link
                      to={`/code?${new URLSearchParams({ file: a.file, ...(a.fromDoc ? {} : { line: String(a.line) }) }).toString()}`}
                    >
                      {a.file}:L{a.line}
                    </Link>
                    {a.testName ? ` — ${a.testName}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {realization.testResults.length > 0 && (
            <div className="sem-trace-group">
              <span className="sem-meta-label">
                {t('blocks.testResults', { count: realization.testResults.length })}
              </span>
              <ul className="sem-trace-list">
                {realization.testResults.map((tr, i) => (
                  <li key={i} className={`sem-test-${tr.status}`}>
                    [{tr.status}] {tr.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {realization.pullRequests.length > 0 && (
            <div className="sem-trace-group">
              <span className="sem-meta-label">
                {t('blocks.pullRequests', { count: realization.pullRequests.length })}
              </span>
              <ul className="sem-trace-list">
                {realization.pullRequests.map((pr) => (
                  <li key={pr.number}>
                    <a href={pr.url} target="_blank" rel="noreferrer">
                      #{pr.number} [{pr.state}] {pr.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {showDiff && diff && (
        <div className="sem-diff-panel">
          <div className="sem-diff-header">
            <span>
              {t('blocks.diffTitle')}
              {diff.baseSource === 'git' && diff.baseCommit && ` (git ${diff.baseCommit})`}
              {diff.baseSource === 'cache' && ` ${t('blocks.diffCache')}`}
            </span>
            <button type="button" className="sem-diff-close" onClick={() => setShowDiff(false)}>
              {t('common.close')}
            </button>
          </div>
          {!diff.hasBase ? (
            <p className="muted sem-diff-empty">{t('blocks.diffNoBase')}</p>
          ) : !diff.changed ? (
            <p className="muted sem-diff-empty">{t('blocks.diffNoChanges')}</p>
          ) : (
            <pre className="sem-diff-lines">
              {diff.lines.map((line, i) => (
                <div key={i} className={`sem-diff-line sem-diff-${line.type}`}>
                  <span className="sem-diff-mark">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
                  <span>{line.text}</span>
                </div>
              ))}
            </pre>
          )}
        </div>
      )}

      {showFeedback && (
        <div className="sem-feedback-panel">
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
                        onClick={() => void handleResolveFeedback(fb.id, !fb.resolved)}
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
            <form className="sem-feedback-form" onSubmit={(e) => void handleSubmitFeedback(e)}>
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
    </>
  )
}
