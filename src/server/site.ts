import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CodeTreeNode } from '../core/code'
import type { DocumentHistory, DocTreeNode } from '../core/types'
import { createApp } from './app'
import type { MaterialIconManifest } from './routes/icons'
import { DocsStore } from './store'

export interface BuildStaticSiteOptions {
  docsDir: string
  projectRoot?: string
  testReportPath?: string
  outDir: string
  clientDist?: string
  /** アセット参照のベースパス（既定: "./" の相対パス） */
  basePath?: string
  /** Code Explorer 用のソースコード全文および <SourceRef> スニペットを含めるか（既定: true） */
  includeCode?: boolean
  /** 各ドキュメントで同梱する過去コミット版の最大件数（既定: 5） */
  maxRevisions?: number
}

export interface BuildStaticSiteResult {
  outDir: string
  documentCount: number
  revisionCount: number
  codeFileCount: number
  sourceSnippetCount: number
  iconCount: number
}

export interface StaticSearchEntry {
  kind: 'doc' | 'block'
  id: string
  docId: string
  type: string
  title: string
  tags: string[]
  blockKind?: string
  text: string
}

const STATIC_HEADERS_FILE = `# Cloudflare Pages / Netlify cache headers (ignored by hosts that do not use _headers)
/assets/*
  Cache-Control: public, max-age=31536000, immutable

/index.html
  Cache-Control: public, max-age=0, must-revalidate

/404.html
  Cache-Control: public, max-age=0, must-revalidate

/data/*
  Cache-Control: public, max-age=0, must-revalidate
`

function encodeDocPathSegments(docId: string): string {
  return docId
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
}

function normalizeBasePath(raw?: string): string {
  if (!raw || raw.trim() === '' || raw.trim() === './') return './'
  let normalized = raw.trim()
  if (!normalized.endsWith('/')) normalized += '/'
  return normalized
}

function sourceKey(params: { file: string; symbol?: string; lines?: string }): string {
  return `${params.file}|${params.symbol ?? ''}|${params.lines ?? ''}`
}

function stableHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

function collectUsedIcons(
  manifest: MaterialIconManifest,
  docTree: readonly DocTreeNode[],
  codeTree: readonly CodeTreeNode[],
): Set<string> {
  const icons = new Set<string>([manifest.file, manifest.folder, manifest.folderExpanded])

  const addFileIcons = (name: string) => {
    const base = (name.split('/').pop() ?? name).toLowerCase()
    if (manifest.fileNames[base]) icons.add(manifest.fileNames[base])
    if (manifest.light.fileNames[base]) icons.add(manifest.light.fileNames[base])
    const parts = base.split('.')
    for (let i = 1; i < parts.length; i++) {
      const ext = parts.slice(i).join('.')
      if (!ext) continue
      if (manifest.fileExtensions[ext]) icons.add(manifest.fileExtensions[ext])
      if (manifest.light.fileExtensions[ext]) icons.add(manifest.light.fileExtensions[ext])
    }
  }

  const addFolderIcons = (name: string) => {
    const lower = name.toLowerCase()
    if (manifest.folderNames[lower]) icons.add(manifest.folderNames[lower])
    if (manifest.light.folderNames[lower]) icons.add(manifest.light.folderNames[lower])
    if (manifest.folderNamesExpanded[lower]) icons.add(manifest.folderNamesExpanded[lower])
    if (manifest.light.folderNamesExpanded[lower]) icons.add(manifest.light.folderNamesExpanded[lower])
  }

  const walkDocs = (nodes: readonly DocTreeNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'dir') {
        addFolderIcons(n.name)
        walkDocs(n.children)
      } else {
        addFileIcons(n.doc.path)
      }
    }
  }

  const walkCode = (nodes: readonly CodeTreeNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'dir') {
        addFolderIcons(n.name)
        walkCode(n.children)
      } else {
        addFileIcons(n.file.path)
      }
    }
  }

  walkDocs(docTree)
  walkCode(codeTree)
  return icons
}

