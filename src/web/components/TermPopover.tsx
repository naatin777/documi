import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { encodeDocId, type TermEntry } from '../api'
import { toErrorMessage, useSourceQuery } from '../queries'
import { HighlightedCode } from './HighlightedCode'

interface TermInlineProps {
  name?: string
  term?: TermEntry
  children?: ReactNode
}

/**
 * 本文中の用語参照 (自動リンクおよび明示 <Term />)。
 * ホバーまたはフォーカスで定義と紐づくコード型定義をポップオーバー表示する。
 * @implements ui.glossary-autolink
 */
export function TermInline({ name, term, children }: TermInlineProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const primarySymbol = term?.symbols[0]
  const [symbolFile, symbolName] = primarySymbol ? primarySymbol.split('#') : ['', '']
  const hasValidSymbol = Boolean(symbolFile && symbolName)
  const label = children ?? name ?? term?.id ?? ''

  const previewQuery = useSourceQuery({ file: symbolFile, symbol: symbolName }, open && hasValidSymbol)
  const preview = previewQuery.data ?? null
  const previewError = toErrorMessage(previewQuery.error)
  const loading = open && hasValidSymbol && previewQuery.isPending

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [])

  if (!term) {
    return <span className="sem-term-inline">{label}</span>
  }

  const handleEnter = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setOpen(true)
  }

  const handleLeave = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 160)
  }

  const targetHref = `/docs/${encodeDocId(term.docId)}#block-${encodeURIComponent(term.id)}`

  return (
    <span className="term-ref-wrap" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      <Link to={targetHref} className="sem-term-inline" onFocus={handleEnter} onBlur={handleLeave}>
        {label}
      </Link>
      {open && (
        <span className="term-popover" role="tooltip">
          <span className="term-popover-head">
            <strong className="term-popover-name">{term.id}</strong>
            {term.aliases.length > 0 && <span className="term-popover-aliases">{term.aliases.join(' / ')}</span>}
          </span>
          <span className="term-popover-body">{term.rawBody}</span>
          {primarySymbol && (
            <span className="term-popover-code">
              <span className="term-popover-symbol mono">{primarySymbol}</span>
              {loading && <span className="muted">{t('term.loadingSymbol')}</span>}
              {previewError && <span className="error-text">{previewError}</span>}
              {preview && <HighlightedCode code={preview.code} lang={preview.language} />}
            </span>
          )}
          <span className="term-popover-foot">
            <Link to={targetHref} className="term-popover-link">
              {t('term.openDefinition')}
            </Link>
          </span>
        </span>
      )}
    </span>
  )
}
