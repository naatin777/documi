import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { extractHeadings } from '../headings'
import { toErrorMessage, useDocumentHistoryQuery, useDocumentQuery, useInvalidateDocs, useTermsQuery } from '../queries'
import { useTabs } from '../tabs'
import DocPeekPane from './DocPeekPane'
import DocRevisionPane from './DocRevisionPane'
import DocViewer from './DocViewer'
import SidePanel, { type InspectorTab } from './SidePanel'

type RightPaneTarget = { kind: 'doc'; docId: string; focusBlockId?: string } | { kind: 'revision'; commitSha: string }

export default function DocLayout() {
  const { t } = useTranslation()
  const params = useParams()
  const docId = (params['*'] ?? '').replace(/^\/+/, '').replace(/\/+$/, '')
  const { openTab } = useTabs()
  const handleMutate = useInvalidateDocs()
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('outline')
  const [highlightChanges, setHighlightChanges] = useState(true)
  const [rightPaneState, setRightPaneState] = useState<{ ownerDocId: string; target: RightPaneTarget } | null>(null)
  const mainRef = useRef<HTMLElement>(null)

  const docQuery = useDocumentQuery(docId)
  const historyQuery = useDocumentHistoryQuery(docId)
  const termsQuery = useTermsQuery()
  const doc = docQuery.data?.document ?? null
  const history = historyQuery.data ?? null
  const terms = termsQuery.data?.terms ?? []
  const error = toErrorMessage(docQuery.error)
  const loading = docQuery.isPending

  // メイン画面が別文書へ遷移、またはプレビュー中と同じ文書を開いたら右ペインを閉じる
  const rightPane =
    rightPaneState &&
    rightPaneState.ownerDocId === docId &&
    !(rightPaneState.target.kind === 'doc' && rightPaneState.target.docId === docId)
      ? rightPaneState.target
      : null

  useEffect(() => {
    if (!doc) return
    openTab({
      id: doc.id,
      type: doc.type,
      title: doc.title,
    })
  }, [doc, openTab])

  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    el.scrollTop = 0
    el.scrollIntoView({ block: 'start' })
  }, [docId])

  const headings = useMemo(() => (doc ? extractHeadings(doc.body, doc.format) : []), [doc])

  return (
    <>
      <main
        ref={mainRef}
        className="relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface max-desktop:flex-none max-desktop:overflow-visible print:block print:h-auto print:min-h-0 print:overflow-visible"
      >
        {!inspectorOpen && !rightPane && doc && (
          <button
            type="button"
            className="sticky top-3 z-15 float-right mt-2 mr-3.5 cursor-pointer rounded-md border border-line bg-sidebar px-2.5 py-1 text-[11.5px] font-semibold text-fg-muted hover:bg-hover hover:text-fg print:hidden"
            onClick={() => setInspectorOpen(true)}
            title={t('doc.openInspectorTitle')}
            aria-label={t('doc.openInspectorAria')}
          >
            {t('doc.openInspector')}
          </button>
        )}
        {loading && !doc && (
          <div className="page">
            <p className="muted">{t('common.loading')}</p>
          </div>
        )}
        {error && (
          <div className="page">
            <h1>{t('doc.loadErrorTitle')}</h1>
            <p className="error-text">{error}</p>
            <p className="muted mono">{docId}</p>
          </div>
        )}
        {doc && (
          <DocViewer
            doc={doc}
            terms={terms}
            onMutate={handleMutate}
            history={history}
            highlightChanges={highlightChanges}
            onToggleHighlight={() => setHighlightChanges((v) => !v)}
            onOpenHistory={() => {
              setRightPaneState(null)
              setInspectorOpen(true)
              setInspectorTab('history')
            }}
          />
        )}
      </main>
      {rightPane?.kind === 'doc' ? (
        <DocPeekPane
          docId={rightPane.docId}
          focusBlockId={rightPane.focusBlockId}
          onBack={() => {
            setRightPaneState(null)
            setInspectorOpen(true)
          }}
          onClose={() => setRightPaneState(null)}
        />
      ) : rightPane?.kind === 'revision' ? (
        <DocRevisionPane
          docId={docId}
          commitSha={rightPane.commitSha}
          onBack={() => {
            setRightPaneState(null)
            setInspectorOpen(true)
            setInspectorTab('history')
          }}
          onClose={() => setRightPaneState(null)}
        />
      ) : (
        inspectorOpen &&
        doc && (
          <SidePanel
            doc={doc}
            headings={headings}
            history={history}
            highlightChanges={highlightChanges}
            activeTab={inspectorTab}
            onTabChange={setInspectorTab}
            onPeek={(targetDocId, focusBlockId) =>
              setRightPaneState({ ownerDocId: docId, target: { kind: 'doc', docId: targetDocId, focusBlockId } })
            }
            onPeekRevision={(commitSha) =>
              setRightPaneState({ ownerDocId: docId, target: { kind: 'revision', commitSha } })
            }
            onCollapse={() => setInspectorOpen(false)}
          />
        )
      )}
    </>
  )
}
