import { createContext, useContext, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { isNoteIntent, isSpecIntent, isStability, STABILITIES } from '../../core/types'
import type { BlockDiffResult, SemanticBlock, Stability } from '../../core/types'
import { api } from '../api'

interface DocReviewContextValue {
  blocksById: ReadonlyMap<string, SemanticBlock>
  onMutate: () => void
}

const DocReviewContext = createContext<DocReviewContextValue | null>(null)

// @implements ui.human-review
export function DocReviewProvider({
  blocks,
  onMutate,
  children,
}: {
  blocks: readonly SemanticBlock[]
  onMutate: () => void
  children: ReactNode
}) {
  const blocksById = new Map(blocks.map((b) => [b.id, b]))
  return <DocReviewContext.Provider value={{ blocksById, onMutate }}>{children}</DocReviewContext.Provider>
}

function useSemanticBlock(id?: string): { block?: SemanticBlock; onMutate?: () => void } {
  const ctx = useContext(DocReviewContext)
  if (!ctx || !id) return {}
  return { block: ctx.blocksById.get(id), onMutate: ctx.onMutate }
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** ブロック単位の承認・Diff・Stability 変更・AI 向けフィードバック操作 UI */
function BlockReviewControls({ block, onMutate }: { block: SemanticBlock; onMutate: () => void }) {
  const { t } = useTranslation()
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

        <button
          type="button"
          className={`sem-action-btn sem-pill-${block.stability}`}
          disabled={busy}
          onClick={() => void handleCycleStability()}
          title={t('blocks.stabilityTooltip')}
        >
          {t(`status.stability.${block.stability}`)}
        </button>

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

        <button
          type="button"
          className={`sem-action-btn${showFeedback || openCount > 0 ? ' has-feedback' : ''}`}
          disabled={busy}
          onClick={() => setShowFeedback((v) => !v)}
        >
          💬 {openCount > 0 ? openCount : ''}
        </button>

        {needsApproval && (
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
                    {a.file}:L{a.line}
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
                    {a.file}:L{a.line}
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
                    <button
                      type="button"
                      className="sem-feedback-toggle"
                      disabled={busy}
                      onClick={() => void handleResolveFeedback(fb.id, !fb.resolved)}
                    >
                      {fb.resolved ? t('blocks.reopenFeedback') : t('blocks.resolveFeedback')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
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
        </div>
      )}
    </>
  )
}

export interface SpecBlockProps {
  id?: string
  intent?: string
  stability?: string
  derives?: string
  title?: string
  children?: ReactNode
}

export function SpecBlock({ id, intent, stability, derives, title, children }: SpecBlockProps) {
  const { block, onMutate } = useSemanticBlock(id)
  const safeIntent = isSpecIntent(intent) ? intent : 'normative'
  const safeStability = block?.stability ?? (isStability(stability) ? stability : 'evolving')
  const deriveList = splitCsv(derives)
  const reviewClass = block ? ` sem-state-${block.review}${block.suspect ? ' sem-state-suspect' : ''}` : ''

  return (
    <section
      id={id ? `block-${id}` : undefined}
      className={`sem-block sem-spec sem-intent-${safeIntent} sem-stability-${safeStability}${reviewClass}`}
    >
      <header className="sem-header">
        <span className="sem-kind sem-kind-spec">SPEC</span>
        {id && <code className="sem-id">{id}</code>}
        {title && <span className="sem-title">{title}</span>}
        <span className="sem-badges">
          {safeIntent !== 'normative' && <span className={`sem-pill sem-pill-${safeIntent}`}>{safeIntent}</span>}
          {!block && <span className={`sem-pill sem-pill-${safeStability}`}>{safeStability}</span>}
        </span>
      </header>
      {block && onMutate && <BlockReviewControls block={block} onMutate={onMutate} />}
      <div className="sem-body">{children}</div>
      {deriveList.length > 0 && (
        <footer className="sem-footer">
          <span className="sem-meta-label">derives</span>
          {deriveList.map((ref) => (
            <code key={ref} className="sem-ref-chip">
              {ref}
            </code>
          ))}
        </footer>
      )}
    </section>
  )
}

export interface ConstraintBlockProps {
  id?: string
  scope?: string
  stability?: string
  title?: string
  children?: ReactNode
}

export function ConstraintBlock({ id, scope, stability, title, children }: ConstraintBlockProps) {
  const { block, onMutate } = useSemanticBlock(id)
  const safeStability = block?.stability ?? (isStability(stability) ? stability : 'stable')
  const reviewClass = block ? ` sem-state-${block.review}${block.suspect ? ' sem-state-suspect' : ''}` : ''

  return (
    <section id={id ? `block-${id}` : undefined} className={`sem-block sem-constraint${reviewClass}`}>
      <header className="sem-header">
        <span className="sem-kind sem-kind-constraint">CONSTRAINT</span>
        {id && <code className="sem-id">{id}</code>}
        {title && <span className="sem-title">{title}</span>}
        <span className="sem-badges">
          {scope && <span className="sem-pill sem-pill-scope">{scope}</span>}
          {!block && <span className={`sem-pill sem-pill-${safeStability}`}>{safeStability}</span>}
        </span>
      </header>
      {block && onMutate && <BlockReviewControls block={block} onMutate={onMutate} />}
      <div className="sem-body">{children}</div>
    </section>
  )
}

export interface OutcomeBlockProps {
  id?: string
  supersedes?: string
  stability?: string
  title?: string
  children?: ReactNode
}

export function OutcomeBlock({ id, supersedes, stability, title, children }: OutcomeBlockProps) {
  const { block, onMutate } = useSemanticBlock(id)
  const safeStability = block?.stability ?? (isStability(stability) ? stability : 'stable')
  const superseded = splitCsv(supersedes)
  const reviewClass = block ? ` sem-state-${block.review}${block.suspect ? ' sem-state-suspect' : ''}` : ''

  return (
    <section id={id ? `block-${id}` : undefined} className={`sem-block sem-outcome${reviewClass}`}>
      <header className="sem-header">
        <span className="sem-kind sem-kind-outcome">OUTCOME</span>
        {id && <code className="sem-id">{id}</code>}
        {title && <span className="sem-title">{title}</span>}
        <span className="sem-badges">
          {!block && <span className={`sem-pill sem-pill-${safeStability}`}>{safeStability}</span>}
        </span>
      </header>
      {block && onMutate && <BlockReviewControls block={block} onMutate={onMutate} />}
      <div className="sem-body">{children}</div>
      {superseded.length > 0 && (
        <footer className="sem-footer">
          <span className="sem-meta-label">supersedes</span>
          {superseded.map((ref) => (
            <code key={ref} className="sem-ref-chip">
              {ref}
            </code>
          ))}
        </footer>
      )}
    </section>
  )
}

export interface NoteBlockProps {
  intent?: string
  title?: string
  children?: ReactNode
}

export function NoteBlock({ intent, title, children }: NoteBlockProps) {
  const { t } = useTranslation()
  const safeIntent = isNoteIntent(intent) ? intent : 'informative'
  const label =
    safeIntent === 'idea'
      ? t('blocks.noteIdea')
      : safeIntent === 'rejected'
        ? t('blocks.noteRejected')
        : t('blocks.noteInformative')
  return (
    <aside className={`sem-block sem-note sem-note-${safeIntent}`}>
      <header className="sem-header">
        <span className={`sem-kind sem-kind-note-${safeIntent}`}>{label}</span>
        {title && <span className="sem-title">{title}</span>}
      </header>
      <div className="sem-body">{children}</div>
    </aside>
  )
}

export interface TermDefBlockProps {
  id?: string
  aliases?: string
  symbols?: string
  children?: ReactNode
}

export function TermDefBlock({ id, aliases, symbols, children }: TermDefBlockProps) {
  const { block, onMutate } = useSemanticBlock(id)
  const aliasList = splitCsv(aliases)
  const symbolList = splitCsv(symbols)
  const reviewClass = block ? ` sem-state-${block.review}${block.suspect ? ' sem-state-suspect' : ''}` : ''

  return (
    <section id={id ? `block-${id}` : undefined} className={`sem-block sem-term${reviewClass}`}>
      <header className="sem-header">
        <span className="sem-kind sem-kind-term">TERM</span>
        {id && <strong className="sem-term-name">{id}</strong>}
        {aliasList.length > 0 && (
          <span className="sem-badges">
            {aliasList.map((a) => (
              <span key={a} className="sem-pill sem-pill-alias">
                {a}
              </span>
            ))}
          </span>
        )}
      </header>
      {block && onMutate && <BlockReviewControls block={block} onMutate={onMutate} />}
      <div className="sem-body">{children}</div>
      {symbolList.length > 0 && (
        <footer className="sem-footer">
          <span className="sem-meta-label">symbols</span>
          {symbolList.map((sym) => (
            <code key={sym} className="sem-ref-chip">
              {sym}
            </code>
          ))}
        </footer>
      )}
    </section>
  )
}
