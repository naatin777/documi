import { useTranslation } from 'react-i18next'
import type { Document } from '../../core/types'
import type { TermEntry } from '../api'
import Markdown from './Markdown'
import { PrintFooter, PrintHeader } from './PrintChrome'
import { DocReviewProvider } from './SemanticBlocks'

interface DocViewerProps {
  doc: Document
  terms?: readonly TermEntry[]
  onMutate: () => void
}

export default function DocViewer({ doc, terms, onMutate }: DocViewerProps) {
  const { t } = useTranslation()
  const typeLabel = t(`types.singular.${doc.type}`)
  return (
    <article className="page doc-page">
      <PrintHeader label={typeLabel} title={doc.title} meta={doc.path} />
      <header className="doc-header">
        <div className="doc-badges">
          <span className={`badge badge-type type-${doc.type}`}>{typeLabel}</span>
          {doc.typeInferred && <span className="badge badge-format">{t('doc.inferred')}</span>}
          {doc.format === 'mdx' && <span className="badge badge-format">MDX</span>}
          {doc.blocks.length > 0 && (
            <span className="badge badge-id">{t('doc.blocksCount', { count: doc.blocks.length })}</span>
          )}
        </div>
        <h1>{doc.title}</h1>
        {doc.description && <p className="doc-description">{doc.description}</p>}
        <div className="doc-meta">
          {doc.date && <span className="meta-item mono">{doc.date}</span>}
          {doc.tags.length > 0 && <span className="meta-item">tags: {doc.tags.join(', ')}</span>}
          <span className="meta-item mono">{doc.path}</span>
        </div>
      </header>

      {doc.issues.length > 0 && (
        <section className="issues-panel">
          <h2>{t('doc.docIssues', { count: doc.issues.length })}</h2>
          <ul>
            {doc.issues.map((issue, i) => (
              <li key={i}>
                <code>{issue.code}</code> {issue.blockId && <code>{issue.blockId}</code>} {issue.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <DocReviewProvider blocks={doc.blocks} onMutate={onMutate}>
        <Markdown body={doc.body} format={doc.format} currentDir={doc.dir} terms={terms} />
      </DocReviewProvider>
      <PrintFooter meta={doc.id} />
    </article>
  )
}
