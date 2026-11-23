#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs as parseNodeArgs } from 'node:util'
import { runDocsCheck } from './core/checker'
import { ConfigError, resolveProjectPaths } from './core/config'
import {
  addBlockToDoc,
  EditError,
  renameBlockIdAcrossProject,
  scaffoldDocument,
  updateBlockInDocs,
  upsertTermInDocs,
} from './core/editor'
import { initDocumiProject } from './core/init'
import type { InitLanguage } from './core/init'
import { loadDocuments } from './core/loader'
import {
  buildProjectMap,
  buildValidationPayload,
  getDocumentDetail,
  getNodeRelations,
  getSpecContext,
  listDocuments,
  querySpecs,
  searchDocuments,
} from './core/query'
import { approveBlock, ReviewError } from './core/reviews'
import {
  ARTIFACT_TYPES,
  BLOCK_KINDS,
  isArtifactType,
  isNoteIntent,
  isReviewStatus,
  isSpecIntent,
  isStability,
  REALIZATION_STATUSES,
  REVIEW_STATUSES,
  SPEC_INTENTS,
  STABILITIES,
} from './core/types'
import type {
  ArtifactType,
  BlockKind,
  NoteIntent,
  RealizationStatus,
  ReviewStatus,
  SpecIntent,
  Stability,
} from './core/types'
import { createApp } from './server/app'
import { startServer } from './server/index'
import { startMcpStdio } from './server/mcp'
import { PdfError, renderPdfFromUrl, renderStandaloneHtmlFromUrl } from './server/pdf'
import { buildStaticSite } from './server/site'
import { DocsStore } from './server/store'

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
  readStdin: () => Promise<string>
}

const DEFAULT_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  readStdin: () => Bun.stdin.text(),
}

function usage(io: CliIo): void {
  io.out(`Documi CLI

Usage:
  documi init [options]                          新規・既存プロジェクト向け docs/ 雛形と Agent Skills を生成
  documi serve [options]                         Web UI・REST API・MCP (HTTP) サーバーを起動
  documi mcp [options]                           MCP サーバーを stdio モードで起動 (AI エディタ連携用)
  documi check [options]                         ドキュメント・グラフ・ASTシンボル・テスト結果を一括検証
  documi approve <block-id...> [opts]            指定したセマンティックブロックを承認 (reviews.json を更新)
  documi export [options]                        複数ドキュメントを 1 冊の PDF / HTML にまとめて出力
  documi build-site [options]                    任意の静的ホスティング向けに読み取り専用静的サイトを生成

  [AI & 人間向け 読み取り・検索コマンド (すべて --json 対応)]
  documi map [options]                           Goal / Architecture / Outcome / 用語 / 統計を一括取得
  documi list [--type <type>] [options]          ドキュメント一覧を取得
  documi show <doc-id> [options]                 ドキュメント本文・ブロック・関係・問題一覧を取得
  documi relations <id> [options]                ドキュメントまたはブロックの外向き・逆参照を取得
  documi search <query...> [options]             ドキュメントとセマンティックブロックを横断全文検索
  documi query [filters] [options]               セマンティックブロックを多軸フィルタ検索
  documi context <id> [options]                  Spec の上流 Goal・未解決 FB・関連文書・用語・SourceRef を集約

  [AI & 人間向け 精密編集コマンド (すべて --json 対応)]
  documi block add <doc-id> [options]            指定ドキュメントにセマンティックブロックを 1 件追記
  documi block update <block-id> [options]       既存セマンティックブロックの該当行範囲のみを安全に更新
  documi block rename <old-id> <new-id> [opts]   docs/ とコード・テストのブロック ID 参照を一括リネーム
  documi term upsert <term-id> [options]         用語集 (<TermDef>) を追加または更新
  documi scaffold <rel-path> --title <t> [opts]  規約通りの frontmatter 付き新規 .mdx を作成

Options:
  --project <dir>         プロジェクトルート (既定: cwd または DOCUMI_PROJECT_ROOT / --docs 指定時はその親)
  --docs <dir>            docs ディレクトリ (既定: 設定ファイルの docs または <project>/docs / DOCUMI_DOCS_DIR)
  --en / --ja             init で生成する Agent Skills・雛形の言語 (既定: en / --lang <en|ja> も可)
  --skills-dir <dir>      Agent Skills 出力先 (init 用、既定: <project>/.agents/skills)
  --skills-only           docs/ を作らず Agent Skills のみ生成 (init 用)
  --no-skills             Agent Skills を生成しない (init 用)
  --force-skills          既存の Documi SKILL.md を最新版で上書き更新 (init 用)
  --port <number>         待ち受けポート (serve 用、既定: 3000 または PORT)
  --host <addr>           バインドアドレス (serve 用、既定: 127.0.0.1 または HOST)
  --test-report <xml>     JUnit XML テストレポートのパス (check / map / query / context 用)
  --strict                未承認・stale・suspect・drifted もエラー扱いにする (check 用)
  --no-review-edit        reviews.json が Git 上で変更されていたらエラーにする (check 用)
  --prs                   gh CLI から PR 情報も取得して紐づける (check 用)
  --author <name>         承認者名 (approve 用)
  --type <type>           Artifact Type (list / search / scaffold 用)
  --limit <n>             最大返却件数 (search 用、既定: 20)
  --kind <kind>           ブロック種別 spec|constraint|outcome|note|term (query / block add 用)
  --intent <intent>       採用意思 normative|idea|rejected|informative (query / block 用)
  --stability <level>     安定度 stable|evolving|volatile (query / block 用)
  --review <status>       レビュー状態 unreviewed|approved|stale (query 用)
  --realization <status>  実装状態 unimplemented|in-progress|implemented|verified|drifted (query 用)
  --suspect               Suspect ブロックのみ抽出 (query 用、--no-suspect で除外)
  --has-feedback          未解決フィードバックありのみ抽出 (query 用、--no-feedback で除外)
  --q <text>              ID または本文のキーワード絞り込み (query 用)
  --id <block-id>         新規ブロック ID (block add 用)
  --body <text>           ブロック/文書本文 ("-" 指定で標準入力から読込)
  --body-file <file>      ブロック/文書本文を読み込むファイルパス
  --definition <text>     用語の定義本文 (term upsert 用、"-" で標準入力可)
  --after-heading <text>  挿入先の見出しテキスト (block add 用)
  --derives <a,b>         derives 参照をカンマ区切りで指定
  --supersedes <a,b>      supersedes 参照をカンマ区切りで指定
  --satisfies <a,b>       satisfies 参照をカンマ区切りで指定 (scaffold 用)
  --verifies <a,b>        verifies 参照をカンマ区切りで指定 (scaffold 用)
  --tags <a,b>            タグ一覧をカンマ区切りで指定 (scaffold 用)
  --description <text>    概要説明 (scaffold 用)
  --date <YYYY-MM-DD>     決定日 (scaffold 用)
  --scope <scope>         出力対象 (export 用) または Constraint の scope (block 用)
  --aliases <a,b>         用語の別名一覧をカンマ区切りで指定 (block / term 用)
  --symbols <a,b>         コードシンボル一覧をカンマ区切りで指定 (block / term 用)
  --doc <doc-id>          追加先の用語集ドキュメント ID (term upsert 用、既定: domain/glossary)
  --dry-run               変更予定一覧のみ確認 (block rename 用)
  --format <pdf|html>     出力形式 (export 用、既定: pdf)
  --ids <a,b,c>           出力するドキュメント ID をカンマ区切りで指定 (export 用)
  --title <text>          表紙タイトル (export) / 文書・ブロックタイトル (scaffold / block)
  --out <file>            出力先ファイル／ディレクトリ (export 既定: documi-bundle.pdf|html / build-site 既定: ./dist-site)
  --base <path>           静的サイトのアセットベースパス (build-site 用、既定: ./)
  --no-code               Code Explorer / ソーススニペットを含めずに書き出す (build-site 用)
  --revisions <n>         各文書で同梱する過去コミット版の最大件数 (build-site 用、既定: 5)
  --json                  JSON 形式で結果を出力
  --full                  map / query / context の JSON 出力を全文・詳細配列込みで展開
  -h, --help              ヘルプを表示`)
}

