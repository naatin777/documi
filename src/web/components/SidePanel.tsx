import { Columns2, History, PanelRightClose } from 'lucide-react'
import { useMemo, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router'
import type { ChangedLineRange, Document, DocumentHistory, GitCommitEntry, ResolvedRelation } from '../../core/types'
import { encodeDocId } from '../api'
import type { Heading } from '../headings'
import { formatDateTime, formatRelativeTime } from '../time'
import ResizeHandle, { useResizableWidth } from './ResizeHandle'

export type InspectorTab = 'outline' | 'links' | 'history'

interface SidePanelProps {
  doc: Document
  headings: Heading[]
  history?: DocumentHistory | null
  highlightChanges?: boolean
  activeTab?: InspectorTab
  onTabChange?: (tab: InspectorTab) => void
  onPeek: (docId: string, focusBlockId?: string) => void
  onPeekRevision?: (commitSha: string) => void
  onCollapse: () => void
}

const TRACE_KINDS = new Set(['derives', 'satisfies', 'verifies', 'supersedes'])

const EDGE_KIND_STYLES: Record<string, string> = {
  derives: 'border-amber-500 text-amber-700 dark:text-amber-400',
  satisfies: 'border-teal-500 text-teal-700 dark:text-teal-400',
  verifies: 'border-green-500 text-green-700 dark:text-green-400',
  supersedes: 'border-rose-500 text-rose-700 dark:text-rose-400',
}

const COMMIT_STATUS_STYLES: Record<GitCommitEntry['status'], string> = {
  A: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  M: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  R: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
  C: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
  D: 'bg-rose-500/15 text-rose-700 dark:text-rose-400',
}

function tabClass(active: boolean) {
  return `inline-flex cursor-pointer items-center gap-[4px] rounded-[5px] border-0 px-2 py-[3px] text-[11.5px] font-semibold ${
    active ? 'bg-surface text-fg shadow-[0_1px_2px_rgba(15,23,42,0.08)]' : 'bg-transparent text-fg-muted hover:text-fg'
  }`
}

function rangeOverlaps(
  start: number | undefined,
  end: number | undefined,
  ranges?: readonly ChangedLineRange[],
): boolean {
  if (!ranges || ranges.length === 0 || start === undefined) return false
  const e = end ?? start
  return ranges.some((r) => r.startLine <= e && r.endLine >= start)
}

// @implements ui.doc-history
export default function SidePanel({
  doc,
  headings,
  history,
  highlightChanges = true,
  activeTab,
  onTabChange,
  onPeek,
  onPeekRevision,
  onCollapse,
}: SidePanelProps) {
  const { t, i18n } = useTranslation()
  const [internalTab, setInternalTab] = useState<InspectorTab>('outline')
  const tab = activeTab ?? internalTab
  const setTab = (next: InspectorTab) => {
    setInternalTab(next)
    onTabChange?.(next)
  }

  const {
    width: panelWidth,
    setWidth: setPanelWidth,
    resetWidth: resetPanelWidth,
  } = useResizableWidth({
    storageKey: 'documi:inspector-width',
    defaultWidth: 300,
    minWidth: 220,
    maxWidth: 480,
  })

  const reviewStats = useMemo(() => {
    let total = 0
    let approved = 0
    let attention = 0
    let verified = 0
    let specTotal = 0
    for (const b of doc.blocks) {
      if (b.kind !== 'note') {
        total++
        if (b.review === 'approved' && !b.suspect) approved++
        if (b.review === 'stale' || b.suspect) attention++
      }
      if (b.realization) {
        specTotal++
        if (b.realization.status === 'verified') verified++
      }
    }
    return { total, approved, attention, verified, specTotal }
  }, [doc.blocks])

  const upstream = useMemo(() => doc.outgoing.filter((r) => TRACE_KINDS.has(r.kind)), [doc.outgoing])
  const downstream = useMemo(() => doc.incoming.filter((r) => TRACE_KINDS.has(r.kind)), [doc.incoming])
  const mentions = useMemo(() => {
    const seen = new Set<string>()
    const list: ResolvedRelation[] = []
    for (const r of [...doc.outgoing, ...doc.incoming]) {
      if (r.kind !== 'mentions') continue
      const key = `${r.docId}:${r.ref}`
      if (seen.has(key)) continue
      seen.add(key)
      list.push(r)
    }
    return list
  }, [doc.outgoing, doc.incoming])

  const totalLinks = upstream.length + downstream.length + doc.sourceRefs.length + mentions.length
  const commits = history?.commits ?? []
  const freshness = history?.freshness ?? doc.freshness
  const activeChangedRanges = highlightChanges ? history?.changedRanges : undefined

  return (
    <>
      <ResizeHandle
        side="left"
        width={panelWidth}
        minWidth={220}
        maxWidth={480}
        onChange={setPanelWidth}
        onReset={resetPanelWidth}
        label={t('resize.inspector')}
      />
      <aside
        className="flex min-h-0 min-w-0 shrink-0 grow-0 flex-col overflow-hidden border-l border-line bg-sidebar max-desktop:flex-none max-desktop:basis-auto max-desktop:overflow-visible max-desktop:border-t max-desktop:border-l-0 desktop:basis-(--pane-width) print:hidden"
        style={{ '--pane-width': `${panelWidth}px` } as CSSProperties}
        aria-label={t('inspector.ariaLabel')}
      >
        <header className="flex shrink-0 items-center justify-between gap-1.5 border-b border-line px-2.5 py-1.5">
          <div
            className="inline-flex gap-0.5 rounded-[7px] border border-line bg-subtle p-0.5"
            role="tablist"
            aria-label={t('inspector.switchAria')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'outline'}
              className={tabClass(tab === 'outline')}
              onClick={() => setTab('outline')}
            >
              {t('inspector.outline')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'links'}
              className={tabClass(tab === 'links')}
              onClick={() => setTab('links')}
            >
              {t('inspector.links')} <span className="text-[10px] opacity-75">{totalLinks}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'history'}
              className={tabClass(tab === 'history')}
              onClick={() => setTab('history')}
            >
              {t('inspector.history')}
              {commits.length > 0 && <span className="text-[10px] opacity-75">{commits.length}</span>}
            </button>
          </div>
          <button
            type="button"
            className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-[5px] border-0 bg-transparent text-fg-muted hover:bg-hover hover:text-fg"
            onClick={onCollapse}
            title={t('inspector.closePanel')}
            aria-label={t('inspector.closePanel')}
          >
            <PanelRightClose size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>

        {reviewStats.total > 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-line px-3.5 py-[7px] text-[11.5px] text-fg-muted">
            <span>
              Approved <strong className="text-fg">{reviewStats.approved}</strong>/{reviewStats.total}
            </span>
            {reviewStats.specTotal > 0 && (
              <span>
                Verified <strong className="text-fg">{reviewStats.verified}</strong>/{reviewStats.specTotal}
              </span>
            )}
            {reviewStats.attention > 0 && (
              <span className="ml-auto rounded-full bg-amber-600/16 px-1.5 py-px text-[10.5px] font-bold text-amber-700 dark:text-amber-500">
                {t('inspector.attentionCount', { count: reviewStats.attention })}
              </span>
            )}
          </div>
        )}

        {tab === 'outline' && (
          <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pt-3.5 pb-10">
            {doc.blocks.length > 0 && (
              <section className="mb-7">
                <h2 className="m-0 mb-2.5 text-[11px] font-bold tracking-[0.07em] text-fg-muted uppercase">
                  {t('inspector.blocks', { count: doc.blocks.length })}
                </h2>
                <ul className="m-0 grid list-none gap-1 p-0">
                  {doc.blocks.map((b) => {
                    const dotClass = b.suspect ? 'suspect' : b.review
                    const changed = rangeOverlaps(b.startLine, b.endLine, activeChangedRanges)
                    return (
                      <li key={b.id}>
                        <button
                          type="button"
                          className="flex w-full cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-1 text-left text-xs text-fg hover:bg-hover"
                          onClick={() => scrollToElement(`block-${b.id}`)}
                          title={`${b.id} (${b.suspect ? 'suspect' : b.review})`}
                        >
                          {b.kind !== 'note' && <span className={`rp-review-dot rp-review-${dotClass}`} />}
                          <span className="shrink-0 rounded bg-accent-soft px-[5px] py-px text-[10px] font-bold text-fg-muted uppercase">
                            {b.kind}
                          </span>
                          <span className="mono truncate">{b.id}</span>
                          {changed && (
                            <span
                              className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500"
                              title={t('inspector.changedSectionTitle')}
                            />
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}

            {headings.length > 0 ? (
              <section className="mb-7">
                <h2 className="m-0 mb-2.5 text-[11px] font-bold tracking-[0.07em] text-fg-muted uppercase">
                  {t('inspector.headings')}
                </h2>
                <ul className="m-0 list-none p-0">
                  {headings.map((h, i) => {
                    const changed = rangeOverlaps(h.line, h.sectionEndLine, activeChangedRanges)
                    return (
                      <li key={`${h.id}-${i}`} style={{ paddingLeft: `${(h.level - 1) * 12}px` }}>
                        <button
                          type="button"
                          className="flex w-full cursor-pointer items-center gap-1.5 rounded-[5px] border-0 bg-transparent px-2 py-[3px] text-left text-[13px] text-fg hover:bg-hover"
                          onClick={() => scrollToElement(h.id)}
                        >
                          <span className="min-w-0 flex-1 truncate">{h.text}</span>
                          {changed && (
                            <span
                              className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500"
                              title={t('inspector.changedSectionTitle')}
                            />
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ) : (
              doc.blocks.length === 0 && (
                <p className="m-0 text-[12.5px] text-fg-muted">{t('inspector.emptyOutline')}</p>
              )
            )}
          </div>
        )}

        {tab === 'links' && (
          <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pt-3.5 pb-10">
            <section className="mb-7">
              <h2 className="m-0 mb-2.5 text-[11px] font-bold tracking-[0.07em] text-fg-muted uppercase">
                {t('inspector.upstream', { count: upstream.length })}
              </h2>
              <RelationList items={upstream} empty={t('inspector.emptyUpstream')} onPeek={onPeek} />
            </section>

            <section className="mb-7">
              <h2 className="m-0 mb-2.5 text-[11px] font-bold tracking-[0.07em] text-fg-muted uppercase">
                {t('inspector.downstream', { count: downstream.length })}
              </h2>
              <RelationList items={downstream} empty={t('inspector.emptyDownstream')} onPeek={onPeek} />
            </section>

            {doc.sourceRefs.length > 0 && (
              <section className="mb-7">
                <h2 className="m-0 mb-2.5 text-[11px] font-bold tracking-[0.07em] text-fg-muted uppercase">
                  {t('inspector.sourceRefs', { count: doc.sourceRefs.length })}
                </h2>
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {doc.sourceRefs.map((ref, i) => {
                    const qs = new URLSearchParams({ file: ref.file })
                    if (ref.mode === 'lines') qs.set('lines', ref.lines)
                    const keySuffix =
                      ref.mode === 'symbol' ? ref.symbol : ref.mode === 'lines' ? ref.lines : `exports-${i}`
                    return (
                      <li
                        key={`${ref.file}:${keySuffix}`}
                        className="mono rounded-md border border-line bg-surface px-2 py-[5px] text-[11px] [overflow-wrap:anywhere]"
                      >
                        <NavLink
                          to={`/code?${qs.toString()}`}
                          className="group inline-flex flex-wrap text-inherit no-underline"
                        >
                          <span className="group-hover:text-accent group-hover:underline">{ref.file}</span>
                          {ref.mode === 'symbol' && <span className="text-fg-muted">#{ref.symbol}</span>}
                          {ref.mode === 'lines' && <span className="text-fg-muted">:L{ref.lines}</span>}
                          {ref.mode === 'exports' && <span className="text-fg-muted"> [exports]</span>}
                        </NavLink>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}

            {mentions.length > 0 && (
              <section className="mb-7">
                <h2 className="m-0 mb-2.5 text-[11px] font-bold tracking-[0.07em] text-fg-muted uppercase">
                  {t('inspector.mentions', { count: mentions.length })}
                </h2>
                <RelationList items={mentions} empty="" onPeek={onPeek} />
              </section>
            )}
          </div>
        )}

        {tab === 'history' && (
          <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pt-3.5 pb-10">
            <section className="mb-6">
              <h2 className="m-0 mb-2.5 text-[11px] font-bold tracking-[0.07em] text-fg-muted uppercase">
                {t('inspector.historySummary')}
              </h2>
              <dl className="m-0 grid gap-1.5 rounded-[7px] border border-line bg-surface px-2.5 py-2 text-xs">
                {freshness?.createdAt && (
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-fg-muted">{t('inspector.historyCreated')}</dt>
                    <dd className="mono m-0 text-[11px] text-fg">{formatDateTime(freshness.createdAt)}</dd>
                  </div>
                )}
                {freshness?.updatedAt && (
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-fg-muted">{t('inspector.historyUpdated')}</dt>
                    <dd className="mono m-0 text-[11px] text-fg" title={formatDateTime(freshness.updatedAt)}>
                      {formatRelativeTime(freshness.updatedAt, i18n.language)}
                    </dd>
                  </div>
                )}
                {freshness?.workingStatus && (
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-fg-muted">{t('inspector.historyWorking')}</dt>
                    <dd className="m-0 font-semibold text-emerald-700 dark:text-emerald-400">
                      {freshness.workingStatus === 'modified'
                        ? t('inspector.historyWorkingModified')
                        : freshness.workingStatus === 'added'
                          ? t('inspector.historyWorkingAdded')
                          : t('inspector.historyWorkingUntracked')}
                    </dd>
                  </div>
                )}
              </dl>
            </section>

            <section className="mb-7">
              <h2 className="m-0 mb-2.5 flex items-center gap-1.5 text-[11px] font-bold tracking-[0.07em] text-fg-muted uppercase">
                <History size={12} strokeWidth={1.85} aria-hidden="true" />
                <span>{t('inspector.historyCommits', { count: commits.length })}</span>
              </h2>
              {history && !history.gitAvailable ? (
                <p className="m-0 text-[12.5px] text-fg-muted">{t('inspector.historyUnavailable')}</p>
              ) : commits.length === 0 ? (
                <p className="m-0 text-[12.5px] text-fg-muted">{t('inspector.historyEmpty')}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {commits.map((commit, index) => (
                    <li key={commit.sha}>
                      <button
                        type="button"
                        className="block w-full cursor-pointer rounded-[7px] border border-line bg-surface px-2.5 py-2 text-left text-fg hover:border-accent hover:bg-accent-soft"
                        onClick={() => onPeekRevision?.(commit.sha)}
                        title={t('inspector.historyOpenRevision', { sha: commit.shortSha })}
                      >
                        <div className="mb-1 flex items-center gap-1.5">
                          <span
                            className={`rounded px-1 py-px font-mono text-[10px] font-bold ${COMMIT_STATUS_STYLES[commit.status]}`}
                          >
                            {commit.status}
                          </span>
                          <code className="font-mono text-[11px] font-semibold text-fg">{commit.shortSha}</code>
                          {index === 0 && (
                            <span className="rounded-full bg-accent-soft px-1.5 py-px text-[9.5px] font-bold text-accent">
                              {t('inspector.historyLatestTag')}
                            </span>
                          )}
                          <span className="ml-auto text-[10.5px] text-fg-muted" title={formatDateTime(commit.date)}>
                            {formatRelativeTime(commit.date, i18n.language)}
                          </span>
                        </div>
                        <div className="line-clamp-2 text-[12.5px] leading-[1.35] font-medium text-fg">
                          {commit.subject}
                        </div>
                        <div className="mt-0.5 truncate text-[10.5px] text-fg-muted">{commit.author}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </aside>
    </>
  )
}

function RelationList({
  items,
  empty,
  onPeek,
}: {
  items: ResolvedRelation[]
  empty: string
  onPeek: (docId: string, focusBlockId?: string) => void
}) {
  const { t } = useTranslation()
  if (items.length === 0) return <p className="m-0 text-[12.5px] text-fg-muted">{empty}</p>
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {items.map((rel) => {
        const focusBlockId = rel.targetKind === 'block' ? rel.ref : undefined
        const hash = focusBlockId ? `#block-${encodeURIComponent(focusBlockId)}` : ''
        return (
          <li key={`${rel.kind}:${rel.docId}:${rel.ref}`} className="flex items-stretch gap-1">
            <NavLink
              to={`/docs/${encodeDocId(rel.docId)}${hash}`}
              className="block min-w-0 flex-1 rounded-[7px] border border-line bg-surface px-2.5 py-[7px] text-fg no-underline hover:border-accent hover:bg-accent-soft"
              onClick={(e) => {
                if (e.shiftKey) {
                  e.preventDefault()
                  onPeek(rel.docId, focusBlockId)
                }
              }}
              title={t('inspector.linkHint')}
            >
              <span className="mb-0.5 flex items-center gap-1.5">
                <span
                  className={`rounded border bg-subtle px-[5px] py-px text-[10px] font-bold ${EDGE_KIND_STYLES[rel.kind] ?? 'border-line text-fg-muted'}`}
                >
                  {rel.kind}
                </span>
                <span className={`text-[10.5px] font-bold tracking-[0.05em] text-tc uppercase type-${rel.type}`}>
                  {t(`types.singular.${rel.type}`)}
                </span>
              </span>
              <span className="block truncate text-[13px] font-medium">{rel.title}</span>
              <span className="mono text-[11px] text-fg-muted">{rel.ref}</span>
            </NavLink>
            <button
              type="button"
              className="flex w-7 shrink-0 cursor-pointer items-center justify-center rounded-md border border-line bg-surface text-fg-muted hover:border-accent hover:bg-hover hover:text-fg"
              onClick={() => onPeek(rel.docId, focusBlockId)}
              title={t('inspector.peekButtonTitle')}
              aria-label={t('inspector.peekButtonAria', { title: rel.title })}
            >
              <SplitIcon />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function SplitIcon() {
  return <Columns2 size={14} strokeWidth={1.75} aria-hidden="true" />
}

function scrollToElement(id: string) {
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
