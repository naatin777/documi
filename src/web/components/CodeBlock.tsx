import { useTranslation } from 'react-i18next'
import { normalizeLang } from '../highlight'
import { useCopyText, useHighlightedCode } from '../hooks'

interface CodeBlockProps {
  code: string
  lang?: string | null
}

/** フェンスコードブロック。Shiki でハイライトし、行番号とコピーボタンを付ける。 */
export default function CodeBlock({ code, lang }: CodeBlockProps) {
  const { t } = useTranslation()
  const html = useHighlightedCode(code, lang)
  const { copied, copy } = useCopyText()
  const normalized = normalizeLang(lang)

  return (
    <div className="codeblock">
      <div className="codeblock-toolbar">
        {normalized && <span className="codeblock-lang">{normalized}</span>}
        <button type="button" className="codeblock-copy" onClick={() => copy(code)}>
          {copied ? t('code.copied') : t('code.copy')}
        </button>
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
