import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface PrintHeaderProps {
  label: string
  title: string
  meta?: string
}

/** 印刷時と HTML 書き出し時にだけ表示する文書ヘッダー */
export function PrintHeader({ label, title, meta }: PrintHeaderProps) {
  return (
    <div className="print-only print-header" aria-hidden="true">
      <span className="print-header-label">{label}</span>
      <span className="print-header-title">{title}</span>
      {meta && <span className="print-header-meta mono">{meta}</span>}
    </div>
  )
}

/** 印刷時と HTML 書き出し時にだけ表示するフッター */
export function PrintFooter({ meta }: { meta?: string }) {
  const { t, i18n } = useTranslation()
  const [renderedAt] = useState(() => new Date())
  const date = renderedAt.toLocaleDateString(i18n.language, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  return (
    <div className="print-only print-footer" aria-hidden="true">
      <span>Documi</span>
      <span>{t('print.printedOn', { date })}</span>
      {meta && <span className="mono">{meta}</span>}
    </div>
  )
}
