import { Columns2, PanelRightClose } from 'lucide-react'
import { useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { ARTIFACT_TYPE_LABELS } from '../../core/types'
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

export default function SidePanel({ doc, headings, onPeek, onCollapse }: SidePanelProps) {
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
        label="右インスペクタ幅を調整"
      />
      <aside className="side-panel" style={{ flexBasis: `${panelWidth}px` }} aria-label="コンテキストインスペクタ">
        <header className="rp-header">
          <div className="rp-tabs" role="tablist" aria-label="インスペクタ切替">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'outline'}
              className={`rp-tab${tab === 'outline' ? ' active' : ''}`}
              onClick={() => setTab('outline')}
            >
              Outline
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'links'}
              className={`rp-tab${tab === 'links' ? ' active' : ''}`}
              onClick={() => setTab('links')}
            >
              Links <span className="rp-tab-count">{totalLinks}</span>
            </button>
          </div>
          <button
            type="button"
            className="rp-collapse-btn"
            onClick={onCollapse}
            title="右パネルを閉じる"
            aria-label="右パネルを閉じる"
          >
            <PanelRightClose size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>

        {reviewStats.total > 0 && (
          <div className="rp-health-bar">
            <span>
              Approved <strong>{reviewStats.approved}</strong>/{reviewStats.total}
            </span>
            {reviewStats.specTotal > 0 && (
              <span>
                Verified <strong>{reviewStats.verified}</strong>/{reviewStats.specTotal}
              </span>
            )}
            {reviewStats.attention > 0 && <span className="rp-health-warn">要確認 {reviewStats.attention}</span>}
          </div>
        )}

        {tab === 'outline' ? (
          <div className="rp-body">
            {doc.blocks.length > 0 && (
              <section className="rp-section">
                <h2 className="rp-title">Blocks ({doc.blocks.length})</h2>
                <ul className="rp-blocks">
                  {doc.blocks.map((b) => {
                    const openFb = b.feedback.filter((f) => !f.resolved).length
                    const dotClass = b.suspect ? 'suspect' : b.review
                    return (
                      <li key={b.id}>
                        <button
                          type="button"
                          className="rp-block-link"
                          onClick={() => scrollToElement(`block-${b.id}`)}
                          title={`${b.id} (${b.suspect ? 'suspect' : b.review})`}
                        >
                          {b.kind !== 'note' && <span className={`rp-review-dot rp-review-${dotClass}`} />}
                          <span className={`rp-block-kind rp-block-kind-${b.kind}`}>{b.kind}</span>
                          <span className="rp-block-id mono">{b.id}</span>
                          {openFb > 0 && <span className="rp-fb-count">{openFb}</span>}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}

            {headings.length > 0 ? (
              <section className="rp-section">
                <h2 className="rp-title">Headings</h2>
                <ul className="rp-outline">
                  {headings.map((h, i) => (
                    <li key={`${h.id}-${i}`} style={{ paddingLeft: `${(h.level - 1) * 12}px` }}>
                      <button type="button" className="rp-outline-link" onClick={() => scrollToElement(h.id)}>
                        {h.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              doc.blocks.length === 0 && <p className="rp-empty">見出し・ブロックはありません</p>
            )}
          </div>
        ) : (
          <div className="rp-body">
            <section className="rp-section">
              <h2 className="rp-title">上流・前提 ({upstream.length})</h2>
              <RelationList items={upstream} empty="上流の参照はありません" onPeek={onPeek} />
            </section>

            <section className="rp-section">
              <h2 className="rp-title">下流・依存元 ({downstream.length})</h2>
              <RelationList items={downstream} empty="下流の参照はありません" onPeek={onPeek} />
            </section>

            {doc.sourceRefs.length > 0 && (
              <section className="rp-section">
                <h2 className="rp-title">関連コード ({doc.sourceRefs.length})</h2>
                <ul className="rp-source-list">
                  {doc.sourceRefs.map((ref, i) => (
                    <li key={`${ref.file}:${ref.symbol ?? ref.lines ?? i}`} className="rp-source-item mono">
                      <span className="rp-source-file">{ref.file}</span>
                      {ref.symbol && <span className="rp-source-sym">#{ref.symbol}</span>}
                      {ref.lines && <span className="rp-source-sym">:L{ref.lines}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {mentions.length > 0 && (
              <section className="rp-section">
                <h2 className="rp-title">言及 ({mentions.length})</h2>
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
  if (items.length === 0) return <p className="rp-empty">{empty}</p>
  return (
    <ul className="rp-relations">
      {items.map((rel) => {
        const focusBlockId = rel.targetKind === 'block' ? rel.ref : undefined
        const hash = focusBlockId ? `#block-${encodeURIComponent(focusBlockId)}` : ''
        return (
          <li key={`${rel.kind}:${rel.docId}:${rel.ref}`} className="rp-relation-row">
            <NavLink
              to={`/docs/${encodeDocId(rel.docId)}${hash}`}
              className="rp-relation"
              onClick={(e) => {
                if (e.shiftKey) {
                  e.preventDefault()
                  onPeek(rel.docId, focusBlockId)
                }
              }}
              title="クリックで開く / Shift+クリックで右に並べて見る"
            >
              <span className="rp-relation-meta">
                <span className={`rp-edge-kind rp-edge-${rel.kind}`}>{rel.kind}</span>
                <span className={`rp-relation-type type-${rel.type}`}>{ARTIFACT_TYPE_LABELS[rel.type]}</span>
              </span>
              <span className="rp-relation-title">{rel.title}</span>
              <span className="rp-relation-id mono">{rel.ref}</span>
            </NavLink>
            <button
              type="button"
              className="rp-peek-btn"
              onClick={() => onPeek(rel.docId, focusBlockId)}
              title="右に並べて見る"
              aria-label={`${rel.title} を右に並べて見る`}
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
