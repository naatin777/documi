import { NavLink } from 'react-router-dom'
import { ARTIFACT_TYPE_LABELS } from '../../core/types'
import type { RelationTarget } from '../../core/types'
import type { Heading } from '../headings'

interface SidePanelProps {
  headings: Heading[]
  /** undefined の場合は Relations セクション自体を表示しない (Glossary など) */
  outgoing?: RelationTarget[]
  incoming?: RelationTarget[]
}

export default function SidePanel({ headings, outgoing, incoming }: SidePanelProps) {
  return (
    <aside className="side-panel">
      {headings.length > 0 && (
        <section className="rp-section">
          <h2 className="rp-title">Outline</h2>
          <ul className="rp-outline">
            {headings.map((h, i) => (
              <li key={`${h.id}-${i}`} style={{ paddingLeft: `${(h.level - 1) * 12}px` }}>
                <button
                  type="button"
                  className="rp-outline-link"
                  onClick={() => scrollToHeading(h.id)}
                >
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
          <RelationList items={outgoing} empty="この文書は他の Artifact を参照していません" />
        </section>
      )}

      {incoming !== undefined && (
        <section className="rp-section">
          <h2 className="rp-title">Referenced by ({incoming.length})</h2>
          <RelationList items={incoming} empty="この文書を参照している Artifact はありません" />
        </section>
      )}
    </aside>
  )
}

function RelationList({ items, empty }: { items: RelationTarget[]; empty: string }) {
  if (items.length === 0) return <p className="rp-empty">{empty}</p>
  return (
    <ul className="rp-relations">
      {items.map((rel) => (
        <li key={rel.ref}>
          <NavLink to={`/pages/${rel.type}/${rel.id}`} className="rp-relation">
            <span className="rp-relation-meta">
              <span className={`rp-relation-type type-${rel.type}`}>{ARTIFACT_TYPE_LABELS[rel.type]}</span>
              <span className="rp-relation-id mono">{rel.id}</span>
            </span>
            <span className="rp-relation-title">{rel.title}</span>
          </NavLink>
        </li>
      ))}
    </ul>
  )
}

function scrollToHeading(id: string) {
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
