import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useCopyText } from '../hooks'
import { toErrorMessage, useSourceExportsQuery, useSourceQuery } from '../queries'
import { HighlightedCode } from './HighlightedCode'
import { MaterialFileIcon } from './MaterialIcon'

interface SourceRefProps {
  file?: string
  symbol?: string
  lines?: string
  mode?: string
  satisfies?: string
  verifies?: string
}

const SYMBOL_KIND_BADGE: Record<string, string> = {
  class: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  interface: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  type: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  enum: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  function: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  method: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  constant: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
  struct: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  trait: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  protocol: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
}

function splitCsv(value?: string): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 実ファイルのコードを AST / 行範囲 / 公開シンボル一覧 (mode="exports") で取得して表示する */
export default function SourceRef({ file, symbol, lines, mode, satisfies, verifies }: SourceRefProps) {
  const { t } = useTranslation()
  const { copied, copy } = useCopyText()

  const isExportsMode = mode === 'exports'
  const validSnippet =
    !isExportsMode &&
    (mode === undefined || mode === '' || mode === 'snippet') &&
    typeof file === 'string' &&
    file !== '' &&
    ((typeof symbol === 'string' && symbol !== '' && (lines === undefined || lines === '')) ||
      (typeof lines === 'string' && lines !== '' && (symbol === undefined || symbol === '')))
  const validExports = isExportsMode && typeof file === 'string' && file !== ''
  const valid = validSnippet || validExports

  const sourceQuery = useSourceQuery(
    {
      file,
      symbol: typeof symbol === 'string' ? symbol : undefined,
      lines: typeof lines === 'string' ? lines : undefined,
    },
    validSnippet,
  )
  const exportsQuery = useSourceExportsQuery(file, validExports)

  if (!valid) {
    return (
      <div className="source-ref source-ref-error">
        <span className="error-text">{t('sourceRef.invalidProps')}</span>
      </div>
    )
  }

  const satisfiesList = splitCsv(satisfies)
  const verifiesList = splitCsv(verifies)

  if (isExportsMode) {
    const data = exportsQuery.data ?? null
    const error = toErrorMessage(exportsQuery.error)
    const loading = exportsQuery.isPending
    const targetFile = data?.file ?? file ?? ''

    return (
      <figure className="source-ref">
        <figcaption className="source-ref-header">
          <Link
            to={`/code?${new URLSearchParams({ file: targetFile }).toString()}`}
            className="source-ref-file mono inline-flex items-center gap-1.5 text-inherit no-underline hover:text-accent hover:underline"
            title={targetFile}
          >
            <MaterialFileIcon name={targetFile} size={14} />
            <span>{targetFile}</span>
          </Link>
          <span className="source-ref-symbol">
            {t('sourceRef.exportsBadge')}
            {data && (
              <span className="source-ref-kind"> {t('sourceRef.exportsCount', { count: data.symbols.length })}</span>
            )}
          </span>
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
        </figcaption>
        {loading && <p className="muted source-ref-status">{t('sourceRef.loading')}</p>}
        {error && <p className="error-text source-ref-status">{error}</p>}
        {data && data.symbols.length === 0 && <p className="muted source-ref-status">{t('sourceRef.noExports')}</p>}
        {data && data.symbols.length > 0 && (
          <ul className="m-0 grid list-none divide-y divide-line p-0">
            {data.symbols.map((sym) => {
              const qs = new URLSearchParams({
                file: targetFile,
                lines: `${sym.startLine}-${sym.endLine}`,
              })
              return (
                <li
                  key={`${sym.name}-${sym.startLine}`}
                  className="flex flex-wrap items-baseline gap-2 px-3 py-1.5 text-[12.5px] hover:bg-subtle/60"
                >
                  <span
                    className={`mono shrink-0 rounded px-1.5 py-px text-[10.5px] font-bold ${SYMBOL_KIND_BADGE[sym.kind] ?? 'bg-subtle text-fg-muted'}`}
                  >
                    {sym.kind}
                  </span>
                  <Link
                    to={`/code?${qs.toString()}`}
                    className="mono font-semibold text-fg no-underline hover:text-accent hover:underline"
                  >
                    {sym.qualifiedName ?? sym.name}
                  </Link>
                  <code className="min-w-0 flex-1 truncate bg-transparent p-0 text-[11.5px] text-fg-muted">
                    {sym.signature}
                  </code>
                  <Link
                    to={`/code?${qs.toString()}`}
                    className="mono ml-auto shrink-0 text-[11px] text-fg-faint tabular-nums no-underline hover:text-accent"
                  >
                    L{sym.startLine}
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </figure>
    )
  }

  const data = sourceQuery.data ?? null
  const error = toErrorMessage(sourceQuery.error)
  const loading = sourceQuery.isPending

  const targetFile = data?.file ?? file ?? ''
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
