import { useTranslation } from 'react-i18next'
import { useCopyText } from '../hooks'
import { toErrorMessage, useSourceQuery } from '../queries'
import { HighlightedCode } from './HighlightedCode'

interface SourceRefProps {
  file?: string
  symbol?: string
  lines?: string
  satisfies?: string
  verifies?: string
}

function splitCsv(value?: string): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 実ファイルのコードを AST / 行範囲で取得して表示する */
export default function SourceRef({ file, symbol, lines, satisfies, verifies }: SourceRefProps) {
  const { t } = useTranslation()
  const { copied, copy } = useCopyText()

  const valid =
    typeof file === 'string' &&
    file !== '' &&
    ((typeof symbol === 'string' && symbol !== '' && (lines === undefined || lines === '')) ||
      (typeof lines === 'string' && lines !== '' && (symbol === undefined || symbol === '')))

  const sourceQuery = useSourceQuery(
    {
      file,
      symbol: typeof symbol === 'string' ? symbol : undefined,
      lines: typeof lines === 'string' ? lines : undefined,
    },
    valid,
  )
  const data = sourceQuery.data ?? null
  const error = toErrorMessage(sourceQuery.error)
  const loading = valid && sourceQuery.isPending

  if (!valid) {
    return (
      <div className="source-ref source-ref-error">
        <span className="error-text">{t('sourceRef.invalidProps')}</span>
      </div>
    )
  }

  const satisfiesList = splitCsv(satisfies)
  const verifiesList = splitCsv(verifies)

  return (
    <figure className="source-ref">
      <figcaption className="source-ref-header">
        <span className="source-ref-file mono" title={data?.file ?? file}>
          {data?.file ?? file}
        </span>
        {data?.symbol && (
          <span className="source-ref-symbol">
            {data.symbol.qualifiedName ?? data.symbol.name}
            <span className="source-ref-kind"> {data.symbol.kind}</span>
          </span>
        )}
        {data && (
          <span className="source-ref-lines">
            L{data.startLine}–{data.endLine}
            {data.truncated ? t('sourceRef.truncated') : ''}
          </span>
        )}
        {satisfiesList.map((id) => (
          <span key={`sat-${id}`} className="source-ref-trace">
            satisfies {id}
          </span>
        ))}
        {verifiesList.map((id) => (
          <span key={`ver-${id}`} className="source-ref-trace source-ref-trace-verify">
            verifies {id}
          </span>
        ))}
        {data && (
          <button type="button" className="codeblock-copy" onClick={() => data && copy(data.code)}>
            {copied ? t('code.copied') : t('code.copy')}
          </button>
        )}
      </figcaption>
      {loading && <p className="muted source-ref-status">{t('sourceRef.loading')}</p>}
      {error && <p className="error-text source-ref-status">{error}</p>}
      {data && <HighlightedCode code={data.code} lang={data.language} />}
    </figure>
  )
}
