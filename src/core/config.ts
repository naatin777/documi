import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Result } from 'better-result'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { ConfigParseError, ConfigReadError, ConfigValidationError, type ConfigDomainError } from './errors'
import type { DocsMount } from './types'

/** プロジェクトルート直下で探索する設定ファイル名（優先順） */
const CONFIG_FILE_NAMES = ['.documi.json', '.documi.yml', '.documi.yaml', 'documi.json'] as const
const MOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

export const RAG_PROVIDERS = ['ollama', 'openai', 'gemini'] as const
export type RagProvider = (typeof RAG_PROVIDERS)[number]

export const REVIEW_GATES = ['none', 'stable', 'all'] as const
export type ReviewGate = (typeof REVIEW_GATES)[number]

export const DEFAULT_OLLAMA_MODEL = 'embeddinggemma'
export const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small'
export const DEFAULT_GEMINI_MODEL = 'gemini-embedding-001'
export const DEFAULT_GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai'

const ragConfigSchema = z
  .object({
    /** true のとき documi search / MCP search_documents / /api/search で既定でハイブリッド検索 (BM25 + Embedding RRF) を使う */
    enabled: z.boolean().optional(),
    /** Embedding プロバイダ (既定: "ollama") */
    provider: z.enum(RAG_PROVIDERS).optional(),
    /** モデル ID (Ollama 既定: "embeddinggemma" / OpenAI 既定: "text-embedding-3-small") */
    model: z.string().trim().min(1).optional(),
    /** Ollama / OpenAI 互換 HTTP エンドポイント URL */
    endpoint: z.string().trim().min(1).optional(),
    /** OpenAI 互換 API キーを読み取る環境変数名 (既定: "OPENAI_API_KEY") */
    apiKeyEnv: z.string().trim().min(1).optional(),
    /** SQLite ベクトルキャッシュファイルパス (projectRoot 相対または絶対、既定: <projectRoot>/.documi/cache/embeddings.sqlite) */
    cachePath: z.string().trim().min(1).optional(),
  })
  .strict()

export type RagConfig = z.infer<typeof ragConfigSchema>

const docsMountConfigSchema = z
  .object({
    /** マウント識別子（省略または "root" でプレフィックスなし、それ以外は "<id>/" を Document ID に付与） */
    id: z.string().trim().regex(MOUNT_ID_PATTERN, 'Mount id must match /^[a-z0-9][a-z0-9_-]*$/').optional(),
    /** ドキュメントディレクトリ（projectRoot からの相対パス） */
    path: z.string().trim().min(1),
    /** Web UI 等の表示ラベル（任意） */
    label: z.string().trim().min(1).optional(),
  })
  .strict()

const documiConfigSchema = z
  .object({
    /** ドキュメントルートディレクトリ（単一相対パス、または Monorepo 統合マウント配列。既定: "docs"） */
    docs: z
      .union([
        z.string().trim().min(1),
        z
          .array(docsMountConfigSchema)
          .min(1)
          .superRefine((entries, ctx) => {
            const seenIds = new Set<string>()
            entries.forEach((entry, idx) => {
              const effectiveId = entry.id ?? 'root'
              if (seenIds.has(effectiveId)) {
                ctx.addIssue({
                  code: 'custom',
                  path: [idx, 'id'],
                  message: `Duplicate docs mount id "${effectiveId}"`,
                })
              }
              seenIds.add(effectiveId)
            })
          }),
      ])
      .optional(),
    /** JUnit XML テストレポートのパス（単一または複数配列、projectRoot からの相対パス） */
    testReport: z.union([z.string().trim().min(1), z.array(z.string().trim().min(1)).min(1)]).optional(),
    /** `documi check` の既定レビュー承認ゲート ("none" | "stable" | "all"、既定: "none") */
    reviewGate: z.enum(REVIEW_GATES).optional(),
    /** ローカル Hybrid RAG（BM25 + Embedding + RRF）設定（任意） */
    rag: ragConfigSchema.optional(),
  })
  .strict()

