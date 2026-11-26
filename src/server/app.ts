import { existsSync } from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/bun'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import type { RagConfig } from '../core/config'
import type { DocsIndex } from '../core/types'
import { handleMcpRequest } from './mcp'
import { createBlocksRoutes } from './routes/blocks'
import { createCodeRoutes } from './routes/code'
import { createDocumentsRoutes } from './routes/documents'
import { createGraphRoutes } from './routes/graph'
import { createIconsRoutes } from './routes/icons'
import { createMediaRoutes } from './routes/media'
import { createSystemRoutes } from './routes/system'
import { DocsStore } from './store'
import { isLocalOrigin, type ErrorStatusCode } from './validator'

export interface AppOptions {
  /** ビルド済みフロントエンド (dist) のパス。存在する場合のみ静的配信する */
  clientDist?: string
  /** SourceRef が参照できるプロジェクトルート。デフォルトは docs ディレクトリの親 */
  projectRoot?: string
  /** ローカル Hybrid RAG 設定（任意） */
  ragConfig?: RagConfig
}

function createApiApp(store: DocsStore, projectRoot: string, ragConfig?: RagConfig) {
  return new Hono()
    .basePath('/api')
    .route('/', createSystemRoutes(store, projectRoot))
    .route('/', createDocumentsRoutes(store, projectRoot, ragConfig))
    .route('/', createGraphRoutes(store))
    .route('/blocks', createBlocksRoutes(store))
    .route('/code', createCodeRoutes(store, projectRoot))
    .route('/icons', createIconsRoutes())
    .route('/media', createMediaRoutes(store))
}

/** Hono RPC (`hc<ApiRoutes>`) が参照する全 `/api/*` ルート型定義 */
export type ApiRoutes = ReturnType<typeof createApiApp>

export function createApp(source: DocsIndex | DocsStore, options: AppOptions = {}): Hono {
  const app = new Hono()
  const store = source instanceof DocsStore ? source : DocsStore.fromIndex(source)
  const projectRoot = options.projectRoot ?? path.dirname(store.rootDir)

  // /api はローカルツール前提。非ローカル Origin (CSRF / DNS rebinding 経由の外部ページ) はリクエスト自体を拒否する
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin')
    if (origin && !isLocalOrigin(origin)) {
      return c.json({ error: 'API access from this Origin is forbidden' }, 403)
    }
    await next()
  })
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

  // 不正な JSON ボディ等の HTTPException を /api/* では JSON 形式で返す
  app.onError((err, c) => {
    if (err instanceof HTTPException && c.req.path.startsWith('/api/')) {
      return c.json({ error: err.message }, err.status as ErrorStatusCode)
    }
    if (err instanceof HTTPException) {
      return err.getResponse()
    }
    console.error(err)
    return c.json({ error: 'Internal Server Error' }, 500)
  })

  app.route('/', createApiApp(store, projectRoot, options.ragConfig))

  // ブラウザ由来のクロスオリジン要求は拒否する (DNS rebinding / CSRF 対策)
  app.all('/mcp', async (c) => {
    const origin = c.req.header('origin')
    if (origin && !isLocalOrigin(origin)) {
      return c.json({ error: 'MCP access from this Origin is forbidden' }, 403)
    }
    return handleMcpRequest(store, c.req.raw, projectRoot, options.ragConfig)
  })

  const dist = options.clientDist ? path.resolve(options.clientDist) : undefined
  if (dist && existsSync(dist)) {
    app.use('/*', serveStatic({ root: dist }))
    app.get('*', serveStatic({ root: dist, path: 'index.html' }))
  }

  return app
}
