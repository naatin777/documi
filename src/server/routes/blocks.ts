import { Hono } from 'hono'
import { z } from 'zod'
import {
  ReviewError,
  addBlockFeedback,
  approveBlock,
  getBlockDiff,
  setBlockStabilityOverride,
  setFeedbackResolved,
} from '../../core/reviews'
import { STABILITIES } from '../../core/types'
import type { DocsStore } from '../store'
import { zValidator, type ErrorStatusCode } from '../validator'

const approveBodySchema = z
  .object({
    author: z.string().optional(),
  })
  .optional()
  .default({})

const feedbackBodySchema = z.object({
  body: z.string(),
  author: z.string().optional(),
})

const feedbackPatchBodySchema = z.object({
  resolved: z.boolean({ message: 'resolved (boolean) が必要です' }),
})

const stabilityPatchBodySchema = z.object({
  stability: z.union([z.enum(STABILITIES), z.null()], {
    message: 'stability は stable / evolving / volatile または null である必要があります',
  }),
})

export function createBlocksRoutes(store: DocsStore) {
  return new Hono()
    .get('/:id/diff', async (c) => {
      const blockId = decodeURIComponent(c.req.param('id'))
      try {
        const diff = await getBlockDiff(store.rootDir, store.getIndex(), blockId)
        return c.json(diff, 200)
      } catch (e) {
        if (e instanceof ReviewError) return c.json({ error: e.message }, e.status as ErrorStatusCode)
        throw e
      }
    })
    .post('/:id/approve', zValidator('json', approveBodySchema), async (c) => {
      const blockId = decodeURIComponent(c.req.param('id'))
      const { author } = c.req.valid('json')
      try {
        await approveBlock(store.rootDir, store.getIndex(), blockId, { author })
        const next = await store.reload()
        const block = next.blocksById.get(blockId)
        if (!block) return c.json({ error: `ブロックが見つかりません: ${blockId}` }, 404)
        return c.json({ block }, 200)
      } catch (e) {
        if (e instanceof ReviewError) return c.json({ error: e.message }, e.status as ErrorStatusCode)
        throw e
      }
    })
    .post('/:id/feedback', zValidator('json', feedbackBodySchema), async (c) => {
      const blockId = decodeURIComponent(c.req.param('id'))
      const { body, author } = c.req.valid('json')
      try {
        const feedback = await addBlockFeedback(store.rootDir, store.getIndex(), blockId, body, author)
        const next = await store.reload()
        const block = next.blocksById.get(blockId)
        if (!block) return c.json({ error: `ブロックが見つかりません: ${blockId}` }, 404)
        return c.json({ feedback, block }, 201)
      } catch (e) {
        if (e instanceof ReviewError) return c.json({ error: e.message }, e.status as ErrorStatusCode)
        throw e
      }
    })
    .patch('/:id/feedback/:feedbackId', zValidator('json', feedbackPatchBodySchema), async (c) => {
      const blockId = decodeURIComponent(c.req.param('id'))
      const feedbackId = decodeURIComponent(c.req.param('feedbackId'))
      const { resolved } = c.req.valid('json')
      try {
        const feedback = await setFeedbackResolved(store.rootDir, blockId, feedbackId, resolved)
        const next = await store.reload()
        const block = next.blocksById.get(blockId)
        if (!block) return c.json({ error: `ブロックが見つかりません: ${blockId}` }, 404)
        return c.json({ feedback, block }, 200)
      } catch (e) {
        if (e instanceof ReviewError) return c.json({ error: e.message }, e.status as ErrorStatusCode)
        throw e
      }
    })
    .patch('/:id/stability', zValidator('json', stabilityPatchBodySchema), async (c) => {
      const blockId = decodeURIComponent(c.req.param('id'))
      const { stability } = c.req.valid('json')
      try {
        await setBlockStabilityOverride(store.rootDir, store.getIndex(), blockId, stability)
        const next = await store.reload()
        const block = next.blocksById.get(blockId)
        if (!block) return c.json({ error: `ブロックが見つかりません: ${blockId}` }, 404)
        return c.json({ block }, 200)
      } catch (e) {
        if (e instanceof ReviewError) return c.json({ error: e.message }, e.status as ErrorStatusCode)
        throw e
      }
    })
}
