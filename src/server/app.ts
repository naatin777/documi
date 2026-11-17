import { existsSync } from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/bun'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ID_PATTERN, isArtifactType } from '../core/types'
import type { DocsIndex } from '../core/types'
import { getDocument } from '../core/loader'
import { resolveSourceLines, resolveSourceSymbol, SourceError } from '../core/source'
import { handleMcpRequest } from './mcp'
import { PdfError, renderPdf } from './pdf'

export interface AppOptions {
  /** ビルド済みフロントエンド (dist) のパス。存在する場合のみ静的配信する */
  clientDist?: string
  /** SourceRef が参照できるプロジェクトルート。デフォルトは docs ディレクトリの親 */
  projectRoot?: string
}

export function createApp(index: DocsIndex, options: AppOptions = {}): Hono {
  const app = new Hono()
  const projectRoot = options.projectRoot ?? path.dirname(index.rootDir)

  // /api はローカルツール前提。ブラウザからのクロスオリジン要求は Origin を検証する
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (origin === '' || isLocalOrigin(origin) ? origin : null),
    }),
  )
  app.use(
    '/mcp',
    cors({
      origin: (origin) => (origin === '' || isLocalOrigin(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version'],
      exposeHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    }),
  )

  app.get('/api/health', (c) => c.json({ ok: true }))

  app.get('/api/status', (c) =>
    c.json({
      rootDir: index.rootDir,
      documentCount: index.documents.length,
      issues: index.issues,
    }),
  )

  app.get('/api/documents', (c) => {
    const type = c.req.query('type')
    if (type !== undefined && !isArtifactType(type)) {
      return c.json({ error: `不正な type です: ${type}` }, 400)
    }
    const documents = index.documents
      .filter((d) => !type || d.type === type)
      .map((d) => ({
        ref: d.ref,
        type: d.type,
        id: d.id,
        title: d.title,
        description: d.description,
        status: d.status,
        path: d.path,
        format: d.format,
        issueCount: d.issues.length,
      }))
    return c.json({ documents })
  })

  app.get('/api/documents/:type/:id', (c) => {
    const { type, id } = c.req.param()
    if (!isArtifactType(type)) return c.json({ error: `不正な type です: ${type}` }, 400)
    if (!ID_PATTERN.test(id)) return c.json({ error: `不正な id です: ${id}` }, 400)
    const doc = getDocument(index, type, id)
    if (!doc) return c.json({ error: `ドキュメントが見つかりません: ${type}:${id}` }, 404)
    return c.json({ document: doc })
  })

  app.get('/api/glossary', (c) => {
    if (!index.glossary) return c.json({ error: 'glossary が見つかりません' }, 404)
    return c.json({ glossary: index.glossary })
  })

  app.get('/api/source', async (c) => {
    const file = c.req.query('file')
    const symbol = c.req.query('symbol')
    const lines = c.req.query('lines')
    if (!file) return c.json({ error: 'file パラメータが必要です' }, 400)
    if ((symbol && lines) || (!symbol && !lines)) {
      return c.json({ error: 'symbol または lines のどちらか一方を指定してください' }, 400)
    }
    try {
      const result = symbol
        ? await resolveSourceSymbol(projectRoot, file, symbol)
        : await resolveSourceLines(projectRoot, file, lines!)
      return c.json(result)
    } catch (e) {
      if (e instanceof SourceError) return c.json({ error: e.message }, e.status as ContentfulStatusCode)
      throw e
    }
  })

  app.post('/api/export/pdf', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'JSON ボディが必要です' }, 400)
    }
    if (typeof body !== 'object' || body === null) {
      return c.json({ error: 'JSON ボディが必要です' }, 400)
    }
    const { html } = body as { html?: unknown }
    if (typeof html !== 'string' || html.trim() === '') {
      return c.json({ error: 'html パラメータが必要です' }, 400)
    }
    try {
      const pdf = await renderPdf(html)
      const name = safePdfFileName((body as { filename?: unknown }).filename)
      return new Response(new Blob([pdf as BlobPart], { type: 'application/pdf' }), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${name}"`,
        },
      })
    } catch (e) {
      if (e instanceof PdfError) return c.json({ error: e.message }, e.status as ContentfulStatusCode)
      throw e
    }
  })

  // ブラウザ由来のクロスオリジン要求は拒否する (DNS rebinding / CSRF 対策)
  app.all('/mcp', async (c) => {
    const origin = c.req.header('origin')
    if (origin && !isLocalOrigin(origin)) {
      return c.json({ error: 'この Origin からの MCP アクセスは許可されていません' }, 403)
    }
    return handleMcpRequest(index, c.req.raw)
  })

  const dist = options.clientDist ? path.resolve(options.clientDist) : undefined
  if (dist && existsSync(dist)) {
    app.use('/*', serveStatic({ root: dist }))
    app.get('*', serveStatic({ root: dist, path: 'index.html' }))
  }

  return app
}

/** Content-Disposition に使うファイル名を安全な ASCII に制限する */
function safePdfFileName(value: unknown): string {
  const base = (typeof value === 'string' ? value : 'documi')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `${base || 'documi'}.pdf`
}

/** localhost / 127.0.0.1 / ::1 からの Origin のみ許可する */
function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}
