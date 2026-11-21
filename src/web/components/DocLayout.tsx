import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { Document } from '../../core/types'
import { api, type TermEntry } from '../api'
import { extractHeadings } from '../headings'
import { useDocsRevision } from '../live'
import { useTabs } from '../tabs'
import DocPeekPane from './DocPeekPane'
import DocTabs from './DocTabs'
import DocViewer from './DocViewer'
import SidePanel from './SidePanel'

interface PeekTarget {
  docId: string
  focusBlockId?: string
}

export default function DocLayout() {
  const params = useParams()
  const docId = (params['*'] ?? '').replace(/^\/+/, '').replace(/\/+$/, '')
  const revision = useDocsRevision()
  const { openTab } = useTabs()
  const [doc, setDoc] = useState<Document | null>(null)
  const [terms, setTerms] = useState<TermEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [localTick, setLocalTick] = useState(0)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [peekTarget, setPeekTarget] = useState<PeekTarget | null>(null)
  const mainRef = useRef<HTMLElement>(null)

  const handleMutate = useCallback(() => {
    setLocalTick((t) => t + 1)
  }, [])

  // メイン画面がプレビュー中と同じ文書へ遷移したら重複表示を解消する
  useEffect(() => {
    if (peekTarget && peekTarget.docId === docId) {
      setPeekTarget(null)
    }
  }, [docId, peekTarget])

  useEffect(() => {
    let cancelled = false
    setLoading((prev) => prev || doc?.id !== docId)
    setError(null)
    Promise.all([api.document(docId), api.terms()])
      .then(([res, termsRes]) => {
        if (cancelled) return
        setDoc(res.document)
        setTerms(termsRes.terms)
        openTab({
          id: res.document.id,
          type: res.document.type,
          title: res.document.title,
        })
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setDoc(null)
          setError(e instanceof Error ? e.message : String(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [docId, revision, localTick, openTab])

  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    el.scrollTop = 0
    el.scrollIntoView({ block: 'start' })
  }, [docId])

  const headings = useMemo(() => (doc ? extractHeadings(doc.body, doc.format) : []), [doc])

  return (
    <>
      <main ref={mainRef} className="content">
        <DocTabs />
        {!inspectorOpen && !peekTarget && doc && (
          <button
            type="button"
            className="rp-reopen-btn"
            onClick={() => setInspectorOpen(true)}
            title="Outline / Links を開く"
            aria-label="右パネルを開く"
          >
            Outline / Links
          </button>
        )}
        {loading && !doc && (
          <div className="page">
            <p className="muted">読み込み中…</p>
          </div>
        )}
        {error && (
          <div className="page">
            <h1>ドキュメントを表示できません</h1>
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
