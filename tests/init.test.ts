import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runDocsCheck } from '../src/core/checker'
import { parseYamlFrontmatter, splitFrontmatter } from '../src/core/frontmatter'
import { initDocumiProject } from '../src/core/init'

describe('documi init & Agent Skills', () => {
  test('[core.agent-skills-init] docs 雛形と標準 Agent Skills を既定 en で冪等に生成し、AGENTS.md を作成・上書きしない', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'documi-init-test-'))
    const docsDir = path.join(repo, 'docs')
    try {
      // 既存の AGENTS.md を置いて一切変更されないことを検証する
      const agentsPath = path.join(repo, 'AGENTS.md')
      await writeFile(agentsPath, '# Custom Project Agents\n')

      const first = await initDocumiProject({ docsDir, projectRoot: repo, today: '2026-11-23' })
      expect(first.lang).toBe('en')
      expect(first.createdDocs).toHaveLength(4)
      expect(first.createdSkills).toEqual(['documi/SKILL.md', 'documi-bootstrap/SKILL.md'])
      expect(first.skippedDocs).toEqual([])
      expect(first.skippedSkills).toEqual([])

      // AGENTS.md は無傷
      expect(await readFile(agentsPath, 'utf-8')).toBe('# Custom Project Agents\n')

      // 生成された SKILL.md が Agent Skills 標準の frontmatter (name / description) を持ち、CLI ベースで MCP 重複が無い
      for (const rel of first.createdSkills) {
        const raw = await readFile(path.join(first.skillsDir, rel), 'utf-8')
        const fm = splitFrontmatter(raw)
        expect(fm.hasFrontmatter).toBe(true)
        const parsed = parseYamlFrontmatter(fm.data) as Record<string, unknown>
        expect(typeof parsed.name).toBe('string')
        expect(typeof parsed.description).toBe('string')
        expect(raw).not.toContain('get_project_map')
        expect(raw).not.toContain('update_block')
      }

      const mainSkill = await readFile(path.join(first.skillsDir, 'documi/SKILL.md'), 'utf-8')
      expect(mainSkill).toContain('documi map')
      expect(mainSkill).toContain('documi context <spec-id>')
      expect(mainSkill).toContain("--body - <<'EOF'")
      expect(mainSkill).toContain('documi check --no-review-edit')

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

      // --force-skills + lang: 'ja' で日本語スキルへ上書き更新できる
      const forced = await initDocumiProject({
        docsDir,
        projectRoot: repo,
        lang: 'ja',
        skillsOnly: true,
        forceSkills: true,
      })
      expect(forced.lang).toBe('ja')
      expect(forced.createdDocs).toEqual([])
      expect(forced.skippedDocs).toEqual([])
      expect(forced.updatedSkills).toEqual(['documi/SKILL.md', 'documi-bootstrap/SKILL.md'])

      const jaSkill = await readFile(path.join(forced.skillsDir, 'documi/SKILL.md'), 'utf-8')
      expect(jaSkill).toContain('Documi Living Specification 運用ワークフロー（CLI）')
      expect(jaSkill).toContain('documi map')
      expect(jaSkill).toContain("--body - <<'EOF'")
      expect(jaSkill).not.toContain('get_project_map')
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test('[core.agent-skills-init] lang=ja の docs 雛形および --no-skills / --skills-only / --skills-dir が反映される', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'documi-init-opts-'))
    try {
      const specDir = path.join(repo, 'spec')
      const noSkills = await initDocumiProject({
        docsDir: specDir,
        projectRoot: repo,
        lang: 'ja',
        noSkills: true,
        today: '2026-11-23',
      })
      expect(noSkills.lang).toBe('ja')
      expect(noSkills.createdDocs).toHaveLength(4)
      expect(existsSync(path.join(repo, '.agents'))).toBe(false)

      const goalBody = await readFile(path.join(specDir, 'goals/project-goal.mdx'), 'utf-8')
      expect(goalBody).toContain('プロジェクト目標')

      // 日本語テンプレートもそのまま documi check がエラー 0 件で通る
      const report = await runDocsCheck({ docsDir: specDir, projectRoot: repo })
      expect(report.ok).toBe(true)
      expect(report.errors).toEqual([])

      const customSkillsDir = path.join(repo, '.claude', 'skills')
      const skillsOnly = await initDocumiProject({
        docsDir: specDir,
        projectRoot: repo,
        lang: 'ja',
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
