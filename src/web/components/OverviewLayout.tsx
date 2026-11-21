import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ARTIFACT_TYPE_LABELS, ARTIFACT_TYPES } from '../../core/types'
import { api, encodeDocId } from '../api'
import type { OverviewResponse } from '../api'
import { useDocsRevision } from '../live'
import { ArtifactTypeIcon } from './BrandMark'

// @implements ui.web-viewer
export default function OverviewLayout() {
  const { t } = useTranslation()
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
        <article className="page doc-page overview-page">
          <header className="doc-header">
            <div className="doc-badges">
              <span className="badge badge-type">{t('overview.badge')}</span>
              {data && <span className="badge badge-format">{t('overview.livingSpec')}</span>}
            </div>
            <h1>{t('overview.title')}</h1>
            <p className="doc-description">{t('overview.description')}</p>
          </header>

          {error && <p className="error-text">{error}</p>}
          {!data && !error && <p className="muted">{t('common.loading')}</p>}

          {data && (
            <>
              <section className="ov-stats">
                <div className="ov-stat">
                  <span className="ov-stat-value">{data.documentCount}</span>
                  <span className="ov-stat-label">{t('overview.stats.documents')}</span>
                </div>
                <div className="ov-stat">
                  <span className="ov-stat-value">{data.reviews.approved}</span>
                  <span className="ov-stat-label">{t('overview.stats.approved')}</span>
                </div>
                <div className="ov-stat">
                  <span className="ov-stat-value">{data.reviews.unreviewed}</span>
                  <span className="ov-stat-label">{t('overview.stats.unreviewed')}</span>
                </div>
                <div className={`ov-stat${data.reviews.stale + data.reviews.suspect > 0 ? ' ov-stat-warn' : ''}`}>
                  <span className="ov-stat-value">{data.reviews.stale + data.reviews.suspect}</span>
                  <span className="ov-stat-label">{t('overview.stats.staleSuspect')}</span>
                </div>
                <div className={`ov-stat${data.reviews.openFeedback > 0 ? ' ov-stat-warn' : ''}`}>
                  <span className="ov-stat-value">{data.reviews.openFeedback}</span>
                  <span className="ov-stat-label">{t('overview.stats.openFeedback')}</span>
                </div>
                <div className={`ov-stat${totalIssues > 0 ? ' ov-stat-warn' : ''}`}>
                  <span className="ov-stat-value">{totalIssues}</span>
                  <span className="ov-stat-label">{t('overview.stats.issues')}</span>
                </div>
              </section>

              {data.attentionBlocks.length > 0 && (
                <section className="ov-section">
                  <h2>{t('overview.attentionBlocks')}</h2>
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
                          <p className="ov-card-desc">
                            {t('overview.upstreamChanged', { sources: b.suspectSources.join(', ') })}
                          </p>
                        )}
                      </Link>
                    ))}
                  </div>
                </section>
              )}

              {data.openFeedbackItems.length > 0 && (
                <section className="ov-section">
                  <h2>{t('overview.openFeedbackTitle', { count: data.openFeedbackItems.length })}</h2>
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
                <h2>{t('overview.artifactTypes')}</h2>
                <div className="ov-type-grid">
                  {ARTIFACT_TYPES.map((type) => (
                    <div key={type} className={`ov-type-card type-${type}`}>
                      <ArtifactTypeIcon type={type} size={14} className="ov-type-icon" />
                      <span className="ov-type-name">{ARTIFACT_TYPE_LABELS[type]}</span>
                      <span className="ov-type-count">{data.byType[type]}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="ov-section">
                <h2>{t('overview.goalsRoot')}</h2>
                {data.goals.length === 0 ? (
                  <p className="muted">{t('overview.noGoals')}</p>
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
                  <h2>{t('overview.decisionOutcomes')}</h2>
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
                  <h2>{t('overview.orphanSpecs', { count: data.orphanSpecs.length })}</h2>
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
                  <h2>{t('overview.allIssues', { count: totalIssues })}</h2>
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
              <section className="ov-section">
                <h2>{t('overview.realizationStability')}</h2>
                <div className="ov-breakdown-grid">
                  <div className="ov-breakdown-card">
                    <h3>{t('overview.realization')}</h3>
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
                  </div>
                  <div className="ov-breakdown-card">
                    <h3>Specs by Intent</h3>
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
                  </div>
                  <div className="ov-breakdown-card">
                    <h3>Specs by Stability</h3>
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
                  </div>
                </div>
              </section>
            </>
          )}
        </article>
      </main>
    </>
  )
}