const CLI_OPTIONS = {
  docs: { type: 'string' },
  project: { type: 'string' },
  ja: { type: 'boolean' },
  en: { type: 'boolean' },
  lang: { type: 'string' },
  'skills-dir': { type: 'string' },
  'skills-only': { type: 'boolean' },
  'no-skills': { type: 'boolean' },
  'force-skills': { type: 'boolean' },
  port: { type: 'string' },
  host: { type: 'string' },
  'test-report': { type: 'string' },
  author: { type: 'string' },
  format: { type: 'string' },
  scope: { type: 'string' },
  ids: { type: 'string' },
  title: { type: 'string' },
  out: { type: 'string' },
  base: { type: 'string' },
  'no-code': { type: 'boolean' },
  revisions: { type: 'string' },
  strict: { type: 'boolean' },
  'no-review-edit': { type: 'boolean' },
  prs: { type: 'boolean' },
  type: { type: 'string' },
  limit: { type: 'string' },
  kind: { type: 'string' },
  intent: { type: 'string' },
  stability: { type: 'string' },
  review: { type: 'string' },
  realization: { type: 'string' },
  suspect: { type: 'boolean' },
  'no-suspect': { type: 'boolean' },
  'has-feedback': { type: 'boolean' },
  'no-feedback': { type: 'boolean' },
  q: { type: 'string' },
  id: { type: 'string' },
  body: { type: 'string' },
  'body-file': { type: 'string' },
  definition: { type: 'string' },
  'after-heading': { type: 'string' },
  derives: { type: 'string' },
  supersedes: { type: 'string' },
  satisfies: { type: 'string' },
  verifies: { type: 'string' },
  tags: { type: 'string' },
  description: { type: 'string' },
  date: { type: 'string' },
  aliases: { type: 'string' },
  symbols: { type: 'string' },
  doc: { type: 'string' },
  'dry-run': { type: 'boolean' },
  full: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

type CliFlags = Partial<Record<keyof typeof CLI_OPTIONS, string | boolean>>

interface ParsedArgs {
  command?: string
  positionals: string[]
  flags: CliFlags
}

class CliArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliArgError'
  }
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
    flags: values,
  }
}

function resolveCliPaths(flags: CliFlags) {
  return resolveProjectPaths({
    docs: typeof flags.docs === 'string' ? flags.docs : undefined,
    project: typeof flags.project === 'string' ? flags.project : undefined,
    testReport: typeof flags['test-report'] === 'string' ? flags['test-report'] : undefined,
  })
}

function getStringFlag(flags: CliFlags, key: keyof CliFlags): string | undefined {
  const value = flags[key]
  return typeof value === 'string' ? value : undefined
}

