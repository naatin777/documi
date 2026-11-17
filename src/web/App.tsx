import { useEffect, useState } from 'react'
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
        <Routes>
          <Route path="/" element={<Navigate to="/glossary" replace />} />
          <Route path="/glossary" element={<GlossaryLayout />} />
          <Route path="/pages/:type/:id" element={<DocLayout />} />
          <Route path="*" element={<NotFoundLayout />} />
        </Routes>
      </div>
    </div>
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
