import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { extractHeadings } from '../headings'
import { toErrorMessage, useDocumentQuery, useInvalidateDocs, useTermsQuery } from '../queries'
import { useTabs } from '../tabs'
import DocPeekPane from './DocPeekPane'
import DocViewer from './DocViewer'
import SidePanel from './SidePanel'

interface PeekTarget {
  docId: string
  focusBlockId?: string
}

export default function DocLayout() {
  const { t } = useTranslation()
  const params = useParams()
  const docId = (params['*'] ?? '').replace(/^\/+/, '').replace(/\/+$/, '')
  const { openTab } = useTabs()
  const handleMutate = useInvalidateDocs()
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [peekTarget, setPeekTarget] = useState<PeekTarget | null>(null)
  const mainRef = useRef<HTMLElement>(null)

  const docQuery = useDocumentQuery(docId)
  const termsQuery = useTermsQuery()
  const doc = docQuery.data?.document ?? null
  const terms = termsQuery.data?.terms ?? []
  const error = toErrorMessage(docQuery.error)
  const loading = docQuery.isPending

  // メイン画面がプレビュー中と同じ文書へ遷移したら重複表示を解消する
  useEffect(() => {
    if (peekTarget && peekTarget.docId === docId) {
      setPeekTarget(null)
    }
  }, [docId, peekTarget])

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
        className="relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface max-[900px]:flex-none max-[900px]:overflow-visible print:block print:h-auto print:min-h-0 print:overflow-visible"
      >
        {!inspectorOpen && !peekTarget && doc && (
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
        {doc && <DocViewer doc={doc} terms={terms} onMutate={handleMutate} />}
      </main>
      {peekTarget ? (
        <DocPeekPane
          docId={peekTarget.docId}
          focusBlockId={peekTarget.focusBlockId}
          onBack={() => {
            setPeekTarget(null)
            setInspectorOpen(true)
          }}
          onClose={() => setPeekTarget(null)}
        />
      ) : (
        inspectorOpen &&
        doc && (
          <SidePanel
            doc={doc}
            headings={headings}
            onPeek={(targetDocId, focusBlockId) => setPeekTarget({ docId: targetDocId, focusBlockId })}
            onCollapse={() => setInspectorOpen(false)}
          />
        )
      )}
    </>
  )
}
