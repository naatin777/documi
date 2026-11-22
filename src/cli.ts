#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs as parseNodeArgs } from 'node:util'
import { runDocsCheck } from './core/checker'
import { loadDocuments } from './core/loader'
import { approveBlock, ReviewError } from './core/reviews'
import { createApp } from './server/app'
import { startServer } from './server/index'
import { startMcpStdio } from './server/mcp'
import { PdfError, renderPdfFromUrl, renderStandaloneHtmlFromUrl } from './server/pdf'
import { DocsStore } from './server/store'

function usage(): void {
  console.log(`Documi CLI

Usage:
  documi init [options]                新規プロジェクト向け docs/ 雛形を生成
  documi serve [options]               Web UI・REST API・MCP (HTTP) サーバーを起動
  documi mcp [options]                 MCP サーバーを stdio モードで起動 (AI エディタ連携用)
  documi check [options]               ドキュメント・グラフ・ASTシンボル・テスト結果を一括検証
  documi approve <block-id...> [opts]  指定したセマンティックブロックを承認 (reviews.json を更新)
  documi export [options]              複数ドキュメントを 1 冊の PDF / HTML にまとめて出力

Options:
  --docs <dir>         docs ディレクトリ (既定: ./docs または DOCUMI_DOCS_DIR)
  --project <dir>      プロジェクトルート (既定: docs の親ディレクトリまたは DOCUMI_PROJECT_ROOT)
  --port <number>      待ち受けポート (serve 用、既定: 3000 または PORT)
  --host <addr>        バインドアドレス (serve 用、既定: 127.0.0.1 または HOST)
  --test-report <xml>  JUnit XML テストレポートのパス (check 用)
  --strict             未承認・stale・suspect・drifted もエラー扱いにする (check 用)
  --no-review-edit     reviews.json が Git 上で変更されていたらエラーにする (check 用)
  --prs                gh CLI から PR 情報も取得して紐づける (check 用)
  --author <name>      承認者名 (approve 用)
  --format <pdf|html>  出力形式 (export 用、既定: pdf)
  --scope <scope>      出力対象 all | dir:<path> | goal:<id> (export 用、既定: all)
  --ids <a,b,c>        出力するドキュメント ID をカンマ区切りで指定 (export 用)
  --title <text>       表紙タイトル (export 用)
  --out <file>         出力先ファイルパス (export 用、既定: documi-bundle.pdf|html)
  --json               JSON 形式で結果を出力 (check 用)
  -h, --help           ヘルプを表示`)
}

