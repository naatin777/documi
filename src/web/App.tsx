import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react'
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'
import { useTranslation } from 'react-i18next'
import { Route, Routes, useLocation } from 'react-router'
import DocTabs from './components/DocTabs'
import Explorer from './components/Explorer'
import ResizeHandle, { useResizableWidth } from './components/ResizeHandle'
import TopBar from './components/TopBar'
import { TooltipProvider } from './components/ui/Tooltip'
import { LiveProvider } from './live'
import { useOverviewQuery } from './queries'
import { TabsProvider } from './tabs'
import { ThemeProvider } from './theme'

const OverviewLayout = lazy(() => import('./components/OverviewLayout'))
const ReviewLayout = lazy(() => import('./components/ReviewLayout'))
const DocLayout = lazy(() => import('./components/DocLayout'))
const GraphLayout = lazy(() => import('./components/GraphLayout'))
const CodeExplorerLayout = lazy(() => import('./components/CodeExplorerLayout'))
const BundleLayout = lazy(() => import('./components/BundleLayout'))
const SearchModal = lazy(() => import('./components/SearchModal'))

export default function App() {
  return (
    <ThemeProvider>
      <LiveProvider>
        <TabsProvider>
          <TooltipProvider>
            <AppRouter />
          </TooltipProvider>
        </TabsProvider>
      </LiveProvider>
    </ThemeProvider>
  )
}

function AppRouter() {
  const location = useLocation()
  // /bundle は表紙・目次・複数章を印刷/PDF 出力する専用レイアウト
  if (location.pathname === '/bundle') {
    return (
      <ErrorBoundary FallbackComponent={ErrorFallback}>
        <Suspense fallback={<RouteLoading />}>
          <BundleLayout />
        </Suspense>
      </ErrorBoundary>
    )
  }
  return <AppShell />
}

function AppShell() {
  const { t } = useTranslation()
  const location = useLocation()
  const [navState, setNavState] = useState<{ open: boolean; path: string }>({ open: false, path: location.pathname })
  const navOpen = navState.open && navState.path === location.pathname
  const setNavOpen = (open: boolean) => setNavState({ open, path: location.pathname })
  const [searchOpen, setSearchOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const {
    width: explorerWidth,
    setWidth: setExplorerWidth,
    resetWidth: resetExplorerWidth,
  } = useResizableWidth({
    storageKey: 'documi:explorer-width',
    defaultWidth: 280,
    minWidth: 200,
    maxWidth: 480,
  })
  const { data: overview } = useOverviewQuery()
  const reviewBadgeCount = overview ? overview.attentionBlocks.length : 0

  // Cmd+K / Ctrl+K (全文検索) および Cmd+B / Ctrl+B (サイドバー開閉)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        setSearchOpen((v) => !v)
      } else if (key === 'b') {
        e.preventDefault()
        setSidebarOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      className={`grid h-screen ${sidebarOpen ? 'grid-cols-[var(--explorer-width)_minmax(0,1fr)]' : 'desktop:grid-cols-[minmax(0,1fr)]'} max-desktop:flex max-desktop:flex-col print:block print:h-auto print:min-h-0 print:overflow-visible`}
      style={{ '--explorer-width': `${explorerWidth}px` } as CSSProperties}
    >
      <TopBar onMenu={() => setNavOpen(true)} />
      <Explorer
        reviewBadgeCount={reviewBadgeCount}
        navOpen={navOpen}
        sidebarOpen={sidebarOpen}
        onClose={() => setNavOpen(false)}
        onOpenSearch={() => setSearchOpen(true)}
        resizeHandle={
          <ResizeHandle
            side="right"
            className="absolute inset-y-0 right-0"
            width={explorerWidth}
            minWidth={200}
            maxWidth={480}
            onChange={setExplorerWidth}
            onReset={resetExplorerWidth}
            label={t('resize.sidebar')}
          />
        }
      />
      {navOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/35 print:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden print:block print:h-auto print:min-h-0 print:overflow-visible">
        <DocTabs sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((v) => !v)} />
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden max-desktop:flex-col max-desktop:overflow-y-auto print:block print:h-auto print:min-h-0 print:overflow-visible">
          <ErrorBoundary FallbackComponent={ErrorFallback} resetKeys={[location.pathname]}>
            <Suspense fallback={<RouteLoading />}>
              <Routes>
                <Route path="/" element={<OverviewLayout />} />
                <Route path="/review" element={<ReviewLayout />} />
                <Route path="/graph" element={<GraphLayout />} />
                <Route path="/code" element={<CodeExplorerLayout />} />
                <Route path="/docs/*" element={<DocLayout />} />
                <Route path="*" element={<NotFoundLayout />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
      {searchOpen && (
        <Suspense fallback={null}>
          <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
        </Suspense>
      )}
    </div>
  )
}

function RouteLoading() {
  const { t } = useTranslation()
  return (
    <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface max-desktop:flex-none max-desktop:overflow-visible">
      <div className="page">
        <p className="muted">{t('common.loading')}</p>
      </div>
    </main>
  )
}

function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const { t } = useTranslation()
  return (
    <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface max-desktop:flex-none max-desktop:overflow-visible">
      <div className="page">
        <h1>{t('common.errorTitle')}</h1>
        <p className="error-text">{error instanceof Error ? error.message : String(error)}</p>
        <button type="button" className="button" onClick={resetErrorBoundary}>
          {t('common.retry')}
        </button>
      </div>
    </main>
  )
}

function NotFoundLayout() {
  const { t } = useTranslation()
  return (
    <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface max-desktop:flex-none max-desktop:overflow-visible">
      <div className="page">
        <h1>{t('common.notFoundTitle')}</h1>
        <p>{t('common.notFoundBody')}</p>
      </div>
    </main>
  )
}
