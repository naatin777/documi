import { Popover } from '@base-ui/react/popover'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  Home,
  ListChecks,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'
import { activeTabKeyFromPath, useTabs, type ViewTabId, type WorkspaceTab } from '../tabs'
import { AppTooltip } from './ui/Tooltip'

interface DocTabsProps {
  sidebarOpen: boolean
  onToggleSidebar: () => void
}

export default function DocTabs({ sidebarOpen, onToggleSidebar }: DocTabsProps) {
  const { t } = useTranslation()
  const { tabs, closeTab, closeAllTabs } = useTabs()
  const { pathname } = useLocation()
  const stripRef = useRef<HTMLDivElement>(null)
  const activeKey = activeTabKeyFromPath(pathname)

  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [menuState, setMenuState] = useState<{ open: boolean; path: string }>({ open: false, path: pathname })
  const menuOpen = menuState.open && menuState.path === pathname
  const setMenuOpen = (open: boolean) => setMenuState({ open, path: pathname })

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

  // リサイズやタブ数変化に応じて左右の溢れ状態を更新
  useEffect(() => {
    syncOverflow()
    const strip = stripRef.current
    if (!strip || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(syncOverflow)
    ro.observe(strip)
    return () => ro.disconnect()
  }, [tabs, syncOverflow])

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

  const stripMaskStyle: CSSProperties | undefined =
    canScrollLeft && canScrollRight
      ? {
          WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 32px, #000 calc(100% - 32px), transparent)',
          maskImage: 'linear-gradient(90deg, transparent, #000 32px, #000 calc(100% - 32px), transparent)',
        }
      : canScrollLeft
        ? {
            WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 32px, #000 100%)',
            maskImage: 'linear-gradient(90deg, transparent, #000 32px, #000 100%)',
          }
        : canScrollRight
          ? {
              WebkitMaskImage: 'linear-gradient(90deg, #000 0%, #000 calc(100% - 32px), transparent)',
              maskImage: 'linear-gradient(90deg, #000 0%, #000 calc(100% - 32px), transparent)',
            }
          : undefined

  const isSoleHome = (tab: WorkspaceTab) => tabs.length === 1 && tab.kind === 'view' && tab.viewId === 'home'

  const resolveTabTitle = (tab: WorkspaceTab) => {
    if (tab.kind === 'doc') return tab.title
    if (tab.viewId === 'home') return t('nav.home')
    if (tab.viewId === 'review') return t('nav.reviewQueue')
    if (tab.viewId === 'code') return t('nav.codeExplorer')
    return t('nav.graph')
  }

  return (
    <nav
      className="doc-tabs relative z-20 flex h-(--tabs-height) shrink-0 items-stretch border-b border-line bg-sidebar print:hidden"
      aria-label={t('tabs.workspaceTabs')}
    >
      <div className="flex shrink-0 items-center border-r border-line bg-sidebar px-[5px] max-desktop:hidden">
        <AppTooltip label={sidebarOpen ? t('tabs.closeSidebarTitle') : t('tabs.openSidebarTitle')}>
          <button
            type="button"
            className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-[5px] border-0 bg-transparent text-fg-muted hover:bg-hover hover:text-fg"
            onClick={onToggleSidebar}
            aria-expanded={sidebarOpen}
            aria-label={sidebarOpen ? t('tabs.closeSidebar') : t('tabs.openSidebar')}
          >
            {sidebarOpen ? (
              <PanelLeftClose size={15} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <PanelLeftOpen size={15} strokeWidth={1.75} aria-hidden="true" />
            )}
          </button>
        </AppTooltip>
      </div>

      <div className="relative flex min-w-0 flex-1 items-stretch overflow-hidden">
        {canScrollLeft && (
          <button
            type="button"
            className="absolute inset-y-1 left-1 z-3 flex w-6 cursor-pointer items-center justify-center rounded-[5px] border border-line bg-sidebar text-fg-muted shadow-[0_1px_4px_rgba(15,23,42,0.12)] hover:bg-hover hover:text-fg"
            onClick={() => scrollByStep(-1)}
            aria-label={t('tabs.scrollLeft')}
            title={t('tabs.scrollLeft')}
          >
            <ChevronLeft size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        )}

        <div
          className="flex min-w-0 flex-1 [scrollbar-width:none] items-stretch gap-0.5 overflow-x-auto overflow-y-hidden overscroll-x-contain px-2 pt-1 [&::-webkit-scrollbar]:hidden"
          style={stripMaskStyle}
          ref={stripRef}
          onScroll={syncOverflow}
          onWheel={handleWheel}
        >
          {tabs.map((tab) => {
            const isActive = activeKey === tab.key
            const hideClose = isSoleHome(tab)
            const typeClass = tab.kind === 'doc' ? `type-${tab.type}` : ''
            const title = resolveTabTitle(tab)
            const tooltip = tab.kind === 'doc' ? `${tab.docId} — ${title}` : title

            return (
              <div
                key={tab.key}
                data-active-tab={isActive ? 'true' : undefined}
                className={`group flex max-w-[240px] min-w-0 shrink-0 items-center rounded-t-md ${
                  isActive
                    ? 'bg-surface shadow-[inset_0_2px_0_var(--tc),inset_1px_0_0_var(--border),inset_-1px_0_0_var(--border)]'
                    : ''
                } ${typeClass}`}
              >
                <Link
                  to={tab.path}
                  className={`flex min-w-0 flex-1 items-center gap-1.5 pl-2.5 text-[13px] no-underline ${hideClose ? 'pr-3' : 'pr-1'} ${
                    isActive ? 'font-semibold text-fg' : 'text-fg-muted group-hover:text-fg'
                  }`}
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
                    <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-tc" aria-hidden="true" />
                  ) : (
                    <ViewTabIcon viewId={tab.viewId} active={isActive} />
                  )}
                  <span className="truncate">{title}</span>
                </Link>
                {!hideClose && (
                  <button
                    type="button"
                    className="mr-1 flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-fg-muted opacity-55 hover:bg-hover hover:text-fg hover:opacity-100"
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
            className="absolute inset-y-1 right-1 z-3 flex w-6 cursor-pointer items-center justify-center rounded-[5px] border border-line bg-sidebar text-fg-muted shadow-[0_1px_4px_rgba(15,23,42,0.12)] hover:bg-hover hover:text-fg"
            onClick={() => scrollByStep(1)}
            aria-label={t('tabs.scrollRight')}
            title={t('tabs.scrollRight')}
          >
            <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="relative flex shrink-0 items-center border-l border-line bg-sidebar px-1.5">
        <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <AppTooltip label={t('tabs.openTabsTitle')}>
            <Popover.Trigger
              className="inline-flex h-[26px] cursor-pointer items-center gap-1 rounded-[5px] border-0 bg-transparent px-2 text-[11.5px] font-semibold text-fg-muted hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg"
              aria-label={t('tabs.openTabsList', { count: tabs.length })}
            >
              <span className="tabular-nums">{tabs.length}</span>
              <ChevronDown size={12} strokeWidth={1.85} aria-hidden="true" />
            </Popover.Trigger>
          </AppTooltip>

          {typeof document !== 'undefined' && (
            <Popover.Portal>
              <Popover.Positioner align="end" sideOffset={4} collisionPadding={8} className="z-60">
                <Popover.Popup
                  aria-label={t('tabs.openTabsTitle')}
                  className="flex max-h-[360px] w-[290px] flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-[0_10px_28px_rgba(15,23,42,0.16)] transition-all duration-100 outline-none data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 dark:shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
                >
                  <ul className="m-0 list-none overflow-y-auto p-1">
                    {tabs.map((tab) => {
                      const isActive = activeKey === tab.key
                      const hideClose = isSoleHome(tab)
                      const typeClass = tab.kind === 'doc' ? `type-${tab.type}` : ''
                      const title = resolveTabTitle(tab)
                      return (
                        <li
                          key={tab.key}
                          className={`flex items-center gap-1 rounded-md hover:bg-hover ${isActive ? 'bg-tc-soft' : ''} ${typeClass}`}
                        >
                          <Link
                            to={tab.path}
                            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-fg no-underline"
                            onClick={() => setMenuOpen(false)}
                          >
                            {tab.kind === 'doc' ? (
                              <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-tc" aria-hidden="true" />
                            ) : (
                              <ViewTabIcon viewId={tab.viewId} active={isActive} />
                            )}
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate text-[12.5px] font-semibold">{title}</span>
                              <span className="mono truncate text-[10.5px] text-fg-muted">
                                {tab.kind === 'doc' ? tab.docId : tab.path}
                              </span>
                            </span>
                          </Link>
                          {!hideClose && (
                            <button
                              type="button"
                              className="mr-1 flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-fg-muted opacity-55 hover:bg-hover hover:text-fg hover:opacity-100"
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
                    <div className="border-t border-line bg-sidebar p-1.5">
                      <button
                        type="button"
                        className="w-full cursor-pointer rounded-md border border-line bg-surface px-2 py-1 text-xs font-semibold text-fg-muted hover:bg-hover hover:text-fg"
                        onClick={() => {
                          setMenuOpen(false)
                          closeAllTabs()
                        }}
                      >
                        {t('tabs.closeAllTabs')}
                      </button>
                    </div>
                  )}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          )}
        </Popover.Root>
      </div>
    </nav>
  )
}

function ViewTabIcon({ viewId, active }: { viewId: ViewTabId; active: boolean }) {
  const props = {
    size: 13,
    strokeWidth: 1.8,
    className: `shrink-0 ${active ? 'text-fg' : 'text-fg-muted'}`,
    'aria-hidden': true as const,
  }
  if (viewId === 'home') return <Home {...props} />
  if (viewId === 'review') return <ListChecks {...props} />
  if (viewId === 'code') return <FileCode2 {...props} />
  return <Network {...props} />
}
