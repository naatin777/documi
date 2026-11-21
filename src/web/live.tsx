import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { createAppQueryClient } from './queries'

function LiveEventSubscriber({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const es = new EventSource('/api/events')
    const onReload = () => {
      void queryClient.invalidateQueries()
    }
    es.addEventListener('reload', onReload)
    return () => {
      es.removeEventListener('reload', onReload)
      es.close()
    }
  }, [queryClient])

  return children
}

/**
 * React Query のキャッシュプロバイダと `/api/events` SSE 購読を統合し、
 * ドキュメント変更時にキャッシュを一括無効化してライブ再描画する。
 * @implements ui.live-reload
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createAppQueryClient)
  return (
    <QueryClientProvider client={queryClient}>
      <LiveEventSubscriber>{children}</LiveEventSubscriber>
    </QueryClientProvider>
  )
}
