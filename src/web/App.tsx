import { useEffect, useState } from 'react'
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import Explorer from './components/Explorer'
import TopBar from './components/TopBar'
import DocLayout from './components/DocLayout'
import GlossaryLayout from './components/GlossaryLayout'
import DocTabs from './components/DocTabs'
import { TabsProvider } from './tabs'
import { ThemeProvider } from './theme'

export default function App() {
  return (
    <ThemeProvider>
      <TabsProvider>
        <AppShell />
      </TabsProvider>
    </ThemeProvider>
  )
}

function AppShell() {
  const [navOpen, setNavOpen] = useState(false)
  const location = useLocation()

  // ルート遷移時にモバイルの Explorer ドロワーを閉じる
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])

  return (
    <div className={`app${navOpen ? ' nav-open' : ''}`}>
      <TopBar onMenu={() => setNavOpen(true)} />
      <Explorer onClose={() => setNavOpen(false)} />
      {navOpen && <div className="nav-overlay" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <div className="doccols">
        <ErrorBoundary FallbackComponent={ErrorFallback} resetKeys={[location.pathname]}>
          <Routes>
            <Route path="/" element={<Navigate to="/glossary" replace />} />
            <Route path="/glossary" element={<GlossaryLayout />} />
            <Route path="/pages/:type/:id" element={<DocLayout />} />
            <Route path="*" element={<NotFoundLayout />} />
          </Routes>
        </ErrorBoundary>
      </div>
    </div>
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
    <>
      <main className="content">
        <DocTabs />
        <div className="page">
          <h1>ページが見つかりません</h1>
          <p>指定されたページは存在しません。</p>
        </div>
      </main>
      <aside className="side-panel" />
    </>
  )
}
