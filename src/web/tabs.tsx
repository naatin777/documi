import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { isArtifactType } from '../core/types'
import type { ArtifactType } from '../core/types'
import { encodeDocId } from './api'

export type ViewTabId = 'home' | 'review' | 'graph' | 'code'

export type WorkspaceTab =
  | {
      kind: 'view'
      key: `view:${ViewTabId}`
      viewId: ViewTabId
      path: '/' | '/review' | '/graph' | '/code'
      title: string
    }
  | {
      kind: 'doc'
      key: string
      docId: string
      path: string
      type: ArtifactType
      title: string
    }

interface OpenDocTabInput {
  id: string
  type: ArtifactType
  title: string
}

interface TabsContextValue {
  tabs: WorkspaceTab[]
  openTab: (tab: OpenDocTabInput) => void
  closeTab: (tab: WorkspaceTab) => void
  closeAllTabs: () => void
}

const TabsContext = createContext<TabsContextValue | null>(null)

const STORAGE_KEY = 'documi:workspace-tabs'

const VIEW_TABS: Record<ViewTabId, Extract<WorkspaceTab, { kind: 'view' }>> = {
  home: { kind: 'view', key: 'view:home', viewId: 'home', path: '/', title: 'Home' },
  review: { kind: 'view', key: 'view:review', viewId: 'review', path: '/review', title: 'Review Queue' },
  graph: { kind: 'view', key: 'view:graph', viewId: 'graph', path: '/graph', title: 'Graph & Matrix' },
  code: { kind: 'view', key: 'view:code', viewId: 'code', path: '/code', title: 'Code Explorer' },
}

function docIdFromPath(pathname: string): string | null {
  const m = /^\/docs\/(.+)$/.exec(pathname)
  if (!m?.[1]) return null
  try {
    return decodeURIComponent(m[1]).replace(/\/+$/, '')
  } catch {
    return m[1].replace(/\/+$/, '')
  }
}

export function activeTabKeyFromPath(pathname: string): string | null {
  if (pathname === '/' || pathname === '') return VIEW_TABS.home.key
  if (pathname === '/review') return VIEW_TABS.review.key
  if (pathname === '/graph') return VIEW_TABS.graph.key
  if (pathname === '/code') return VIEW_TABS.code.key
  const docId = docIdFromPath(pathname)
  return docId ? `doc:${docId}` : null
}

function viewTabForPath(pathname: string): Extract<WorkspaceTab, { kind: 'view' }> | null {
  if (pathname === '/' || pathname === '') return VIEW_TABS.home
  if (pathname === '/review') return VIEW_TABS.review
  if (pathname === '/graph') return VIEW_TABS.graph
  if (pathname === '/code') return VIEW_TABS.code
  return null
}

function loadTabs(initialPathname: string): WorkspaceTab[] {
  const initialView = viewTabForPath(initialPathname)
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return [initialView ?? VIEW_TABS.home]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [initialView ?? VIEW_TABS.home]

    const restored: WorkspaceTab[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      if (
        rec.kind === 'view' &&
        (rec.viewId === 'home' || rec.viewId === 'review' || rec.viewId === 'graph' || rec.viewId === 'code')
      ) {
        const vt = VIEW_TABS[rec.viewId]
        if (!seen.has(vt.key)) {
          seen.add(vt.key)
          restored.push(vt)
        }
      } else if (
        rec.kind === 'doc' &&
        typeof rec.docId === 'string' &&
        rec.docId.length > 0 &&
        isArtifactType(rec.type) &&
        typeof rec.title === 'string'
      ) {
        const key = `doc:${rec.docId}`
        if (!seen.has(key)) {
          seen.add(key)
          restored.push({
            kind: 'doc',
            key,
            docId: rec.docId,
            path: `/docs/${encodeDocId(rec.docId)}`,
            type: rec.type,
            title: rec.title,
          })
        }
      }
    }

    if (initialView && !seen.has(initialView.key)) {
      restored.push(initialView)
    }
    return restored.length > 0 ? restored : [initialView ?? VIEW_TABS.home]
  } catch {
    return [initialView ?? VIEW_TABS.home]
  }
}

export function TabsProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() => loadTabs(pathname))

  // ルート遷移時に Home / Review Queue / Graph & Matrix タブを自動登録する
  useEffect(() => {
    const viewTab = viewTabForPath(pathname)
    if (!viewTab) return
    setTabs((prev) => {
      if (prev.some((t) => t.key === viewTab.key)) return prev
      return [...prev, viewTab]
    })
  }, [pathname])

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tabs))
    } catch {
      // sessionStorage が使えない環境では永続化を諦める
    }
  }, [tabs])

  const openTab = useCallback((input: OpenDocTabInput) => {
    const key = `doc:${input.id}`
    const nextTab: WorkspaceTab = {
      kind: 'doc',
      key,
      docId: input.id,
      path: `/docs/${encodeDocId(input.id)}`,
      type: input.type,
      title: input.title,
    }
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.key === key)
      const existing = i >= 0 ? prev[i] : undefined
      if (!existing) return [...prev, nextTab]
      if (existing.kind === 'doc' && existing.title === nextTab.title && existing.type === nextTab.type) {
        return prev
      }
      const next = [...prev]
      next[i] = nextTab
      return next
    })
  }, [])

  const closeTab = useCallback(
    (tab: WorkspaceTab) => {
      const idx = tabs.findIndex((t) => t.key === tab.key)
      if (idx < 0) return
      const next = tabs.filter((_, i) => i !== idx)
      const activeKey = activeTabKeyFromPath(pathname)

      if (next.length === 0) {
        setTabs([VIEW_TABS.home])
        if (pathname !== '/') navigate('/')
        return
      }

      setTabs(next)
      if (activeKey === tab.key) {
        const neighbor = next[Math.min(idx, next.length - 1)]
        navigate(neighbor ? neighbor.path : '/')
      }
    },
    [tabs, pathname, navigate],
  )

  const closeAllTabs = useCallback(() => {
    setTabs([VIEW_TABS.home])
    if (pathname !== '/') navigate('/')
  }, [pathname, navigate])

  const value = useMemo(() => ({ tabs, openTab, closeTab, closeAllTabs }), [tabs, openTab, closeTab, closeAllTabs])
  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>
}

export function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext)
  if (!ctx) throw new Error('useTabs must be used within TabsProvider')
  return ctx
}
