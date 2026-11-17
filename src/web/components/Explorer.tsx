import { useEffect, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { ARTIFACT_TYPES } from '../../core/types'
import type { ArtifactType } from '../../core/types'
import { api } from '../api'
import type { DocumentSummary, StatusResponse } from '../api'
import { ThemeToggle } from '../theme'

const SECTION_LABELS: Record<ArtifactType, string> = {
  goal: 'Goals',
  requirement: 'Requirements',
  architecture: 'Architecture',
  design: 'Designs',
  decision: 'Decisions',
  contract: 'Contracts',
  verification: 'Verification',
  guide: 'Guides',
}

interface ExplorerProps {
  onClose: () => void
}

export default function Explorer({ onClose }: ExplorerProps) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<ArtifactType>>(new Set())

  useEffect(() => {
    Promise.all([api.documents(), api.status()])
      .then(([docs, st]) => {
        setDocuments(docs.documents)
        setStatus(st)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const grouped = useMemo(() => {
    const map = new Map<ArtifactType, DocumentSummary[]>()
    for (const type of ARTIFACT_TYPES) map.set(type, [])
    for (const doc of documents) {
      map.get(doc.type as ArtifactType)?.push(doc)
    }
    return map
  }, [documents])

  const toggle = (type: ArtifactType) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  return (
    <aside className="explorer" aria-label="Explorer">
      <div className="explorer-header">
        <span className="brand">Documi</span>
        <div className="explorer-actions">
          <ThemeToggle />
          <button type="button" className="explorer-close" onClick={onClose} aria-label="Explorerを閉じる">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
      <nav className="explorer-nav">
        <NavLink
          to="/glossary"
          className={({ isActive }) => `nav-item nav-glossary${isActive ? ' active' : ''}`}
          onClick={onClose}
        >
          Glossary
        </NavLink>
        {ARTIFACT_TYPES.map((type) => {
          const docs = grouped.get(type) ?? []
          const isCollapsed = collapsed.has(type)
          return (
            <section key={type} className={`nav-group type-${type}`}>
              <button
                type="button"
                className="nav-section"
                aria-expanded={!isCollapsed}
                onClick={() => toggle(type)}
              >
                <svg
                  className={`nav-chevron${isCollapsed ? ' collapsed' : ''}`}
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  aria-hidden="true"
                >
                  <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="nav-section-label">{SECTION_LABELS[type]}</span>
                <span className="nav-count">{docs.length}</span>
              </button>
              {!isCollapsed && (
                <ul>
                  {docs.length === 0 && <li className="nav-empty">文書なし</li>}
                  {docs.map((doc) => (
                    <li key={doc.ref}>
                      <NavLink
                        to={`/pages/${doc.type}/${doc.id}`}
                        className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                        title={doc.title}
                        onClick={onClose}
                      >
                        <span className="nav-id">{doc.id}</span>
                        <span className="nav-title">{doc.title}</span>
                        {doc.issueCount > 0 && (
                          <span className="issue-dot" title={`問題 ${doc.issueCount} 件`} />
                        )}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )
        })}
      </nav>
      {status && status.issues.length > 0 && (
        <details className="explorer-issues">
          <summary>読み込み問題 ({status.issues.length})</summary>
          <ul>
            {status.issues.map((issue, i) => (
              <li key={i}>
                {issue.path && <code>{issue.path}</code>}
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <div className="explorer-error">{error}</div>}
      {status && <div className="explorer-footer">docs: {status.rootDir}</div>}
    </aside>
  )
}