function parseCsvFlag(flags: CliFlags, key: keyof CliFlags): string[] | undefined {
  const raw = getStringFlag(flags, key)
  if (raw === undefined) return undefined
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return items
}

function isBlockKind(value: unknown): value is BlockKind {
  return typeof value === 'string' && (BLOCK_KINDS as readonly string[]).includes(value)
}

function isRealizationStatus(value: unknown): value is RealizationStatus {
  return typeof value === 'string' && (REALIZATION_STATUSES as readonly string[]).includes(value)
}

function parseOptionalArtifactType(flags: CliFlags): ArtifactType | undefined {
  const raw = getStringFlag(flags, 'type')
  if (raw === undefined) return undefined
  if (!isArtifactType(raw)) {
    throw new CliArgError(`不正な --type です: "${raw}" (有効値: ${ARTIFACT_TYPES.join(', ')})`)
  }
  return raw
}

function parseOptionalBlockKind(flags: CliFlags): BlockKind | undefined {
  const raw = getStringFlag(flags, 'kind')
  if (raw === undefined) return undefined
  if (!isBlockKind(raw)) {
    throw new CliArgError(`不正な --kind です: "${raw}" (有効値: ${BLOCK_KINDS.join(', ')})`)
  }
  return raw
}

function parseOptionalStability(flags: CliFlags): Stability | undefined {
  const raw = getStringFlag(flags, 'stability')
  if (raw === undefined) return undefined
  if (!isStability(raw)) {
    throw new CliArgError(`不正な --stability です: "${raw}" (有効値: ${STABILITIES.join(', ')})`)
  }
  return raw
}

function parseOptionalSpecIntent(flags: CliFlags): SpecIntent | undefined {
  const raw = getStringFlag(flags, 'intent')
  if (raw === undefined) return undefined
  if (!isSpecIntent(raw)) {
    throw new CliArgError(`不正な --intent です: "${raw}" (有効値: ${SPEC_INTENTS.join(', ')})`)
  }
  return raw
}

function parseOptionalBlockIntent(flags: CliFlags): SpecIntent | NoteIntent | undefined {
  const raw = getStringFlag(flags, 'intent')
  if (raw === undefined) return undefined
  if (!isSpecIntent(raw) && !isNoteIntent(raw)) {
    throw new CliArgError(`不正な --intent です: "${raw}" (有効値: normative, idea, rejected, informative)`)
  }
  return raw
}

function parseOptionalReviewStatus(flags: CliFlags): ReviewStatus | undefined {
  const raw = getStringFlag(flags, 'review')
  if (raw === undefined) return undefined
  if (!isReviewStatus(raw)) {
    throw new CliArgError(`不正な --review です: "${raw}" (有効値: ${REVIEW_STATUSES.join(', ')})`)
  }
  return raw
}

function parseOptionalRealizationStatus(flags: CliFlags): RealizationStatus | undefined {
  const raw = getStringFlag(flags, 'realization')
  if (raw === undefined) return undefined
  if (!isRealizationStatus(raw)) {
    throw new CliArgError(`不正な --realization です: "${raw}" (有効値: ${REALIZATION_STATUSES.join(', ')})`)
  }
  return raw
}

function resolveInitLanguage(flags: CliFlags): InitLanguage {
  const hasJa = flags.ja === true
  const hasEn = flags.en === true
  const langFlag = getStringFlag(flags, 'lang')?.trim().toLowerCase()

  if (hasJa && hasEn) {
    throw new CliArgError('--ja と --en は同時に指定できません')
  }
  if (langFlag !== undefined && langFlag !== 'en' && langFlag !== 'ja') {
    throw new CliArgError(`不正な --lang です: "${langFlag}" (有効値: en, ja)`)
  }
  if (hasJa && langFlag === 'en') {
    throw new CliArgError('--ja と --lang en は同時に指定できません')
  }
  if (hasEn && langFlag === 'ja') {
    throw new CliArgError('--en と --lang ja は同時に指定できません')
  }

  if (hasJa || langFlag === 'ja') return 'ja'
  return 'en'
}

async function resolveBodyContent(
  flags: CliFlags,
  io: CliIo,
  options: { allowDefinition?: boolean; required?: boolean } = {},
): Promise<string | undefined> {
  const bodyFile = getStringFlag(flags, 'body-file')
  const bodyFlag = getStringFlag(flags, 'body')
  const defFlag = options.allowDefinition ? getStringFlag(flags, 'definition') : undefined
  const inline = defFlag ?? bodyFlag

  if (bodyFile !== undefined && inline !== undefined) {
    throw new CliArgError('--body / --definition と --body-file は同時に指定できません')
  }
  if (bodyFile !== undefined) {
    return readFile(path.resolve(bodyFile), 'utf-8')
  }
  if (inline === '-') {
    return io.readStdin()
  }
  if (inline !== undefined) {
    return inline
  }
  if (options.required) {
    const label = options.allowDefinition ? '--definition または --body / --body-file' : '--body または --body-file'
    throw new CliArgError(`${label} を指定してください`)
  }
  return undefined
}

function printJson(io: CliIo, data: unknown): void {
  io.out(JSON.stringify(data, null, 2))
}

