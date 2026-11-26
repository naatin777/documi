import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeLang } from '../highlight'
import { useCopyText, useHighlightedCode } from '../hooks'

interface CodeBlockProps {
  code: string
  lang?: string | null
}

/** フェンスコードブロック。Shiki でハイライトし、固定行番号・折り返し切替・コピーボタンを付ける。 */
export default function CodeBlock({ code, lang }: CodeBlockProps) {
  const { t } = useTranslation()
  const html = useHighlightedCode(code, lang)
  const { copied, copy } = useCopyText()
  const [wrap, setWrap] = useState(false)
  const normalized = normalizeLang(lang)

  return (
    <div className={`codeblock${wrap ? ' codeblock-wrap' : ''}`}>
      <div className="codeblock-toolbar">
        {normalized ? <span className="codeblock-lang">{normalized}</span> : <span />}
        <div className="codeblock-actions">
          <button
            type="button"
            aria-pressed={wrap}
            className={`codeblock-copy${wrap ? ' active' : ''}`}
            onClick={() => setWrap((v) => !v)}
          >
            {wrap ? t('code.unwrap') : t('code.wrap')}
          </button>
          <button type="button" className="codeblock-copy" onClick={() => copy(code)}>
            {copied ? t('code.copied') : t('code.copy')}
          </button>
        </div>
      </div>
      {html ? (
        <div className="codeblock-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="codeblock-plain">
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}