const CLI_OPTIONS = {
  docs: { type: 'string' },
  project: { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  'test-report': { type: 'string' },
  author: { type: 'string' },
  format: { type: 'string' },
  scope: { type: 'string' },
  ids: { type: 'string' },
  title: { type: 'string' },
  out: { type: 'string' },
  strict: { type: 'boolean' },
  'no-review-edit': { type: 'boolean' },
  prs: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

type CliFlags = Partial<Record<keyof typeof CLI_OPTIONS, string | boolean>>

interface ParsedArgs {
  command?: string
  positionals: string[]
  flags: CliFlags
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const { values, positionals } = parseNodeArgs({
    args: argv,
    options: CLI_OPTIONS,
    allowPositionals: true,
    strict: false,
  })
  return {
    command: positionals[0],
    positionals: positionals.slice(1),
    flags: values as CliFlags,
  }
}

function resolveDocsDir(flags: Record<string, string | boolean>): string {
  if (typeof flags.docs === 'string') return path.resolve(flags.docs)
  if (process.env.DOCUMI_DOCS_DIR) return path.resolve(process.env.DOCUMI_DOCS_DIR)
  return path.resolve(process.cwd(), 'docs')
}

function resolveProjectRoot(flags: Record<string, string | boolean>, docsDir: string): string {
  if (typeof flags.project === 'string') return path.resolve(flags.project)
  if (process.env.DOCUMI_PROJECT_ROOT) return path.resolve(process.env.DOCUMI_PROJECT_ROOT)
  return path.dirname(docsDir)
}

const INIT_TEMPLATES: Record<string, string> = {
  'goals/project-goal.mdx': `---
type: goal
title: プロジェクト目標
description: このプロジェクトが解決したい課題と達成したい状態
tags: [goal]
---

# プロジェクト目標

ここに「なぜこのシステムを作るのか」「誰の何を解決するのか」を記述します。
すべての \`normative\` な \`<Spec>\` は \`derives\` でこの Goal に接続します。
`,
  'domain/glossary.mdx': `---
type: domain
title: ドメイン用語集
description: 人間と AI が共有するユビキタス言語とコードシンボルの対応表
tags: [domain, glossary]
---

# ドメイン用語集

<TermDef id="ExampleTerm" aliases="サンプル用語">
  プロジェクト内で繰り返し使う主要概念を定義します。\`symbols="src/example.ts#Example"\` を付けるとホバー時に実コードも表示されます。
</TermDef>
`,
  'decisions/first-decision.mdx': `---
type: decision
title: 初期アーキテクチャ方針
description: 主要な技術選定とトレードオフの記録
date: ${new Date().toISOString().slice(0, 10)}
tags: [adr]
---

# 初期アーキテクチャ方針

<Outcome id="dec.initial-architecture" stability="evolving">
  決定した結論を 2〜3 行で簡潔に記述します。AI への常時コンテキストとして優先投入されます。
</Outcome>

## 背景・比較検討

ここに選択肢の比較やトレードオフの詳細を残します。
`,
  'specs/example.mdx': `---
type: spec
title: サンプル機能仕様
description: 最初の仕様テンプレート
tags: [spec]
derives:
  - goals/project-goal
---

# サンプル機能仕様

<Spec id="example.behavior" stability="evolving">
  **When** ユーザーが対象操作を行ったとき、
  **the** システム **shall** 期待される結果を返す。
</Spec>
`,
}

async function cmdInit(flags: Record<string, string | boolean>): Promise<number> {
  const docsDir = resolveDocsDir(flags)
  const created: string[] = []
  const skipped: string[] = []

  for (const [rel, content] of Object.entries(INIT_TEMPLATES)) {
    const abs = path.join(docsDir, rel)
    if (existsSync(abs)) {
      skipped.push(rel)
      continue
    }
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf-8')
    created.push(rel)
  }

  console.log(`Documi Init: ${docsDir}`)
  for (const rel of created) console.log(`  + created ${rel}`)
  for (const rel of skipped) console.log(`  - skipped ${rel} (already exists)`)
  console.log('\n推奨 .gitignore 設定:')
  console.log('  docs/.documi/cache/')
  console.log('  docs/.documi/test-results.xml')
  console.log('\n次のステップ:')
  console.log('  documi check')
  console.log('  documi serve')
  return 0
}

async function cmdServe(flags: Record<string, string | boolean>): Promise<number> {
  const docsDir = resolveDocsDir(flags)
  const projectRoot = resolveProjectRoot(flags, docsDir)
  const port = typeof flags.port === 'string' ? Number(flags.port) : undefined
  const hostname = typeof flags.host === 'string' ? flags.host : undefined

  await startServer({
    docsDir,
    projectRoot,
    port: Number.isFinite(port) ? port : undefined,
    hostname,
  })
  // サーバー稼働中は終了させない
  await new Promise(() => {})
  return 0
}

async function cmdMcp(flags: Record<string, string | boolean>): Promise<number> {
  const docsDir = resolveDocsDir(flags)
  const projectRoot = resolveProjectRoot(flags, docsDir)
  const store = await DocsStore.open(docsDir, { projectRoot })
  const stopWatch = store.watch()

  process.on('SIGINT', () => {
    stopWatch()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    stopWatch()
    process.exit(0)
  })

  await startMcpStdio(store, projectRoot)
  // stdio 接続が閉じるまで待機
  await new Promise(() => {})
  return 0
}

async function cmdCheck(flags: Record<string, string | boolean>): Promise<number> {
  const docsDir = resolveDocsDir(flags)
  const projectRoot = resolveProjectRoot(flags, docsDir)
  const testReportPath = typeof flags['test-report'] === 'string' ? flags['test-report'] : undefined

  const report = await runDocsCheck({
    docsDir,
    projectRoot,
    testReportPath,
    strict: flags.strict === true,
    noReviewEdit: flags['no-review-edit'] === true,
    fetchPrs: flags.prs === true,
  })

  if (flags.json === true) {
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          docsDir: report.docsDir,
          documentCount: report.documentCount,
          blockCount: report.blockCount,
          reviewCounts: report.reviewCounts,
          realizationCounts: report.realizationCounts,
          errors: report.errors,
          warnings: report.warnings,
        },
        null,
        2,
      ),
    )
    return report.ok ? 0 : 1
  }

  console.log(`Documi Check: ${report.docsDir}`)
  console.log(`  documents:   ${report.documentCount} (${report.blockCount} blocks)`)
  console.log(
    `  reviews:     approved=${report.reviewCounts.approved} unreviewed=${report.reviewCounts.unreviewed} stale=${report.reviewCounts.stale} suspect=${report.reviewCounts.suspect}`,
  )
  console.log(
    `  realization: verified=${report.realizationCounts.verified} implemented=${report.realizationCounts.implemented} in-progress=${report.realizationCounts['in-progress']} unimplemented=${report.realizationCounts.unimplemented} drifted=${report.realizationCounts.drifted}`,
  )

  if (report.warnings.length > 0) {
    console.log(`\nWarnings (${report.warnings.length}):`)
    for (const w of report.warnings) {
      console.log(`  ⚠ [${w.code}] ${w.path ? `${w.path}: ` : ''}${w.message}`)
    }
  }

  if (report.errors.length > 0) {
    console.log(`\nErrors (${report.errors.length}):`)
    for (const e of report.errors) {
      console.log(`  ✗ [${e.code}] ${e.path ? `${e.path}: ` : ''}${e.message}`)
    }
  }

  console.log(report.ok ? '\n✓ Check passed' : `\n✗ Check failed (${report.errors.length} errors)`)
  return report.ok ? 0 : 1
}

