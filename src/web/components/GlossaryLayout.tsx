import { useEffect, useMemo, useState } from 'react'
import type { Glossary } from '../../core/types'
import { api } from '../api'
import { extractHeadings } from '../headings'
import DocTabs from './DocTabs'
import Markdown from './Markdown'
import { PrintFooter, PrintHeader } from './PrintChrome'
import SidePanel from './SidePanel'

export default function GlossaryLayout() {
  const [glossary, setGlossary] = useState<Glossary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .glossary()
      .then((res) => setGlossary(res.glossary))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const headings = useMemo(() => (glossary ? extractHeadings(glossary.body, glossary.format) : []), [glossary])

  return (
    <>
      <main className="content">
        <DocTabs />
        <article className="page doc-page">
          <PrintHeader label="Glossary" title={glossary?.title ?? 'Glossary'} meta={glossary?.path} />
          <header className="doc-header">
            <div className="doc-badges">
              <span className="badge badge-type">Glossary</span>
            </div>
            <h1>{glossary?.title ?? 'Glossary'}</h1>
            {glossary?.description && <p className="doc-description">{glossary.description}</p>}
            {glossary && (
              <div className="doc-meta">
                <span className="meta-item mono">{glossary.path}</span>
              </div>
            )}
          </header>
          {error && <p className="error-text">{error}</p>}
          {!glossary && !error && <p className="muted">読み込み中…</p>}
          {glossary && <Markdown body={glossary.body} format={glossary.format} />}
          <PrintFooter meta="glossary" />
        </article>
      </main>
      <SidePanel headings={headings} />
    </>
  )
}