async function cmdInit(flags: CliFlags, io: CliIo): Promise<number> {
  const { docsDir, projectRoot } = resolveCliPaths(flags)
  const lang = resolveInitLanguage(flags)
  const skillsDir = typeof flags['skills-dir'] === 'string' ? path.resolve(flags['skills-dir']) : undefined
  const result = await initDocumiProject({
    docsDir,
    projectRoot,
    lang,
    skillsDir,
    skillsOnly: flags['skills-only'] === true,
    noSkills: flags['no-skills'] === true,
    forceSkills: flags['force-skills'] === true,
  })

  if (flags.json === true) {
    printJson(io, result)
    return 0
  }

  const relDocs = path.relative(projectRoot, docsDir).split(path.sep).join('/') || 'docs'
  if (flags['skills-only'] !== true) {
    io.out(`Documi Init (docs, lang=${result.lang}): ${result.docsDir}`)
    for (const rel of result.createdDocs) io.out(`  + created ${rel}`)
    for (const rel of result.skippedDocs) io.out(`  - skipped ${rel} (already exists)`)
  }
  if (flags['no-skills'] !== true) {
    io.out(`Documi Init (Agent Skills, lang=${result.lang}): ${result.skillsDir}`)
    for (const rel of result.createdSkills) io.out(`  + created ${rel}`)
    for (const rel of result.updatedSkills) io.out(`  ~ updated ${rel}`)
    for (const rel of result.skippedSkills) io.out(`  - skipped ${rel} (already exists)`)
  }
  io.out('\n推奨 .gitignore 設定:')
  io.out(`  ${relDocs}/.documi/cache/`)
  io.out(`  ${relDocs}/.documi/test-results.xml`)
  io.out('\nAI 連携方法（どちらでも単体で完結します）:')
  io.out('  1. CLI + Agent Skills (MCP 設定不要):')
  io.out('     .agents/skills/ のスキルが自動で読み込まれ、documi map / search / query / context / block を利用します')
  io.out('  2. MCP Server (Skill 不要・instructions 内蔵):')
  io.out(
    JSON.stringify(
      {
        mcpServers: {
          documi: {
            command: 'documi',
            args: ['mcp', '--project', projectRoot],
          },
        },
      },
      null,
      2,
    ),
  )
  io.out('\n次のステップ:')
  io.out('  documi check')
  io.out('  documi map')
  io.out('  documi serve')
  return 0
}

async function cmdServe(flags: CliFlags): Promise<number> {
  const { docsDir, projectRoot, testReportPath } = resolveCliPaths(flags)
  const port = typeof flags.port === 'string' ? Number(flags.port) : undefined
  const hostname = typeof flags.host === 'string' ? flags.host : undefined

  await startServer({
    docsDir,
    projectRoot,
    testReportPath,
    port: Number.isFinite(port) ? port : undefined,
    hostname,
  })
  // サーバー稼働中は終了させない
  await new Promise(() => {})
  return 0
}

async function cmdMcp(flags: CliFlags): Promise<number> {
  const { docsDir, projectRoot, testReportPath } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, { projectRoot, testReportPath })
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

async function cmdCheck(flags: CliFlags, io: CliIo): Promise<number> {
  const { docsDir, projectRoot, testReportPath } = resolveCliPaths(flags)

  const report = await runDocsCheck({
    docsDir,
    projectRoot,
    testReportPath,
    strict: flags.strict === true,
    noReviewEdit: flags['no-review-edit'] === true,
    fetchPrs: flags.prs === true,
  })

  if (flags.json === true) {
    printJson(io, {
      ok: report.ok,
      docsDir: report.docsDir,
      documentCount: report.documentCount,
      blockCount: report.blockCount,
      reviewCounts: report.reviewCounts,
      realizationCounts: report.realizationCounts,
      errors: report.errors,
      warnings: report.warnings,
    })
    return report.ok ? 0 : 1
  }

  io.out(`Documi Check: ${report.docsDir}`)
  io.out(`  documents:   ${report.documentCount} (${report.blockCount} blocks)`)
  io.out(
    `  reviews:     approved=${report.reviewCounts.approved} unreviewed=${report.reviewCounts.unreviewed} stale=${report.reviewCounts.stale} suspect=${report.reviewCounts.suspect}`,
  )
  io.out(
    `  realization: verified=${report.realizationCounts.verified} implemented=${report.realizationCounts.implemented} in-progress=${report.realizationCounts['in-progress']} unimplemented=${report.realizationCounts.unimplemented} drifted=${report.realizationCounts.drifted}`,
  )

  if (report.warnings.length > 0) {
    io.out(`\nWarnings (${report.warnings.length}):`)
    for (const w of report.warnings) {
      io.out(`  ⚠ [${w.code}] ${w.path ? `${w.path}: ` : ''}${w.message}`)
    }
  }

  if (report.errors.length > 0) {
    io.out(`\nErrors (${report.errors.length}):`)
    for (const e of report.errors) {
      io.out(`  ✗ [${e.code}] ${e.path ? `${e.path}: ` : ''}${e.message}`)
    }
  }

  io.out(report.ok ? '\n✓ Check passed' : `\n✗ Check failed (${report.errors.length} errors)`)
  return report.ok ? 0 : 1
}

async function cmdApprove(ids: string[], flags: CliFlags, io: CliIo): Promise<number> {
  if (ids.length === 0) {
    io.err('承認するブロック ID を 1 つ以上指定してください (例: documi approve auth.lockout)')
    return 1
  }
  const { docsDir } = resolveCliPaths(flags)
  const author = typeof flags.author === 'string' ? flags.author : undefined
  const index = await loadDocuments(docsDir)

  let failed = 0
  for (const id of ids) {
    try {
      const rec = await approveBlock(docsDir, index, id, { author })
      io.out(`✓ Approved ${id} (${rec.hash.slice(0, 19)}… by ${rec.approvedBy ?? 'human'})`)
    } catch (e) {
      const msg = e instanceof ReviewError ? e.message : String(e)
      io.err(`✗ ${id}: ${msg}`)
      failed++
    }
  }
  return failed > 0 ? 1 : 0
}

