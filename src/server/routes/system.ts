import { Hono } from 'hono'
import { z } from 'zod'
import { runDocsCheck } from '../../core/checker'
import { extractExportedSymbols, resolveSourceLines, resolveSourceSymbol } from '../../core/source'
import { sourceErrorToHttp } from '../errors'
import { PdfError, renderPdf, renderPdfFromUrl } from '../pdf'
import type { DocsStore } from '../store'
import { isLocalOrigin, zValidator, type ErrorStatusCode } from '../validator'

const checkQuerySchema = z.object({
  strict: z.enum(['true', 'false']).optional(),
})

const sourceQuerySchema = z
  .object({
    file: z.string().min(1, 'file parameter is required'),
    symbol: z.string().min(1).optional(),
    lines: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.symbol) !== Boolean(v.lines), {
    message: 'Specify exactly one of symbol or lines',
  })

const sourceExportsQuerySchema = z.object({
  file: z.string().min(1, 'file parameter is required'),
})

const exportPdfBodySchema = z.object({
  html: z.string().refine((v) => v.trim().length > 0, { message: 'html parameter is required' }),
  filename: z.string().optional(),
})

const exportBundlePdfBodySchema = z.object({
  scope: z.string().optional(),
  ids: z.array(z.string()).optional(),
  title: z.string().optional(),
  filename: z.string().optional(),
  baseUrl: z.string().optional(),
})

/** Content-Disposition に使うファイル名を安全な ASCII に制限する */
function safePdfFileName(value: unknown): string {
  const base = (typeof value === 'string' ? value : 'documi')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `${base || 'documi'}.pdf`
}

export function createSystemRoutes(store: DocsStore, projectRoot: string) {
  return (
    new Hono()
      .get('/health', (c) => c.json({ ok: true as const }, 200))
      .get('/check', zValidator('query', checkQuerySchema), async (c) => {
        const { strict } = c.req.valid('query')
        const report = await runDocsCheck({ docsDir: store.rootDir, projectRoot, strict: strict === 'true' })
        return c.json(
          {
            ok: report.ok,
            documentCount: report.documentCount,
            blockCount: report.blockCount,
            reviewCounts: report.reviewCounts,
            realizationCounts: report.realizationCounts,
            health: report.health,
            errors: report.errors,
            warnings: report.warnings,
          },
          200,
        )
      })
      .get('/status', (c) => {
        const index = store.getIndex()
        return c.json(
          {
            rootDir: index.rootDir,
            loadedAt: index.loadedAt,
            documentCount: index.documents.length,
            blockCount: index.blocksById.size,
            issues: index.issues,
          },
          200,
        )
      })
      .get('/source', zValidator('query', sourceQuerySchema), async (c) => {
        const { file, symbol, lines } = c.req.valid('query')
        const res = symbol
          ? await resolveSourceSymbol(projectRoot, file, symbol)
          : await resolveSourceLines(projectRoot, file, lines!)
        if (res.isErr()) {
          const http = sourceErrorToHttp(res.error)
          return c.json(http.body, http.status)
        }
        return c.json(res.value, 200)
      })
      .get('/source/exports', zValidator('query', sourceExportsQuerySchema), async (c) => {
        const { file } = c.req.valid('query')
        const res = await extractExportedSymbols(projectRoot, file)
        if (res.isErr()) {
          const http = sourceErrorToHttp(res.error)
          return c.json(http.body, http.status)
        }
        return c.json(res.value, 200)
      })
      // SSE: ファイル変更をブラウザへ即時通知する
      .get('/events', () => {
        const encoder = new TextEncoder()
        let unsubscribe: (() => void) | null = null
        let heartbeat: ReturnType<typeof setInterval> | null = null

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (chunk: string) => {
              try {
                controller.enqueue(encoder.encode(chunk))
              } catch {
                // ストリーム閉鎖済み
              }
            }
            send(`event: connected\ndata: ${JSON.stringify({ loadedAt: store.getIndex().loadedAt })}\n\n`)
            unsubscribe = store.subscribe((next) => {
              send(`event: reload\ndata: ${JSON.stringify({ loadedAt: next.loadedAt })}\n\n`)
            })
            heartbeat = setInterval(() => send(': ping\n\n'), 25000)
          },
          cancel() {
            if (heartbeat) clearInterval(heartbeat)
            unsubscribe?.()
          },
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        })
      })
      .post('/export/pdf', zValidator('json', exportPdfBodySchema), async (c) => {
        const { html, filename } = c.req.valid('json')
        try {
          const pdf = await renderPdf(html)
          const name = safePdfFileName(filename)
          return new Response(new Blob([pdf as BlobPart], { type: 'application/pdf' }), {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': `attachment; filename="${name}"`,
            },
          })
        } catch (e) {
          if (e instanceof PdfError) return c.json({ error: e.message }, e.status as ErrorStatusCode)
          throw e
        }
      })
      .post('/export/bundle-pdf', zValidator('json', exportBundlePdfBodySchema), async (c) => {
        const { scope, ids, title, filename, baseUrl: requestedBaseUrl } = c.req.valid('json')
        const originHeader = c.req.header('origin')
        const reqOrigin = new URL(c.req.url).origin
        const baseUrl =
          requestedBaseUrl && isLocalOrigin(requestedBaseUrl)
            ? requestedBaseUrl
            : originHeader && isLocalOrigin(originHeader)
              ? originHeader
              : reqOrigin

        const qs = new URLSearchParams()
        if (ids && ids.length > 0) qs.set('ids', ids.join(','))
        else qs.set('scope', scope || 'all')
        if (title) qs.set('title', title)
        qs.set('mode', 'pdf')

        const targetUrl = `${baseUrl.replace(/\/+$/, '')}/bundle?${qs.toString()}`
        try {
          const pdf = await renderPdfFromUrl(targetUrl)
          const name = safePdfFileName(filename ?? title ?? 'documi-bundle')
          return new Response(new Blob([pdf as BlobPart], { type: 'application/pdf' }), {
            headers: {
              'Content-Type': 'application/pdf',
              'Content-Disposition': `attachment; filename="${name}"`,
            },
          })
        } catch (e) {
          if (e instanceof PdfError) return c.json({ error: e.message }, e.status as ErrorStatusCode)
          throw e
        }
      })
  )
}
