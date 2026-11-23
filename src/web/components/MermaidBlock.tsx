import { X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useTheme } from '../theme'
import { AppDialog, DialogClose } from './ui/Dialog'

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
  const { t } = useTranslation()
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
              {showSource ? t('mermaid.showDiagram') : t('mermaid.showSource')}
            </button>
            <button type="button" className="codeblock-copy" onClick={() => setZoomed(true)}>
              {t('mermaid.zoom')}
            </button>
          </>
        )}
      </div>
      {loading && <p className="muted mermaid-status">{t('mermaid.rendering')}</p>}
      {error && (
        <div className="mermaid-error">
          <p className="error-text">{t('mermaid.renderError', { error })}</p>
          <pre className="codeblock-plain">
            <code>{code}</code>
          </pre>
        </div>
      )}
      {svg && !showSource && (
        <div
          className="mermaid-svg"
          role="img"
          aria-label={t('mermaid.diagramAria')}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {svg && showSource && (
        <pre className="codeblock-plain">
          <code>{code}</code>
        </pre>
      )}
      {svg && (
        <AppDialog
          open={zoomed}
          onOpenChange={setZoomed}
          ariaLabel={t('mermaid.zoomAria')}
          align="center"
          className="relative max-h-[90vh] max-w-[90vw] w-auto overflow-auto p-8"
        >
          <DialogClose
            className="absolute top-2.5 right-3 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-fg-muted hover:bg-hover hover:text-fg"
            aria-label={t('common.close')}
          >
            <X size={16} strokeWidth={1.85} aria-hidden="true" />
          </DialogClose>
          <div className="mermaid-zoom-svg" dangerouslySetInnerHTML={{ __html: svg }} />
        </AppDialog>
      )}
    </div>
  )
}
