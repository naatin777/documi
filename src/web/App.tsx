import { lazy, Suspense, useEffect, useState } from 'react'
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'
import { Route, Routes, useLocation } from 'react-router-dom'
import { api } from './api'
import DocTabs from './components/DocTabs'
import Explorer from './components/Explorer'
import TopBar from './components/TopBar'
import { LiveProvider, useDocsRevision } from './live'
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
  const [navOpen, setNavOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [reviewBadgeCount, setReviewBadgeCount] = useState(0)
  const revision = useDocsRevision()
  const location = useLocation()

  // ルート遷移時にモバイルの Explorer ドロワーを閉じる
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])

  // Review Queue の要確認バッジ件数を購読
  useEffect(() => {
    let cancelled = false
    api
      .overview()
      .then((res) => {
        if (!cancelled) {
          setReviewBadgeCount(res.attentionBlocks.length + res.openFeedbackItems.length)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [revision])

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
    <div className={`app${navOpen ? ' nav-open' : ''}${!sidebarOpen ? ' sidebar-collapsed' : ''}`}>
      <TopBar onMenu={() => setNavOpen(true)} />
      {!sidebarOpen && (
        <button
          type="button"
          className="sidebar-reopen-btn"
          onClick={() => setSidebarOpen(true)}
          title="サイドバーを開く (⌘B)"
          aria-label="サイドバーを開く"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M5.5 3.5L10 8L5.5 12.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      <Explorer
        reviewBadgeCount={reviewBadgeCount}
        onCollapse={() => setSidebarOpen(false)}
        onClose={() => setNavOpen(false)}
        onOpenSearch={() => setSearchOpen(true)}
      />
      {navOpen && <div className="nav-overlay" onClick={() => setNavOpen(false)} aria-hidden="true" />}
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
      {searchOpen && (
        <Suspense fallback={null}>
          <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
        </Suspense>
      )}
    </div>
  )
}

function RouteLoading() {
  return (
    <main className="content">
      <div className="page">
        <p className="muted">読み込み中…</p>
      </div>
    </main>
  )
}

function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <main className="content">
      <div className="page">
        <h1>表示中にエラーが発生しました</h1>
        <p className="error-text">{error instanceof Error ? error.message : String(error)}</p>
        <button type="button" className="button" onClick={resetErrorBoundary}>
          再表示
        </button>
      </div>
    </main>
  )
}

function NotFoundLayout() {
  return (
    <main className="content">
      <DocTabs />
      <div className="page">
        <h1>ページが見つかりません</h1>
        <p>指定されたページは存在しません。</p>
      </div>
    </main>
  )
}
