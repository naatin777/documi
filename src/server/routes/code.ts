import { Hono } from 'hono'
import { z } from 'zod'
import { buildCodeTree, readCodeFile } from '../../core/code'
import { SourceError } from '../../core/source'
import type { DocsStore } from '../store'
import { zValidator, type ErrorStatusCode } from '../validator'

const codeFileQuerySchema = z.object({
  path: z.string().min(1, 'path パラメータが必要です'),
})

export function createCodeRoutes(store: DocsStore, projectRoot: string) {
  return new Hono()
    .get('/tree', async (c) => {
      const result = await buildCodeTree(projectRoot, store.getIndex())
      return c.json(result, 200)
    })
    .get('/file', zValidator('query', codeFileQuerySchema), async (c) => {
      const { path: filePath } = c.req.valid('query')
      try {
        const result = await readCodeFile(projectRoot, store.getIndex(), filePath)
        return c.json(result, 200)
      } catch (e) {
        if (e instanceof SourceError) return c.json({ error: e.message }, e.status as ErrorStatusCode)
        throw e
      }
    })
}
