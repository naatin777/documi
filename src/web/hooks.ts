import { useCallback, useEffect, useRef, useState } from 'react'
import { highlightCode } from './highlight'

/** Shiki ハイライト済み HTML を非同期に保持する。依存変更時・アンマウント時に結果を破棄する。 */
export function useHighlightedCode(code: string, lang?: string | null): string | null {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setHtml(null)
    void highlightCode(code, lang).then((result) => {
      if (!cancelled) setHtml(result)
    })
    return () => {
      cancelled = true
    }
  }, [code, lang])

  return html
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
    void clipboard.writeText(text).then(() => {
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    }).catch(() => {
      // clipboard が使えない環境では何もしない
    })
  }, [])

  return { copied, copy }
}
