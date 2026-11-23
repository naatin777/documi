import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

/** プロジェクトルート直下で探索する設定ファイル名（優先順） */
const CONFIG_FILE_NAMES = ['.documi.json', '.documi.yml', '.documi.yaml', 'documi.json'] as const

const documiConfigSchema = z
  .object({
    /** ドキュメントルートディレクトリ（projectRoot からの相対パス、既定: "docs"） */
    docs: z.string().trim().min(1).optional(),
    /** JUnit XML テストレポートのパス（projectRoot からの相対パス） */
    testReport: z.string().trim().min(1).optional(),
  })
  .strict()

type DocumiConfig = z.infer<typeof documiConfigSchema>

export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly configPath?: string,
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

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
export function loadProjectConfig(projectRoot: string): LoadedDocumiConfig {
  const absRoot = path.resolve(projectRoot)
  for (const name of CONFIG_FILE_NAMES) {
    const filePath = path.join(absRoot, name)
    if (!existsSync(filePath)) continue

    let rawText: string
    try {
      rawText = readFileSync(filePath, 'utf-8')
    } catch (error) {
      throw new ConfigError(
        `設定ファイルを読み込めません (${name}): ${error instanceof Error ? error.message : String(error)}`,
        filePath,
      )
    }

    let parsed: unknown
    try {
      if (name.endsWith('.json')) {
        parsed = JSON.parse(rawText)
      } else {
        parsed = parseYaml(rawText)
      }
    } catch (error) {
      throw new ConfigError(
        `設定ファイルの構文が不正です (${name}): ${error instanceof Error ? error.message : String(error)}`,
        filePath,
      )
    }

    // 空の YAML ファイルは空設定として扱う
    if (parsed === null || parsed === undefined) {
      return { config: {}, configPath: filePath }
    }

    const result = documiConfigSchema.safeParse(parsed)
    if (!result.success) {
      const detail = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
      throw new ConfigError(`設定ファイルのスキーマが不正です (${name}): ${detail}`, filePath)
    }

    return { config: result.data, configPath: filePath }
  }

  return { config: {} }
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
export function resolveProjectPaths(options: ResolveProjectPathsOptions = {}): ResolvedProjectPaths {
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
    loaded = loadProjectConfig(projectRoot)
    docsDir = rawDocs ? path.resolve(cwd, rawDocs) : path.resolve(projectRoot, loaded.config.docs ?? 'docs')
  } else if (rawDocs) {
    docsDir = path.resolve(cwd, rawDocs)
    projectRoot = path.dirname(docsDir)
    loaded = loadProjectConfig(projectRoot)
  } else {
    projectRoot = cwd
    loaded = loadProjectConfig(projectRoot)
    docsDir = path.resolve(projectRoot, loaded.config.docs ?? 'docs')
  }

  const testReportPath = rawTestReport
    ? path.resolve(cwd, rawTestReport)
    : loaded.config.testReport
      ? path.resolve(projectRoot, loaded.config.testReport)
      : undefined

  return {
    projectRoot,
    docsDir,
    ...(testReportPath ? { testReportPath } : {}),
    ...(loaded.configPath ? { configPath: loaded.configPath } : {}),
    config: loaded.config,
  }
}