async function cmdApprove(ids: string[], flags: Record<string, string | boolean>): Promise<number> {
  if (ids.length === 0) {
    console.error('承認するブロック ID を 1 つ以上指定してください (例: documi approve auth.lockout)')
    return 1
  }
  const docsDir = resolveDocsDir(flags)
  const author = typeof flags.author === 'string' ? flags.author : undefined
  const index = await loadDocuments(docsDir)

  let failed = 0
  for (const id of ids) {
    try {
      const rec = await approveBlock(docsDir, index, id, { author })
      console.log(`✓ Approved ${id} (${rec.hash.slice(0, 19)}… by ${rec.approvedBy ?? 'human'})`)
    } catch (e) {
      const msg = e instanceof ReviewError ? e.message : String(e)
      console.error(`✗ ${id}: ${msg}`)
      failed++
    }
  }
  return failed > 0 ? 1 : 0
}

async function cmdExport(flags: Record<string, string | boolean>): Promise<number> {
  const format = flags.format === 'html' ? 'html' : 'pdf'
  const docsDir = resolveDocsDir(flags)
  const projectRoot = resolveProjectRoot(flags, docsDir)
  const clientDist = path.resolve(import.meta.dir, '../dist')
  if (!existsSync(clientDist)) {
    console.error(`ビルド済みフロントエンドが見つかりません (${clientDist})。先に "bun run build" を実行してください。`)
    return 1
  }

  const outPath = path.resolve(typeof flags.out === 'string' ? flags.out : `documi-bundle.${format}`)
  const store = await DocsStore.open(docsDir, { projectRoot })
  const app = createApp(store, { clientDist, projectRoot })
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch })

  try {
    const qs = new URLSearchParams()
    if (typeof flags.ids === 'string' && flags.ids.trim()) qs.set('ids', flags.ids.trim())
    else qs.set('scope', typeof flags.scope === 'string' ? flags.scope : 'all')
    if (typeof flags.title === 'string' && flags.title.trim()) qs.set('title', flags.title.trim())
    qs.set('mode', format)

    const url = `http://127.0.0.1:${server.port}/bundle?${qs.toString()}`
    await mkdir(path.dirname(outPath), { recursive: true })

    if (format === 'pdf') {
      const bytes = await renderPdfFromUrl(url)
      await writeFile(outPath, bytes)
    } else {
      const html = await renderStandaloneHtmlFromUrl(url)
      await writeFile(outPath, html, 'utf-8')
    }

    console.log(`✓ Exported ${format.toUpperCase()} → ${outPath}`)
    return 0
  } catch (e) {
    const msg = e instanceof PdfError ? e.message : String(e)
    console.error(`✗ Export 失敗: ${msg}`)
    return 1
  } finally {
    void server.stop(true)
  }
}

async function main(): Promise<void> {
  const { command, positionals, flags } = parseCliArgs(process.argv.slice(2))
  if (flags.help || !command) {
    usage()
    process.exit(command ? 0 : 1)
  }

  if (command === 'init') {
    process.exit(await cmdInit(flags))
  }
  if (command === 'serve') {
    process.exit(await cmdServe(flags))
  }
  if (command === 'mcp') {
    process.exit(await cmdMcp(flags))
  }
  if (command === 'check') {
    process.exit(await cmdCheck(flags))
  }
  if (command === 'approve') {
    process.exit(await cmdApprove(positionals, flags))
  }
  if (command === 'export') {
    process.exit(await cmdExport(flags))
  }

  console.error(`不明なコマンドです: ${command}`)
  usage()
  process.exit(1)
}

void main()