async function cmdExport(flags: CliFlags, io: CliIo): Promise<number> {
  const format = flags.format === 'html' ? 'html' : 'pdf'
  const { docsDir, projectRoot, testReportPath } = resolveCliPaths(flags)
  const clientDist = path.resolve(import.meta.dir, '../dist')
  if (!existsSync(clientDist)) {
    io.err(`ビルド済みフロントエンドが見つかりません (${clientDist})。先に "bun run build" を実行してください。`)
    return 1
  }

  const outPath = path.resolve(typeof flags.out === 'string' ? flags.out : `documi-bundle.${format}`)
  const store = await DocsStore.open(docsDir, { projectRoot, testReportPath })
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

    io.out(`✓ Exported ${format.toUpperCase()} → ${outPath}`)
    return 0
  } catch (e) {
    const msg = e instanceof PdfError ? e.message : String(e)
    io.err(`✗ Export 失敗: ${msg}`)
    return 1
  } finally {
    void server.stop(true)
  }
}

// ---------- AI & 人間向け 読み取り・検索コマンド ----------
// @implements core.ai-cli

async function cmdMap(flags: CliFlags, io: CliIo): Promise<number> {
  const { docsDir, projectRoot, testReportPath } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, { projectRoot, testReportPath })
  const map = buildProjectMap(store.getIndex(), { full: flags.full === true })

  if (flags.json === true) {
    printJson(io, map)
    return 0
  }

  io.out(`Documi Project Map (${map.documentCount} docs, ${map.blockCount} blocks, ${map.issueCount} issues)`)
  io.out(
    `  reviews:     approved=${map.reviewSummary.approved} unreviewed=${map.reviewSummary.unreviewed} stale=${map.reviewSummary.stale} suspect=${map.reviewSummary.suspect} openFeedback=${map.reviewSummary.openFeedback}`,
  )
  io.out(
    `  realization: verified=${map.realizationSummary.verified} implemented=${map.realizationSummary.implemented} in-progress=${map.realizationSummary['in-progress']} unimplemented=${map.realizationSummary.unimplemented} drifted=${map.realizationSummary.drifted}`,
  )

  if (map.goals.length > 0) {
    io.out(`\nGoals (${map.goals.length}):`)
    for (const g of map.goals) io.out(`  - ${g.id}: ${g.title}`)
  }
  if (map.architecture.length > 0) {
    io.out(`\nArchitecture (${map.architecture.length}):`)
    for (const a of map.architecture) io.out(`  - ${a.id}: ${a.title}`)
  }
  if (map.decisionOutcomes.length > 0) {
    io.out(`\nDecision Outcomes (${map.decisionOutcomes.length}):`)
    for (const o of map.decisionOutcomes) {
      const firstLine = o.body.trim().split('\n')[0] ?? ''
      io.out(`  - ${o.id} (${o.docId}${o.date ? `, ${o.date}` : ''}): ${firstLine}`)
    }
  }
  if (map.terms.length > 0) {
    io.out(`\nDomain Terms (${map.terms.length}):`)
    for (const t of map.terms) {
      const aliases = t.aliases.length > 0 ? ` [${t.aliases.join(', ')}]` : ''
      io.out(`  - ${t.id}${aliases}`)
    }
  }
  return 0
}

async function cmdList(flags: CliFlags, io: CliIo): Promise<number> {
  const type = parseOptionalArtifactType(flags)
  const { docsDir } = resolveCliPaths(flags)
  const index = await loadDocuments(docsDir)
  const res = listDocuments(index, type)

  if (flags.json === true) {
    printJson(io, res)
    return 0
  }

  io.out(`Documents (${res.count}):`)
  for (const d of res.documents) {
    const datePart = d.date ? ` [${d.date}]` : ''
    io.out(`  [${d.type}] ${d.id}${datePart} — ${d.title}`)
  }
  return 0
}

async function cmdShow(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  const id = positionals[0]
  if (!id) throw new CliArgError('ドキュメント ID を指定してください (例: documi show specs/core/document-model)')
  const { docsDir, projectRoot, testReportPath } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, { projectRoot, testReportPath })
  const detail = getDocumentDetail(store.getIndex(), id)
  if (!detail) {
    io.err(`✗ ドキュメントが見つかりません: ${id}`)
    return 1
  }

  if (flags.json === true) {
    printJson(io, detail)
    return 0
  }

  io.out(`[${detail.type}] ${detail.id} — ${detail.title}`)
  io.out(`path: ${detail.path}`)
  if (detail.blocks.length > 0) {
    io.out(`blocks (${detail.blocks.length}):`)
    for (const b of detail.blocks) {
      const real = b.realization ? ` realization=${b.realization.status}` : ''
      io.out(`  - ${b.id} (${b.kind}, L${b.startLine}-L${b.endLine}, review=${b.review}${real})`)
    }
  }
  io.out('')
  io.out(detail.body)
  return 0
}