function collectCodeFilePaths(nodes: readonly CodeTreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === 'dir') {
      collectCodeFilePaths(node.children, out)
    } else {
      out.push(node.file.path)
    }
  }
  return out
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(data), 'utf-8')
}

async function fetchJson<T>(app: ReturnType<typeof createApp>, urlPath: string): Promise<T | null> {
  const res = await app.request(urlPath)
  if (!res.ok) return null
  return (await res.json()) as T
}

/**
 * Vite が既定 base="/" で出力した CSS 内フォント URL と preload-helper のルート固定 "/" を
 * 任意のサブパス・全静的ホスティング（Cloudflare Pages / Vercel / Netlify / GitHub Pages / S3 等）で動作するよう書き換える。
 */
async function rewriteCopiedAssetsForStaticHosting(outDir: string): Promise<void> {
  const assetsDir = path.join(outDir, 'assets')
  if (!existsSync(assetsDir)) return

  const entries = await readdir(assetsDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const filePath = path.join(assetsDir, entry.name)
    if (entry.name.endsWith('.css')) {
      const css = await readFile(filePath, 'utf-8')
      const next = css
        .replaceAll('url(/assets/', 'url(./')
        .replaceAll('url("/assets/', 'url("./')
        .replaceAll("url('/assets/", "url('./")
      if (next !== css) {
        await writeFile(filePath, next, 'utf-8')
      }
    } else if (entry.name.startsWith('preload-helper-') && entry.name.endsWith('.js')) {
      const js = await readFile(filePath, 'utf-8')
      const baseExpr = '((window.__DOCUMI_STATIC__&&window.__DOCUMI_STATIC__.basePath)||"./")'
      const next = js.replace(/return\s*(?:`\/`|"\/"|'\/')\s*\+/g, `return ${baseExpr}+`)
      if (next !== js) {
        await writeFile(filePath, next, 'utf-8')
      }
    }
  }
}

// @implements core.static-site
/**
 * ビルド済み Web UI と事前計算した API JSON 一式を、プロバイダ非依存の静的サイトディレクトリへ書き出す。
 * Cloudflare Pages / Workers Static Assets / Vercel / Netlify / GitHub Pages / S3 等の任意の静的ホスティング上で読み取り専用 Documi をサーバーレス動作させられる。
 */
