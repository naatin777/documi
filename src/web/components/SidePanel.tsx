import { Columns2, PanelRightClose } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router'
import type { Document, ResolvedRelation } from '../../core/types'
import { encodeDocId } from '../api'
import type { Heading } from '../headings'
import ResizeHandle, { useResizableWidth } from './ResizeHandle'

interface SidePanelProps {
  doc: Document
  headings: Heading[]
  onPeek: (docId: string, focusBlockId?: string) => void
  onCollapse: () => void
}

type InspectorTab = 'outline' | 'links'

const TRACE_KINDS = new Set(['derives', 'satisfies', 'verifies', 'supersedes'])

const EDGE_KIND_STYLES: Record<string, string> = {
  derives: 'border-amber-500 text-amber-700 dark:text-amber-400',
  satisfies: 'border-teal-500 text-teal-700 dark:text-teal-400',
  verifies: 'border-green-500 text-green-700 dark:text-green-400',
  supersedes: 'border-rose-500 text-rose-700 dark:text-rose-400',
}

function tabClass(active: boolean) {
  return `inline-flex cursor-pointer items-center gap-[5px] rounded-[5px] border-0 px-2.5 py-[3px] text-xs font-semibold ${
    active ? 'bg-surface text-fg shadow-[0_1px_2px_rgba(15,23,42,0.08)]' : 'bg-transparent text-fg-muted hover:text-fg'
  }`
}

export default function SidePanel({ doc, headings, onPeek, onCollapse }: SidePanelProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<InspectorTab>('outline')
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
        className="flex min-h-0 min-w-0 shrink-0 grow-0 flex-col overflow-hidden border-l border-line bg-sidebar max-[900px]:flex-none max-[900px]:!basis-auto max-[900px]:overflow-visible max-[900px]:border-t max-[900px]:border-l-0 print:hidden"
        style={{ flexBasis: `${panelWidth}px` }}
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
              {t('inspector.links')} <span className="text-[10.5px] opacity-75">{totalLinks}</span>
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

        {tab === 'outline' ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pt-3.5 pb-10">
            {doc.blocks.length > 0 && (
              <section className="mb-7">
                <h2 className="m-0 mb-2.5 text-[11px] font-bold tracking-[0.07em] text-fg-muted uppercase">
                  {t('inspector.blocks', { count: doc.blocks.length })}
                </h2>
                <ul className="m-0 grid list-none gap-1 p-0">
                  {doc.blocks.map((b) => {
                    const openFb = b.feedback.filter((f) => !f.resolved).length
                    const dotClass = b.suspect ? 'suspect' : b.review
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
                          {openFb > 0 && <span className="rp-fb-count">{openFb}</span>}
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
                  {headings.map((h, i) => (
                    <li key={`${h.id}-${i}`} style={{ paddingLeft: `${(h.level - 1) * 12}px` }}>
                      <button
                        type="button"
                        className="block w-full cursor-pointer truncate rounded-[5px] border-0 bg-transparent px-2 py-[3px] text-left text-[13px] text-fg hover:bg-hover"
                        onClick={() => scrollToElement(h.id)}
                      >
                        {h.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              doc.blocks.length === 0 && (
                <p className="m-0 text-[12.5px] text-fg-muted">{t('inspector.emptyOutline')}</p>
              )
            )}
          </div>
        ) : (
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
                    if (ref.lines) qs.set('lines', ref.lines)
                    return (
                      <li
                        key={`${ref.file}:${ref.symbol ?? ref.lines ?? i}`}
                        className="mono rounded-md border border-line bg-surface px-2 py-[5px] text-[11px] [overflow-wrap:anywhere]"
                      >
                        <NavLink
                          to={`/code?${qs.toString()}`}
                          className="group inline-flex flex-wrap text-inherit no-underline"
                        >
                          <span className="group-hover:text-accent group-hover:underline">{ref.file}</span>
                          {ref.symbol && <span className="text-fg-muted">#{ref.symbol}</span>}
                          {ref.lines && <span className="text-fg-muted">:L{ref.lines}</span>}
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
                <span
                  className={`text-[10.5px] font-bold tracking-[0.05em] text-[var(--tc)] uppercase type-${rel.type}`}
                >
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