async function cmdRelations(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  const id = positionals[0]
  if (!id)
    throw new CliArgError(
      'ドキュメント ID またはブロック ID を指定してください (例: documi relations core.document-model)',
    )
  const { docsDir } = resolveCliPaths(flags)
  const index = await loadDocuments(docsDir)
  const rel = getNodeRelations(index, id)
  if (!rel) {
    io.err(`✗ ドキュメントまたはブロックが見つかりません: ${id}`)
    return 1
  }

  if (flags.json === true) {
    printJson(io, rel)
    return 0
  }

  io.out(`Relations for ${rel.id} (${rel.kind})`)
  if (rel.kind === 'doc') {
    io.out(`  outgoing (${rel.outgoing.length}):`)
    for (const e of rel.outgoing) io.out(`    --${e.kind}--> ${e.ref} (${e.title})`)
    io.out(`  incoming (${rel.incoming.length}):`)
    for (const e of rel.incoming) io.out(`    <--${e.kind}-- ${e.ref} (${e.title})`)
  } else {
    io.out(`  outgoing (${rel.outgoing.length}):`)
    for (const e of rel.outgoing) io.out(`    --${e.kind}--> ${e.to}`)
    io.out(`  incoming (${rel.incoming.length}):`)
    for (const e of rel.incoming) io.out(`    <--${e.kind}-- ${e.from}`)
  }
  return 0
}

async function cmdSearch(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  const query = positionals.join(' ').trim()
  if (!query) throw new CliArgError('検索キーワードを指定してください (例: documi search "Rooted DAG")')
  const type = parseOptionalArtifactType(flags)
  const limitRaw = getStringFlag(flags, 'limit')
  let limit: number | undefined
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new CliArgError(`--limit は 1〜100 の整数で指定してください: "${limitRaw}"`)
    }
    limit = parsed
  }

  const { docsDir } = resolveCliPaths(flags)
  const index = await loadDocuments(docsDir)
  const res = searchDocuments(index, query, { type, limit })

  if (flags.json === true) {
    printJson(io, res)
    return 0
  }

  io.out(`Search "${res.query}" (${res.count} hits):`)
  for (const hit of res.results) {
    const blockPart = hit.kind === 'block' ? ` #${hit.id}` : ''
    io.out(`  [${hit.type}] ${hit.docId}${blockPart} (score=${hit.score}) — ${hit.title}`)
    if (hit.snippet) io.out(`    ${hit.snippet}`)
  }
  return 0
}

async function cmdQuery(flags: CliFlags, io: CliIo): Promise<number> {
  if (flags.suspect === true && flags['no-suspect'] === true) {
    throw new CliArgError('--suspect と --no-suspect は同時に指定できません')
  }
  if (flags['has-feedback'] === true && flags['no-feedback'] === true) {
    throw new CliArgError('--has-feedback と --no-feedback は同時に指定できません')
  }

  const filters = {
    kind: parseOptionalBlockKind(flags),
    intent: parseOptionalSpecIntent(flags),
    stability: parseOptionalStability(flags),
    review: parseOptionalReviewStatus(flags),
    realization: parseOptionalRealizationStatus(flags),
    suspect: flags.suspect === true ? true : flags['no-suspect'] === true ? false : undefined,
    hasFeedback: flags['has-feedback'] === true ? true : flags['no-feedback'] === true ? false : undefined,
    query: getStringFlag(flags, 'q'),
    full: flags.full === true,
  }

  const { docsDir, projectRoot, testReportPath } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, { projectRoot, testReportPath })
  const res = querySpecs(store.getIndex(), filters)

  if (flags.json === true) {
    printJson(io, res)
    return 0
  }

  io.out(`Blocks (${res.count}):`)
  for (const b of res.blocks) {
    const status = 'summary' in b ? b.realizationStatus : b.realization?.status
    const real = status ? ` realization=${status}` : ''
    const suspect = b.suspect ? ' suspect' : ''
    const openFb = 'summary' in b ? b.openFeedbackCount : b.feedback.filter((f) => !f.resolved).length
    const fb = openFb > 0 ? ` feedback=${openFb}` : ''
    io.out(`  [${b.kind}] ${b.id} (${b.docPath}:${b.startLine}-${b.endLine}) review=${b.review}${real}${suspect}${fb}`)
  }
  return 0
}

async function cmdContext(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  const id = positionals[0]
  if (!id)
    throw new CliArgError(
      'Spec ブロック ID またはドキュメント ID を指定してください (例: documi context core.document-model)',
    )
  const { docsDir, projectRoot, testReportPath } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, { projectRoot, testReportPath })
  const ctx = getSpecContext(store.getIndex(), id, { full: flags.full === true })
  if (!ctx) {
    io.err(`✗ 対象が見つかりません: ${id}`)
    return 1
  }

  if (flags.json === true) {
    printJson(io, ctx)
    return 0
  }

  io.out(`Spec Context: ${id} (${ctx.docPath}${ctx.startLine ? `:${ctx.startLine}-${ctx.endLine}` : ''})`)
  if ('rawBody' in ctx.target && ctx.target.rawBody) {
    io.out(`  body:`)
    for (const line of ctx.target.rawBody.trim().split('\n')) {
      io.out(`    ${line}`)
    }
  }
  if (ctx.upstreamGoals.length > 0) {
    io.out(`  upstream goals: ${ctx.upstreamGoals.map((g) => g.id).join(', ')}`)
  }
  if (ctx.openFeedback.length > 0) {
    io.out(`  open feedback (${ctx.openFeedback.length}):`)
    for (const f of ctx.openFeedback) io.out(`    - [${f.blockId}] ${f.author}: ${f.body}`)
  }
  if (ctx.relatedDocuments.length > 0) {
    io.out(`  related docs: ${ctx.relatedDocuments.map((d) => `${d.id} [${d.type}]`).join(', ')}`)
  }
  if (ctx.decisionOutcomes.length > 0) {
    io.out(`  decision outcomes: ${ctx.decisionOutcomes.map((o) => o.id).join(', ')}`)
  }
  if (ctx.relevantTerms.length > 0) {
    io.out(`  terms: ${ctx.relevantTerms.map((t) => t.id).join(', ')}`)
  }
  if (ctx.sourceRefs.length > 0) {
    io.out(`  sourceRefs (${ctx.sourceRefs.length}):`)
    for (const r of ctx.sourceRefs) io.out(`    - ${r.file}${r.symbol ? `#${r.symbol}` : ''}`)
  }
  return 0
}

