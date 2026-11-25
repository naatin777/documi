import { Hono } from 'hono'
import { z } from 'zod'
import { buildCodeTree, readCodeFile } from '../../core/code'
import { codeFileErrorToHttp } from '../errors'
import type { DocsStore } from '../store'
import { zValidator } from '../validator'

const codeFileQuerySchema = z.object({
  path: z.string().min(1, 'path parameter is required'),
})

export function createCodeRoutes(store: DocsStore, projectRoot: string) {
  return new Hono()
    .get('/tree', async (c) => {
      const result = await buildCodeTree(projectRoot, store.getIndex())
      return c.json(result, 200)
    })
    .get('/file', zValidator('query', codeFileQuerySchema), async (c) => {
      const { path: filePath } = c.req.valid('query')
      const res = await readCodeFile(projectRoot, store.getIndex(), filePath)
      if (res.isErr()) {
        const http = codeFileErrorToHttp(res.error)
        return c.json(http.body, http.status)
      }
      return c.json(res.value, 200)
    })
}
