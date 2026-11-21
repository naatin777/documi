import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ARTIFACT_TYPE_LABELS, ARTIFACT_TYPES } from '../../core/types'
import { api, encodeDocId } from '../api'
import type { OverviewResponse } from '../api'
import { useDocsRevision } from '../live'
import DocTabs from './DocTabs'

// @implements ui.web-viewer
export default function OverviewLayout() {
  const revision = useDocsRevision()
  const [data, setData] = useState<OverviewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .overview()
      .then((res) => {
        if (!cancelled) {
          setData(res)
          setError(null)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [revision])

  const totalIssues = data ? data.indexIssues.length + data.docIssues.length : 0

  return (
    <>
      <main className="content">
        <DocTabs />
        <article className="page doc-page overview-page">
          <header className="doc-header">
            <div className="doc-badges">
              <span className="badge badge-type">Overview</span>
              {data && <span className="badge badge-format">Living Specification</span>}
            </div>
            <h1>Project Overview</h1>
            <p className="doc-description">
              Goal を起点とした仕様・契約・設計・決定・用語の整合性と、人間のレビュー状態を確認できます。
            </p>
          </header>

          {error && <p className="error-text">{error}</p>}
          {!data && !error && <p className="muted">読み込み中…</p>}

          {data && (
            <>
              <section className="ov-stats">
                <div className="ov-stat">
                  <span className="ov-stat-value">{data.documentCount}</span>
                  <span className="ov-stat-label">Documents</span>
                </div>
                <div className="ov-stat">
                  <span className="ov-stat-value">{data.reviews.approved}</span>
                  <span className="ov-stat-label">Approved</span>
                </div>
                <div className="ov-stat">
                  <span className="ov-stat-value">{data.reviews.unreviewed}</span>
                  <span className="ov-stat-label">Unreviewed</span>
                </div>
                <div className={`ov-stat${data.reviews.stale + data.reviews.suspect > 0 ? ' ov-stat-warn' : ''}`}>
                  <span className="ov-stat-value">{data.reviews.stale + data.reviews.suspect}</span>
                  <span className="ov-stat-label">Stale / Suspect</span>
                </div>
                <div className={`ov-stat${data.reviews.openFeedback > 0 ? ' ov-stat-warn' : ''}`}>
                  <span className="ov-stat-value">{data.reviews.openFeedback}</span>
                  <span className="ov-stat-label">Open Feedback</span>
                </div>
                <div className={`ov-stat${totalIssues > 0 ? ' ov-stat-warn' : ''}`}>
                  <span className="ov-stat-value">{totalIssues}</span>
                  <span className="ov-stat-label">Issues</span>
                </div>
              </section>

              {data.attentionBlocks.length > 0 && (
                <section className="ov-section">
                  <h2>要確認ブロック (Stale / Suspect)</h2>
                  <div className="ov-card-list">
                    {data.attentionBlocks.map((b) => (
                      <Link
                        key={b.id}
                        to={`/docs/${encodeDocId(b.docId)}#block-${encodeURIComponent(b.id)}`}
                        className="ov-card ov-card-warn"
                      >
                        <div className="ov-card-head">
                          <code className="sem-id">{b.id}</code>
                          {b.review === 'stale' && <span className="sem-review-badge sem-review-stale">Stale</span>}
                          {b.suspect && <span className="sem-review-badge sem-review-suspect">Suspect</span>}
                          <span className="ov-card-sub">{b.docTitle}</span>
                        </div>
                        {b.suspectSources.length > 0 && (
                          <p className="ov-card-desc">上流変更: {b.suspectSources.join(', ')}</p>
                        )}
                      </Link>
                    ))}
                  </div>
                </section>
              )}

              {data.openFeedbackItems.length > 0 && (
                <section className="ov-section">
                  <h2>未解決フィードバック ({data.openFeedbackItems.length})</h2>
                  <div className="ov-card-list">
                    {data.openFeedbackItems.map((fb) => (
                      <Link
                        key={fb.feedbackId}
                        to={`/docs/${encodeDocId(fb.docId)}#block-${encodeURIComponent(fb.blockId)}`}
                        className="ov-card type-spec"
                      >
                        <div className="ov-card-head">
                          <code className="sem-id">{fb.blockId}</code>
                          <span className="ov-card-sub">
                            {fb.docTitle} · {fb.author}
                          </span>
                        </div>
                        <p className="ov-card-desc">{fb.body}</p>
                      </Link>
                    ))}
                  </div>
                </section>
              )}

              <section className="ov-section">
                <h2>Artifact Types</h2>
                <div className="ov-type-grid">
                  {ARTIFACT_TYPES.map((type) => (
                    <div key={type} className={`ov-type-card type-${type}`}>
                      <span className="ov-type-dot" />
                      <span className="ov-type-name">{ARTIFACT_TYPE_LABELS[type]}</span>
                      <span className="ov-type-count">{data.byType[type]}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="ov-section">
                <h2>Goals (Root)</h2>
                {data.goals.length === 0 ? (
                  <p className="muted">Goal ドキュメントがまだありません。</p>
                ) : (
                  <div className="ov-card-list">
                    {data.goals.map((g) => (
                      <Link key={g.id} to={`/docs/${encodeDocId(g.id)}`} className="ov-card type-goal">
                        <div className="ov-card-title">{g.title}</div>
                        {g.description && <p className="ov-card-desc">{g.description}</p>}
                        <span className="ov-card-path mono">{g.path}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </section>

              {data.outcomes.length > 0 && (
                <section className="ov-section">
                  <h2>Decision Outcomes (ADR 結論)</h2>
                  <div className="ov-card-list">
                    {data.outcomes.map((o) => (
                      <Link
                        key={o.id}
                        to={`/docs/${encodeDocId(o.docId)}#block-${encodeURIComponent(o.id)}`}
                        className="ov-card type-decision"
                      >
                        <div className="ov-card-head">
                          <code className="sem-id">{o.id}</code>
                          <span className="ov-card-sub">{o.docTitle}</span>
                          {o.date && <span className="ov-card-date mono">{o.date}</span>}
                        </div>
                        <p className="ov-card-desc">{o.rawBody}</p>
                      </Link>
                    ))}
                  </div>
                </section>
              )}

              {data.orphanSpecs.length > 0 && (
                <section className="ov-section issues-panel">
                  <h2>Orphan Specs ({data.orphanSpecs.length})</h2>
                  <ul>
                    {data.orphanSpecs.map((item, i) => (
                      <li key={i}>
                        <Link to={`/docs/${encodeDocId(item.docId)}`}>{item.docTitle}</Link>: {item.message}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {totalIssues > 0 && (
                <section className="ov-section issues-panel">
                  <h2>すべての問題 ({totalIssues})</h2>
                  <ul>
                    {data.indexIssues.map((issue, i) => (
                      <li key={`idx-${i}`}>
                        <code>{issue.code}</code> {issue.path && <code>{issue.path}</code>} {issue.message}
                      </li>
                    ))}
                    {data.docIssues.map((issue, i) => (
                      <li key={`doc-${i}`}>
                        <code>{issue.code}</code> <Link to={`/docs/${encodeDocId(issue.docId)}`}>{issue.docId}</Link>:{' '}
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </article>
      </main>
      <aside className="side-panel">
        {data && (
          <>
            <section className="rp-section">
              <h2 className="rp-title">Human Review</h2>
              <ul className="ov-kv">
                <li>
                  <span>approved</span>
                  <strong>{data.reviews.approved}</strong>
                </li>
                <li>
                  <span>unreviewed</span>
                  <strong>{data.reviews.unreviewed}</strong>
                </li>
                <li>
                  <span>stale</span>
                  <strong>{data.reviews.stale}</strong>
                </li>
                <li>
                  <span>suspect</span>
                  <strong>{data.reviews.suspect}</strong>
                </li>
              </ul>
            </section>
            <section className="rp-section">
              <h2 className="rp-title">Realization</h2>
              <ul className="ov-kv">
                <li>
                  <span>verified</span>
                  <strong>{data.realizations.verified}</strong>
                </li>
                <li>
                  <span>implemented</span>
                  <strong>{data.realizations.implemented}</strong>
                </li>
                <li>
                  <span>in-progress</span>
                  <strong>{data.realizations['in-progress']}</strong>
                </li>
                <li>
                  <span>unimplemented</span>
                  <strong>{data.realizations.unimplemented}</strong>
                </li>
                <li>
                  <span>drifted</span>
                  <strong>{data.realizations.drifted}</strong>
                </li>
              </ul>
            </section>
            <section className="rp-section">
              <h2 className="rp-title">Specs by Intent</h2>
              <ul className="ov-kv">
                <li>
                  <span>normative</span>
                  <strong>{data.specsByIntent.normative}</strong>
                </li>
                <li>
                  <span>idea</span>
                  <strong>{data.specsByIntent.idea}</strong>
                </li>
                <li>
                  <span>rejected</span>
                  <strong>{data.specsByIntent.rejected}</strong>
                </li>
              </ul>
            </section>
            <section className="rp-section">
              <h2 className="rp-title">Specs by Stability</h2>
              <ul className="ov-kv">
                <li>
                  <span>stable</span>
                  <strong>{data.specsByStability.stable}</strong>
                </li>
                <li>
                  <span>evolving</span>
                  <strong>{data.specsByStability.evolving}</strong>
                </li>
                <li>
                  <span>volatile</span>
                  <strong>{data.specsByStability.volatile}</strong>
                </li>
              </ul>
            </section>
          </>
        )}
      </aside>
    </>
  )
}
