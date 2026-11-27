import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toErrorMessage, useGraphQuery, useTreeQuery } from '../queries'
import DocPeekPane from './DocPeekPane'
import SigmaGraph from './SigmaGraph'

const EDGE_KIND_STYLES: Record<string, string> = {
  derives: 'border-amber-500 text-amber-700 dark:text-amber-400',
  satisfies: 'border-teal-500 text-teal-700 dark:text-teal-400',
  verifies: 'border-green-500 text-green-700 dark:text-green-400',
  supersedes: 'border-rose-500 text-rose-700 dark:text-rose-400',
}

function chipClass(active: boolean) {
  return `cursor-pointer rounded-full border px-2.5 py-1 text-xs font-semibold ${
    active ? 'border-accent bg-accent text-surface' : 'border-line bg-subtle text-fg-muted hover:text-fg'
  }`
}

export default function GraphLayout() {
  const { t } = useTranslation()
  const [edgeLayer, setEdgeLayer] = useState<'trace' | 'all'>('all')
  const [granularity, setGranularity] = useState<'docs' | 'blocks'>('docs')
  const [selectedScope, setSelectedScope] = useState<string>('all')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  const handleSelectNode = useCallback((id: string | null) => {
    setSelectedNodeId(id)
  }, [])

  const graphQuery = useGraphQuery(edgeLayer, granularity)
  const treeQuery = useTreeQuery()
  const mounts = treeQuery.data?.mounts ?? []
  const hasMultipleMounts = mounts.length > 1
  const activeScope = hasMultipleMounts && mounts.some((m) => m.id === selectedScope) ? selectedScope : 'all'
  const docMountById = useMemo(() => {
    const map = new Map<string, string>()
    for (const d of treeQuery.data?.documents ?? []) map.set(d.id, d.mountId)
    return map
  }, [treeQuery.data?.documents])

  const rawGraph = graphQuery.data ?? null
  const graph = useMemo(() => {
    if (!rawGraph || activeScope === 'all') return rawGraph
    const nodes = rawGraph.nodes.filter((n) => docMountById.get(n.docId) === activeScope)
    const nodeIds = new Set(nodes.map((n) => n.id))
    const edges = rawGraph.edges.filter(
      (e) => (nodeIds.has(e.from) || nodeIds.has(e.fromDocId)) && (nodeIds.has(e.to) || nodeIds.has(e.toDocId)),
    )
    return { ...rawGraph, nodes, edges }
  }, [rawGraph, activeScope, docMountById])
  const error = toErrorMessage(graphQuery.error)

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
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface max-desktop:flex-none max-desktop:overflow-visible">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3.5 gap-y-2 border-b border-line bg-surface px-4 py-2">
          <div className="flex items-center gap-2 text-[13.5px] font-semibold text-fg">
            <span>{t('graph.graphViewTab', { count: graph?.nodes.length ?? 0 })}</span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
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
            {hasMultipleMounts && (
              <>
                <span className="mx-0.5 h-4 w-px bg-line" aria-hidden="true" />
                <button
                  type="button"
                  className={chipClass(activeScope === 'all')}
                  onClick={() => {
                    setSelectedNodeId(null)
                    setSelectedScope('all')
                  }}
                >
                  All
                </button>
                {mounts.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={chipClass(activeScope === m.id)}
                    onClick={() => {
                      setSelectedNodeId(null)
                      setSelectedScope(m.id)
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </>
            )}
          </div>
        </div>

        {error && (
          <div className="page">
            <p className="error-text">{error}</p>
          </div>
        )}

        {graph && (
          <section className="flex min-h-0 flex-1">
            <SigmaGraph data={graph} selectedNodeId={selectedNodeId} onSelectNode={handleSelectNode} />
          </section>
        )}
      </main>
      {selectedNode && (
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
