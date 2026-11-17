import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { Document } from '../../core/types'
import { api } from '../api'
import { extractHeadings } from '../headings'
import { useTabs } from '../tabs'
import DocTabs from './DocTabs'
import DocViewer from './DocViewer'
import SidePanel from './SidePanel'

export default function DocLayout() {
  const { type = '', id = '' } = useParams()
  const { openTab } = useTabs()
  const [doc, setDoc] = useState<Document | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const mainRef = useRef<HTMLElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setDoc(null)
    setError(null)
    api
      .document(type, id)
      .then((res) => {
        if (cancelled) return
        setDoc(res.document)
        openTab({
          type: res.document.type,
          id: res.document.id,
          title: res.document.title,
        })
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
  }, [type, id, openTab])

  // 文書切り替え時にスクロール位置を先頭へ戻す
  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    el.scrollTop = 0
    el.scrollIntoView({ block: 'start' })
  }, [type, id])

  const headings = useMemo(() => (doc ? extractHeadings(doc.body, doc.format) : []), [doc])

  return (
    <>
      <main ref={mainRef} className="content">
        <DocTabs />
        {loading && (
          <div className="page">
            <p className="muted">読み込み中…</p>
          </div>
        )}
        {error && (
          <div className="page">
            <h1>ドキュメントを表示できません</h1>
            <p className="error-text">{error}</p>
            <p className="muted">
              type: {type} / id: {id}
            </p>
          </div>
        )}
        {doc && <DocViewer doc={doc} />}
      </main>
      <SidePanel headings={headings} outgoing={doc?.relations ?? []} incoming={doc?.incomingRelations ?? []} />
    </>
  )
}
