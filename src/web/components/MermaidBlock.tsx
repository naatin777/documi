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
  const renderKey = `${resolved}\0${code}`
  const [rendered, setRendered] = useState<{ key: string; svg: string | null; error: string | null } | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const [scale, setScale] = useState(1)

  const openZoom = () => {
    setScale(1)
    setZoomed(true)
  }

  const isCurrent = rendered?.key === renderKey
  const loading = !isCurrent
  const svg = isCurrent ? rendered.svg : null
  const error = isCurrent ? rendered.error : null

  useEffect(() => {
    let cancelled = false
    const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`
    void (async () => {
      try {
        const mermaid = await getMermaid()
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: resolved === 'dark' ? 'dark' : 'default',
        })
        const { svg: out } = await mermaid.render(renderId, code)
        if (!cancelled) setRendered({ key: renderKey, svg: out, error: null })
      } catch (e) {
        if (!cancelled) setRendered({ key: renderKey, svg: null, error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [renderKey, code, resolved, reactId])

  return (
    <div className="mermaid-block">
      <div className="codeblock-toolbar">
        <span className="codeblock-lang">mermaid</span>
        {svg && (
          <>
            <button type="button" className="codeblock-copy" onClick={() => setShowSource((v) => !v)}>
              {showSource ? t('mermaid.showDiagram') : t('mermaid.showSource')}
            </button>
            <button type="button" className="codeblock-copy" onClick={openZoom}>
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
        <button
          type="button"
          className="mermaid-svg mermaid-svg-trigger"
          aria-label={t('mermaid.zoomAria')}
          onClick={openZoom}
        >
          <span dangerouslySetInnerHTML={{ __html: svg }} />
        </button>
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
          className="relative max-h-[90vh] w-auto max-w-[92vw] overflow-auto p-8 pt-12"
        >
          <div className="mermaid-zoom-toolbar">
            <button
              type="button"
              className="codeblock-copy"
              onClick={() => setScale((s) => Math.max(0.5, Math.round((s - 0.25) * 100) / 100))}
            >
              -
            </button>
            <button type="button" className="codeblock-copy" onClick={() => setScale(1)}>
              {Math.round(scale * 100)}%
            </button>
            <button
              type="button"
              className="codeblock-copy"
              onClick={() => setScale((s) => Math.min(2.5, Math.round((s + 0.25) * 100) / 100))}
            >
              +
            </button>
          </div>
          <DialogClose
            className="absolute top-2.5 right-3 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-fg-muted hover:bg-hover hover:text-fg"
            aria-label={t('common.close')}
          >
            <X size={16} strokeWidth={1.85} aria-hidden="true" />
          </DialogClose>
          <div
            className="mermaid-zoom-svg"
            style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </AppDialog>
      )}
    </div>
  )
}
