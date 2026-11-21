import { useEffect, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { ARTIFACT_TYPE_SECTION_LABELS, ARTIFACT_TYPES } from '../../core/types'
import type { ArtifactType, DocTreeDir, DocTreeNode, DocumentSummary } from '../../core/types'
import { api, encodeDocId } from '../api'
import type { StatusResponse } from '../api'
import { useDocsRevision } from '../live'
import { ThemeToggle } from '../theme'
import ExportActions from './ExportActions'

type DocListMode = 'flow' | 'files'

/**
 * 読む順番（上流→下流のライフサイクル順）でドキュメントを並べる順序。
 * 目的・全体像・用語 → 要件・契約 → 設計・判断 → 検証・ガイド
 */
const READING_FLOW_ORDER: readonly ArtifactType[] = [
  'goal',
  'architecture',
  'domain',
  'spec',
  'contract',
  'design',
  'decision',
  'verification',
  'guide',
]

interface ExplorerProps {
  reviewBadgeCount: number
  onCollapse: () => void
  onClose: () => void
  onOpenSearch: () => void
}

// @implements ui.explorer-modes
export default function Explorer({ reviewBadgeCount, onCollapse, onClose, onOpenSearch }: ExplorerProps) {
  const revision = useDocsRevision()
  const [mode, setMode] = useState<DocListMode>('flow')
  const [tree, setTree] = useState<DocTreeNode[]>([])
  const [documents, setDocuments] = useState<DocumentSummary[]>([])
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(new Set())
  const [collapsedTypes, setCollapsedTypes] = useState<ReadonlySet<ArtifactType>>(new Set())

  useEffect(() => {
    let cancelled = false
    Promise.all([api.tree(), api.status()])
      .then(([treeRes, st]) => {
        if (cancelled) return
        setTree(treeRes.tree)
        setDocuments(treeRes.documents)
        setStatus(st)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [revision])

  const grouped = useMemo(() => {
    const map = new Map<ArtifactType, DocumentSummary[]>()
    for (const type of ARTIFACT_TYPES) map.set(type, [])
    for (const doc of documents) {
      map.get(doc.type)?.push(doc)
    }
    return map
  }, [documents])

  const toggleDir = (dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
  }

  const toggleType = (type: ArtifactType) => {
    setCollapsedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  return (
    <aside className="explorer" aria-label="ナビゲーション">
      <div className="explorer-header">
        <NavLink to="/" className="brand brand-link" onClick={onClose}>
          Documi
        </NavLink>
        <div className="explorer-actions">
          <ExportActions />
          <ThemeToggle />
          <button
            type="button"
            className="explorer-collapse-btn"
            onClick={onCollapse}
            title="サイドバーを畳む (⌘B)"
            aria-label="サイドバーを畳む"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M10.5 3.5L6 8L10.5 12.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button type="button" className="explorer-close" onClick={onClose} aria-label="メニューを閉じる">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      <div className="explorer-search-wrap">
        <button type="button" className="explorer-search-btn" onClick={onOpenSearch}>
          <span>検索…</span>
          <kbd className="explorer-kbd">⌘K</kbd>
        </button>
      </div>

      <div className="explorer-primary-nav" role="navigation" aria-label="主要ビュー">
        <NavLink
          to="/"
          end
          className={({ isActive }) => `nav-primary-item${isActive ? ' active' : ''}`}
          onClick={onClose}
        >
          <HomeIcon />
          <span>Home</span>
        </NavLink>
        <NavLink
          to="/review"
          className={({ isActive }) => `nav-primary-item${isActive ? ' active' : ''}`}
          onClick={onClose}
        >
          <ReviewIcon />
          <span>Review Queue</span>
          {reviewBadgeCount > 0 && <span className="nav-badge warn">{reviewBadgeCount}</span>}
        </NavLink>
        <NavLink
          to="/graph"
          className={({ isActive }) => `nav-primary-item${isActive ? ' active' : ''}`}
          onClick={onClose}
        >
          <GraphIcon />
          <span>Graph & Matrix</span>
        </NavLink>
      </div>

      <div className="explorer-docs-bar">
        <span className="explorer-docs-label">Documents</span>
        <div className="explorer-mode-inline" role="tablist" aria-label="ドキュメント一覧の表示切替">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'flow'}
            className={`explorer-mode-pill${mode === 'flow' ? ' active' : ''}`}
            onClick={() => setMode('flow')}
            title="上流（Goals・Architecture）から下流（設計・検証）の読み順で表示"
          >
            Flow
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'files'}
            className={`explorer-mode-pill${mode === 'files' ? ' active' : ''}`}
            onClick={() => setMode('files')}
            title="docs/ のフォルダ階層そのままを表示"
          >
            Files
          </button>
        </div>
      </div>

      <nav className="explorer-nav" aria-label="ドキュメント一覧">
        {mode === 'flow' ? (
          READING_FLOW_ORDER.map((type) => {
            const docs = grouped.get(type) ?? []
            const isCollapsed = collapsedTypes.has(type)
            return (
              <section key={type} className={`nav-group type-${type}`}>
                <button
                  type="button"
                  className="nav-section"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleType(type)}
                >
                  <Chevron collapsed={isCollapsed} />
                  <span className="nav-type-dot" aria-hidden="true" />
                  <span className="nav-section-label">{ARTIFACT_TYPE_SECTION_LABELS[type]}</span>
                  <span className="nav-count">{docs.length}</span>
                </button>
                {!isCollapsed && (
                  <ul>
                    {docs.length === 0 && <li className="nav-empty">文書なし</li>}
                    {docs.map((doc) => (
                      <li key={doc.id}>
                        <NavLink
                          to={`/docs/${encodeDocId(doc.id)}`}
                          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                          title={`${doc.id} — ${doc.title}`}
                          onClick={onClose}
                        >
                          <span className="nav-title">{doc.title}</span>
                          {doc.date && <span className="nav-date mono">{doc.date}</span>}
                          {doc.issueCount > 0 && <span className="issue-dot" title={`問題 ${doc.issueCount} 件`} />}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })
        ) : (
          <div className="nav-tree">
            {tree.length === 0 && <div className="nav-empty">文書なし</div>}
            {tree.map((node) => (
              <TreeBranch
                key={node.kind === 'dir' ? `dir:${node.path}` : `doc:${node.doc.id}`}
                node={node}
                depth={0}
                collapsedDirs={collapsedDirs}
                onToggleDir={toggleDir}
                onClose={onClose}
              />
            ))}
          </div>
        )}
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

function TreeBranch({
  node,
  depth,
  collapsedDirs,
  onToggleDir,
  onClose,
}: {
  node: DocTreeNode
  depth: number
  collapsedDirs: ReadonlySet<string>
  onToggleDir: (path: string) => void
  onClose: () => void
}) {
  if (node.kind === 'dir') {
    const dir: DocTreeDir = node
    const isCollapsed = collapsedDirs.has(dir.path)
    return (
      <div className="nav-dir">
        <button
          type="button"
          className="nav-dir-btn"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          aria-expanded={!isCollapsed}
          onClick={() => onToggleDir(dir.path)}
        >
          <Chevron collapsed={isCollapsed} />
          <span className="nav-dir-name">{dir.name}</span>
        </button>
        {!isCollapsed && (
          <div className="nav-dir-children">
            {dir.children.map((child) => (
              <TreeBranch
                key={child.kind === 'dir' ? `dir:${child.path}` : `doc:${child.doc.id}`}
                node={child}
                depth={depth + 1}
                collapsedDirs={collapsedDirs}
                onToggleDir={onToggleDir}
                onClose={onClose}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  const { doc } = node
  return (
    <NavLink
      to={`/docs/${encodeDocId(doc.id)}`}
      className={({ isActive }) => `nav-item nav-tree-doc type-${doc.type}${isActive ? ' active' : ''}`}
      style={{ paddingLeft: `${10 + depth * 14}px` }}
      title={`${doc.id} — ${doc.title}`}
      onClick={onClose}
    >
      <span className="nav-type-dot" aria-hidden="true" />
      <span className="nav-title">{doc.title}</span>
      {doc.issueCount > 0 && <span className="issue-dot" title={`問題 ${doc.issueCount} 件`} />}
    </NavLink>
  )
}

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      className={`nav-chevron${collapsed ? ' collapsed' : ''}`}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function HomeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3 9.5L10 3.5L17 9.5V16.5C17 17.05 16.55 17.5 16 17.5H12.5V12.5H7.5V17.5H4C3.45 17.5 3 17.05 3 16.5V9.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ReviewIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="14" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M6.8 10.2L9 12.4L13.4 7.8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function GraphIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="5" cy="5.5" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="15" cy="5.5" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="10" cy="15" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7.2 5.5H12.8M6.1 7.4L8.9 13.1M13.9 7.4L11.1 13.1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}
