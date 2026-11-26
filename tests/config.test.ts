import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadProjectConfig, resolveProjectPaths } from '../src/core/config'

describe('Project Config & Bidirectional Path Resolution', () => {
  test('[core.project-config] 引数省略・--project のみ・--docs のみ・両方指定のすべてを双方向推論で正しく解決する', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'documi-config-basic-'))
    const repo = await mkdtemp(path.join(tmpdir(), 'documi-config-repo-'))
    try {
      // 1. 両方省略 -> cwd と cwd/docs
      const def = resolveProjectPaths({ cwd: work, env: {} }).unwrap()
      expect(def.projectRoot).toBe(path.resolve(work))
      expect(def.docsDir).toBe(path.join(path.resolve(work), 'docs'))
      expect(def.configPath).toBeUndefined()

      // 2. --project のみ -> <project>/docs を暗黙的に参照（cwd と別ディレクトリでも安全）
      const byProject = resolveProjectPaths({ cwd: work, project: repo, env: {} }).unwrap()
      expect(byProject.projectRoot).toBe(path.resolve(repo))
      expect(byProject.docsDir).toBe(path.join(path.resolve(repo), 'docs'))

      // 3. DOCUMI_PROJECT_ROOT 環境変数のみ -> <project>/docs
      const byEnvProject = resolveProjectPaths({ cwd: work, env: { DOCUMI_PROJECT_ROOT: repo } }).unwrap()
      expect(byEnvProject.projectRoot).toBe(path.resolve(repo))
      expect(byEnvProject.docsDir).toBe(path.join(path.resolve(repo), 'docs'))

      // 4. --docs のみ -> 親ディレクトリを projectRoot として推論
      const customDocs = path.join(repo, 'spec')
      const byDocs = resolveProjectPaths({ cwd: work, docs: customDocs, env: {} }).unwrap()
      expect(byDocs.docsDir).toBe(path.resolve(customDocs))
      expect(byDocs.projectRoot).toBe(path.resolve(repo))

      // 5. 両方指定（モノレポなど別階層の docs）
      const monoDocs = path.join(repo, 'packages', 'app', 'docs')
      const byBoth = resolveProjectPaths({ cwd: work, project: repo, docs: monoDocs, env: {} }).unwrap()
      expect(byBoth.projectRoot).toBe(path.resolve(repo))
      expect(byBoth.docsDir).toBe(path.resolve(monoDocs))
    } finally {
      await rm(work, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test('[core.project-config] .documi.json / .documi.yml / .documi.yaml / documi.json を読み込み CLI 引数で上書きできる', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'documi-config-cwd-'))
    const repoJson = await mkdtemp(path.join(tmpdir(), 'documi-config-json-'))
    const repoYml = await mkdtemp(path.join(tmpdir(), 'documi-config-yml-'))
    try {
      await writeFile(
        path.join(repoJson, '.documi.json'),
        JSON.stringify({ docs: 'documi', testReport: 'reports/junit.xml' }),
      )
      // .documi.yml も置いて .documi.json の方が優先されることを確認
      await writeFile(path.join(repoJson, '.documi.yml'), 'docs: ignored-yml\n')

      const fromJson = resolveProjectPaths({ cwd: work, project: repoJson, env: {} }).unwrap()
      expect(fromJson.projectRoot).toBe(path.resolve(repoJson))
      expect(fromJson.docsDir).toBe(path.join(path.resolve(repoJson), 'documi'))
      expect(fromJson.testReportPath).toBe(path.join(path.resolve(repoJson), 'reports/junit.xml'))
      expect(fromJson.configPath).toBe(path.join(path.resolve(repoJson), '.documi.json'))

      // 明示的な --docs と --test-report は設定ファイルより優先される
      const overridden = resolveProjectPaths({
        cwd: work,
        project: repoJson,
        docs: path.join(repoJson, 'override-docs'),
        testReport: path.join(repoJson, 'override.xml'),
        env: {},
      }).unwrap()
      expect(overridden.docsDir).toBe(path.join(path.resolve(repoJson), 'override-docs'))
      expect(overridden.testReportPath).toBe(path.join(path.resolve(repoJson), 'override.xml'))

      // YAML (.documi.yml) の読み込み（rag 設定含む）
      await writeFile(
        path.join(repoYml, '.documi.yml'),
        [
          'docs: specs-root',
          'testReport: out/test.xml',
          'rag:',
          '  enabled: true',
          '  provider: ollama',
          '  model: embeddinggemma',
          '',
        ].join('\n'),
      )
      const fromYml = resolveProjectPaths({ cwd: repoYml, env: {} }).unwrap()
      expect(fromYml.docsDir).toBe(path.join(path.resolve(repoYml), 'specs-root'))
      expect(fromYml.testReportPath).toBe(path.join(path.resolve(repoYml), 'out/test.xml'))
      expect(fromYml.configPath).toBe(path.join(path.resolve(repoYml), '.documi.yml'))
      expect(fromYml.config.rag?.enabled).toBe(true)
      expect(fromYml.config.rag?.provider).toBe('ollama')
      expect(fromYml.config.rag?.model).toBe('embeddinggemma')
    } finally {
      await rm(work, { recursive: true, force: true })
      await rm(repoJson, { recursive: true, force: true })
      await rm(repoYml, { recursive: true, force: true })
    }
  })

  test('[core.project-config] 不正な構文や未定義キーを含む設定ファイルは型付き ConfigDomainError を返す', async () => {
    const repoBadJson = await mkdtemp(path.join(tmpdir(), 'documi-config-bad-json-'))
    const repoUnknownKey = await mkdtemp(path.join(tmpdir(), 'documi-config-bad-key-'))
    try {
      await writeFile(path.join(repoBadJson, '.documi.json'), '{ invalid json')
      const badJson = loadProjectConfig(repoBadJson)
      expect(badJson.isErr()).toBe(true)
      if (badJson.isErr()) expect(badJson.error._tag).toBe('ConfigParseError')

      await writeFile(path.join(repoUnknownKey, '.documi.yml'), 'docs: docs\nunknownOption: true\n')
      const unknownKey = loadProjectConfig(repoUnknownKey)
      expect(unknownKey.isErr()).toBe(true)
      if (unknownKey.isErr()) expect(unknownKey.error._tag).toBe('ConfigValidationError')
    } finally {
      await rm(repoBadJson, { recursive: true, force: true })
      await rm(repoUnknownKey, { recursive: true, force: true })
    }
  })
})