// ---------- AI & 人間向け 精密編集コマンド ----------
// @implements core.ai-cli

async function cmdBlock(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  const action = positionals[0]
  if (action !== 'add' && action !== 'update' && action !== 'rename') {
    throw new CliArgError('documi block のサブコマンドは add / update / rename のいずれかを指定してください')
  }

  const { docsDir, projectRoot, testReportPath } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, { projectRoot, testReportPath, enrichTrace: false })

  if (action === 'add') {
    const docId = positionals[1]
    if (!docId)
      throw new CliArgError(
        '追加先のドキュメント ID を指定してください (例: documi block add specs/auth --kind spec --id auth.login --body "...")',
      )
    const kind = parseOptionalBlockKind(flags)
    if (!kind) throw new CliArgError(`--kind を指定してください (${BLOCK_KINDS.join(', ')})`)
    const id = getStringFlag(flags, 'id')
    if (!id) throw new CliArgError('--id を指定してください')
    const body = (await resolveBodyContent(flags, io, { required: true }))!

    const result = await addBlockToDoc(store.rootDir, store.getIndex(), {
      docId,
      kind,
      id,
      body,
      afterHeading: getStringFlag(flags, 'after-heading'),
      title: getStringFlag(flags, 'title'),
      stability: parseOptionalStability(flags),
      intent: parseOptionalBlockIntent(flags),
      derives: parseCsvFlag(flags, 'derives'),
      supersedes: parseCsvFlag(flags, 'supersedes'),
      scope: getStringFlag(flags, 'scope'),
      aliases: parseCsvFlag(flags, 'aliases'),
      symbols: parseCsvFlag(flags, 'symbols'),
    })
    const nextIndex = await store.reload()
    const validation = await buildValidationPayload(nextIndex, projectRoot)
    const payload = { ...result, validation }

    if (flags.json === true) printJson(io, payload)
    else
      io.out(
        `✓ Added ${result.id} → ${result.path}:${result.startLine}-${result.endLine} (issues: ${validation.totalIssues})`,
      )
    return 0
  }

  if (action === 'update') {
    const id = positionals[1]
    if (!id)
      throw new CliArgError(
        '更新対象のブロック ID を指定してください (例: documi block update auth.lockout --body "...")',
      )
    const body = (await resolveBodyContent(flags, io, { required: true }))!

    const result = await updateBlockInDocs(store.rootDir, store.getIndex(), {
      id,
      body,
      title: getStringFlag(flags, 'title'),
      stability: parseOptionalStability(flags),
      intent: parseOptionalBlockIntent(flags),
      derives: parseCsvFlag(flags, 'derives'),
      supersedes: parseCsvFlag(flags, 'supersedes'),
      scope: getStringFlag(flags, 'scope'),
      aliases: parseCsvFlag(flags, 'aliases'),
      symbols: parseCsvFlag(flags, 'symbols'),
    })
    const nextIndex = await store.reload()
    const validation = await buildValidationPayload(nextIndex, projectRoot)
    const payload = { ...result, validation }

    if (flags.json === true) printJson(io, payload)
    else
      io.out(
        `✓ Updated ${result.id} → ${result.path}:${result.startLine}-${result.endLine} (issues: ${validation.totalIssues})`,
      )
    return 0
  }

  // rename
  const oldId = positionals[1]
  const newId = positionals[2]
  if (!oldId || !newId) {
    throw new CliArgError(
      '変更前・変更後のブロック ID を指定してください (例: documi block rename old.id new.id --dry-run)',
    )
  }
  const dryRun = flags['dry-run'] === true
  const result = await renameBlockIdAcrossProject(store.rootDir, projectRoot, store.getIndex(), {
    oldId,
    newId,
    dryRun,
  })
  if (!result.dryRun && result.changes.length > 0) {
    const nextIndex = await store.reload()
    const validation = await buildValidationPayload(nextIndex, projectRoot)
    const payload = { ...result, validation }
    if (flags.json === true) printJson(io, payload)
    else {
      io.out(`✓ Renamed ${oldId} → ${newId} (${result.changes.length} files, issues: ${validation.totalIssues})`)
      for (const c of result.changes) io.out(`  - ${c.path} (${c.occurrences})`)
    }
    return 0
  }

  if (flags.json === true) printJson(io, result)
  else {
    const prefix = result.dryRun ? '[dry-run] ' : ''
    io.out(`${prefix}${oldId} → ${newId} (${result.changes.length} files)`)
    for (const c of result.changes) io.out(`  - ${c.path} (${c.occurrences})`)
  }
  return 0
}

