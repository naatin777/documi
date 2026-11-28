import { useCallback, useEffect, useRef, useState } from 'react'
import { highlightCode } from './highlight'

/** Shiki ハイライト済み HTML を非同期に保持する。依存変更時・アンマウント時に結果を破棄する。 */
export function useHighlightedCode(code: string, lang?: string | null): string | null {
  const key = `${lang ?? ''}\0${code}`
  const [entry, setEntry] = useState<{ key: string; html: string | null }>({ key: '', html: null })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const result = await highlightCode(code, lang)
      if (!cancelled) setEntry({ key, html: result })
    })()
    return () => {
      cancelled = true
    }
  }, [key, code, lang])

  return entry.key === key ? entry.html : null
}

/** 入力値を指定ミリ秒デバウンスした値を返す。無効時や空文字時は同期 setState せず即座に空文字を返す。 */
export function useDebouncedValue(value: string, delayMs: number, enabled = true): string {
  const trimmed = enabled ? value.trim() : ''
  const [debounced, setDebounced] = useState('')

  useEffect(() => {
    if (!trimmed) return
    const timer = setTimeout(() => setDebounced(trimmed), delayMs)
    return () => clearTimeout(timer)
  }, [trimmed, delayMs])

  return trimmed ? debounced : ''
}

/** active が true の間だけ document.body に CSS クラスを付与する */
export function useBodyClass(className: string, active: boolean): void {
  useEffect(() => {
    if (!active) return
    document.body.classList.add(className)
    return () => {
      document.body.classList.remove(className)
    }
  }, [className, active])
}

/** テキストをコピーし、一時的な「コピー済み」状態を提供する。タイマーはアンマウント時に解除する。 */
export function useCopyText(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copy = useCallback((text: string) => {
    const clipboard = navigator.clipboard
    if (!clipboard) return
    void (async () => {
      try {
        await clipboard.writeText(text)
        setCopied(true)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1500)
      } catch {
        // clipboard が使えない環境では何もしない
      }
    })()
  }, [])

  return { copied, copy }
}

import type { StoredCard } from '../core/cards'
import type { ReviewCardStateMap } from './reviewCards'

/** カードストアの一覧と、そこから種まきした初期回答状態を返す。未取得は null、取得失敗は空。 */
export function useReviewCards(): { cards: StoredCard[] | null; seededStates: ReviewCardStateMap } {
  const [result, setResult] = useState<{ cards: StoredCard[]; seededStates: ReviewCardStateMap } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { rpc } = await import('./api')
        const res = await rpc.api.cards.$get()
        const data = await res.json()
        if (cancelled) return
        const seededStates: ReviewCardStateMap = {}
        for (const card of data.cards) {
          seededStates[card.id] = {
            selectedOptionId: card.answer?.selectedOptionId,
            finish: card.answer?.finish,
            writeIn: card.answer?.writeIn,
            incomprehensible: card.incomprehensible,
            objected: card.objected,
          }
        }
        setResult({ cards: data.cards, seededStates })
      } catch {
        if (!cancelled) setResult({ cards: [], seededStates: {} })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return { cards: result?.cards ?? null, seededStates: result?.seededStates ?? {} }
}
