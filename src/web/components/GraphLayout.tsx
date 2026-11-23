import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { encodeDocId } from '../api'
import { toErrorMessage, useGraphQuery, useMatrixQuery } from '../queries'
import DocPeekPane from './DocPeekPane'
import SigmaGraph from './SigmaGraph'

type PageTab = 'graph' | 'matrix'
type MatrixFilter = 'all' | 'verified' | 'unimplemented' | 'drifted' | 'unreviewed' | 'orphan'

const EDGE_KIND_STYLES: Record<string, string> = {
  derives: 'border-amber-500 text-amber-700 dark:text-amber-400',
  satisfies: 'border-teal-500 text-teal-700 dark:text-teal-400',
  verifies: 'border-green-500 text-green-700 dark:text-green-400',
  supersedes: 'border-rose-500 text-rose-700 dark:text-rose-400',
}

export default function GraphLayout() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<PageTab>('graph')
  const [matrixFilter, setMatrixFilter] = useState<MatrixFilter>('all')
  const [edgeLayer, setEdgeLayer] = useState<'trace' | 'all'>('all')
  const [granularity, setGranularity] = useState<'docs' | 'blocks'>('docs')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const handleSelectNode = useCallback((id: string | null) => {
    setSelectedNodeId(id)
  }, [])

  const matrixQuery = useMatrixQuery()
  const graphQuery = useGraphQuery(edgeLayer, granularity)
  const rows = useMemo(() => matrixQuery.data?.rows ?? [], [matrixQuery.data])
  const graph = graphQuery.data ?? null
  const error = toErrorMessage(matrixQuery.error ?? graphQuery.error)

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

  const chipClass = (active: boolean) =>
    `cursor-pointer rounded-full border px-2.5 py-1 text-xs font-semibold ${
      active ? 'border-accent bg-accent text-surface' : 'border-line bg-subtle text-fg-muted hover:text-fg'
    }`

  const pageTabClass = (active: boolean) =>
    `cursor-pointer border-0 border-b-2 bg-transparent px-3 py-2 text-[13.5px] font-semibold ${
      active ? 'border-b-accent text-fg' : 'border-b-transparent text-fg-muted hover:text-fg'
    }`

  const matrixChipClass =
    'mr-1 mb-1 inline-block rounded-full bg-[var(--tc-soft)] px-[7px] py-px text-[11.5px] font-semibold text-[var(--tc)] no-underline'

  return (
    <>
      <main
        className={`relative min-h-0 min-w-0 flex-1 bg-surface max-[900px]:flex-none max-[900px]:overflow-visible ${
          tab === 'graph' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'
        }`}
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3.5 gap-y-2 border-b border-line bg-surface px-4 pt-1.5">
          <div className="flex gap-2" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'graph'}
              className={pageTabClass(tab === 'graph')}
              onClick={() => setTab('graph')}
            >
              {t('graph.graphViewTab', { count: graph?.nodes.length ?? 0 })}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'matrix'}
              className={pageTabClass(tab === 'matrix')}
              onClick={() => setTab('matrix')}
            >
              {t('graph.matrixTab', { count: rows.length })}
            </button>
          </div>

          {tab === 'graph' && (
            <div className="flex flex-wrap items-center gap-1.5 pb-1.5">
              <button
                type="button"
                className={chipClass(granularity === 'docs')}
                onClick={() => {
                  setSelectedNodeId(null)
                  setGranularity('docs')
                }}
              >
                {t('graph.documents')}
              </button>
              <button
                type="button"
                className={chipClass(granularity === 'blocks')}
                onClick={() => {
                  setSelectedNodeId(null)
                  setGranularity('blocks')
                }}
              >
                {t('graph.docsAndBlocks')}
              </button>
              <span className="mx-0.5 h-4 w-px bg-line" aria-hidden="true" />
              <button type="button" className={chipClass(edgeLayer === 'all')} onClick={() => setEdgeLayer('all')}>
                {t('graph.allLinks')}
              </button>
              <button type="button" className={chipClass(edgeLayer === 'trace')} onClick={() => setEdgeLayer('trace')}>
                {t('graph.traceabilityOnly')}
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
          <section className="flex min-h-0 flex-1">
            <SigmaGraph data={graph} selectedNodeId={selectedNodeId} onSelectNode={handleSelectNode} />
          </section>
        )}

        {tab === 'matrix' && (
          <article className="page doc-page !max-w-[1120px]">
            <section>
              <div className="mb-3.5 flex flex-wrap gap-1.5">
                {(['all', 'verified', 'unimplemented', 'drifted', 'unreviewed', 'orphan'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className={chipClass(matrixFilter === f)}
                    onClick={() => setMatrixFilter(f)}
                  >
                    {t(`matrix.filters.${f}`)}
                  </button>
                ))}
              </div>

              {filteredRows.length === 0 ? (
                <p className="muted">{t('matrix.empty')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-[13px] [&_td]:border-b [&_td]:border-line [&_td]:px-2.5 [&_td]:py-[9px] [&_td]:text-left [&_td]:align-top [&_th]:border-b [&_th]:border-line [&_th]:bg-sidebar [&_th]:px-2.5 [&_th]:py-[9px] [&_th]:text-left [&_th]:text-[11.5px] [&_th]:tracking-[0.03em] [&_th]:text-fg-muted [&_th]:uppercase">
                    <thead>
                      <tr>
                        <th>{t('matrix.spec')}</th>
                        <th>{t('matrix.goals')}</th>
                        <th>{t('matrix.designContract')}</th>
                        <th>{t('matrix.verification')}</th>
                        <th>{t('matrix.review')}</th>
                        <th>{t('matrix.realization')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRows.map((row) => (
                        <tr key={row.specId} className={row.orphan ? 'bg-amber-500/8' : ''}>
                          <td>
                            <Link
                              to={`/docs/${encodeDocId(row.docId)}#block-${encodeURIComponent(row.specId)}`}
                              className="mono font-bold text-fg no-underline hover:underline"
                            >
                              {row.specId}
                            </Link>
                            <div className="text-[11.5px] text-fg-muted">{row.docTitle}</div>
                          </td>
                          <td>
                            {row.orphan ? (
                              <span className="sem-review-badge sem-review-stale">{t('matrix.orphan')}</span>
                            ) : (
                              row.goals.map((g) => (
                                <Link
                                  key={g.id}
                                  to={`/docs/${encodeDocId(g.id)}`}
                                  className={`${matrixChipClass} type-goal`}
                                >
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
                                  className={`${matrixChipClass} type-${d.type}`}
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
                                  className={`${matrixChipClass} type-verification`}
                                >
                                  {v.title}
                                </Link>
                              ))
                            )}
                          </td>
                          <td>
                            <span className={`sem-review-badge sem-review-${row.suspect ? 'suspect' : row.review}`}>
                              {row.suspect ? t('status.review.suspect') : t(`status.review.${row.review}`)}
                            </span>
                          </td>
                          <td>
                            {row.realization ? (
                              <span className={`sem-realization-badge sem-real-${row.realization.status}`}>
                                {t(`status.realization.${row.realization.status}`)}
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
            label: t('peek.connectionsTab', { count: selectedEdges.out.length + selectedEdges.inc.length }),
            content: (
              <div>
                <div className="doc-badges mb-2.5">
                  <span className={`badge badge-type type-${selectedNode.type}`}>
                    {t(`types.singular.${selectedNode.type}`)}
                  </span>
                  {selectedNode.blockKind && <span className="badge badge-format">{selectedNode.blockKind}</span>}
                  {selectedNode.review && (
                    <span className={`sem-review-badge sem-review-${selectedNode.review}`}>
                      {t(`status.review.${selectedNode.review}`)}
                    </span>
                  )}
                  {selectedNode.realization && (
                    <span className={`sem-realization-badge sem-real-${selectedNode.realization}`}>
                      {t(`status.realization.${selectedNode.realization}`)}
                    </span>
                  )}
                </div>

                <h3 className="m-0 mb-2.5 text-[11px] font-bold tracking-[0.07em] text-fg-muted uppercase">
                  {t('peek.outgoing', { count: selectedEdges.out.length })}
                </h3>
                {selectedEdges.out.length === 0 ? (
                  <p className="m-0 text-[12.5px] text-fg-muted">{t('peek.noOutgoing')}</p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {selectedEdges.out.map((e) => (
                      <li key={`${e.kind}:${e.target}`}>
                        <button
                          type="button"
                          className="flex w-full cursor-pointer items-center gap-2 rounded-[7px] border border-line bg-surface px-2.5 py-[7px] text-left text-fg hover:border-accent hover:bg-accent-soft"
                          onClick={() =>
                            setSelectedNodeId(graph?.nodes.some((n) => n.id === e.target) ? e.target : e.docId)
                          }
                        >
                          <span
                            className={`rounded border bg-subtle px-[5px] py-px text-[10px] font-bold ${EDGE_KIND_STYLES[e.kind] ?? 'border-line text-fg-muted'}`}
                          >
                            {e.kind}
                          </span>
                          <span className="mono text-[11px] text-fg-muted">{e.target}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <h3 className="m-0 mt-3.5 mb-2.5 text-[11px] font-bold tracking-[0.07em] text-fg-muted uppercase">
                  {t('peek.incoming', { count: selectedEdges.inc.length })}
                </h3>
                {selectedEdges.inc.length === 0 ? (
                  <p className="m-0 text-[12.5px] text-fg-muted">{t('peek.noIncoming')}</p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {selectedEdges.inc.map((e) => (
                      <li key={`${e.kind}:${e.source}`}>
                        <button
                          type="button"
                          className="flex w-full cursor-pointer items-center gap-2 rounded-[7px] border border-line bg-surface px-2.5 py-[7px] text-left text-fg hover:border-accent hover:bg-accent-soft"
                          onClick={() =>
                            setSelectedNodeId(graph?.nodes.some((n) => n.id === e.source) ? e.source : e.docId)
                          }
                        >
                          <span
                            className={`rounded border bg-subtle px-[5px] py-px text-[10px] font-bold ${EDGE_KIND_STYLES[e.kind] ?? 'border-line text-fg-muted'}`}
                          >
                            {e.kind}
                          </span>
                          <span className="mono text-[11px] text-fg-muted">{e.source}</span>
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
