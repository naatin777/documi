import { useEffect, useId, useState } from 'react'
import { useTheme } from '../theme'

type MermaidModule = typeof import('mermaid').default

let mermaidPromise: Promise<MermaidModule> | null = null

function getMermaid(): Promise<MermaidModule> {
  mermaidPromise ??= import('mermaid').then((m) => m.default)
  return mermaidPromise
}

interface MermaidBlockProps {
  code: string
}

/** ```mermaid フェンスを図としてレンダリングする */
export default function MermaidBlock({ code }: MermaidBlockProps) {
  const { resolved } = useTheme()
  const reactId = useId()
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showSource, setShowSource] = useState(false)
  const [zoomed, setZoomed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setSvg(null)
    const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`
    ;(async () => {
      try {
        const mermaid = await getMermaid()
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: resolved === 'dark' ? 'dark' : 'default',
        })
        const { svg: out } = await mermaid.render(renderId, code)
        if (!cancelled) setSvg(out)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, resolved, reactId])

  return (
    <div className="mermaid-block">
      <div className="codeblock-toolbar">
        <span className="codeblock-lang">mermaid</span>
        {svg && (
          <>
            <button type="button" className="codeblock-copy" onClick={() => setShowSource((v) => !v)}>
              {showSource ? '図を表示' : 'ソース'}
            </button>
            <button type="button" className="codeblock-copy" onClick={() => setZoomed(true)}>
              拡大
            </button>
          </>
        )}
      </div>
      {loading && <p className="muted mermaid-status">図を描画中…</p>}
      {error && (
        <div className="mermaid-error">
          <p className="error-text">Mermaid の描画に失敗しました: {error}</p>
          <pre className="codeblock-plain">
            <code>{code}</code>
          </pre>
        </div>
      )}
      {svg && !showSource && (
        <div className="mermaid-svg" role="img" aria-label="Mermaid 図" dangerouslySetInnerHTML={{ __html: svg }} />
      )}
      {svg && showSource && (
        <pre className="codeblock-plain">
          <code>{code}</code>
        </pre>
      )}
      {zoomed && svg && (
        <div
          className="mermaid-zoom"
          role="dialog"
          aria-modal="true"
          aria-label="Mermaid 図（拡大）"
          onClick={() => setZoomed(false)}
        >
          <div className="mermaid-zoom-inner" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="mermaid-zoom-close" aria-label="閉じる" onClick={() => setZoomed(false)}>
              ×
            </button>
            <div dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
        </div>
      )}
    </div>
  )
}