type DocumiConfig = z.infer<typeof documiConfigSchema>

export interface LoadedDocumiConfig {
  config: DocumiConfig
  configPath?: string
}

export interface ResolveProjectPathsOptions {
  docs?: string
  project?: string
  testReport?: string
  cwd?: string
  env?: Record<string, string | undefined>
}

export interface ResolvedProjectPaths {
  projectRoot: string
  /** プライマリドキュメントディレクトリ（単一 docs、または root / 先頭マウントのパス） */
  docsDir: string
  /** 解決済みドキュメントマウント一覧（常に 1 件以上） */
  docsMounts: DocsMount[]
  /** 最初の JUnit XML テストレポートパス（後方互換用） */
  testReportPath?: string
  /** 解決済み JUnit XML テストレポートパス一覧 */
  testReportPaths: string[]
  configPath?: string
  config: DocumiConfig
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseDotEnvValue(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"')
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  const commentIdx = trimmed.search(/\s#/)
  return (commentIdx >= 0 ? trimmed.slice(0, commentIdx) : trimmed).trim()
}

/**
 * 対象プロジェクトの `.env.local` → `.env` を読み取り、未設定のキーのみ `targetEnv` に補完する。
 * `--project` や MCP 経由で別ディレクトリから起動した場合でも、プロジェクト直下の `.env` の API キーを利用できるようにする。
 */
export function loadProjectDotEnv(projectRoot: string, targetEnv: Record<string, string | undefined>): void {
  const absRoot = path.resolve(projectRoot)
  for (const fileName of ['.env.local', '.env']) {
    const filePath = path.join(absRoot, fileName)
    if (!existsSync(filePath)) continue
    let raw: string
    try {
      raw = readFileSync(filePath, 'utf-8')
    } catch {
      continue
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(trimmed)
      if (!match) continue
      const key = match[1]!
      if (targetEnv[key] !== undefined && targetEnv[key] !== '') continue
      targetEnv[key] = parseDotEnvValue(match[2] ?? '')
    }
  }
}

/**
 * プロジェクトルート直下から `.documi.json` / `.documi.yml` / `.documi.yaml` / `documi.json` を探索して読み込む。
 * 設定ファイルが存在しない場合は空オブジェクトを返す。
 */
export function loadProjectConfig(projectRoot: string): Result<LoadedDocumiConfig, ConfigDomainError> {
  const absRoot = path.resolve(projectRoot)
  for (const name of CONFIG_FILE_NAMES) {
    const filePath = path.join(absRoot, name)
    if (!existsSync(filePath)) continue

    const rawResult = Result.try({
      try: () => readFileSync(filePath, 'utf-8'),
      catch: (error) =>
        new ConfigReadError({
          configPath: filePath,
          message: `Failed to read config file (${name}): ${error instanceof Error ? error.message : String(error)}`,
        }),
    })
    if (rawResult.isErr()) return rawResult

    const parsedResult = Result.try({
      try: () =>
        name.endsWith('.json') ? (JSON.parse(rawResult.value) as unknown) : (parseYaml(rawResult.value) as unknown),
      catch: (error) =>
        new ConfigParseError({
          configPath: filePath,
          message: `Invalid syntax in config file (${name}): ${error instanceof Error ? error.message : String(error)}`,
        }),
    })
    if (parsedResult.isErr()) return parsedResult

    // 空の YAML ファイルは空設定として扱う
    if (parsedResult.value === null || parsedResult.value === undefined) {
      return Result.ok({ config: {}, configPath: filePath })
    }

    const result = documiConfigSchema.safeParse(parsedResult.value)
    if (!result.success) {
      const detail = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      return Result.err(
        new ConfigValidationError({
          configPath: filePath,
          message: `Invalid config schema (${name}): ${detail}`,
        }),
      )
    }

    return Result.ok({ config: result.data, configPath: filePath })
  }

  return Result.ok({ config: {} })
}

function resolveConfiguredMounts(projectRoot: string, rawDocsConfig: DocumiConfig['docs']): DocsMount[] {
  if (!rawDocsConfig) {
    return [{ id: 'root', dir: path.resolve(projectRoot, 'docs'), prefixed: false }]
  }
  if (typeof rawDocsConfig === 'string') {
    return [{ id: 'root', dir: path.resolve(projectRoot, rawDocsConfig), prefixed: false }]
  }
  return rawDocsConfig.map((entry) => {
    const id = entry.id ?? 'root'
    return {
      id,
      dir: path.resolve(projectRoot, entry.path),
      ...(entry.label ? { label: entry.label } : {}),
      prefixed: id !== 'root',
    }
  })
}

// @implements core.project-config
/**
 * CLI 引数・環境変数・プロジェクト設定ファイルから `projectRoot`・`docsDir`・`docsMounts`・`testReportPaths` を双方向推論で解決する。
 *
 * 解決ルール:
 * 1. `--project` / `DOCUMI_PROJECT_ROOT` のみ指定 → `<projectRoot>` の設定ファイル `docs`（単一または複数マウント）、無ければ `<projectRoot>/docs`
 * 2. `--docs` / `DOCUMI_DOCS_DIR` のみ指定 → `projectRoot` は `dirname(docsDir)`（明示指定の単一マウントとして採用）
 * 3. 両方省略 → `projectRoot = cwd`、設定ファイル `docs` または `<cwd>/docs`
 * 4. 両方指定 → それぞれを明示採用
 */
export function resolveProjectPaths(
  options: ResolveProjectPathsOptions = {},
): Result<ResolvedProjectPaths, ConfigDomainError> {
  return Result.gen(function* () {
    const cwd = path.resolve(options.cwd ?? process.cwd())
    const env = options.env ?? process.env
    const rawProject = nonEmpty(options.project) ?? nonEmpty(env.DOCUMI_PROJECT_ROOT)
    const rawDocs = nonEmpty(options.docs) ?? nonEmpty(env.DOCUMI_DOCS_DIR)
    const rawTestReport = nonEmpty(options.testReport)

    let projectRoot: string
    let docsMounts: DocsMount[]
    let loaded: LoadedDocumiConfig

    if (rawProject) {
      projectRoot = path.resolve(cwd, rawProject)
      loaded = yield* loadProjectConfig(projectRoot)
      docsMounts = rawDocs
        ? [{ id: 'root', dir: path.resolve(cwd, rawDocs), prefixed: false }]
        : resolveConfiguredMounts(projectRoot, loaded.config.docs)
    } else if (rawDocs) {
      const explicitDocsDir = path.resolve(cwd, rawDocs)
      projectRoot = path.dirname(explicitDocsDir)
      loaded = yield* loadProjectConfig(projectRoot)
      docsMounts = [{ id: 'root', dir: explicitDocsDir, prefixed: false }]
    } else {
      projectRoot = cwd
      loaded = yield* loadProjectConfig(projectRoot)
      docsMounts = resolveConfiguredMounts(projectRoot, loaded.config.docs)
    }

    const primaryMount = docsMounts.find((m) => !m.prefixed) ?? docsMounts[0]!
    const docsDir = primaryMount.dir

    if (!options.env) {
      loadProjectDotEnv(projectRoot, process.env)
    }

    const testReportPaths: string[] = rawTestReport
      ? [path.resolve(cwd, rawTestReport)]
      : loaded.config.testReport
        ? (Array.isArray(loaded.config.testReport) ? loaded.config.testReport : [loaded.config.testReport]).map((p) =>
            path.resolve(projectRoot, p),
          )
        : []
    const testReportPath = testReportPaths[0]

    return Result.ok({
      projectRoot,
      docsDir,
      docsMounts,
      ...(testReportPath ? { testReportPath } : {}),
      testReportPaths,
      ...(loaded.configPath ? { configPath: loaded.configPath } : {}),
      config: loaded.config,
    })
  })
}
