import { PreviewCard } from '@base-ui/react/preview-card'
import { useState, type ReactNode } from 'react'
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
 * `@base-ui/react/preview-card` でホバー／フォーカス時に定義と紐づくコード型定義を
 * ビューポート境界に収まるよう自動配置してポップオーバー表示する。
 * @implements ui.glossary-autolink
 */
export function TermInline({ name, term, children }: TermInlineProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const primarySymbol = term?.symbols[0]
  const [symbolFile, symbolName] = primarySymbol ? primarySymbol.split('#') : ['', '']
  const hasValidSymbol = Boolean(symbolFile && symbolName)
  const label = children ?? name ?? term?.id ?? ''

  const previewQuery = useSourceQuery({ file: symbolFile, symbol: symbolName }, open && hasValidSymbol)
  const preview = previewQuery.data ?? null
  const previewError = toErrorMessage(previewQuery.error)
  const loading = open && hasValidSymbol && previewQuery.isPending

  if (!term) {
    return <span className="sem-term-inline">{label}</span>
  }

  const targetHref = `/docs/${encodeDocId(term.docId)}#block-${encodeURIComponent(term.id)}`

  return (
    <PreviewCard.Root open={open} onOpenChange={setOpen}>
      <PreviewCard.Trigger delay={150} closeDelay={160} render={<Link to={targetHref} className="sem-term-inline" />}>
        {label}
      </PreviewCard.Trigger>
      {typeof document !== 'undefined' && (
        <PreviewCard.Portal>
          <PreviewCard.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={12} className="z-60">
            <PreviewCard.Popup className="flex w-[min(440px,85vw)] flex-col gap-2 rounded-[10px] border border-line bg-surface px-3.5 py-3 text-left text-[13px] leading-[1.55] text-fg shadow-[0_12px_32px_rgba(0,0,0,0.16)] outline-none transition-all duration-120 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 dark:shadow-[0_12px_34px_rgba(0,0,0,0.5)] print:hidden">
              <div className="flex flex-wrap items-baseline gap-2">
                <strong className="text-sm text-fg">{term.id}</strong>
                {term.aliases.length > 0 && (
                  <span className="text-[11.5px] text-fg-muted">{term.aliases.join(' / ')}</span>
                )}
              </div>
              <div className="text-fg">{term.rawBody}</div>
              {primarySymbol && (
                <div className="flex max-h-[180px] flex-col gap-1 overflow-auto rounded-md border border-line bg-code px-2 py-1.5 text-[11.5px]">
                  <span className="mono text-[11px] text-fg-muted">{primarySymbol}</span>
                  {loading && <span className="muted">{t('term.loadingSymbol')}</span>}
                  {previewError && <span className="error-text">{previewError}</span>}
                  {preview && <HighlightedCode code={preview.code} lang={preview.language} />}
                </div>
              )}
              <div className="flex justify-end">
                <Link
                  to={targetHref}
                  className="text-xs font-semibold text-sky-700 no-underline hover:underline dark:text-sky-400"
                  onClick={() => setOpen(false)}
                >
                  {t('term.openDefinition')}
                </Link>
              </div>
            </PreviewCard.Popup>
          </PreviewCard.Positioner>
        </PreviewCard.Portal>
      )}
    </PreviewCard.Root>
  )
}
