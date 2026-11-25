import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { BlockDiffResult, SemanticBlock } from '../../core/types'
import { api, isStaticSite } from '../api'

/** ブロック単位の承認・承認取消・Diff・Realization 詳細・AI 向け参照コピー UI */
export default function BlockReviewControls({ block, onMutate }: { block: SemanticBlock; onMutate: () => void }) {
  const { t, i18n } = useTranslation()
  const readOnly = isStaticSite()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [diff, setDiff] = useState<BlockDiffResult | null>(null)
  const [showTrace, setShowTrace] = useState(false)
  const [copiedAi, setCopiedAi] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const handleCopyForAi = async () => {
    const isJa = (i18n.resolvedLanguage ?? 'ja').startsWith('ja')
    const prompt = isJa
      ? `Documi ブロック \`${block.id}\` (${block.docId}) を \`documi context ${block.id}\` で確認して、`
      : `Inspect Documi block \`${block.id}\` (${block.docId}) via \`documi context ${block.id}\` and `
    try {
      await navigator.clipboard.writeText(prompt)
      setCopiedAi(true)
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopiedAi(false), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
              ? `${t('blocks.approvedTooltip', {
                  by: block.approvedBy ?? '',
                  commit: block.approvedCommit ?? 'uncommitted',
                  at: block.approvedAt,
                })}${block.approvedNote ? `\n${block.approvedNote}` : ''}`
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

        <span className={`sem-pill sem-pill-${block.stability}`}>{t(`status.stability.${block.stability}`)}</span>

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

        {!readOnly && (
          <button type="button" className="sem-action-btn" disabled={busy} onClick={() => void handleCopyForAi()}>
            {copiedAi ? t('review.copied') : t('blocks.copyForAi')}
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

      {block.approvedNote && block.review === 'approved' && (
        <div className="mt-1 text-[11.5px] text-fg-muted">
          {t('blocks.approvedNoteLabel')}: {block.approvedNote}
        </div>
      )}

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
    </>
  )
}
