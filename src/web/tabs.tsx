import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ID_PATTERN, isArtifactType } from '../core/types'
import type { ArtifactType } from '../core/types'

export interface DocTab {
  type: ArtifactType
  id: string
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
        isArtifactType((t as DocTab).type) &&
        ID_PATTERN.test((t as DocTab).id) &&
        typeof (t as DocTab).title === 'string',
    )
  } catch {
    return []
  }
}

export function pageRef(pathname: string): { type: ArtifactType; id: string } | null {
  const m = /^\/pages\/([^/]+)\/([^/]+)/.exec(pathname)
  const type = m?.[1]
  const id = m?.[2]
  return type && id && isArtifactType(type) && ID_PATTERN.test(id) ? { type, id } : null
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
      const i = prev.findIndex((t) => t.type === tab.type && t.id === tab.id)
      const existing = i >= 0 ? prev[i] : undefined
      if (!existing) return [...prev, tab]
      if (existing.title === tab.title) return prev
      const next = [...prev]
      next[i] = { ...existing, title: tab.title }
      return next
    })
  }, [])

  const closeTab = useCallback(
    (tab: DocTab) => {
      const idx = tabs.findIndex((t) => t.type === tab.type && t.id === tab.id)
      if (idx < 0) return
      const next = tabs.filter((_, i) => i !== idx)
      setTabs(next)
      const cur = pageRef(pathname)
      if (cur && cur.type === tab.type && cur.id === tab.id) {
        const neighbor = next[Math.min(idx, next.length - 1)]
        navigate(neighbor ? `/pages/${neighbor.type}/${neighbor.id}` : '/glossary')
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
