import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import { exportBundleHtmlFromDom, printDocument } from '../export'
import { bundleDocAnchor } from '../mdast'
import { toErrorMessage, useBundleQuery } from '../queries'
import Markdown from './Markdown'
import { DocReviewProvider } from './SemanticBlocks'

declare global {
  interface Window {
    __DOCUMI_BUNDLE_READY__?: boolean
  }
}

export default function BundleLayout() {
  const { t, i18n } = useTranslation()
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
  const actionFired = useRef(false)

  const bundleQuery = useBundleQuery({ scope, ids, title })
  const bundle = bundleQuery.data ?? null
  const error = toErrorMessage(bundleQuery.error)

  useEffect(() => {
    window.__DOCUMI_BUNDLE_READY__ = false
  }, [scope, ids, title])

  useEffect(() => {
    if (bundle) {
      document.title = `${bundle.title} — Documi`
    }
  }, [bundle])

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
      <div className="min-h-screen bg-surface text-fg">
        <div className="mx-auto max-w-[900px] px-6 py-12">
          <h1>{t('bundle.errorTitle')}</h1>
          <p className="error-text">{error}</p>
          <Link to="/" className="button">
            {t('bundle.backToOverview')}
          </Link>
        </div>
      </div>
    )
  }

  if (!bundle) {
    return (
      <div className="min-h-screen bg-surface p-8 text-fg">
        <p className="muted">{t('bundle.building')}</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-surface text-fg">
      <div className="bundle-toolbar sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-sidebar px-5 py-2.5 print:hidden">
        <Link to="/" className="sem-action-btn no-underline">
          {t('bundle.backToDocumi')}
        </Link>
        <span className="text-[12.5px] text-fg-muted">
          {t('bundle.meta', { docs: bundle.summary.documentCount, blocks: bundle.summary.blockCount })}
        </span>
        <div className="ml-auto flex gap-2">
          <button type="button" className="sem-action-btn" onClick={() => exportBundleHtmlFromDom(bundle.title)}>
            {t('bundle.downloadHtml')}
          </button>
          <button type="button" className="sem-action-btn sem-approve-btn" onClick={printDocument}>
            {t('bundle.printPdf')}
          </button>
        </div>
      </div>

      <div className="bundle-root mx-auto max-w-[900px] px-6 pt-8 pb-20">
        {/* 表紙 */}
        <section className="bundle-cover mb-9 border-b-2 border-line pt-12 pb-9">
          <div className="mb-2 text-xs font-bold tracking-[0.08em] text-fg-muted uppercase">
            Documi Living Specification
          </div>
          <h1 className="m-0 mb-2 text-[32px] leading-[1.25] font-bold">{bundle.title}</h1>
          <p className="m-0 mb-6 text-fg-muted">{bundle.scopeLabel}</p>
          <dl className="m-0 mb-5 grid grid-cols-4 gap-3 max-sm:grid-cols-2">
            {[
              ['Documents', bundle.summary.documentCount],
              ['Semantic Blocks', bundle.summary.blockCount],
              ['Approved', bundle.summary.approvedCount],
              ['Verified', bundle.summary.verifiedCount],
            ].map(([label, val]) => (
              <div key={String(label)} className="rounded-lg border border-line bg-sidebar px-3 py-2.5">
                <dt className="text-[11px] text-fg-muted">{label}</dt>
                <dd className="m-0 mt-0.5 text-xl font-bold">{val}</dd>
              </div>
            ))}
          </dl>
          <div className="text-xs text-fg-muted">
            {t('bundle.generated', { date: new Date(bundle.generatedAt).toLocaleString(i18n.language) })}
          </div>
        </section>

        {/* 目次 (TOC) */}
        <nav className="bundle-toc mb-12 border-b border-line pb-6" aria-label={t('bundle.toc')}>
          <h2 className="m-0 mb-3 text-lg font-bold">{t('bundle.toc')}</h2>
          <ol className="m-0 grid list-none gap-1.5 p-0">
            {bundle.documents.map((doc, idx) => (
              <li key={doc.id}>
                <a
                  href={`#${bundleDocAnchor(doc.id)}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-fg no-underline hover:bg-hover"
                >
                  <span className="w-6 font-semibold text-fg-muted">{idx + 1}.</span>
                  <span className={`badge badge-type type-${doc.type}`}>{t(`types.singular.${doc.type}`)}</span>
                  <span>{doc.title}</span>
                  <span className="mono ml-auto text-[11.5px] text-fg-muted">{doc.path}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {/* 各ドキュメント章 */}
        {bundle.documents.map((doc, idx) => (
          <article
            key={doc.id}
            id={bundleDocAnchor(doc.id)}
            className="bundle-chapter page border-b border-line py-7 pb-10"
          >
            <header className="doc-header">
              <div className="doc-badges">
                <span className="badge badge-id">{t('bundle.chapter', { index: idx + 1 })}</span>
                <span className={`badge badge-type type-${doc.type}`}>{t(`types.singular.${doc.type}`)}</span>
                {doc.blocks.length > 0 && (
                  <span className="badge badge-id">{t('doc.blocksCount', { count: doc.blocks.length })}</span>
                )}
              </div>
              <h1>{doc.title}</h1>
              {doc.description && <p className="doc-description">{doc.description}</p>}
              <div className="doc-meta">
                {doc.tags.length > 0 && <span>tags: {doc.tags.join(', ')}</span>}
                <span className="mono">{doc.path}</span>
              </div>
            </header>

            <DocReviewProvider blocks={doc.blocks} onMutate={() => {}}>
              <Markdown
                body={doc.body}
                format={doc.format}
                currentDir={doc.dir}
                resolvedLinks={doc.resolvedLinks}
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
