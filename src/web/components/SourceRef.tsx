import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useCopyText } from '../hooks'
import { toErrorMessage, useSourceQuery } from '../queries'
import { HighlightedCode } from './HighlightedCode'
import { MaterialFileIcon } from './MaterialIcon'

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
  const targetFile = data?.file ?? file
  const codeQuery = new URLSearchParams({ file: targetFile })
  if (data) {
    codeQuery.set('lines', `${data.startLine}-${data.endLine}`)
  } else if (lines) {
    codeQuery.set('lines', lines)
  }

  return (
    <figure className="source-ref">
      <figcaption className="source-ref-header">
        <Link
          to={`/code?${codeQuery.toString()}`}
          className="source-ref-file mono inline-flex items-center gap-1.5 text-inherit no-underline hover:text-accent hover:underline"
          title={targetFile}
        >
          <MaterialFileIcon name={targetFile} size={14} />
          <span>{targetFile}</span>
        </Link>
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
