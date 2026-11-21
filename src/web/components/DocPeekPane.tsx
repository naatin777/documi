import { ArrowLeft, ExternalLink, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ARTIFACT_TYPE_LABELS } from '../../core/types'
import type { Document } from '../../core/types'
import { api, encodeDocId, type TermEntry } from '../api'
import { useDocsRevision } from '../live'
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
export default function DocPeekPane({ docId, focusBlockId, onBack, onClose, extraTab }: DocPeekPaneProps) {
  const revision = useDocsRevision()
  const [doc, setDoc] = useState<Document | null>(null)
  const [terms, setTerms] = useState<TermEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [localTick, setLocalTick] = useState(0)
  const [activeTab, setActiveTab] = useState<'preview' | 'extra'>('preview')
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

  const handleMutate = useCallback(() => {
    setLocalTick((t) => t + 1)
  }, [])

  // 別ドキュメントへ切り替えたら本文タブへ戻す
  useEffect(() => {
    setActiveTab('preview')
  }, [docId, focusBlockId])

  useEffect(() => {
    let cancelled = false
    setLoading((prev) => prev || doc?.id !== docId)
    setError(null)
    Promise.all([api.document(docId), api.terms()])
      .then(([res, termsRes]) => {
        if (cancelled) return
        setDoc(res.document)
        setTerms(termsRes.terms)
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
  }, [docId, revision, localTick])

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
      target.classList.add('peek-focus-highlight')
      const timer = setTimeout(() => target.classList.remove('peek-focus-highlight'), 1800)
      return () => clearTimeout(timer)
    }
  }, [doc, focusBlockId, activeTab])

  const openHref = `/docs/${encodeDocId(docId)}${focusBlockId ? `#block-${encodeURIComponent(focusBlockId)}` : ''}`

  const maxPeekWidth = useCallback(() => {
    if (typeof window === 'undefined') return 860
    return Math.max(360, Math.min(860, Math.round(window.innerWidth * 0.65)))
  }, [])

  return (
    <>
      <ResizeHandle
        side="left"
        width={peekWidth}
        minWidth={320}
        maxWidth={maxPeekWidth}
        onChange={setPeekWidth}
        onReset={resetPeekWidth}
        label="プレビューペイン幅を調整"
      />
      <aside
        className="side-panel side-panel-peek"
        style={{ flexBasis: `${peekWidth}px` }}
        aria-label="ドキュメントプレビュー"
      >
        <header className="peek-header">
          <div className="peek-header-top">
            <div className="peek-header-left">
              {onBack && (
                <button type="button" className="peek-icon-btn" onClick={onBack} title="Outline / Links に戻る">
                  <ArrowLeft size={13} strokeWidth={1.8} aria-hidden="true" />
                  <span>戻る</span>
                </button>
              )}
              {doc && <span className={`badge badge-type type-${doc.type}`}>{ARTIFACT_TYPE_LABELS[doc.type]}</span>}
              {doc?.date && <span className="peek-date mono">{doc.date}</span>}
            </div>
            <div className="peek-header-actions">
              <Link to={openHref} className="peek-icon-btn peek-open-link" title="メイン画面で開く">
                <span>開く</span>
                <ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" />
              </Link>
              <button type="button" className="peek-icon-btn" onClick={onClose} aria-label="プレビューを閉じる">
                <X size={13} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="peek-title-row">
            <strong className="peek-title">{doc?.title ?? docId}</strong>
            <span className="peek-path mono">{focusBlockId ? `${docId} #${focusBlockId}` : docId}</span>
          </div>

          {extraTab && (
            <div className="rp-tabs" role="tablist" aria-label="プレビュー切替">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'preview'}
                className={`rp-tab${activeTab === 'preview' ? ' active' : ''}`}
                onClick={() => setActiveTab('preview')}
              >
                本文
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'extra'}
                className={`rp-tab${activeTab === 'extra' ? ' active' : ''}`}
                onClick={() => setActiveTab('extra')}
              >
                {extraTab.label}
              </button>
            </div>
          )}
        </header>

        <div ref={bodyRef} className="peek-body">
          {activeTab === 'extra' && extraTab ? (
            extraTab.content
          ) : (
            <>
              {loading && !doc && <p className="muted">読み込み中…</p>}
              {error && <p className="error-text">{error}</p>}
              {doc && (
                <div className="peek-doc-content">
                  {doc.description && <p className="peek-description">{doc.description}</p>}
                  <DocReviewProvider blocks={doc.blocks} onMutate={handleMutate}>
                    <Markdown
                      body={doc.body}
                      format={doc.format}
                      currentDir={doc.dir}
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
