import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { runCli } from '../src/cli'

let projectDir: string
let docsDir: string

async function execCli(
  args: string[],
  stdinText = '',
): Promise<{ code: number; stdout: string; stderr: string; json: () => Record<string, unknown> }> {
  const outLines: string[] = []
  const errLines: string[] = []
  const code = await runCli(args, {
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
    readStdin: async () => stdinText,
  })
  const stdout = outLines.join('\n')
  const stderr = errLines.join('\n')
  return {
    code,
    stdout,
    stderr,
    json: () => JSON.parse(stdout) as Record<string, unknown>,
  }
}

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), 'documi-cli-agent-'))
  docsDir = path.join(projectDir, 'docs')

  const writeDoc = async (rel: string, fm: Record<string, unknown>, body: string) => {
    const file = path.join(docsDir, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `---\n${stringify(fm).trim()}\n---\n\n${body}`)
  }
  const writeSrc = async (rel: string, content: string) => {
    const file = path.join(projectDir, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }

  await writeDoc('goals/core.mdx', { type: 'goal', title: 'Core Goal' }, '# Core Goal\n')
  await writeDoc(
    'domain/glossary.mdx',
    { type: 'domain', title: 'Glossary' },
    '# Glossary\n\n<TermDef id="Session" aliases="セッション" symbols="src/auth.ts#Session">\n  ログインセッション。\n</TermDef>\n',
  )
  await writeDoc(
    'specs/auth.mdx',
    { type: 'spec', title: 'Auth Spec', derives: ['goals/core'] },
    [
      '# Auth Spec',
      '',
      '## Login',
      '',
      '<Spec id="auth.lockout" stability="stable">',
      '  5回失敗でアカウントをロックする。',
      '</Spec>',
      '',
    ].join('\n'),
  )
  await writeDoc(
    'designs/auth.mdx',
    { type: 'design', title: 'Auth Design', satisfies: ['auth.lockout'] },
    '# Auth Design\n\n<SourceRef file="src/auth.ts" symbol="Session" satisfies="auth.lockout" />\n',
  )
  await writeSrc('src/auth.ts', '// @implements auth.lockout\nexport interface Session { id: string }\n')
  await writeSrc('tests/auth.test.ts', "test('[auth.lockout] locks account', () => {})\n")
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

describe('AI & Human CLI commands', () => {
  test('[core.ai-cli] map / list / show / relations / search / query / context が JSON 形式で正確に動作する', async () => {
    const mapRes = await execCli(['map', '--project', projectDir, '--json'])
    expect(mapRes.code).toBe(0)
    const mapData = mapRes.json()
    expect(mapData.documentCount).toBe(4)
    expect((mapData.goals as Array<{ body?: string }>).length).toBe(1)
    // 既定はコンテキスト節約のため body を省略し、--full 指定時のみ展開する
    expect((mapData.goals as Array<{ body?: string }>)[0]?.body).toBeUndefined()
    expect((mapData.terms as unknown[]).length).toBe(1)

    const mapFullRes = await execCli(['map', '--project', projectDir, '--json', '--full'])
    expect(mapFullRes.code).toBe(0)
    expect((mapFullRes.json().goals as Array<{ body?: string }>)[0]?.body).toContain('# Core Goal')

    const listRes = await execCli(['list', '--project', projectDir, '--type', 'spec', '--json'])
    expect(listRes.code).toBe(0)
    expect(listRes.json().count).toBe(1)

    const showRes = await execCli(['show', 'specs/auth', '--project', projectDir, '--json'])
    expect(showRes.code).toBe(0)
    expect(showRes.json().id).toBe('specs/auth')

    const relRes = await execCli(['relations', 'auth.lockout', '--project', projectDir, '--json'])
    expect(relRes.code).toBe(0)
    expect(relRes.json().kind).toBe('block')

    const searchRes = await execCli(['search', 'ロック', '--project', projectDir, '--json'])
    expect(searchRes.code).toBe(0)
    expect((searchRes.json().count as number) >= 1).toBe(true)

    const queryRes = await execCli([
      'query',
      '--project',
      projectDir,
      '--kind',
      'spec',
      '--stability',
      'stable',
      '--json',
    ])
    expect(queryRes.code).toBe(0)
    const blocks = queryRes.json().blocks as Array<{
      id: string
      docPath: string
      startLine: number
      realizationStatus?: string
      realization?: unknown
    }>
    expect(blocks.map((b) => b.id)).toEqual(['auth.lockout'])
    expect(blocks[0]?.docPath).toBe('specs/auth.mdx')
    expect(blocks[0]?.startLine).toBeGreaterThan(1)
    // 既定は軽量サマリ（realizationStatus のみで詳細配列を含まない）
    expect(blocks[0]?.realizationStatus).toBeTruthy()
    expect(blocks[0]?.realization).toBeUndefined()

    const queryFullRes = await execCli(['query', '--project', projectDir, '--kind', 'spec', '--json', '--full'])
    expect(queryFullRes.code).toBe(0)
    expect((queryFullRes.json().blocks as Array<{ realization?: unknown }>)[0]?.realization).toBeTruthy()

    const ctxRes = await execCli(['context', 'auth.lockout', '--project', projectDir, '--json'])
    expect(ctxRes.code).toBe(0)
    const ctx = ctxRes.json()
    expect(ctx.docPath).toBe('specs/auth.mdx')
    expect((ctx.upstreamGoals as Array<{ id: string; body?: string }>).map((g) => g.id)).toEqual(['goals/core'])
    expect((ctx.upstreamGoals as Array<{ body?: string }>)[0]?.body).toBeUndefined()
    expect((ctx.relatedDocuments as Array<{ id: string }>).map((d) => d.id)).toContain('designs/auth')

    const ctxFullRes = await execCli(['context', 'auth.lockout', '--project', projectDir, '--json', '--full'])
    expect(ctxFullRes.code).toBe(0)
    expect((ctxFullRes.json().upstreamGoals as Array<{ body?: string }>)[0]?.body).toContain('# Core Goal')

    // 人間・AI 向けテキスト出力もエラーなく動作（context テキストに対象 Spec 本文が含まれる）
    const textMap = await execCli(['map', '--project', projectDir])
    expect(textMap.code).toBe(0)
    expect(textMap.stdout).toContain('Documi Project Map')

    const textCtx = await execCli(['context', 'auth.lockout', '--project', projectDir])
    expect(textCtx.code).toBe(0)
    expect(textCtx.stdout).toContain('5回失敗でアカウントをロックする。')
  })

  test('[core.ai-cli] scaffold / block add / block update (stdin) / term upsert / block rename が精密編集と検証を行う', async () => {
    // 1. scaffold
    const scRes = await execCli([
      'scaffold',
      'specs/mfa.mdx',
      '--project',
      projectDir,
      '--title',
      'MFA Spec',
      '--derives',
      'goals/core',
      '--tags',
      'auth,mfa',
      '--json',
    ])
    expect(scRes.code).toBe(0)
    expect(scRes.json().docId).toBe('specs/mfa')

    // 2. block add
    const addRes = await execCli([
      'block',
      'add',
      'specs/mfa',
      '--project',
      projectDir,
      '--kind',
      'spec',
      '--id',
      'auth.mfa',
      '--stability',
      'evolving',
      '--derives',
      'goals/core',
      '--body',
      'TOTP コードで二要素認証を行う。',
      '--json',
    ])
    expect(addRes.code).toBe(0)
    expect((addRes.json().validation as { ok: boolean }).ok).toBe(true)

    // 3. block update (stdin via --body -)
    const updRes = await execCli(
      ['block', 'update', 'auth.mfa', '--project', projectDir, '--body', '-', '--stability', 'stable', '--json'],
      'TOTP または WebAuthn で二要素認証を行う。',
    )
    expect(updRes.code).toBe(0)
    const mfaDoc = await readFile(path.join(docsDir, 'specs/mfa.mdx'), 'utf-8')
    expect(mfaDoc).toContain('WebAuthn')
    expect(mfaDoc).toContain('stability="stable"')

    // 4. term upsert
    const termRes = await execCli([
      'term',
      'upsert',
      'Token',
      '--project',
      projectDir,
      '--definition',
      '認証トークン。',
      '--aliases',
      'トークン,AuthToken',
      '--json',
    ])
    expect(termRes.code).toBe(0)
    expect(termRes.json().action).toBe('created')

    // 5. block rename (--dry-run → 実行)
    const dryRes = await execCli([
      'block',
      'rename',
      'auth.lockout',
      'auth.account-lockout',
      '--project',
      projectDir,
      '--dry-run',
      '--json',
    ])
    expect(dryRes.code).toBe(0)
    expect(dryRes.json().dryRun).toBe(true)
    expect((dryRes.json().changes as unknown[]).length).toBeGreaterThanOrEqual(3)

    const renameRes = await execCli([
      'block',
      'rename',
      'auth.lockout',
      'auth.account-lockout',
      '--project',
      projectDir,
      '--json',
    ])
    expect(renameRes.code).toBe(0)
    expect((renameRes.json().validation as { ok: boolean }).ok).toBe(true)
    expect(await readFile(path.join(projectDir, 'src/auth.ts'), 'utf-8')).toContain('@implements auth.account-lockout')
    expect(await readFile(path.join(projectDir, 'tests/auth.test.ts'), 'utf-8')).toContain('[auth.account-lockout]')
  })

  test('[core.ai-cli] init の --ja / --en / --lang 検証および不正引数・危険構文の拒否が動作する', async () => {
    const freshRepo = await mkdtemp(path.join(tmpdir(), 'documi-cli-init-lang-'))
    try {
      // --ja と --en の同時指定はエラー
      const conflict = await execCli(['init', '--project', freshRepo, '--ja', '--en'])
      expect(conflict.code).toBe(1)
      expect(conflict.stderr).toContain('--ja and --en cannot be used together')

      // --ja で日本語スキル生成
      const jaRes = await execCli(['init', '--project', freshRepo, '--ja', '--json'])
      expect(jaRes.code).toBe(0)
      expect(jaRes.json().lang).toBe('ja')
      const skillJa = await readFile(path.join(freshRepo, '.agents/skills/documi/SKILL.md'), 'utf-8')
      expect(skillJa).toContain('Documi Living Specification 運用ワークフロー（CLI）')

      // --en --force-skills で英語スキルに上書き切替
      const enRes = await execCli(['init', '--project', freshRepo, '--en', '--skills-only', '--force-skills', '--json'])
      expect(enRes.code).toBe(0)
      expect(enRes.json().lang).toBe('en')
      const skillEn = await readFile(path.join(freshRepo, '.agents/skills/documi/SKILL.md'), 'utf-8')
      expect(skillEn).toContain('Documi Living Specification Workflow (CLI)')
    } finally {
      await rm(freshRepo, { recursive: true, force: true })
    }

    // 危険な MDX 式や reviews.json への書き込みを拒否
    const unsafe = await execCli([
      'block',
      'update',
      'auth.lockout',
      '--project',
      projectDir,
      '--body',
      '{process.exit(1)}',
    ])
    expect(unsafe.code).toBe(1)

    const forbidden = await execCli(['scaffold', '.documi/reviews.json', '--project', projectDir, '--title', 'Hack'])
    expect(forbidden.code).toBe(1)
  })

  test('[core.ai-cli] 未知フラグ (typo) を拒否し、<command> --help はそのコマンドの使い方だけを表示する', async () => {
    const typo = await execCli(['check', '--stict', '--project', projectDir])
    expect(typo.code).toBe(1)
    expect(typo.stderr).toContain('Unknown option: --stict')

    const help = await execCli(['check', '--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('documi check')
    expect(help.stdout).toContain('--strict')
    expect(help.stdout).not.toContain('documi serve')
    expect(help.stdout).not.toContain('--skills-dir')

    const full = await execCli(['--help'])
    expect(full.stdout).toContain('documi serve')
  })
})
