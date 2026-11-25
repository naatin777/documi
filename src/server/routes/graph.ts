import { Hono } from 'hono'
import { z } from 'zod'
import { TRACE_EDGE_KINDS } from '../../core/types'
import type { ArtifactType, BlockKind, GraphEdge, RealizationStatus, ReviewStatus } from '../../core/types'
import type { DocsStore } from '../store'
import { zValidator } from '../validator'

const graphQuerySchema = z.object({
  layers: z.enum(['all', 'trace']).optional(),
  granularity: z.enum(['docs', 'blocks']).optional(),
})

interface GraphNodePayload {
  id: string
  kind: 'doc' | 'block'
  docId: string
  type: ArtifactType
  title: string
  path: string
  blockKind?: BlockKind
  review?: ReviewStatus
  realization?: RealizationStatus
  blockCount: number
  issueCount: number
}

interface GraphEdgePayload {
  from: string
  fromDocId: string
  to: string
  toDocId: string
  toKind: 'doc' | 'block'
  kind: GraphEdge['kind'] | 'contains'
}

export function createGraphRoutes(store: DocsStore) {
  return new Hono().get('/graph', zValidator('query', graphQuerySchema), (c) => {
    const index = store.getIndex()
    const { layers = 'all', granularity = 'docs' } = c.req.valid('query')
    const traceSet = new Set<string>(TRACE_EDGE_KINDS)
    const filteredEdges: GraphEdgePayload[] =
      layers === 'trace' ? index.edges.filter((e) => traceSet.has(e.kind)) : index.edges

    const docNodes: GraphNodePayload[] = index.documents.map((d) => ({
      id: d.id,
      kind: 'doc',
      docId: d.id,
      type: d.type,
      title: d.title,
      path: d.path,
      blockCount: d.blocks.length,
      issueCount: d.issues.length,
    }))

    if (granularity === 'docs') {
      return c.json({ granularity, nodes: docNodes, edges: filteredEdges }, 200)
    }

    const blockNodes: GraphNodePayload[] = []
    const containsEdges: GraphEdgePayload[] = []
    for (const doc of index.documents) {
      for (const b of doc.blocks) {
        if (b.kind === 'note') continue
        blockNodes.push({
          id: b.id,
          kind: 'block',
          docId: doc.id,
          type: doc.type,
          title: b.title ? `${b.id} — ${b.title}` : b.id,
          path: doc.path,
          blockKind: b.kind,
          review: b.review,
          realization: b.realization?.status,
          blockCount: 0,
          issueCount: 0,
        })
        containsEdges.push({
          from: doc.id,
          fromDocId: doc.id,
          to: b.id,
          toDocId: doc.id,
          toKind: 'block',
          kind: 'contains',
        })
      }
    }

    return c.json(
      {
        granularity,
        nodes: [...docNodes, ...blockNodes],
        edges: [...containsEdges, ...filteredEdges],
      },
      200,
    )
  })
}
