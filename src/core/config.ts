import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Result } from 'better-result'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { ConfigParseError, ConfigReadError, ConfigValidationError, type ConfigDomainError } from './errors'

/** プロジェクトルート直下で探索する設定ファイル名（優先順） */
const CONFIG_FILE_NAMES = ['.documi.json', '.documi.yml', '.documi.yaml', 'documi.json'] as const

export const RAG_PROVIDERS = ['ollama', 'openai'] as const
export type RagProvider = (typeof RAG_PROVIDERS)[number]

export const REVIEW_GATES = ['none', 'stable', 'all'] as const
export type ReviewGate = (typeof REVIEW_GATES)[number]

export const DEFAULT_OLLAMA_MODEL = 'embeddinggemma'
export const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small'

const ragConfigSchema = z
  .object({
    /** true のとき documi retrieve / search / MCP / /api/search で既定でハイブリッド検索 (BM25 + Embedding RRF) を使う */
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

const documiConfigSchema = z
  .object({
    /** ドキュメントルートディレクトリ（projectRoot からの相対パス、既定: "docs"） */
    docs: z.string().trim().min(1).optional(),
    /** JUnit XML テストレポートのパス（projectRoot からの相対パス） */
    testReport: z.string().trim().min(1).optional(),
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
  docsDir: string
  testReportPath?: string
  configPath?: string
  config: DocumiConfig
}

function nonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
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

// @implements core.project-config
/**
 * CLI 引数・環境変数・プロジェクト設定ファイルから `projectRoot` と `docsDir` を双方向推論で解決する。
 *
 * 解決ルール:
 * 1. `--project` / `DOCUMI_PROJECT_ROOT` のみ指定 → `<projectRoot>` の設定ファイル `docs`、無ければ `<projectRoot>/docs`
 * 2. `--docs` / `DOCUMI_DOCS_DIR` のみ指定 → `projectRoot` は `dirname(docsDir)`
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
    let docsDir: string
    let loaded: LoadedDocumiConfig

    if (rawProject) {
      projectRoot = path.resolve(cwd, rawProject)
      loaded = yield* loadProjectConfig(projectRoot)
      docsDir = rawDocs ? path.resolve(cwd, rawDocs) : path.resolve(projectRoot, loaded.config.docs ?? 'docs')
    } else if (rawDocs) {
      docsDir = path.resolve(cwd, rawDocs)
      projectRoot = path.dirname(docsDir)
      loaded = yield* loadProjectConfig(projectRoot)
    } else {
      projectRoot = cwd
      loaded = yield* loadProjectConfig(projectRoot)
      docsDir = path.resolve(projectRoot, loaded.config.docs ?? 'docs')
    }

    const testReportPath = rawTestReport
      ? path.resolve(cwd, rawTestReport)
      : loaded.config.testReport
        ? path.resolve(projectRoot, loaded.config.testReport)
        : undefined

    return Result.ok({
      projectRoot,
      docsDir,
      ...(testReportPath ? { testReportPath } : {}),
      ...(loaded.configPath ? { configPath: loaded.configPath } : {}),
      config: loaded.config,
    })
  })
}
