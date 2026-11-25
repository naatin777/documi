import { Hono } from 'hono'
import { z } from 'zod'
import { getChangedBlockIds } from '../../core/git'
import { approveBlock, getBlockDiff, unapproveBlock } from '../../core/reviews'
import type { BlockKind, DocFormat, RealizationStatus, ReviewStatus, Stability } from '../../core/types'
import { reviewErrorToHttp } from '../errors'
import type { DocsStore } from '../store'
import { zValidator } from '../validator'

interface ReviewBlockSummary {
  id: string
  kind: BlockKind
  docId: string
  docTitle: string
  docPath: string
  docDir: string
  docFormat: DocFormat
  title?: string
  rawBody: string
  stability: Stability
  review: ReviewStatus
  suspect: boolean
  suspectSources: string[]
  changed: boolean
  approvedAt?: string
  approvedBy?: string
  approvedNote?: string
  realization?: RealizationStatus
}

const approveBodySchema = z
  .object({
    author: z.string().optional(),
    note: z.string().optional(),
  })
  .optional()
  .default({})

const approveBatchBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'Specify at least one block ID to approve'),
  author: z.string().optional(),
  note: z.string().optional(),
})

export function createBlocksRoutes(store: DocsStore) {
  return new Hono()
    .get('/', (c) => {
      const index = store.getIndex()
      const changedIds = getChangedBlockIds(index)
      const blocks: ReviewBlockSummary[] = []
      const counts = { approved: 0, unreviewed: 0, stale: 0, suspect: 0, changed: 0 }

      for (const doc of index.documents) {
        for (const b of doc.blocks) {
          if (b.kind === 'note') continue
          const changed = changedIds.has(b.id)
          counts[b.review]++
          if (b.suspect) counts.suspect++
          if (changed) counts.changed++

          blocks.push({
            id: b.id,
            kind: b.kind,
            docId: doc.id,
            docTitle: doc.title,
            docPath: doc.path,
            docDir: doc.dir,
            docFormat: doc.format,
            ...(b.title ? { title: b.title } : {}),
            rawBody: b.rawBody,
            stability: b.stability,
            review: b.review,
            suspect: b.suspect,
            suspectSources: b.suspectSources,
            changed,
            ...(b.approvedAt ? { approvedAt: b.approvedAt } : {}),
            ...(b.approvedBy ? { approvedBy: b.approvedBy } : {}),
            ...(b.approvedNote ? { approvedNote: b.approvedNote } : {}),
            ...(b.realization ? { realization: b.realization.status } : {}),
          })
        }
      }

      return c.json({ blocks, counts }, 200)
    })
    .post('/approve-batch', zValidator('json', approveBatchBodySchema), async (c) => {
      const { ids, author, note } = c.req.valid('json')
      const uniqueIds = [...new Set(ids)]
      const index = store.getIndex()
      for (const blockId of uniqueIds) {
        if (!index.blocksById.has(blockId)) {
          return c.json({ code: 'BlockNotFoundError', error: `Block not found: ${blockId}` }, 404)
        }
      }
      for (const blockId of uniqueIds) {
        const res = await approveBlock(store.rootDir, index, blockId, { author, note, cacheRoot: store.projectRoot })
        if (res.isErr()) {
          const http = reviewErrorToHttp(res.error)
          return c.json(http.body, http.status)
        }
      }
      const next = await store.reload()
      const approved = uniqueIds
        .map((id) => next.blocksById.get(id))
        .filter((b): b is NonNullable<typeof b> => Boolean(b))
      return c.json({ approvedIds: approved.map((b) => b.id), count: approved.length }, 200)
    })
    .get('/:id/diff', async (c) => {
      const blockId = decodeURIComponent(c.req.param('id'))
      const res = await getBlockDiff(store.rootDir, store.getIndex(), blockId, { cacheRoot: store.projectRoot })
      if (res.isErr()) {
        const http = reviewErrorToHttp(res.error)
        return c.json(http.body, http.status)
      }
      return c.json(res.value, 200)
    })
    .post('/:id/approve', zValidator('json', approveBodySchema), async (c) => {
      const blockId = decodeURIComponent(c.req.param('id'))
      const { author, note } = c.req.valid('json')
      const res = await approveBlock(store.rootDir, store.getIndex(), blockId, {
        author,
        note,
        cacheRoot: store.projectRoot,
      })
      if (res.isErr()) {
        const http = reviewErrorToHttp(res.error)
        return c.json(http.body, http.status)
      }
      const next = await store.reload()
      const block = next.blocksById.get(blockId)
      if (!block) return c.json({ code: 'BlockNotFoundError', error: `Block not found: ${blockId}` }, 404)
      return c.json({ block }, 200)
    })
    .delete('/:id/approve', async (c) => {
      const blockId = decodeURIComponent(c.req.param('id'))
      const res = await unapproveBlock(store.rootDir, store.getIndex(), blockId, { cacheRoot: store.projectRoot })
      if (res.isErr()) {
        const http = reviewErrorToHttp(res.error)
        return c.json(http.body, http.status)
      }
      const next = await store.reload()
      const block = next.blocksById.get(blockId)
      if (!block) return c.json({ code: 'BlockNotFoundError', error: `Block not found: ${blockId}` }, 404)
      return c.json({ block }, 200)
    })
}
