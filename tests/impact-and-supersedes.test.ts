import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../src/cli'
import { initDocumiProject } from '../src/core/init'
import { buildProjectMap, getImpactAnalysis } from '../src/core/query'
import { createApp } from '../src/server/app'
import { DocsStore } from '../src/server/store'

describe('supersedes separation & impact analysis', () => {
  test('[core.rooted-dag] separates active and superseded Decision Outcomes across graph, map, and /api/overview', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'documi-supersedes-'))
    const docsDir = path.join(tmp, 'docs')
    try {
      await mkdir(path.join(docsDir, 'goals'), { recursive: true })
      await mkdir(path.join(docsDir, 'decisions'), { recursive: true })
      await writeFile(path.join(docsDir, 'goals', 'main.mdx'), '---\ntype: goal\ntitle: Main Goal\n---\n\n# Main\n')
      await writeFile(
        path.join(docsDir, 'decisions', '2026-01-old-choice.mdx'),
        `---
type: decision
title: Old Choice
date: 2026-01-10
---

<Decision id="dec.old">
  Use legacy approach.
</Decision>
`,
      )
      await writeFile(
        path.join(docsDir, 'decisions', '2026-02-new-choice.mdx'),
        `---
type: decision
title: New Choice
date: 2026-02-15
supersedes:
  - decisions/2026-01-old-choice
---

<Decision id="dec.new">
  Use unified approach instead.
</Decision>
`,
      )

      const store = await DocsStore.open(docsDir, { projectRoot: tmp })
      const index = store.getIndex()

      // Old ADR doc and its <Outcome> inherit supersededBy
      expect(index.byId.get('decisions/2026-01-old-choice')?.supersededBy).toEqual(['decisions/2026-02-new-choice'])
      expect(index.blocksById.get('dec.old')?.supersededBy).toEqual(['decisions/2026-02-new-choice'])
      expect(index.blocksById.get('dec.new')?.supersededBy).toBeUndefined()

      // buildProjectMap separates active vs superseded outcomes
      const map = buildProjectMap(index)
      expect(map.decisionOutcomes.map((o) => o.id)).toEqual(['dec.new'])
      expect(map.supersededOutcomes.map((o) => o.id)).toEqual(['dec.old'])
      expect(map.supersededOutcomes[0]?.supersededBy).toEqual(['decisions/2026-02-new-choice'])

      // GET /api/overview separates active outcomes vs supersededOutcomes
      const app = createApp(store, { projectRoot: tmp })
      const res = await app.request('/api/overview')
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        outcomes: Array<{ id: string }>
        supersededOutcomes: Array<{ id: string; supersededBy?: string[] }>
      }
      expect(body.outcomes.map((o) => o.id)).toEqual(['dec.new'])
      expect(body.supersededOutcomes.map((o) => o.id)).toEqual(['dec.old'])
      expect(body.supersededOutcomes[0]?.supersededBy).toEqual(['decisions/2026-02-new-choice'])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('[core.ai-cli] documi impact and MCP get_impact recursively list affected docs, blocks, SourceRefs, and code anchors', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'documi-impact-'))
    const docsDir = path.join(tmp, 'docs')
    try {
      await mkdir(path.join(docsDir, 'goals'), { recursive: true })
      await mkdir(path.join(docsDir, 'specs'), { recursive: true })
      await mkdir(path.join(docsDir, 'designs'), { recursive: true })
      await mkdir(path.join(tmp, 'src'), { recursive: true })
      await mkdir(path.join(tmp, 'tests'), { recursive: true })

      await writeFile(path.join(docsDir, 'goals', 'core.mdx'), '---\ntype: goal\ntitle: Core Goal\n---\n\n# Core\n')
      await writeFile(
        path.join(docsDir, 'specs', 'auth.mdx'),
        `---
type: spec
title: Auth Spec
derives:
  - goals/core
---

<Spec id="auth.login" stability="stable" derives="goals/core">
  **When** a user logs in, **the** system **shall** validate credentials.
</Spec>
`,
      )
      await writeFile(
        path.join(docsDir, 'designs', 'auth-design.mdx'),
        `---
type: design
title: Auth Design
satisfies:
  - auth.login
---

<SourceRef file="src/auth.ts" symbol="login" satisfies="auth.login" />
`,
      )
      await writeFile(path.join(tmp, 'src', 'auth.ts'), '// @implements auth.login\nexport function login() {}\n')
      await writeFile(path.join(tmp, 'tests', 'auth.test.ts'), 'test("[auth.login] validates", () => {})\n')

      const store = await DocsStore.open(docsDir, { projectRoot: tmp })
      const impact = getImpactAnalysis(store.getIndex(), 'goals/core')
      expect(impact).toBeDefined()
      expect(impact!.affectedDocuments.map((d) => ({ id: d.id, depth: d.depth }))).toEqual([
        { id: 'specs/auth', depth: 1 },
        { id: 'designs/auth-design', depth: 2 },
      ])
      expect(impact!.sourceRefs.map((r) => r.file)).toContain('src/auth.ts')
      expect(impact!.codeAnchors.some((a) => a.file === 'src/auth.ts' && a.kind === 'implements')).toBe(true)
      expect(impact!.codeAnchors.some((a) => a.file === 'tests/auth.test.ts' && a.kind === 'verifies')).toBe(true)

      // depth=1 stops at specs/auth
      const shallow = getImpactAnalysis(store.getIndex(), 'goals/core', { maxDepth: 1 })
      expect(shallow!.affectedDocuments.map((d) => d.id)).toEqual(['specs/auth'])

      // CLI `documi impact`
      const out: string[] = []
      const code = await runCli(['impact', 'auth.login', '--project', tmp, '--json'], {
        out: (l) => out.push(l),
        err: () => {},
        readStdin: async () => '',
      })
      expect(code).toBe(0)
      const parsed = JSON.parse(out.join('\n')) as { affectedDocuments: Array<{ id: string }> }
      expect(parsed.affectedDocuments.map((d) => d.id)).toEqual(['designs/auth-design'])

      // MCP `get_impact`
      const app = createApp(store, { projectRoot: tmp })
      const mcpRes = await app.fetch(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'get_impact', arguments: { id: 'goals/core', maxDepth: 4 } },
          }),
        }),
      )
      expect(mcpRes.status).toBe(200)
      const mcpBody = (await mcpRes.json()) as {
        result?: { structuredContent?: { affectedDocuments: Array<{ id: string }> } }
      }
      expect(mcpBody.result?.structuredContent?.affectedDocuments.map((d) => d.id)).toEqual([
        'specs/auth',
        'designs/auth-design',
      ])
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('[core.agent-skills-init] embeds Spec-First, impact, supersedes, chat-decision capture, and contradiction audit into generated skills', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'documi-skill-specfirst-'))
    try {
      await initDocumiProject({ docsDir: path.join(tmp, 'docs'), projectRoot: tmp, lang: 'ja', skillsOnly: true })
      const documiSkill = await readFile(path.join(tmp, '.agents/skills/documi/SKILL.md'), 'utf-8')
      const auditSkill = await readFile(path.join(tmp, '.agents/skills/documi-audit/SKILL.md'), 'utf-8')
      expect(documiSkill).toContain('Spec-First')
      expect(documiSkill).toContain('documi impact')
      expect(documiSkill).toContain('supersedes')
      expect(documiSkill).toContain('チャット合意の即時永続化')
      expect(auditSkill).toContain('意味的矛盾チェック')
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
