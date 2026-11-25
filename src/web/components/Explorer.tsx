import { ChevronRight, FileCode2, Home, ListChecks, Network, Search, X } from 'lucide-react'
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router'
import { ARTIFACT_TYPES } from '../../core/types'
import type { ArtifactType, DocTreeDir, DocTreeNode, DocumentSummary, WorkingTreeStatus } from '../../core/types'
import { encodeDocId } from '../api'
import { LanguageToggle } from '../i18n'
import { toErrorMessage, useStatusQuery, useTreeQuery } from '../queries'
import { ThemeToggle } from '../theme'
import { formatDateTime } from '../time'
import { ArtifactTypeIcon, BrandMark } from './BrandMark'
import ExportActions from './ExportActions'
import { MaterialFileIcon, MaterialFolderIcon } from './MaterialIcon'

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
  navOpen?: boolean
  sidebarOpen?: boolean
  onClose: () => void
  onOpenSearch: () => void
  resizeHandle?: ReactNode
}

function primaryNavClass({ isActive }: { isActive: boolean }) {
  return `flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-semibold no-underline ${
    isActive ? 'bg-accent-soft text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg'
  }`
}

// @implements ui.explorer-modes
export default function Explorer({
  reviewBadgeCount,
  navOpen = false,
  sidebarOpen = true,
  onClose,
  onOpenSearch,
  resizeHandle,
}: ExplorerProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<DocListMode>('flow')
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(new Set())
  const [collapsedTypes, setCollapsedTypes] = useState<ReadonlySet<ArtifactType>>(new Set())

  const treeQuery = useTreeQuery()
  const statusQuery = useStatusQuery()
  const tree = treeQuery.data?.tree ?? []
  const documents = treeQuery.data?.documents
  const status = statusQuery.data ?? null
  const error = toErrorMessage(treeQuery.error ?? statusQuery.error)

  const grouped = useMemo(() => {
    const map = new Map<ArtifactType, DocumentSummary[]>()
    for (const type of ARTIFACT_TYPES) map.set(type, [])
    for (const doc of documents ?? []) {
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
    <aside
      className={`relative flex min-h-0 flex-col border-r border-line bg-sidebar ${sidebarOpen ? '' : 'desktop:hidden'} motion-reduce:transition-none max-desktop:fixed max-desktop:inset-y-0 max-desktop:left-0 max-desktop:z-60 max-desktop:w-[min(300px,85vw)] max-desktop:shadow-[4px_0_16px_rgba(15,23,42,0.12)] max-desktop:transition-transform max-desktop:duration-150 ${navOpen ? 'max-desktop:translate-x-0' : 'max-desktop:-translate-x-[105%]'} print:hidden`}
      aria-label={t('nav.navigation')}
    >
      <div className="flex h-(--tabs-height) shrink-0 items-center justify-between border-b border-line pr-2.5 pl-3.5">
        <NavLink
          to="/"
          className="inline-flex items-center gap-2 text-[15.5px] font-bold tracking-[-0.01em] text-inherit no-underline"
          onClick={onClose}
        >
          <BrandMark size={20} />
          <span>Documi</span>
        </NavLink>
        <div className="flex items-center gap-0.5">
          <ExportActions />
          <LanguageToggle />
          <ThemeToggle />
          <button
            type="button"
            className="hidden h-7 w-7 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-fg-muted hover:bg-hover hover:text-fg max-desktop:flex"
            onClick={onClose}
            aria-label={t('nav.closeMenu')}
          >
            <X size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="px-2.5 pt-2 pb-1">
        <button
          type="button"
          className="flex w-full cursor-pointer items-center justify-between rounded-[7px] border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-fg-muted hover:border-fg-muted hover:text-fg"
          onClick={onOpenSearch}
        >
          <span className="inline-flex items-center gap-1.5">
            <Search size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>{t('nav.searchPlaceholder')}</span>
          </span>
          <kbd className="rounded border border-line bg-subtle px-[5px] py-px font-mono text-[11px]">⌘K</kbd>
        </button>
      </div>

      <div
        className="flex flex-col gap-0.5 border-b border-line px-2 pt-1.5 pb-2"
        role="navigation"
        aria-label={t('nav.primaryViews')}
      >
        <NavLink to="/" end className={primaryNavClass} onClick={onClose}>
          <HomeIcon />
          <span>{t('nav.home')}</span>
        </NavLink>
        <NavLink to="/review" className={primaryNavClass} onClick={onClose}>
          <ReviewIcon />
          <span>{t('nav.reviewQueue')}</span>
          {reviewBadgeCount > 0 && (
            <span className="ml-auto h-[18px] min-w-[18px] rounded-full bg-amber-600/16 px-1.5 text-center text-[10.5px] leading-[18px] font-bold text-amber-700 tabular-nums dark:text-amber-500">
              {reviewBadgeCount}
            </span>
          )}
        </NavLink>
        <NavLink to="/graph" className={primaryNavClass} onClick={onClose}>
          <GraphIcon />
          <span>{t('nav.graph')}</span>
        </NavLink>
        <NavLink to="/code" className={primaryNavClass} onClick={onClose}>
          <FileCode2 size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>{t('nav.codeExplorer')}</span>
        </NavLink>
      </div>

      <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1">
        <span className="text-[11px] font-bold tracking-[0.06em] text-fg-muted uppercase">{t('nav.documents')}</span>
        <div
          className="inline-flex rounded-md border border-line bg-subtle p-0.5"
          role="tablist"
          aria-label={t('nav.documents')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'flow'}
            className={`cursor-pointer rounded border-0 px-2 py-0.5 text-[11px] font-semibold ${
              mode === 'flow'
                ? 'bg-surface text-fg shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
                : 'bg-transparent text-fg-muted hover:text-fg'
            }`}
            onClick={() => setMode('flow')}
            title={t('nav.flowTitle')}
          >
            {t('nav.flow')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'files'}
            className={`cursor-pointer rounded border-0 px-2 py-0.5 text-[11px] font-semibold ${
              mode === 'files'
                ? 'bg-surface text-fg shadow-[0_1px_2px_rgba(15,23,42,0.08)]'
                : 'bg-transparent text-fg-muted hover:text-fg'
            }`}
            onClick={() => setMode('files')}
            title={t('nav.filesTitle')}
          >
            {t('nav.files')}
          </button>
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto py-1.5" aria-label={t('nav.documents')}>
        {mode === 'flow' ? (
          READING_FLOW_ORDER.map((type) => {
            const docs = grouped.get(type) ?? []
            const isCollapsed = collapsedTypes.has(type)
            return (
              <section key={type} className={`mb-1 type-${type}`}>
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent px-3 py-1.5 text-left text-[11.5px] font-bold tracking-[0.04em] text-fg-muted uppercase hover:bg-hover"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleType(type)}
                >
                  <Chevron collapsed={isCollapsed} />
                  <ArtifactTypeIcon type={type} size={13} className="shrink-0 text-tc" />
                  <span className="flex-1 text-tc">{t(`types.section.${type}`)}</span>
                  <span className="rounded-full bg-subtle px-[7px] text-[10.5px] leading-[1.7] font-semibold text-fg-muted tabular-nums">
                    {docs.length}
                  </span>
                </button>
                {!isCollapsed && (
                  <ul className="m-0 list-none p-0">
                    {docs.length === 0 && (
                      <li className="py-1 pr-3 pl-[30px] text-xs text-fg-muted">{t('nav.noDocs')}</li>
                    )}
                    {docs.map((doc) => {
                      const updatedLabel = doc.freshness?.updatedAt
                        ? t('nav.updatedTooltip', { time: formatDateTime(doc.freshness.updatedAt) })
                        : ''
                      const docTitleAttr = updatedLabel
                        ? `${doc.id} — ${doc.title} (${updatedLabel})`
                        : `${doc.id} — ${doc.title}`
                      return (
                        <li key={doc.id}>
                          <NavLink
                            to={`/docs/${encodeDocId(doc.id)}`}
                            className={({ isActive }) =>
                              `flex items-baseline gap-2 border-l-[3px] py-[5px] pr-3 pl-[30px] text-[13.5px] no-underline ${
                                isActive
                                  ? 'border-l-tc bg-tc-soft font-semibold text-tc'
                                  : 'border-l-transparent text-fg hover:bg-hover'
                              }`
                            }
                            title={docTitleAttr}
                            onClick={onClose}
                          >
                            <span className="truncate">{doc.title}</span>
                            {doc.date && (
                              <span className="mono ml-auto shrink-0 text-[10.5px] text-fg-muted">{doc.date}</span>
                            )}
                            {doc.freshness?.workingStatus && (
                              <WorkingStatusBadge status={doc.freshness.workingStatus} pushRight={!doc.date} />
                            )}
                            {doc.issueCount > 0 && (
                              <span
                                className="h-[7px] w-[7px] shrink-0 self-center rounded-full bg-amber-600"
                                title={t('nav.issueCountTitle', { count: doc.issueCount })}
                              />
                            )}
                          </NavLink>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            )
          })
        ) : (
          <div className="px-1">
            {tree.length === 0 && <div className="py-1 pr-3 pl-[30px] text-xs text-fg-muted">{t('nav.noDocs')}</div>}
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
        <details className="max-h-[180px] overflow-y-auto border-t border-line px-4 py-2 text-xs">
          <summary className="cursor-pointer font-semibold text-amber-700">
            {t('nav.loadIssues', { count: status.issues.length })}
          </summary>
          <ul className="m-0 mt-2 list-none p-0">
            {status.issues.map((issue, i) => (
              <li key={i} className="mb-2">
                {issue.path && <code className="block text-[11px] text-fg-muted">{issue.path}</code>}
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <div className="border-t border-line px-4 py-2 text-xs text-red-600">{error}</div>}
      {status && (
        <div className="truncate border-t border-line px-4 py-2 font-mono text-[11px] text-fg-muted">
          docs: {status.rootDir}
        </div>
      )}
      {resizeHandle}
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
  const { t } = useTranslation()

  if (node.kind === 'dir') {
    const dir: DocTreeDir = node
    const isCollapsed = collapsedDirs.has(dir.path)
    return (
      <div className="group/dir">
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 py-[5px] text-left text-[12.5px] font-semibold text-fg-muted hover:bg-hover hover:text-fg"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          aria-expanded={!isCollapsed}
          onClick={() => onToggleDir(dir.path)}
        >
          <Chevron collapsed={isCollapsed} />
          <MaterialFolderIcon name={dir.name} open={!isCollapsed} size={15} />
          <span className="truncate">{dir.name}</span>
        </button>
        {!isCollapsed && (
          <div
            className="relative before:pointer-events-none before:absolute before:top-0 before:bottom-0.5 before:left-[calc(14px+var(--tree-depth,0)*14px)] before:w-px before:bg-line before:opacity-70 before:transition-colors before:duration-140 before:content-[''] group-hover/dir:before:bg-fg-faint group-hover/dir:before:opacity-90"
            style={{ '--tree-depth': depth } as CSSProperties}
          >
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
  const updatedLabel = doc.freshness?.updatedAt
    ? t('nav.updatedTooltip', { time: formatDateTime(doc.freshness.updatedAt) })
    : ''
  const docTitleAttr = updatedLabel ? `${doc.id} — ${doc.title} (${updatedLabel})` : `${doc.id} — ${doc.title}`
  return (
    <NavLink
      to={`/docs/${encodeDocId(doc.id)}`}
      className={({ isActive }) =>
        `flex items-center gap-1.5 border-l-[3px] py-[5px] pr-3 text-[13.5px] no-underline type-${doc.type} ${
          isActive ? 'border-l-tc bg-tc-soft font-semibold text-tc' : 'border-l-transparent text-fg hover:bg-hover'
        }`
      }
      style={{ paddingLeft: `${23 + depth * 14}px` }}
      title={docTitleAttr}
      onClick={onClose}
    >
      <MaterialFileIcon name={doc.path} size={15} />
      <span className="min-w-0 flex-1 truncate">{doc.title}</span>
      {doc.freshness?.workingStatus && <WorkingStatusBadge status={doc.freshness.workingStatus} />}
      <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-tc" aria-hidden="true" />
      {doc.issueCount > 0 && (
        <span
          className="h-[7px] w-[7px] shrink-0 rounded-full bg-amber-600"
          title={t('nav.issueCountTitle', { count: doc.issueCount })}
        />
      )}
    </NavLink>
  )
}

function WorkingStatusBadge({ status, pushRight = false }: { status: WorkingTreeStatus; pushRight?: boolean }) {
  const { t } = useTranslation()
  const code = status === 'modified' ? 'M' : status === 'added' ? 'A' : 'U'
  const colorClass = status === 'modified' ? 'text-sky-600 dark:text-sky-400' : 'text-emerald-600 dark:text-emerald-400'
  const label =
    status === 'modified'
      ? t('nav.uncommittedModified')
      : status === 'added'
        ? t('nav.uncommittedAdded')
        : t('nav.uncommittedUntracked')
  return (
    <span
      className={`mono shrink-0 self-center text-[10.5px] font-bold ${colorClass} ${pushRight ? 'ml-auto' : ''}`}
      title={label}
      aria-label={label}
    >
      {code}
    </span>
  )
}

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <ChevronRight
      size={12}
      strokeWidth={2}
      className={`shrink-0 text-fg-muted transition-transform duration-150 motion-reduce:transition-none ${collapsed ? 'rotate-0' : 'rotate-90'}`}
      aria-hidden="true"
    />
  )
}

function HomeIcon() {
  return <Home size={15} strokeWidth={1.75} aria-hidden="true" />
}

function ReviewIcon() {
  return <ListChecks size={15} strokeWidth={1.75} aria-hidden="true" />
}

function GraphIcon() {
  return <Network size={15} strokeWidth={1.75} aria-hidden="true" />
}
