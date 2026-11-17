import type { DocStatus, Document } from '../../core/types'
import { ARTIFACT_TYPE_LABELS } from '../../core/types'
import Markdown from './Markdown'

export default function DocViewer({ doc }: { doc: Document }) {
  return (
    <article className="page doc-page">
      <header className="doc-header">
        <div className="doc-badges">
          <span className={`badge badge-type type-${doc.type}`}>{ARTIFACT_TYPE_LABELS[doc.type]}</span>
          <span className="badge badge-id">{doc.id}</span>
          <StatusBadge status={doc.status} />
          {doc.format === 'mdx' && <span className="badge badge-format">MDX</span>}
        </div>
        <h1>{doc.title}</h1>
        <p className="doc-description">{doc.description}</p>
        <div className="doc-meta">
          {doc.tags.length > 0 && <span className="meta-item">tags: {doc.tags.join(', ')}</span>}
          {doc.subtype && <span className="meta-item">subtype: {doc.subtype}</span>}
          {doc.perspective && <span className="meta-item">perspective: {doc.perspective}</span>}
          <span className="meta-item mono">{doc.path}</span>
        </div>
      </header>

      {doc.issues.length > 0 && (
        <section className="issues-panel">
          <h2>この文書の問題</h2>
          <ul>
            {doc.issues.map((issue, i) => (
              <li key={i}>
                <code>{issue.code}</code> {issue.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      <Markdown body={doc.body} format={doc.format} />
    </article>
  )
}

function StatusBadge({ status }: { status: DocStatus }) {
  return <span className={`badge badge-status badge-status-${status}`}>{status}</span>
}
