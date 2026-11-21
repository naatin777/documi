import { useEffect, useState } from 'react'
import { api } from '../api'
import type { SourceResponse } from '../api'
import { useCopyText } from '../hooks'
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
  const [data, setData] = useState<SourceResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const { copied, copy } = useCopyText()

  const valid =
    typeof file === 'string' &&
    file !== '' &&
    ((typeof symbol === 'string' && symbol !== '' && (lines === undefined || lines === '')) ||
      (typeof lines === 'string' && lines !== '' && (symbol === undefined || symbol === '')))

  useEffect(() => {
    if (!valid || typeof file !== 'string') {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .source({
        file,
        symbol: typeof symbol === 'string' ? symbol : undefined,
        lines: typeof lines === 'string' ? lines : undefined,
      })
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [file, symbol, lines, valid])

  if (!valid) {
    return (
      <div className="source-ref source-ref-error">
        <span className="error-text">SourceRef には file と symbol または lines のどちらか一方が必要です</span>
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
            {data.truncated ? ' (途中まで)' : ''}
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
            {copied ? 'コピーしました' : 'コピー'}
          </button>
        )}
      </figcaption>
      {loading && <p className="muted source-ref-status">ソースを読み込み中…</p>}
      {error && <p className="error-text source-ref-status">{error}</p>}
      {data && <HighlightedCode code={data.code} lang={data.language} />}
    </figure>
  )
}
