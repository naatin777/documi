import path from 'node:path'
import { resolveProjectPaths } from '../core/config'
import type { RagConfig } from '../core/config'
import { createApp } from './app'
import { DocsStore } from './store'

export interface ServerStartOptions {
  docsDir: string
  projectRoot?: string
  testReportPath?: string
  ragConfig?: RagConfig
  port?: number
  hostname?: string
  clientDist?: string
}

/**
 * Documi HTTP サーバー（Web UI・REST API・SSE・Streamable HTTP MCP）を起動する。
 */
export async function startServer(options: ServerStartOptions): Promise<{ stop: () => void; port: number }> {
  const docsDir = path.resolve(options.docsDir)
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : path.dirname(docsDir)
  const port = options.port ?? Number(process.env.PORT ?? 3000)
  // ローカル利用前提のためデフォルトは loopback のみ。外部公開する場合は HOST=0.0.0.0 を明示する
  const hostname = options.hostname ?? process.env.HOST ?? '127.0.0.1'
  const clientDist = options.clientDist ?? path.resolve(import.meta.dir, '../../dist')

  const store = await DocsStore.open(docsDir, { projectRoot, testReportPath: options.testReportPath })
  const stopWatch = store.watch()
  const app = createApp(store, { clientDist, projectRoot, ragConfig: options.ragConfig })

  const server = Bun.serve({
    port,
    fetch: app.fetch,
    hostname,
  })

  const stop = () => {
    stopWatch()
    void server.stop(true)
  }

  process.on('SIGINT', () => {
    stop()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    stop()
    process.exit(0)
  })

  const index = store.getIndex()
  const docIssueCount = index.documents.reduce((sum, d) => sum + d.issues.length, 0)
  const actualPort = server.port ?? port
  console.log(`Documi server listening on http://${hostname}:${actualPort}`)
  console.log(`  docs:      ${index.rootDir} (watching)`)
  console.log(`  project:   ${projectRoot}`)
  console.log(`  documents: ${index.documents.length} (${index.blocksById.size} blocks, ${index.edges.length} edges)`)
  if (index.issues.length + docIssueCount > 0) {
    console.log(`  issues:    ${index.issues.length} index / ${docIssueCount} document (see /api/overview)`)
  }
  console.log(`  web UI:    http://localhost:${actualPort}/`)
  console.log(`  MCP:       http://localhost:${actualPort}/mcp`)

  return { stop, port: actualPort }
}

function parseFlag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === `--${name}` && args[i + 1]) return args[i + 1]!
    if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3)
  }
  return undefined
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const docsFlag = parseFlag(args, 'docs')
  const projectFlag = parseFlag(args, 'project')
  const testReportFlag = parseFlag(args, 'test-report')
  const portFlag = parseFlag(args, 'port')
  const hostFlag = parseFlag(args, 'host')

  const resolvedRes = resolveProjectPaths({
    docs: docsFlag,
    project: projectFlag,
    testReport: testReportFlag,
  })
  if (resolvedRes.isErr()) {
    console.error(`✗ ${resolvedRes.error.message}`)
    process.exit(1)
  }
  const resolved = resolvedRes.value
  const port = portFlag ? Number(portFlag) : undefined

  await startServer({
    docsDir: resolved.docsDir,
    projectRoot: resolved.projectRoot,
    testReportPath: resolved.testReportPath,
    ragConfig: resolved.config.rag,
    port: Number.isFinite(port) ? port : undefined,
    hostname: hostFlag,
  })
}
