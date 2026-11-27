import { ArrowLeft, ExternalLink, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { encodeDocId } from '../api'
import { toErrorMessage, useDocumentQuery, useInvalidateDocs, useTermsQuery } from '../queries'
import Markdown from './Markdown'
import ResizeHandle, { useResizableWidth } from './ResizeHandle'
import { DocReviewProvider } from './SemanticBlocks'

interface DocPeekPaneProps {
  docId: string
  focusBlockId?: string
  /** DocLayout から Context Inspector へ戻すためのコールバック */
  onBack?: () => void
  onClose: () => void
  /** Graph 画面などで追加タブ（例: 繋がり一覧）を表示する場合 */
  extraTab?: {
    label: string
    content: ReactNode
  }
}

/**
 * 右ペインに別ドキュメントの本文をそのまま並べて表示する Side-by-Side プレビューペイン。
 * Graph のノード選択時や、文書閲覧中の関連文書比較、Review Queue からの文脈確認で共通利用する。
 */
function tabClass(active: boolean) {
  return `inline-flex cursor-pointer items-center gap-[5px] rounded-[5px] border-0 px-2.5 py-[3px] text-xs font-semibold ${
    active ? 'bg-surface text-fg shadow-[0_1px_2px_rgba(15,23,42,0.08)]' : 'bg-transparent text-fg-muted hover:text-fg'
  }`
}

export default function DocPeekPane({ docId, focusBlockId, onBack, onClose, extraTab }: DocPeekPaneProps) {
  const { t } = useTranslation()
  const handleMutate = useInvalidateDocs()
  const [tabState, setTabState] = useState<{ scope: string; tab: 'preview' | 'extra' }>({
    scope: '',
    tab: 'preview',
  })
  const tabScope = `${docId}:${focusBlockId ?? ''}`
  const activeTab: 'preview' | 'extra' = tabState.scope === tabScope ? tabState.tab : 'preview'
  const setActiveTab = (tab: 'preview' | 'extra') => setTabState({ scope: tabScope, tab })
  const bodyRef = useRef<HTMLDivElement>(null)
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

  const docQuery = useDocumentQuery(docId)
  const termsQuery = useTermsQuery()
  const doc = docQuery.data?.document ?? null
  const terms = termsQuery.data?.terms ?? []
  const loading = docQuery.isPending
  const error = toErrorMessage(docQuery.error)

  // ブロック指定がある場合はペイン内を該当ブロックへスクロール
  useEffect(() => {
    const container = bodyRef.current
    if (!container || activeTab !== 'preview' || !doc) return
    if (!focusBlockId) {
      container.scrollTop = 0
      return
    }
    const targetId = `block-${focusBlockId}`
    const target = container.querySelector<HTMLElement>(`[id="${CSS.escape(targetId)}"]`)
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target.classList.add('ring-2', 'ring-amber-500', 'transition-shadow', 'duration-300')
      const timer = setTimeout(
        () => target.classList.remove('ring-2', 'ring-amber-500', 'transition-shadow', 'duration-300'),
        1800,
      )
      return () => clearTimeout(timer)
    }
  }, [doc, focusBlockId, activeTab])

  const openHref = `/docs/${encodeDocId(docId)}${focusBlockId ? `#block-${encodeURIComponent(focusBlockId)}` : ''}`

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
        className="flex min-h-0 min-w-0 shrink-0 grow-0 flex-col overflow-hidden border-l border-line bg-surface max-desktop:flex-none max-desktop:basis-auto max-desktop:overflow-visible max-desktop:border-t max-desktop:border-l-0 desktop:basis-(--pane-width) print:hidden"
        style={{ '--pane-width': `${peekWidth}px` } as CSSProperties}
        aria-label={t('peek.ariaLabel')}
      >
        <header className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-sidebar px-3.5 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              {onBack && (
                <button type="button" className={iconBtnClass} onClick={onBack} title={t('peek.backToInspector')}>
                  <ArrowLeft size={13} strokeWidth={1.8} aria-hidden="true" />
                  <span>{t('common.back')}</span>
                </button>
              )}
              {doc && <span className={`badge badge-type type-${doc.type}`}>{t(`types.singular.${doc.type}`)}</span>}
              {doc?.date && <span className="mono text-[11px] text-fg-muted">{doc.date}</span>}
            </div>
            <div className="flex items-center gap-1.5">
              <Link to={openHref} className={iconBtnClass} title={t('peek.openInMain')}>
                <span>{t('common.open')}</span>
                <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" />
              </Link>
              <button type="button" className={iconBtnClass} onClick={onClose} aria-label={t('peek.closePreview')}>
                <X size={13} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-px">
            <strong className="text-[15px] leading-[1.35]">{doc?.title ?? docId}</strong>
            <span className="mono text-[11px] text-fg-muted">{focusBlockId ? `${docId} #${focusBlockId}` : docId}</span>
          </div>

          {extraTab && (
            <div
              className="inline-flex w-fit gap-0.5 rounded-[7px] border border-line bg-subtle p-0.5"
              role="tablist"
              aria-label={t('peek.switchAria')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'preview'}
                className={tabClass(activeTab === 'preview')}
                onClick={() => setActiveTab('preview')}
              >
                {t('peek.bodyTab')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'extra'}
                className={tabClass(activeTab === 'extra')}
                onClick={() => setActiveTab('extra')}
              >
                {extraTab.label}
              </button>
            </div>
          )}
        </header>

        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-12">
          {activeTab === 'extra' && extraTab ? (
            extraTab.content
          ) : (
            <>
              {loading && !doc && <p className="muted">{t('common.loading')}</p>}
              {error && <p className="error-text">{error}</p>}
              {doc && (
                <div className="[&_.markdown]:text-sm">
                  {doc.description && (
                    <p className="m-0 mb-3.5 border-b border-line pb-3 text-[13px] text-fg-muted">{doc.description}</p>
                  )}
                  <DocReviewProvider blocks={doc.blocks} onMutate={handleMutate}>
                    <Markdown
                      body={doc.body}
                      format={doc.format}
                      currentDir={doc.dir}
                      resolvedLinks={doc.resolvedLinks}
                      terms={terms}
                      headingPrefix="peek"
                    />
                  </DocReviewProvider>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  )
}