async function cmdTerm(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  const action = positionals[0]
  if (action !== 'upsert') {
    throw new CliArgError(
      'documi term のサブコマンドは upsert を指定してください (例: documi term upsert Artifact --definition "...")',
    )
  }
  const id = positionals[1]
  if (!id) throw new CliArgError('用語 ID を指定してください (例: documi term upsert Artifact --definition "...")')
  const definition = (await resolveBodyContent(flags, io, { allowDefinition: true, required: true }))!

  const { docsDir, projectRoot, testReportPath } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, { projectRoot, testReportPath, enrichTrace: false })
  const result = await upsertTermInDocs(store.rootDir, store.getIndex(), {
    id,
    definition,
    aliases: parseCsvFlag(flags, 'aliases'),
    symbols: parseCsvFlag(flags, 'symbols'),
    docId: getStringFlag(flags, 'doc'),
  })
  const nextIndex = await store.reload()
  const validation = await buildValidationPayload(nextIndex, projectRoot)
  const payload = { ...result, validation }

  if (flags.json === true) printJson(io, payload)
  else
    io.out(
      `✓ Term ${result.action}: ${result.id} → ${result.path}:${result.startLine}-${result.endLine} (issues: ${validation.totalIssues})`,
    )
  return 0
}

async function cmdScaffold(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  const relPath = positionals[0]
  if (!relPath)
    throw new CliArgError('作成する相対パスを指定してください (例: documi scaffold specs/auth.mdx --title "Auth Spec")')
  const title = getStringFlag(flags, 'title')
  if (!title) throw new CliArgError('--title を指定してください')
  const body = await resolveBodyContent(flags, io, { required: false })

  const { docsDir, projectRoot, testReportPath } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, { projectRoot, testReportPath, enrichTrace: false })
  const result = await scaffoldDocument(store.rootDir, store.getIndex(), {
    path: relPath,
    title,
    type: parseOptionalArtifactType(flags),
    description: getStringFlag(flags, 'description'),
    date: getStringFlag(flags, 'date'),
    tags: parseCsvFlag(flags, 'tags'),
    derives: parseCsvFlag(flags, 'derives'),
    satisfies: parseCsvFlag(flags, 'satisfies'),
    verifies: parseCsvFlag(flags, 'verifies'),
    body,
  })
  const nextIndex = await store.reload()
  const validation = await buildValidationPayload(nextIndex, projectRoot)
  const payload = { ...result, validation }

  if (flags.json === true) printJson(io, payload)
  else io.out(`✓ Scaffolded ${result.docId} → ${result.path} (issues: ${validation.totalIssues})`)
  return 0
}

async function cmdBuildSite(flags: CliFlags, io: CliIo): Promise<number> {
  const { docsDir, projectRoot, testReportPath } = resolveCliPaths(flags)
  const outDir = path.resolve(typeof flags.out === 'string' ? flags.out : 'dist-site')
  const basePath = typeof flags.base === 'string' ? flags.base : undefined
  const maxRevisions = typeof flags.revisions === 'string' ? Number(flags.revisions) : undefined

  try {
    const result = await buildStaticSite({
      docsDir,
      projectRoot,
      testReportPath,
      outDir,
      basePath,
      includeCode: flags['no-code'] !== true,
      maxRevisions: maxRevisions !== undefined && Number.isFinite(maxRevisions) ? maxRevisions : undefined,
    })
    io.out(`✓ Built static site → ${result.outDir}`)
    io.out(
      `  documents: ${result.documentCount}, revisions: ${result.revisionCount}, code files: ${result.codeFileCount}, snippets: ${result.sourceSnippetCount}, icons: ${result.iconCount}`,
    )
    return 0
  } catch (error) {
    io.err(`✗ Static site ビルド失敗: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

/**
 * CLI エントリポイント（テストから直接呼び出せるように分離）。
 */
export async function runCli(argv: string[], io: CliIo = DEFAULT_IO): Promise<number> {
  const { command, positionals, flags } = parseCliArgs(argv)
  if (flags.help || !command) {
    usage(io)
    return command ? 0 : 1
  }

  try {
    if (command === 'init') return await cmdInit(flags, io)
    if (command === 'serve') return await cmdServe(flags)
    if (command === 'mcp') return await cmdMcp(flags)
    if (command === 'check') return await cmdCheck(flags, io)
    if (command === 'approve') return await cmdApprove(positionals, flags, io)
    if (command === 'export') return await cmdExport(flags, io)
    if (command === 'build-site') return await cmdBuildSite(flags, io)
    if (command === 'map') return await cmdMap(flags, io)
    if (command === 'list') return await cmdList(flags, io)
    if (command === 'show') return await cmdShow(positionals, flags, io)
    if (command === 'relations') return await cmdRelations(positionals, flags, io)
    if (command === 'search') return await cmdSearch(positionals, flags, io)
    if (command === 'query') return await cmdQuery(flags, io)
    if (command === 'context') return await cmdContext(positionals, flags, io)
    if (command === 'block') return await cmdBlock(positionals, flags, io)
    if (command === 'term') return await cmdTerm(positionals, flags, io)
    if (command === 'scaffold') return await cmdScaffold(positionals, flags, io)

    io.err(`不明なコマンドです: ${command}`)
    usage(io)
    return 1
  } catch (error) {
    if (error instanceof ConfigError || error instanceof EditError || error instanceof CliArgError) {
      io.err(`✗ ${error.message}`)
      return 1
    }
    throw error
  }
}

if (import.meta.main) {
  void runCli(process.argv.slice(2)).then((code) => process.exit(code))
}
