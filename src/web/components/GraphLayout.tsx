import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { TraceMatrixRow } from '../../core/bundle'
import { ARTIFACT_TYPE_LABELS } from '../../core/types'
import { api, encodeDocId, type GraphResponse } from '../api'
import { useDocsRevision } from '../live'
import DocPeekPane from './DocPeekPane'
import DocTabs from './DocTabs'
import SigmaGraph from './SigmaGraph'

type PageTab = 'graph' | 'matrix'
type MatrixFilter = 'all' | 'verified' | 'unimplemented' | 'drifted' | 'unreviewed' | 'orphan'

export default function GraphLayout() {
  const revision = useDocsRevision()
  const [tab, setTab] = useState<PageTab>('graph')
  const [matrixFilter, setMatrixFilter] = useState<MatrixFilter>('all')
  const [edgeLayer, setEdgeLayer] = useState<'trace' | 'all'>('all')
  const [granularity, setGranularity] = useState<'docs' | 'blocks'>('docs')
  const [rows, setRows] = useState<TraceMatrixRow[]>([])
  const [graph, setGraph] = useState<GraphResponse | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSelectNode = useCallback((id: string | null) => {
    setSelectedNodeId(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([api.matrix(), api.graph(edgeLayer, granularity)])
      .then(([m, g]) => {
        if (cancelled) return
        setRows(m.rows)
        setGraph(g)
        setError(null)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [revision, edgeLayer, granularity])

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (matrixFilter === 'all') return true
      if (matrixFilter === 'orphan') return r.orphan
      if (matrixFilter === 'unreviewed') return r.review !== 'approved' || r.suspect
      return r.realization?.status === matrixFilter
    })
  }, [rows, matrixFilter])

  const selectedNode = useMemo(
    () => (selectedNodeId && graph ? (graph.nodes.find((n) => n.id === selectedNodeId) ?? null) : null),
    [selectedNodeId, graph],
  )

  const selectedEdges = useMemo(() => {
    if (!selectedNodeId || !graph) return { out: [], inc: [] }
    const nodeIds = new Set(graph.nodes.map((n) => n.id))
    const out: Array<{ target: string; docId: string; kind: string; isBlock: boolean }> = []
    const inc: Array<{ source: string; docId: string; kind: string; isBlock: boolean }> = []
    const seenOut = new Set<string>()
    const seenInc = new Set<string>()

    for (const e of graph.edges) {
      const src = graph.granularity === 'blocks' && nodeIds.has(e.from) ? e.from : e.fromDocId
      const dst = graph.granularity === 'blocks' && nodeIds.has(e.to) ? e.to : e.toDocId
      if (src === dst) continue
      if (src === selectedNodeId) {
        const key = `${e.kind}|${dst}`
        if (!seenOut.has(key)) {
          seenOut.add(key)
          out.push({ target: dst, docId: e.toDocId, kind: e.kind, isBlock: e.toKind === 'block' && dst !== e.toDocId })
        }
      }
      if (dst === selectedNodeId) {
        const key = `${e.kind}|${src}`
        if (!seenInc.has(key)) {
          seenInc.add(key)
          inc.push({ source: src, docId: e.fromDocId, kind: e.kind, isBlock: src !== e.fromDocId })
        }
      }
    }
    return { out, inc }
  }, [selectedNodeId, graph])

  return (
    <>
      <main className={`content${tab === 'graph' ? ' content-graph-full' : ''}`}>
        <DocTabs />

        <div className="graph-topbar">
          <div className="graph-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'graph'}
              className={`graph-tab${tab === 'graph' ? ' active' : ''}`}
              onClick={() => setTab('graph')}
            >
              Graph View ({graph?.nodes.length ?? 0})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'matrix'}
              className={`graph-tab${tab === 'matrix' ? ' active' : ''}`}
              onClick={() => setTab('matrix')}
            >
              Traceability Matrix ({rows.length})
            </button>
          </div>

          {tab === 'graph' && (
            <div className="graph-topbar-filters">
              <button
                type="button"
                className={`export-mode-chip${granularity === 'docs' ? ' active' : ''}`}
                onClick={() => {
                  setSelectedNodeId(null)
                  setGranularity('docs')
                }}
              >
                Documents
              </button>
              <button
                type="button"
                className={`export-mode-chip${granularity === 'blocks' ? ' active' : ''}`}
                onClick={() => {
                  setSelectedNodeId(null)
                  setGranularity('blocks')
                }}
              >
                Docs + Blocks
              </button>
              <span className="graph-sep" aria-hidden="true" />
              <button
                type="button"
                className={`export-mode-chip${edgeLayer === 'all' ? ' active' : ''}`}
                onClick={() => setEdgeLayer('all')}
              >
                All Links
              </button>
              <button
                type="button"
                className={`export-mode-chip${edgeLayer === 'trace' ? ' active' : ''}`}
                onClick={() => setEdgeLayer('trace')}
              >
                Traceability Only
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="page">
            <p className="error-text">{error}</p>
          </div>
        )}

        {tab === 'graph' && graph && (
          <section className="sigma-full-viewport">
            <SigmaGraph data={graph} selectedNodeId={selectedNodeId} onSelectNode={handleSelectNode} />
          </section>
        )}

        {tab === 'matrix' && (
          <article className="page doc-page graph-page">
            <section className="matrix-section">
              <div className="matrix-filters">
                {(['all', 'verified', 'unimplemented', 'drifted', 'unreviewed', 'orphan'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={`export-mode-chip${matrixFilter === f ? ' active' : ''}`}
                    onClick={() => setMatrixFilter(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>

              {filteredRows.length === 0 ? (
                <p className="muted">該当する Spec がありません。</p>
              ) : (
                <div className="matrix-table-wrap">
                  <table className="matrix-table">
                    <thead>
                      <tr>
                        <th>Spec</th>
                        <th>Goals (上流)</th>
                        <th>Design / Contract</th>
                        <th>Verification</th>
                        <th>Review</th>
                        <th>Realization</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRows.map((row) => (
                        <tr key={row.specId} className={row.orphan ? 'matrix-row-warn' : ''}>
                          <td>
                            <Link
                              to={`/docs/${encodeDocId(row.docId)}#block-${encodeURIComponent(row.specId)}`}
                              className="matrix-spec-link mono"
                            >
                              {row.specId}
                            </Link>
                            <div className="matrix-sub">{row.docTitle}</div>
                          </td>
                          <td>
                            {row.orphan ? (
                              <span className="sem-review-badge sem-review-stale">orphan</span>
                            ) : (
                              row.goals.map((g) => (
                                <Link key={g.id} to={`/docs/${encodeDocId(g.id)}`} className="matrix-chip type-goal">
                                  {g.title}
                                </Link>
                              ))
                            )}
                          </td>
                          <td>
                            {row.designs.length === 0 ? (
                              <span className="muted">—</span>
                            ) : (
                              row.designs.map((d) => (
                                <Link
                                  key={d.id}
                                  to={`/docs/${encodeDocId(d.id)}`}
                                  className={`matrix-chip type-${d.type}`}
                                >
                                  {d.title}
                                </Link>
                              ))
                            )}
                          </td>
                          <td>
                            {row.verifications.length === 0 ? (
                              <span className="muted">—</span>
                            ) : (
                              row.verifications.map((v) => (
                                <Link
                                  key={v.id}
                                  to={`/docs/${encodeDocId(v.id)}`}
                                  className="matrix-chip type-verification"
                                >
                                  {v.title}
                                </Link>
                              ))
                            )}
                          </td>
                          <td>
                            <span className={`sem-review-badge sem-review-${row.suspect ? 'suspect' : row.review}`}>
                              {row.suspect ? 'suspect' : row.review}
                            </span>
                          </td>
                          <td>
                            {row.realization ? (
                              <span className={`sem-realization-badge sem-real-${row.realization.status}`}>
                                {row.realization.status}
                              </span>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </article>
        )}
      </main>
      {tab === 'graph' && selectedNode && (
        <DocPeekPane
          docId={selectedNode.docId}
          focusBlockId={selectedNode.kind === 'block' ? selectedNode.id : undefined}
          onClose={() => setSelectedNodeId(null)}
          extraTab={{
            label: `繋がり (${selectedEdges.out.length + selectedEdges.inc.length})`,
            content: (
              <div className="peek-connections">
                <div className="doc-badges" style={{ marginBottom: 10 }}>
                  <span className={`badge badge-type type-${selectedNode.type}`}>
                    {ARTIFACT_TYPE_LABELS[selectedNode.type]}
                  </span>
                  {selectedNode.blockKind && <span className="badge badge-format">{selectedNode.blockKind}</span>}
                  {selectedNode.review && (
                    <span className={`sem-review-badge sem-review-${selectedNode.review}`}>{selectedNode.review}</span>
                  )}
                  {selectedNode.realization && (
                    <span className={`sem-realization-badge sem-real-${selectedNode.realization}`}>
                      {selectedNode.realization}
                    </span>
                  )}
                </div>

                <h3 className="rp-title">Outgoing ({selectedEdges.out.length})</h3>
                {selectedEdges.out.length === 0 ? (
                  <p className="rp-empty">外向き参照はありません</p>
                ) : (
                  <ul className="rp-relations">
                    {selectedEdges.out.map((e) => (
                      <li key={`${e.kind}:${e.target}`}>
                        <button
                          type="button"
                          className="rp-relation rp-relation-btn"
                          onClick={() =>
                            setSelectedNodeId(graph?.nodes.some((n) => n.id === e.target) ? e.target : e.docId)
                          }
                        >
                          <span className={`rp-edge-kind rp-edge-${e.kind}`}>{e.kind}</span>
                          <span className="rp-relation-id mono">{e.target}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <h3 className="rp-title" style={{ marginTop: 14 }}>
                  Incoming ({selectedEdges.inc.length})
                </h3>
                {selectedEdges.inc.length === 0 ? (
                  <p className="rp-empty">逆参照はありません</p>
                ) : (
                  <ul className="rp-relations">
                    {selectedEdges.inc.map((e) => (
                      <li key={`${e.kind}:${e.source}`}>
                        <button
                          type="button"
                          className="rp-relation rp-relation-btn"
                          onClick={() =>
                            setSelectedNodeId(graph?.nodes.some((n) => n.id === e.source) ? e.source : e.docId)
                          }
                        >
                          <span className={`rp-edge-kind rp-edge-${e.kind}`}>{e.kind}</span>
                          <span className="rp-relation-id mono">{e.source}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ),
          }}
        />
      )}
    </>
  )
}
