import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Home,
  ListChecks,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router-dom'
import { activeTabKeyFromPath, useTabs, type ViewTabId, type WorkspaceTab } from '../tabs'

interface DocTabsProps {
  sidebarOpen: boolean
  onToggleSidebar: () => void
}

export default function DocTabs({ sidebarOpen, onToggleSidebar }: DocTabsProps) {
  const { t } = useTranslation()
  const { tabs, closeTab, closeAllTabs } = useTabs()
  const { pathname } = useLocation()
  const stripRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const activeKey = activeTabKeyFromPath(pathname)

  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const syncOverflow = useCallback(() => {
    const strip = stripRef.current
    if (!strip) {
      setCanScrollLeft(false)
      setCanScrollRight(false)
      return
    }
    const maxScroll = strip.scrollWidth - strip.clientWidth
    setCanScrollLeft(strip.scrollLeft > 2)
    setCanScrollRight(maxScroll - strip.scrollLeft > 2)
  }, [])

  // アクティブタブを中央付近へ寄せる
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const el = strip.querySelector<HTMLElement>('.doc-tab.active')
    if (!el) {
      syncOverflow()
      return
    }
    const left = el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2
    strip.scrollTo({ left: Math.max(0, left), behavior: 'smooth' })
    const timer = setTimeout(syncOverflow, 220)
    return () => clearTimeout(timer)
  }, [pathname, tabs, syncOverflow])

  // リサイズやタブ数変化に応じて左右の溢れ状態を更新
  useEffect(() => {
    syncOverflow()
    const strip = stripRef.current
    if (!strip || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(syncOverflow)
    ro.observe(strip)
    return () => ro.disconnect()
  }, [tabs, syncOverflow])

  // ルート遷移時にドロップダウンを閉じる
  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  // 外側クリック・Escape でドロップダウンを閉じる
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const scrollByStep = (dir: -1 | 1) => {
    const strip = stripRef.current
    if (!strip) return
    const step = Math.max(180, Math.round(strip.clientWidth * 0.6))
    strip.scrollBy({ left: dir * step, behavior: 'smooth' })
  }

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const strip = stripRef.current
    if (!strip || strip.scrollWidth <= strip.clientWidth) return
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault()
      strip.scrollLeft += e.deltaY
      syncOverflow()
    }
  }

  const fadeClass = ['doc-tabs-strip', canScrollLeft ? 'can-scroll-left' : '', canScrollRight ? 'can-scroll-right' : '']
    .filter(Boolean)
    .join(' ')

  const isSoleHome = (tab: WorkspaceTab) => tabs.length === 1 && tab.kind === 'view' && tab.viewId === 'home'

  const resolveTabTitle = (tab: WorkspaceTab) => {
    if (tab.kind === 'doc') return tab.title
    if (tab.viewId === 'home') return t('nav.home')
    if (tab.viewId === 'review') return t('nav.reviewQueue')
    return t('nav.graphMatrix')
  }

  return (
    <nav className="doc-tabs" aria-label={t('tabs.workspaceTabs')}>
      <div className="doc-tabs-sidebar-slot">
        <button
          type="button"
          className={`doc-tabs-sidebar-btn${sidebarOpen ? ' active' : ''}`}
          onClick={onToggleSidebar}
          aria-expanded={sidebarOpen}
          aria-label={sidebarOpen ? t('tabs.closeSidebar') : t('tabs.openSidebar')}
          title={sidebarOpen ? t('tabs.closeSidebarTitle') : t('tabs.openSidebarTitle')}
        >
          {sidebarOpen ? (
            <PanelLeftClose size={15} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <PanelLeftOpen size={15} strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
      </div>

      <div className="doc-tabs-viewport">
        {canScrollLeft && (
          <button
            type="button"
            className="doc-tabs-scroll-btn doc-tabs-scroll-left"
            onClick={() => scrollByStep(-1)}
            aria-label={t('tabs.scrollLeft')}
            title={t('tabs.scrollLeft')}
          >
            <ChevronLeft size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        )}

        <div className={fadeClass} ref={stripRef} onScroll={syncOverflow} onWheel={handleWheel}>
          {tabs.map((tab) => {
            const isActive = activeKey === tab.key
            const hideClose = isSoleHome(tab)
            const typeClass = tab.kind === 'doc' ? `type-${tab.type}` : 'doc-tab-view'
            const title = resolveTabTitle(tab)
            const tooltip = tab.kind === 'doc' ? `${tab.docId} — ${title}` : title

            return (
              <div key={tab.key} className={`doc-tab${isActive ? ' active' : ''} ${typeClass}`}>
                <Link
                  to={tab.path}
                  className={`doc-tab-link${hideClose ? ' doc-tab-link-solo' : ''}`}
                  title={tooltip}
                  aria-current={isActive ? 'page' : undefined}
                  onAuxClick={(e) => {
                    if (e.button === 1 && !hideClose) {
                      e.preventDefault()
                      closeTab(tab)
                    }
                  }}
                  onMouseDown={(e) => {
                    if (e.button === 1 && !hideClose) e.preventDefault()
                  }}
                >
                  {tab.kind === 'doc' ? (
                    <span className="doc-tab-dot" aria-hidden="true" />
                  ) : (
                    <ViewTabIcon viewId={tab.viewId} />
                  )}
                  <span className="doc-tab-title">{title}</span>
                </Link>
                {!hideClose && (
                  <button
                    type="button"
                    className="doc-tab-close"
                    aria-label={t('tabs.closeTab', { title })}
                    onClick={() => closeTab(tab)}
                  >
                    <X size={12} strokeWidth={1.85} aria-hidden="true" />
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {canScrollRight && (
          <button
            type="button"
            className="doc-tabs-scroll-btn doc-tabs-scroll-right"
            onClick={() => scrollByStep(1)}
            aria-label={t('tabs.scrollRight')}
            title={t('tabs.scrollRight')}
          >
            <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="doc-tabs-menu-wrap" ref={menuRef}>
        <button
          type="button"
          className={`doc-tabs-menu-btn${menuOpen ? ' active' : ''}`}
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label={t('tabs.openTabsList', { count: tabs.length })}
          title={t('tabs.openTabsTitle')}
        >
          <span className="doc-tabs-menu-count">{tabs.length}</span>
          <ChevronDown size={12} strokeWidth={1.85} aria-hidden="true" />
        </button>

        {menuOpen && (
          <div className="doc-tabs-dropdown" role="menu" aria-label={t('tabs.openTabsTitle')}>
            <ul className="doc-tabs-dropdown-list">
              {tabs.map((tab) => {
                const isActive = activeKey === tab.key
                const hideClose = isSoleHome(tab)
                const typeClass = tab.kind === 'doc' ? `type-${tab.type}` : 'doc-tab-view'
                const title = resolveTabTitle(tab)
                return (
                  <li key={tab.key} className={`doc-tabs-dropdown-row${isActive ? ' active' : ''} ${typeClass}`}>
                    <Link
                      to={tab.path}
                      className="doc-tabs-dropdown-link"
                      role="menuitem"
                      onClick={() => setMenuOpen(false)}
                    >
                      {tab.kind === 'doc' ? (
                        <span className="doc-tab-dot" aria-hidden="true" />
                      ) : (
                        <ViewTabIcon viewId={tab.viewId} />
                      )}
                      <span className="doc-tabs-dropdown-text">
                        <span className="doc-tabs-dropdown-title">{title}</span>
                        <span className="doc-tabs-dropdown-id mono">{tab.kind === 'doc' ? tab.docId : tab.path}</span>
                      </span>
                    </Link>
                    {!hideClose && (
                      <button
                        type="button"
                        className="doc-tab-close"
                        aria-label={t('tabs.closeTab', { title })}
                        onClick={() => closeTab(tab)}
                      >
                        <X size={12} strokeWidth={1.85} aria-hidden="true" />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
            {(tabs.length > 1 || (tabs[0] && !isSoleHome(tabs[0]))) && (
              <div className="doc-tabs-dropdown-foot">
                <button
                  type="button"
                  className="doc-tabs-clear-btn"
                  onClick={() => {
                    setMenuOpen(false)
                    closeAllTabs()
                  }}
                >
                  {t('tabs.closeAllTabs')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </nav>
  )
}

function ViewTabIcon({ viewId }: { viewId: ViewTabId }) {
  const props = { size: 13, strokeWidth: 1.8, className: 'doc-tab-icon', 'aria-hidden': true as const }
  if (viewId === 'home') return <Home {...props} />
  if (viewId === 'review') return <ListChecks {...props} />
  return <Network {...props} />
}
