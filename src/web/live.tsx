import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

const LiveContext = createContext<number>(0)

/**
 * `/api/events` の SSE を購読し、ドキュメント変更時にリビジョン番号をインクリメントする。
 * @implements ui.live-reload
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const es = new EventSource('/api/events')
    const onReload = () => setRevision((r) => r + 1)
    es.addEventListener('reload', onReload)
    return () => {
      es.removeEventListener('reload', onReload)
      es.close()
    }
  }, [])

  return <LiveContext.Provider value={revision}>{children}</LiveContext.Provider>
}

export function useDocsRevision(): number {
  return useContext(LiveContext)
}