export async function buildStaticSite(options: BuildStaticSiteOptions): Promise<BuildStaticSiteResult> {
  const docsDir = path.resolve(options.docsDir)
  const projectRoot = path.resolve(options.projectRoot ?? path.dirname(docsDir))
  const outDir = path.resolve(options.outDir)
  const clientDist = path.resolve(options.clientDist ?? path.resolve(import.meta.dir, '../../dist'))
  const basePath = normalizeBasePath(options.basePath)
  const includeCode = options.includeCode !== false
  const maxRevisions = Math.max(0, Math.min(options.maxRevisions ?? 5, 20))

  const distIndexPath = path.join(clientDist, 'index.html')
  if (!existsSync(distIndexPath)) {
    throw new Error(
      `ビルド済みフロントエンドが見つかりません (${clientDist})。先に "bun run build" を実行してください。`,
    )
  }

  const store = await DocsStore.open(docsDir, {
    projectRoot,
    testReportPath: options.testReportPath,
  })
  const app = createApp(store, { projectRoot })
  const index = store.getIndex()

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  await cp(clientDist, outDir, { recursive: true })
  await rewriteCopiedAssetsForStaticHosting(outDir)
  await writeFile(path.join(outDir, '.nojekyll'), '', 'utf-8')
  await writeFile(path.join(outDir, '_headers'), STATIC_HEADERS_FILE, 'utf-8')

  const dataDir = path.join(outDir, 'data')
  await mkdir(dataDir, { recursive: true })

  // 1. 主要エンドポイントの JSON をインメモリ Hono から直接生成（API スキーマと完全一致）
  const endpoints: readonly [string, string][] = [
    ['/api/status', 'status.json'],
    ['/api/overview', 'overview.json'],
    ['/api/tree', 'tree.json'],
    ['/api/documents', 'documents.json'],
    ['/api/terms', 'terms.json'],
    ['/api/blocks', 'blocks.json'],
    ['/api/matrix', 'matrix.json'],
    ['/api/graph?layers=all&granularity=docs', 'graph-all-docs.json'],
    ['/api/graph?layers=all&granularity=blocks', 'graph-all-blocks.json'],
    ['/api/graph?layers=trace&granularity=docs', 'graph-trace-docs.json'],
    ['/api/graph?layers=trace&granularity=blocks', 'graph-trace-blocks.json'],
  ]

  let docTree: DocTreeNode[] = []
  for (const [urlPath, fileName] of endpoints) {
    const payload = await fetchJson<Record<string, unknown>>(app, urlPath)
    if (payload) {
      if (fileName === 'tree.json' && Array.isArray(payload.tree)) {
        docTree = payload.tree as DocTreeNode[]
      }
      await writeJson(path.join(dataDir, fileName), payload)
    }
  }

  // 2. 各ドキュメント詳細・履歴・過去コミット版・stale ブロック Diff
  let revisionCount = 0
  const searchEntries: StaticSearchEntry[] = []

  for (const doc of index.documents) {
    const encodedId = encodeDocPathSegments(doc.id)
    const docPayload = await fetchJson<unknown>(app, `/api/documents/${encodedId}`)
    if (docPayload) {
      await writeJson(path.join(dataDir, 'documents', `${doc.id}.json`), docPayload)
    }

    searchEntries.push({
      kind: 'doc',
      id: doc.id,
      docId: doc.id,
      type: doc.type,
      title: doc.title,
      tags: doc.tags,
      text: `${doc.description}\n${doc.body}`.slice(0, 8000),
    })

    for (const block of doc.blocks) {
      searchEntries.push({
        kind: 'block',
        id: block.id,
        docId: doc.id,
        type: doc.type,
        title: block.title ?? block.id,
        tags: doc.tags,
        blockKind: block.kind,
        text: block.rawBody.slice(0, 2000),
      })

      if (block.review === 'stale') {
        const diffPayload = await fetchJson<unknown>(app, `/api/blocks/${encodeURIComponent(block.id)}/diff`)
        if (diffPayload) {
          await writeJson(path.join(dataDir, 'block-diffs', `${encodeURIComponent(block.id)}.json`), diffPayload)
        }
      }
    }

    const histPayload = await fetchJson<DocumentHistory>(app, `/api/history?id=${encodeURIComponent(doc.id)}`)
    if (histPayload) {
      await writeJson(path.join(dataDir, 'history', `${doc.id}.json`), histPayload)
      for (const commit of histPayload.commits.slice(0, maxRevisions)) {
        const revPayload = await fetchJson<unknown>(
          app,
          `/api/history/revision?id=${encodeURIComponent(doc.id)}&commit=${encodeURIComponent(commit.sha)}`,
        )
        if (revPayload) {
          await writeJson(path.join(dataDir, 'revisions', doc.id, `${commit.sha}.json`), revPayload)
          revisionCount++
        }
      }
    }
  }

  await writeJson(path.join(dataDir, 'search-index.json'), { entries: searchEntries })

  // 3. Code Explorer & <SourceRef> / <TermDef symbols> のスニペット
  // ファイル名に `[id].tsx` やドットファイル等を含んでいても全静的ホスティングで確実に配信できるようハッシュ索引で保存する
  let codeTree: CodeTreeNode[] = []
  let codeFileCount = 0
  let sourceSnippetCount = 0
  const codeFileIndex: Record<string, string> = {}
  const sourceIndex: Record<string, string> = {}

  if (includeCode) {
    const codeTreePayload = await fetchJson<{ tree: CodeTreeNode[] }>(app, '/api/code/tree')
    if (codeTreePayload) {
      codeTree = codeTreePayload.tree
      await writeJson(path.join(dataDir, 'code', 'tree.json'), codeTreePayload)

      for (const relFile of collectCodeFilePaths(codeTree)) {
        const filePayload = await fetchJson<unknown>(app, `/api/code/file?path=${encodeURIComponent(relFile)}`)
        if (filePayload) {
          const h = stableHash(relFile)
          codeFileIndex[relFile] = h
          await writeJson(path.join(dataDir, 'code', 'files', `${h}.json`), filePayload)
          codeFileCount++
        }
      }
    }

    // 文書内の全 SourceRef および TermDef symbols を事前解決
    const sourceQueries = new Map<string, { file: string; symbol?: string; lines?: string }>()
    for (const doc of index.documents) {
      for (const ref of doc.sourceRefs) {
        const params = { file: ref.file, symbol: ref.symbol, lines: ref.lines }
        sourceQueries.set(sourceKey(params), params)
      }
      for (const block of doc.blocks) {
        for (const symSpec of block.symbols ?? []) {
          const hashIdx = symSpec.indexOf('#')
          if (hashIdx <= 0) continue
          const file = symSpec.slice(0, hashIdx)
          const symbol = symSpec.slice(hashIdx + 1)
          const params = { file, symbol }
          sourceQueries.set(sourceKey(params), params)
        }
      }
    }

    for (const [key, params] of sourceQueries) {
      const qs = new URLSearchParams({ file: params.file })
      if (params.symbol) qs.set('symbol', params.symbol)
      if (params.lines) qs.set('lines', params.lines)
      const snippet = await fetchJson<unknown>(app, `/api/source?${qs.toString()}`)
      if (snippet) {
        const h = stableHash(key)
        sourceIndex[key] = h
        await writeJson(path.join(dataDir, 'sources', `${h}.json`), snippet)
        sourceSnippetCount++
      }
    }
  } else {
    await writeJson(path.join(dataDir, 'code', 'tree.json'), {
      totalFiles: 0,
      coveredFiles: 0,
      tree: [],
      files: [],
    })
  }
  await writeJson(path.join(dataDir, 'code', 'file-index.json'), codeFileIndex)
  await writeJson(path.join(dataDir, 'source-index.json'), sourceIndex)

  // 4. Material Icon Theme（実際に使用するアイコン SVG のみコピー）
  let iconCount = 0
  const manifest = await fetchJson<MaterialIconManifest>(app, '/api/icons/manifest')
  if (manifest) {
    await writeJson(path.join(dataDir, 'icons', 'manifest.json'), manifest)
    const usedIcons = collectUsedIcons(manifest, docTree, codeTree)
    const iconsDir = path.join(dataDir, 'icons')
    await mkdir(iconsDir, { recursive: true })
    for (const iconId of usedIcons) {
      const res = await app.request(`/api/icons/${encodeURIComponent(iconId)}.svg`)
      if (res.ok) {
        await writeFile(path.join(iconsDir, `${iconId}.svg`), await res.text(), 'utf-8')
        iconCount++
      }
    }
  }

  // 5. index.html / 404.html に静的モード設定を注入し、アセット参照をベースパス対応化
  const rawHtml = await readFile(distIndexPath, 'utf-8')
  const staticConfig = {
    mode: 'static' as const,
    basePath,
    includeCode,
    generatedAt: new Date().toISOString(),
  }
  const bootScript = `<script>window.__DOCUMI_STATIC__=${JSON.stringify(staticConfig)};</script>`
  const rewrittenHtml = rawHtml
    .replaceAll('src="/assets/', `src="${basePath}assets/`)
    .replaceAll('href="/assets/', `href="${basePath}assets/`)
    .replaceAll('href="/favicon.svg"', `href="${basePath}favicon.svg"`)
    .replace('</head>', `  ${bootScript}\n  </head>`)

  await writeFile(path.join(outDir, 'index.html'), rewrittenHtml, 'utf-8')
  await writeFile(path.join(outDir, '404.html'), rewrittenHtml, 'utf-8')

  return {
    outDir,
    documentCount: index.documents.length,
    revisionCount,
    codeFileCount,
    sourceSnippetCount,
    iconCount,
  }
}
