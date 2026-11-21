import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ARTIFACT_TYPE_LABELS } from '../../core/types'
import { api, type BundleResponse } from '../api'
import { exportBundleHtmlFromDom, printDocument } from '../export'
import { bundleDocAnchor } from '../mdast'
import Markdown from './Markdown'
import { DocReviewProvider } from './SemanticBlocks'

declare global {
  interface Window {
    __DOCUMI_BUNDLE_READY__?: boolean
  }
}

export default function BundleLayout() {
  const [searchParams] = useSearchParams()
  const scope = searchParams.get('scope') ?? undefined
  const rawIds = searchParams.get('ids')
  const ids = useMemo(
    () =>
      rawIds
        ? rawIds
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    [rawIds],
  )
  const title = searchParams.get('title') ?? undefined
  const action = searchParams.get('action')

  const [bundle, setBundle] = useState<BundleResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const actionFired = useRef(false)

  useEffect(() => {
    window.__DOCUMI_BUNDLE_READY__ = false
    let cancelled = false
    api
      .bundle({ scope, ids, title })
      .then((res) => {
        if (!cancelled) {
          setBundle(res)
          document.title = `${res.title} — Documi`
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [scope, ids, title])

  // Mermaid / Shiki / SourceRef の非同期描画完了を待って READY フラグを立てる
  useEffect(() => {
    if (!bundle) return
    let cancelled = false
    const start = Date.now()
    const check = () => {
      if (cancelled) return
      const pendingSource = document.querySelectorAll('.source-ref-status').length
      const elapsed = Date.now() - start
      if ((pendingSource === 0 && elapsed >= 350) || elapsed >= 4000) {
        window.__DOCUMI_BUNDLE_READY__ = true
        if (!actionFired.current) {
          actionFired.current = true
          if (action === 'print') {
            setTimeout(() => printDocument(), 100)
          } else if (action === 'download-html') {
            setTimeout(() => exportBundleHtmlFromDom(bundle.title), 100)
          }
        }
        return
      }
      setTimeout(check, 120)
    }
    const timer = setTimeout(check, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [bundle, action])

  const bundleDocIds = useMemo(() => new Set((bundle?.documents ?? []).map((d) => d.id)), [bundle])

  if (error) {
    return (
      <div className="bundle-shell">
        <div className="bundle-error">
          <h1>バンドルを生成できません</h1>
          <p className="error-text">{error}</p>
          <Link to="/" className="button">
            Overview に戻る
          </Link>
        </div>
      </div>
    )
  }

  if (!bundle) {
    return (
      <div className="bundle-shell">
        <p className="muted">バンドルを構築中…</p>
      </div>
    )
  }

  return (
    <div className="bundle-shell">
      <div className="bundle-toolbar">
        <Link to="/" className="sem-action-btn">
          ← Documi に戻る
        </Link>
        <span className="bundle-toolbar-meta">
          {bundle.summary.documentCount} documents · {bundle.summary.blockCount} blocks
        </span>
        <div className="bundle-toolbar-actions">
          <button type="button" className="sem-action-btn" onClick={() => exportBundleHtmlFromDom(bundle.title)}>
            HTML ダウンロード
          </button>
          <button type="button" className="sem-action-btn sem-approve-btn" onClick={printDocument}>
            印刷 / PDF 保存
          </button>
        </div>
      </div>

      <div className="bundle-root">
        {/* 表紙 */}
        <section className="bundle-cover">
          <div className="bundle-cover-brand">Documi Living Specification</div>
          <h1>{bundle.title}</h1>
          <p className="bundle-cover-scope">{bundle.scopeLabel}</p>
          <dl className="bundle-cover-stats">
            <div>
              <dt>Documents</dt>
              <dd>{bundle.summary.documentCount}</dd>
            </div>
            <div>
              <dt>Semantic Blocks</dt>
              <dd>{bundle.summary.blockCount}</dd>
            </div>
            <div>
              <dt>Approved</dt>
              <dd>{bundle.summary.approvedCount}</dd>
            </div>
            <div>
              <dt>Verified</dt>
              <dd>{bundle.summary.verifiedCount}</dd>
            </div>
          </dl>
          <div className="bundle-cover-date">Generated: {new Date(bundle.generatedAt).toLocaleString('ja-JP')}</div>
        </section>

        {/* 目次 (TOC) */}
        <nav className="bundle-toc" aria-label="目次">
          <h2>目次</h2>
          <ol>
            {bundle.documents.map((doc, idx) => (
              <li key={doc.id}>
                <a href={`#${bundleDocAnchor(doc.id)}`} className="bundle-toc-link">
                  <span className="bundle-toc-num">{idx + 1}.</span>
                  <span className={`badge badge-type type-${doc.type}`}>{ARTIFACT_TYPE_LABELS[doc.type]}</span>
                  <span className="bundle-toc-title">{doc.title}</span>
                  <span className="bundle-toc-path mono">{doc.path}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {/* 各ドキュメント章 */}
        {bundle.documents.map((doc, idx) => (
          <article key={doc.id} id={bundleDocAnchor(doc.id)} className="bundle-chapter page">
            <header className="doc-header">
              <div className="doc-badges">
                <span className="badge badge-id">Chapter {idx + 1}</span>
                <span className={`badge badge-type type-${doc.type}`}>{ARTIFACT_TYPE_LABELS[doc.type]}</span>
                {doc.blocks.length > 0 && <span className="badge badge-id">{doc.blocks.length} blocks</span>}
              </div>
              <h1>{doc.title}</h1>
              {doc.description && <p className="doc-description">{doc.description}</p>}
              <div className="doc-meta">
                {doc.tags.length > 0 && <span className="meta-item">tags: {doc.tags.join(', ')}</span>}
                <span className="meta-item mono">{doc.path}</span>
              </div>
            </header>

            <DocReviewProvider blocks={doc.blocks} onMutate={() => {}}>
              <Markdown
                body={doc.body}
                format={doc.format}
                currentDir={doc.dir}
                terms={bundle.terms}
                bundleDocIds={bundleDocIds}
                headingPrefix={bundleDocAnchor(doc.id)}
                expandAllTabs
              />
            </DocReviewProvider>
          </article>
        ))}
      </div>
    </div>
  )
}
