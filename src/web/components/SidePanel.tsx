import { NavLink } from 'react-router-dom'
import { ARTIFACT_TYPE_LABELS } from '../../core/types'
import type { ResolvedRelation, SemanticBlock } from '../../core/types'
import { encodeDocId } from '../api'
import type { Heading } from '../headings'

interface SidePanelProps {
  headings: Heading[]
  blocks?: SemanticBlock[]
  outgoing?: ResolvedRelation[]
  incoming?: ResolvedRelation[]
}

export default function SidePanel({ headings, blocks = [], outgoing, incoming }: SidePanelProps) {
  return (
    <aside className="side-panel">
      {blocks.length > 0 && (
        <section className="rp-section">
          <h2 className="rp-title">Blocks ({blocks.length})</h2>
          <ul className="rp-blocks">
            {blocks.map((b) => {
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

      {headings.length > 0 && (
        <section className="rp-section">
          <h2 className="rp-title">Outline</h2>
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
      )}

      {outgoing !== undefined && (
        <section className="rp-section">
          <h2 className="rp-title">References ({outgoing.length})</h2>
          <RelationList items={outgoing} empty="他の文書・ブロックへの参照はありません" />
        </section>
      )}

      {incoming !== undefined && (
        <section className="rp-section">
          <h2 className="rp-title">Referenced by ({incoming.length})</h2>
          <RelationList items={incoming} empty="この文書を参照している文書はありません" />
        </section>
      )}
    </aside>
  )
}

function RelationList({ items, empty }: { items: ResolvedRelation[]; empty: string }) {
  if (items.length === 0) return <p className="rp-empty">{empty}</p>
  return (
    <ul className="rp-relations">
      {items.map((rel) => {
        const hash = rel.targetKind === 'block' ? `#block-${encodeURIComponent(rel.ref)}` : ''
        return (
          <li key={`${rel.kind}:${rel.ref}`}>
            <NavLink to={`/docs/${encodeDocId(rel.docId)}${hash}`} className="rp-relation">
              <span className="rp-relation-meta">
                <span className={`rp-edge-kind rp-edge-${rel.kind}`}>{rel.kind}</span>
                <span className={`rp-relation-type type-${rel.type}`}>{ARTIFACT_TYPE_LABELS[rel.type]}</span>
              </span>
              <span className="rp-relation-title">{rel.title}</span>
              <span className="rp-relation-id mono">{rel.ref}</span>
            </NavLink>
          </li>
        )
      })}
    </ul>
  )
}

function scrollToElement(id: string) {
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
