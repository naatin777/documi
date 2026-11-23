import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { ARTIFACT_TYPES } from '../../core/types'
import { encodeDocId } from '../api'
import { toErrorMessage, useOverviewQuery } from '../queries'
import { formatDateTime, formatRelativeTime, formatShortDate } from '../time'
import { ArtifactTypeIcon } from './BrandMark'

function statCard(warn = false) {
  return `flex flex-col gap-0.5 rounded-[10px] border bg-sidebar px-3.5 py-3 ${warn ? 'border-amber-600' : 'border-line'}`
}

// @implements ui.web-viewer
export default function OverviewLayout() {
  const { t, i18n } = useTranslation()
  const { data, error: queryError } = useOverviewQuery()
  const error = toErrorMessage(queryError)

  const totalIssues = data ? data.indexIssues.length + data.docIssues.length : 0

  const cardClass =
    'block rounded-lg border border-line border-l-[3px] border-l-[var(--tc)] bg-surface px-3.5 py-3 text-inherit no-underline hover:bg-subtle'

  const kvListClass =
    'm-0 grid list-none gap-1.5 p-0 [&_li]:flex [&_li]:justify-between [&_li]:text-[13px] [&_li]:text-fg-muted [&_strong]:text-fg'

  return (
    <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface max-[900px]:flex-none max-[900px]:overflow-visible">
      <article className="page doc-page">
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
            <section className="my-5 mb-7 grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2.5">
              <div className={statCard()}>
                <span className="text-2xl leading-[1.2] font-bold">{data.documentCount}</span>
                <span className="text-xs text-fg-muted">{t('overview.stats.documents')}</span>
              </div>
              <div className={statCard()}>
                <span className="text-2xl leading-[1.2] font-bold">{data.reviews.approved}</span>
                <span className="text-xs text-fg-muted">{t('overview.stats.approved')}</span>
              </div>
              <div className={statCard()}>
                <span className="text-2xl leading-[1.2] font-bold">{data.reviews.unreviewed}</span>
                <span className="text-xs text-fg-muted">{t('overview.stats.unreviewed')}</span>
              </div>
              <div className={statCard(data.reviews.stale + data.reviews.suspect > 0)}>
                <span className="text-2xl leading-[1.2] font-bold">{data.reviews.stale + data.reviews.suspect}</span>
                <span className="text-xs text-fg-muted">{t('overview.stats.staleSuspect')}</span>
              </div>
              <div className={statCard(data.reviews.openFeedback > 0)}>
                <span className="text-2xl leading-[1.2] font-bold">{data.reviews.openFeedback}</span>
                <span className="text-xs text-fg-muted">{t('overview.stats.openFeedback')}</span>
              </div>
              <div className={statCard(totalIssues > 0)}>
                <span className="text-2xl leading-[1.2] font-bold">{totalIssues}</span>
                <span className="text-xs text-fg-muted">{t('overview.stats.issues')}</span>
              </div>
            </section>

            {data.recentDocuments.length > 0 && (
              <section className="mb-7">
                <div className="mb-3 flex items-center gap-2">
                  <h2 className="m-0 text-[15px] font-bold text-fg">{t('overview.recentlyUpdated')}</h2>
                  {data.uncommittedCount > 0 && (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-400">
                      {t('overview.uncommittedCount', { count: data.uncommittedCount })}
                    </span>
                  )}
                </div>
                <div className="grid gap-2">
                  {data.recentDocuments.map((d) => (
                    <Link key={d.id} to={`/docs/${encodeDocId(d.id)}`} className={`${cardClass} type-${d.type}`}>
                      <div className="mb-0.5 flex flex-wrap items-center gap-2">
                        <ArtifactTypeIcon type={d.type} size={13} className="shrink-0 text-[var(--tc)]" />
                        <span className="text-[14px] font-bold text-fg">{d.title}</span>
                        {d.freshness?.workingStatus && (
                          <span className="rounded-full bg-emerald-500/15 px-1.5 py-px text-[10.5px] font-bold text-emerald-700 dark:text-emerald-400">
                            {t('overview.uncommittedBadge')}
                          </span>
                        )}
                        {d.freshness?.updatedAt && (
                          <span
                            className="ml-auto shrink-0 text-[11.5px] text-fg-muted"
                            title={formatDateTime(d.freshness.updatedAt)}
                          >
                            {t('overview.updatedAtLabel', {
                              time: formatRelativeTime(d.freshness.updatedAt, i18n.language),
                            })}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-fg-muted">
                        <span className="mono">{d.path}</span>
                        {d.freshness?.createdAt && (
                          <span title={formatDateTime(d.freshness.createdAt)}>
                            {t('overview.createdAtLabel', { date: formatShortDate(d.freshness.createdAt) })}
                          </span>
                        )}
                        {d.freshness?.lastCommitSubject && (
                          <span className="truncate">
                            {d.freshness.lastCommitSha ? `${d.freshness.lastCommitSha} · ` : ''}
                            {d.freshness.lastCommitSubject}
                          </span>
                        )}
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {data.attentionBlocks.length > 0 && (
              <section className="mb-7">
                <h2 className="m-0 mb-3 text-[15px] font-bold text-fg">{t('overview.attentionBlocks')}</h2>
                <div className="grid gap-2.5">
                  {data.attentionBlocks.map((b) => (
                    <Link
                      key={b.id}
                      to={`/docs/${encodeDocId(b.docId)}#block-${encodeURIComponent(b.id)}`}
                      className={`${cardClass} !border-l-amber-600`}
                    >
                      <div className="mb-1 flex items-center gap-2">
                        <code className="sem-id">{b.id}</code>
                        {b.review === 'stale' && (
                          <span className="sem-review-badge sem-review-stale">{t('status.review.stale')}</span>
                        )}
                        {b.suspect && (
                          <span className="sem-review-badge sem-review-suspect">{t('status.review.suspect')}</span>
                        )}
                        <span className="text-xs text-fg-muted">{b.docTitle}</span>
                      </div>
                      {b.suspectSources.length > 0 && (
                        <p className="mt-1 mb-1.5 text-[13.5px] text-fg-muted">
                          {t('overview.upstreamChanged', { sources: b.suspectSources.join(', ') })}
                        </p>
                      )}
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {data.openFeedbackItems.length > 0 && (
              <section className="mb-7">
                <h2 className="m-0 mb-3 text-[15px] font-bold text-fg">
                  {t('overview.openFeedbackTitle', { count: data.openFeedbackItems.length })}
                </h2>
                <div className="grid gap-2.5">
                  {data.openFeedbackItems.map((fb) => (
                    <Link
                      key={fb.feedbackId}
                      to={`/docs/${encodeDocId(fb.docId)}#block-${encodeURIComponent(fb.blockId)}`}
                      className={`${cardClass} type-spec`}
                    >
                      <div className="mb-1 flex items-center gap-2">
                        <code className="sem-id">{fb.blockId}</code>
                        <span className="text-xs text-fg-muted">
                          {fb.docTitle} · {fb.author}
                        </span>
                      </div>
                      <p className="mt-1 mb-1.5 text-[13.5px] text-fg-muted">{fb.body}</p>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            <section className="mb-7">
              <h2 className="m-0 mb-3 text-[15px] font-bold text-fg">{t('overview.artifactTypes')}</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                {ARTIFACT_TYPES.map((type) => (
                  <div
                    key={type}
                    className={`flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-2 text-[13px] type-${type}`}
                  >
                    <ArtifactTypeIcon type={type} size={14} className="shrink-0 text-[var(--tc)]" />
                    <span>{t(`types.singular.${type}`)}</span>
                    <span className="ml-auto text-xs font-bold text-fg-muted">{data.byType[type]}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="mb-7">
              <h2 className="m-0 mb-3 text-[15px] font-bold text-fg">{t('overview.goalsRoot')}</h2>
              {data.goals.length === 0 ? (
                <p className="muted">{t('overview.noGoals')}</p>
              ) : (
                <div className="grid gap-2.5">
                  {data.goals.map((g) => (
                    <Link key={g.id} to={`/docs/${encodeDocId(g.id)}`} className={`${cardClass} type-goal`}>
                      <div className="text-[14.5px] font-bold">{g.title}</div>
                      {g.description && <p className="mt-1 mb-1.5 text-[13.5px] text-fg-muted">{g.description}</p>}
                      <span className="mono text-[11.5px] text-fg-muted">{g.path}</span>
                    </Link>
                  ))}
                </div>
              )}
            </section>

            {data.outcomes.length > 0 && (
              <section className="mb-7">
                <h2 className="m-0 mb-3 text-[15px] font-bold text-fg">{t('overview.decisionOutcomes')}</h2>
                <div className="grid gap-2.5">
                  {data.outcomes.map((o) => (
                    <Link
                      key={o.id}
                      to={`/docs/${encodeDocId(o.docId)}#block-${encodeURIComponent(o.id)}`}
                      className={`${cardClass} type-decision`}
                    >
                      <div className="mb-1 flex items-center gap-2">
                        <code className="sem-id">{o.id}</code>
                        <span className="text-xs text-fg-muted">{o.docTitle}</span>
                        {o.date && <span className="mono ml-auto shrink-0 text-[11px] text-fg-muted">{o.date}</span>}
                      </div>
                      <p className="mt-1 mb-1.5 text-[13.5px] text-fg-muted">{o.rawBody}</p>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {data.orphanSpecs.length > 0 && (
              <section className="issues-panel mb-7">
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
              <section className="issues-panel mb-7">
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

            <section className="mb-7">
              <h2 className="m-0 mb-3 text-[15px] font-bold text-fg">{t('overview.realizationStability')}</h2>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
                <div className="rounded-[10px] border border-line bg-sidebar px-3.5 py-3">
                  <h3 className="m-0 mb-2 text-[11.5px] font-bold tracking-[0.05em] text-fg-muted uppercase">
                    {t('overview.realization')}
                  </h3>
                  <ul className={kvListClass}>
                    <li>
                      <span>{t('status.realization.verified')}</span>
                      <strong>{data.realizations.verified}</strong>
                    </li>
                    <li>
                      <span>{t('status.realization.implemented')}</span>
                      <strong>{data.realizations.implemented}</strong>
                    </li>
                    <li>
                      <span>{t('status.realization.in-progress')}</span>
                      <strong>{data.realizations['in-progress']}</strong>
                    </li>
                    <li>
                      <span>{t('status.realization.unimplemented')}</span>
                      <strong>{data.realizations.unimplemented}</strong>
                    </li>
                    <li>
                      <span>{t('status.realization.drifted')}</span>
                      <strong>{data.realizations.drifted}</strong>
                    </li>
                  </ul>
                </div>
                <div className="rounded-[10px] border border-line bg-sidebar px-3.5 py-3">
                  <h3 className="m-0 mb-2 text-[11.5px] font-bold tracking-[0.05em] text-fg-muted uppercase">
                    {t('overview.specsByIntent')}
                  </h3>
                  <ul className={kvListClass}>
                    <li>
                      <span>{t('status.intent.normative')}</span>
                      <strong>{data.specsByIntent.normative}</strong>
                    </li>
                    <li>
                      <span>{t('status.intent.idea')}</span>
                      <strong>{data.specsByIntent.idea}</strong>
                    </li>
                    <li>
                      <span>{t('status.intent.rejected')}</span>
                      <strong>{data.specsByIntent.rejected}</strong>
                    </li>
                  </ul>
                </div>
                <div className="rounded-[10px] border border-line bg-sidebar px-3.5 py-3">
                  <h3 className="m-0 mb-2 text-[11.5px] font-bold tracking-[0.05em] text-fg-muted uppercase">
                    {t('overview.specsByStability')}
                  </h3>
                  <ul className={kvListClass}>
                    <li>
                      <span>{t('status.stability.stable')}</span>
                      <strong>{data.specsByStability.stable}</strong>
                    </li>
                    <li>
                      <span>{t('status.stability.evolving')}</span>
                      <strong>{data.specsByStability.evolving}</strong>
                    </li>
                    <li>
                      <span>{t('status.stability.volatile')}</span>
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
  )
}
