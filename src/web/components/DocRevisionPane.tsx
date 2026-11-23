import { ArrowLeft, History, X } from 'lucide-react'
import { useCallback, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { toErrorMessage, useDocumentRevisionQuery, useTermsQuery } from '../queries'
import { formatDateTime } from '../time'
import Markdown from './Markdown'
import ResizeHandle, { useResizableWidth } from './ResizeHandle'

interface DocRevisionPaneProps {
  docId: string
  commitSha: string
  onBack: () => void
  onClose: () => void
}

// @implements ui.doc-history
/**
 * 指定コミット時点の過去ドキュメント本文を右ペインに並べて表示する読み取り専用プレビュー。
 */
export default function DocRevisionPane({ docId, commitSha, onBack, onClose }: DocRevisionPaneProps) {
  const { t } = useTranslation()
  const {
    width: peekWidth,
    setWidth: setPeekWidth,
    resetWidth: resetPeekWidth,
  } = useResizableWidth({
    storageKey: 'documi:peek-width',
    defaultWidth: 520,
    minWidth: 320,
    maxWidth: 860,
  })

  const revisionQuery = useDocumentRevisionQuery(docId, commitSha)
  const termsQuery = useTermsQuery()
  const revision = revisionQuery.data ?? null
  const terms = termsQuery.data?.terms ?? []
  const loading = revisionQuery.isPending
  const error = toErrorMessage(revisionQuery.error)

  const maxPeekWidth = useCallback(() => {
    if (typeof window === 'undefined') return 860
    return Math.max(360, Math.min(860, Math.round(window.innerWidth * 0.65)))
  }, [])

  const iconBtnClass =
    'inline-flex cursor-pointer items-center gap-1 rounded-md border border-line bg-surface px-2 py-[3px] text-[11.5px] font-semibold text-fg-muted no-underline hover:border-accent hover:bg-hover hover:text-fg'

  return (
    <>
      <ResizeHandle
        side="left"
        width={peekWidth}
        minWidth={320}
        maxWidth={maxPeekWidth}
        onChange={setPeekWidth}
        onReset={resetPeekWidth}
        label={t('resize.peek')}
      />
      <aside
        className="flex min-h-0 min-w-0 shrink-0 grow-0 flex-col overflow-hidden border-l border-line bg-surface max-[900px]:flex-none max-[900px]:basis-auto max-[900px]:overflow-visible max-[900px]:border-t max-[900px]:border-l-0 min-[901px]:basis-[var(--pane-width)] print:hidden"
        style={{ '--pane-width': `${peekWidth}px` } as CSSProperties}
        aria-label={t('peek.revisionAriaLabel')}
      >
        <header className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-sidebar px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <button type="button" className={iconBtnClass} onClick={onBack} title={t('peek.backToHistory')}>
                <ArrowLeft size={13} strokeWidth={1.8} aria-hidden="true" />
                <span>{t('common.back')}</span>
              </button>
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold text-amber-700 dark:text-amber-400">
                <History size={11} strokeWidth={2} aria-hidden="true" />
                {t('peek.revisionBadge')}
              </span>
            </div>
            <button
              type="button"
              className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-md border border-line bg-surface text-fg-muted hover:border-accent hover:bg-hover hover:text-fg"
              onClick={onClose}
              title={t('peek.closePreview')}
              aria-label={t('peek.closePreview')}
            >
              <X size={14} strokeWidth={1.85} aria-hidden="true" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <code className="rounded bg-subtle px-1.5 py-0.5 font-mono text-[11px] font-semibold text-fg">
              {revision?.commit.shortSha ?? commitSha.slice(0, 7)}
            </code>
            {revision && (
              <>
                <span className="mono text-[11px] text-fg-muted">{formatDateTime(revision.commit.date)}</span>
                <span className="text-[11px] text-fg-muted">· {revision.commit.author}</span>
              </>
            )}
          </div>

          {revision && (
            <p className="m-0 truncate text-[12.5px] font-medium text-fg" title={revision.commit.subject}>
              {revision.commit.subject}
            </p>
          )}
          <p className="m-0 text-[11px] text-fg-muted">{t('peek.revisionHint')}</p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-5 pb-12">
          {loading && !revision && <p className="muted">{t('common.loading')}</p>}
          {error && <p className="error-text">{error}</p>}
          {revision && (
            <article>
              <header className="mb-5 border-b border-line pb-3.5">
                <h2 className="m-0 mb-1.5 text-[22px] leading-[1.3] font-bold">{revision.title}</h2>
                {revision.description && <p className="m-0 text-[13.5px] text-fg-muted">{revision.description}</p>}
              </header>
              <Markdown body={revision.body} format={revision.format} currentDir={revision.dir} terms={terms} />
            </article>
          )}
        </div>
      </aside>
    </>
  )
}
