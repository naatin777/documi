import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react'
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'
import { useTranslation } from 'react-i18next'
import { Route, Routes, useLocation } from 'react-router'
import DocTabs from './components/DocTabs'
import Explorer from './components/Explorer'
import ResizeHandle, { useResizableWidth } from './components/ResizeHandle'
import TopBar from './components/TopBar'
import { LiveProvider } from './live'
import { useOverviewQuery } from './queries'
import { TabsProvider } from './tabs'
import { ThemeProvider } from './theme'

const OverviewLayout = lazy(() => import('./components/OverviewLayout'))
const ReviewLayout = lazy(() => import('./components/ReviewLayout'))
const DocLayout = lazy(() => import('./components/DocLayout'))
const GraphLayout = lazy(() => import('./components/GraphLayout'))
const BundleLayout = lazy(() => import('./components/BundleLayout'))
const SearchModal = lazy(() => import('./components/SearchModal'))

export default function App() {
  return (
    <ThemeProvider>
      <LiveProvider>
        <TabsProvider>
          <AppRouter />
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
  const [navOpen, setNavOpen] = useState(false)
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
  const location = useLocation()
  const { data: overview } = useOverviewQuery()
  const reviewBadgeCount = overview ? overview.attentionBlocks.length + overview.openFeedbackItems.length : 0

  // ルート遷移時にモバイルの Explorer ドロワーを閉じる
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])

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
      className={`app${navOpen ? ' nav-open' : ''}${!sidebarOpen ? ' sidebar-collapsed' : ''}`}
      style={{ '--explorer-width': `${explorerWidth}px` } as CSSProperties}
    >
      <TopBar onMenu={() => setNavOpen(true)} />
      <Explorer
        reviewBadgeCount={reviewBadgeCount}
        onClose={() => setNavOpen(false)}
        onOpenSearch={() => setSearchOpen(true)}
        resizeHandle={
          <ResizeHandle
            side="right"
            className="resize-handle-edge-right"
            width={explorerWidth}
            minWidth={200}
            maxWidth={480}
            onChange={setExplorerWidth}
            onReset={resetExplorerWidth}
            label={t('resize.sidebar')}
          />
        }
      />
      {navOpen && <div className="nav-overlay" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <div className="workspace">
        <DocTabs sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((v) => !v)} />
        <div className="doccols">
          <ErrorBoundary FallbackComponent={ErrorFallback} resetKeys={[location.pathname]}>
            <Suspense fallback={<RouteLoading />}>
              <Routes>
                <Route path="/" element={<OverviewLayout />} />
                <Route path="/review" element={<ReviewLayout />} />
                <Route path="/graph" element={<GraphLayout />} />
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
    <main className="content">
      <div className="page">
        <p className="muted">{t('common.loading')}</p>
      </div>
    </main>
  )
}

function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const { t } = useTranslation()
  return (
    <main className="content">
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
    <main className="content">
      <div className="page">
        <h1>{t('common.notFoundTitle')}</h1>
        <p>{t('common.notFoundBody')}</p>
      </div>
    </main>
  )
}
