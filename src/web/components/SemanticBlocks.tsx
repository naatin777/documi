import { createContext, useContext, useState, type FormEvent, type ReactNode } from 'react'
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
              ? `承認: ${block.approvedBy ?? ''} (${block.approvedCommit ?? 'uncommitted'} / ${block.approvedAt})`
              : '未承認'
          }
        >
          {block.review === 'approved' && '✓ Approved'}
          {block.review === 'unreviewed' && '○ Unreviewed'}
          {block.review === 'stale' && '↻ Stale (承認後に変更)'}
        </span>

        {block.suspect && (
          <span className="sem-review-badge sem-review-suspect" title={`上流変更: ${block.suspectSources.join(', ')}`}>
            ⚠ Suspect
          </span>
        )}

        {realization && (
          <button
            type="button"
            className={`sem-realization-badge sem-real-${realization.status}`}
            onClick={() => setShowTrace((v) => !v)}
            title="クリックで実装・テスト・PR の紐づけ詳細を表示"
          >
            {realization.status === 'verified' &&
              `● Verified (${realization.testResults.filter((t) => t.status === 'passed').length}/${realization.testResults.length})`}
            {realization.status === 'implemented' && `● Implemented (${realization.implementations.length})`}
            {realization.status === 'in-progress' && '◐ In Progress'}
            {realization.status === 'unimplemented' && '○ Unimplemented'}
            {realization.status === 'drifted' && '✕ Drifted'}
          </button>
        )}

        <button
          type="button"
          className={`sem-action-btn sem-pill-${block.stability}`}
          disabled={busy}
          onClick={() => void handleCycleStability()}
          title="クリックで安定度 (stable / evolving / volatile) を切替"
        >
          {block.stability}
        </button>

        {block.review === 'stale' && (
          <button
            type="button"
            className={`sem-action-btn${showDiff ? ' active' : ''}`}
            disabled={busy}
            onClick={() => void handleToggleDiff()}
          >
            Diff
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
            承認
          </button>
        )}
      </div>

      {block.suspect && block.suspectSources.length > 0 && (
        <div className="sem-suspect-banner">
          上流の変更が検知されました (
          {block.suspectSources.map((s) => (
            <code key={s}>{s}</code>
          ))}
          )。内容を確認して再承認してください。
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
            <span className="sem-meta-label">Implementations ({realization.implementations.length})</span>
            {realization.implementations.length === 0 ? (
              <span className="muted">なし</span>
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
            <span className="sem-meta-label">Tests ({realization.verifications.length})</span>
            {realization.verifications.length === 0 ? (
              <span className="muted">なし</span>
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
              <span className="sem-meta-label">Test Results ({realization.testResults.length})</span>
              <ul className="sem-trace-list">
                {realization.testResults.map((t, i) => (
                  <li key={i} className={`sem-test-${t.status}`}>
                    [{t.status}] {t.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {realization.pullRequests.length > 0 && (
            <div className="sem-trace-group">
              <span className="sem-meta-label">Pull Requests ({realization.pullRequests.length})</span>
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
              承認時点からの差分
              {diff.baseSource === 'git' && diff.baseCommit && ` (git ${diff.baseCommit})`}
              {diff.baseSource === 'cache' && ' (ローカル承認キャッシュ)'}
            </span>
            <button type="button" className="sem-diff-close" onClick={() => setShowDiff(false)}>
              閉じる
            </button>
          </div>
          {!diff.hasBase ? (
            <p className="muted sem-diff-empty">承認時点のベース本文を取得できませんでした。</p>
          ) : !diff.changed ? (
            <p className="muted sem-diff-empty">差分はありません。</p>
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
                      {fb.resolved ? '未解決に戻す' : '解決済みにする'}
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
              placeholder="AI 向けフィードバックを入力 (例: 5回ではなく3回にして)…"
              disabled={busy}
            />
            <button type="submit" className="sem-action-btn sem-approve-btn" disabled={busy || !draft.trim()}>
              送信
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

const NOTE_LABELS: Record<string, string> = {
  idea: 'IDEA / 未確定メモ',
  informative: 'NOTE',
  rejected: 'REJECTED / 不採用',
}

export function NoteBlock({ intent, title, children }: NoteBlockProps) {
  const safeIntent = isNoteIntent(intent) ? intent : 'informative'
  return (
    <aside className={`sem-block sem-note sem-note-${safeIntent}`}>
      <header className="sem-header">
        <span className={`sem-kind sem-kind-note-${safeIntent}`}>{NOTE_LABELS[safeIntent]}</span>
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
