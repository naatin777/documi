import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runDocsCheck } from '../src/core/checker'
import { splitFrontmatter, parseYamlFrontmatter } from '../src/core/frontmatter'
import { initDocumiProject } from '../src/core/init'

describe('documi init & Agent Skills', () => {
  test('[core.agent-skills-init] docs 雛形と標準 Agent Skills を冪等に生成し、AGENTS.md を作成・上書きしない', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'documi-init-test-'))
    const docsDir = path.join(repo, 'docs')
    try {
      // 既存の AGENTS.md を置いて一切変更されないことを検証する
      const agentsPath = path.join(repo, 'AGENTS.md')
      await writeFile(agentsPath, '# Custom Project Agents\n')

      const first = await initDocumiProject({ docsDir, projectRoot: repo, today: '2026-11-23' })
      expect(first.createdDocs).toHaveLength(4)
      expect(first.createdSkills).toEqual(['documi/SKILL.md', 'documi-bootstrap/SKILL.md'])
      expect(first.skippedDocs).toEqual([])
      expect(first.skippedSkills).toEqual([])

      // AGENTS.md は無傷
      expect(await readFile(agentsPath, 'utf-8')).toBe('# Custom Project Agents\n')

      // 生成された SKILL.md が Agent Skills 標準の frontmatter (name / description) を持つ
      for (const rel of first.createdSkills) {
        const raw = await readFile(path.join(first.skillsDir, rel), 'utf-8')
        const fm = splitFrontmatter(raw)
        expect(fm.hasFrontmatter).toBe(true)
        const parsed = parseYamlFrontmatter(fm.data) as Record<string, unknown>
        expect(typeof parsed.name).toBe('string')
        expect(typeof parsed.description).toBe('string')
      }

      // 生成された docs/ はそのまま documi check がエラー 0 件で通る
      const report = await runDocsCheck({ docsDir, projectRoot: repo })
      expect(report.ok).toBe(true)
      expect(report.errors).toEqual([])

      // 2 回目の実行はすべてスキップ（既存ファイルを上書きしない）
      const second = await initDocumiProject({ docsDir, projectRoot: repo, today: '2026-11-23' })
      expect(second.createdDocs).toEqual([])
      expect(second.skippedDocs).toHaveLength(4)
      expect(second.createdSkills).toEqual([])
      expect(second.skippedSkills).toEqual(['documi/SKILL.md', 'documi-bootstrap/SKILL.md'])

      // --force-skills でスキルのみ最新版へ上書き更新できる
      const forced = await initDocumiProject({
        docsDir,
        projectRoot: repo,
        skillsOnly: true,
        forceSkills: true,
      })
      expect(forced.createdDocs).toEqual([])
      expect(forced.skippedDocs).toEqual([])
      expect(forced.updatedSkills).toEqual(['documi/SKILL.md', 'documi-bootstrap/SKILL.md'])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test('[core.agent-skills-init] --no-skills / --skills-only / --skills-dir およびカスタム docs パスが反映される', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'documi-init-opts-'))
    try {
      const noSkills = await initDocumiProject({
        docsDir: path.join(repo, 'spec'),
        projectRoot: repo,
        noSkills: true,
      })
      expect(noSkills.createdDocs).toHaveLength(4)
      expect(existsSync(path.join(repo, '.agents'))).toBe(false)

      const customSkillsDir = path.join(repo, '.claude', 'skills')
      const skillsOnly = await initDocumiProject({
        docsDir: path.join(repo, 'spec'),
        projectRoot: repo,
        skillsDir: customSkillsDir,
        skillsOnly: true,
      })
      expect(skillsOnly.createdDocs).toEqual([])
      expect(skillsOnly.createdSkills).toEqual(['documi/SKILL.md', 'documi-bootstrap/SKILL.md'])

      const skillBody = await readFile(path.join(customSkillsDir, 'documi/SKILL.md'), 'utf-8')
      expect(skillBody).toContain('`spec/`')
      expect(skillBody).toContain('`spec/.documi/reviews.json`')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})
