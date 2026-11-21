import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { isArtifactType } from '../core/types'
import type { ArtifactType } from '../core/types'
import { encodeDocId } from './api'

export interface DocTab {
  id: string
  type: ArtifactType
  title: string
}

interface TabsContextValue {
  tabs: DocTab[]
  openTab: (tab: DocTab) => void
  closeTab: (tab: DocTab) => void
}

const TabsContext = createContext<TabsContextValue | null>(null)

const STORAGE_KEY = 'documi:open-tabs'

function loadTabs(): DocTab[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (t): t is DocTab =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as DocTab).id === 'string' &&
        (t as DocTab).id.length > 0 &&
        isArtifactType((t as DocTab).type) &&
        typeof (t as DocTab).title === 'string',
    )
  } catch {
    return []
  }
}

export function docIdFromPath(pathname: string): string | null {
  const m = /^\/docs\/(.+)$/.exec(pathname)
  if (!m?.[1]) return null
  try {
    return decodeURIComponent(m[1]).replace(/\/+$/, '')
  } catch {
    return m[1].replace(/\/+$/, '')
  }
}

export function TabsProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<DocTab[]>(loadTabs)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tabs))
    } catch {
      // sessionStorage が使えない環境では永続化を諦める
    }
  }, [tabs])

  const openTab = useCallback((tab: DocTab) => {
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.id === tab.id)
      const existing = i >= 0 ? prev[i] : undefined
      if (!existing) return [...prev, tab]
      if (existing.title === tab.title && existing.type === tab.type) return prev
      const next = [...prev]
      next[i] = { ...existing, title: tab.title, type: tab.type }
      return next
    })
  }, [])

  const closeTab = useCallback(
    (tab: DocTab) => {
      const idx = tabs.findIndex((t) => t.id === tab.id)
      if (idx < 0) return
      const next = tabs.filter((_, i) => i !== idx)
      setTabs(next)
      const cur = docIdFromPath(pathname)
      if (cur === tab.id) {
        const neighbor = next[Math.min(idx, next.length - 1)]
        navigate(neighbor ? `/docs/${encodeDocId(neighbor.id)}` : '/')
      }
    },
    [tabs, pathname, navigate],
  )

  const value = useMemo(() => ({ tabs, openTab, closeTab }), [tabs, openTab, closeTab])
  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>
}

export function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error('useTabs must be used within TabsProvider')
  return ctx
}
