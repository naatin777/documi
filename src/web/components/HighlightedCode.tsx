import { useHighlightedCode } from '../hooks'

interface HighlightedCodeProps {
  code: string
  lang?: string | null
}

/** Shiki ハイライト済みコードを表示する。未対応言語・失敗時はプレーン表示。 */
export function HighlightedCode({ code, lang }: HighlightedCodeProps) {
  const html = useHighlightedCode(code, lang)

  if (html) return <div className="shiki-host" dangerouslySetInnerHTML={{ __html: html }} />
  return (
    <pre className="codeblock-plain">
      <code>{code}</code>
    </pre>
  )
}
