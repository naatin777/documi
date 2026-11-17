import path from 'node:path'
import { loadDocuments } from '../core/loader'
import { createApp } from './app'

function parseDocsDir(): string {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--docs' && args[i + 1]) return path.resolve(args[i + 1]!)
    if (arg.startsWith('--docs=')) return path.resolve(arg.slice('--docs='.length))
  }
  if (process.env.DOCUMI_DOCS_DIR) return path.resolve(process.env.DOCUMI_DOCS_DIR)
  return path.resolve(process.cwd(), 'docs')
}

const docsDir = parseDocsDir()
const index = await loadDocuments(docsDir)
const app = createApp(index, { clientDist: path.resolve(process.cwd(), 'dist') })

const port = Number(process.env.PORT ?? 3000)
// ローカル利用前提のためデフォルトは loopback のみ。外部公開する場合は HOST=0.0.0.0 を明示する
const hostname = process.env.HOST ?? '127.0.0.1'

Bun.serve({
  port,
  fetch: app.fetch,
  hostname,
})

console.log(`Documi server listening on http://${hostname}:${port}`)
console.log(`  docs: ${index.rootDir}`)
console.log(`  documents: ${index.documents.length}`)
if (index.issues.length > 0) {
  console.log(`  issues: ${index.issues.length} (see /api/status)`)
}
console.log(`  web UI: http://localhost:${port}/`)
console.log(`  MCP:    http://localhost:${port}/mcp`)
