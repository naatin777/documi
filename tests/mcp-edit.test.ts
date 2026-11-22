import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { createApp } from '../src/server/app'
import { DocsStore } from '../src/server/store'

let projectDir: string
let docsDir: string
let app: ReturnType<typeof createApp>

function mcpCall(name: string, args: Record<string, unknown>, id = 1): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
}

async function callTool<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; data?: T }> {
  const res = await app.fetch(mcpCall(name, args))
  expect(res.status).toBe(200)
  const json = (await res.json()) as {
    result?: {
      isError?: boolean
      content?: Array<{ text?: string }>
      structuredContent?: T
    }
  }
  return {
    isError: Boolean(json.result?.isError),
    text: json.result?.content?.[0]?.text ?? '',
    data: json.result?.structuredContent,
  }
}

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), 'documi-mcp-edit-'))
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
    '# Glossary\n\n<TermDef id="Session" aliases="セッション" symbols="src/auth.ts#Session">\n  ログインセッションを表す。\n</TermDef>\n',
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
      '## Keep Untouched',
      '',
      '<Spec id="auth.lockout.notify" stability="evolving">',
      '  ロック時に通知を送る。',
      '</Spec>',
      '',
    ].join('\n'),
  )
  await writeDoc(
    'designs/auth.mdx',
    { type: 'design', title: 'Auth Design', satisfies: ['auth.lockout'] },
    '# Auth Design\n\n<SourceRef file="src/auth.ts" symbol="Session" satisfies="auth.lockout" />\n',
  )

  await writeSrc(
    'src/auth.ts',
    [
      '// @implements auth.lockout',
      '// @implements auth.lockout.notify',
      'export interface Session { id: string }',
      '',
    ].join('\n'),
  )
  await writeSrc('tests/auth.test.ts', "test('[auth.lockout] locks account', () => {})\n")

  const store = await DocsStore.open(docsDir, { projectRoot: projectDir })
  app = createApp(store, { projectRoot: projectDir })
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

describe('MCP Surgical Editing', () => {
  test('[core.mcp-surgical-edit] query_specs と get_spec_context が正確な docPath とファイル行番号を返す', async () => {
    const ctx = await callTool<{ docPath: string; startLine: number; endLine: number }>('get_spec_context', {
      id: 'auth.lockout',
    })
    expect(ctx.isError).toBe(false)
    expect(ctx.data?.docPath).toBe('specs/auth.mdx')
    const rawLines = (await readFile(path.join(docsDir, 'specs/auth.mdx'), 'utf-8')).split('\n')
    expect(rawLines[ctx.data!.startLine - 1]).toContain('<Spec id="auth.lockout"')
    expect(rawLines[ctx.data!.endLine - 1]).toContain('</Spec>')

    const queried = await callTool<{ blocks: Array<{ id: string; docPath: string; startLine: number }> }>(
      'query_specs',
      { query: 'auth.lockout' },
    )
    expect(queried.isError).toBe(false)
    const hit = queried.data?.blocks.find((b) => b.id === 'auth.lockout')
    expect(hit?.docPath).toBe('specs/auth.mdx')
    expect(hit?.startLine).toBe(ctx.data?.startLine)
  })

  test('[core.mcp-surgical-edit] update_block が対象ブロックのみを書き換え周囲の文書を保持する', async () => {
    const res = await callTool<{ id: string; startLine: number; validation: { ok: boolean } }>('update_block', {
      id: 'auth.lockout',
      body: '3回失敗で10分間ロックする。',
      stability: 'evolving',
    })
    expect(res.isError).toBe(false)
    expect(res.data?.id).toBe('auth.lockout')
    expect(res.data?.validation.ok).toBe(true)

    const updated = await readFile(path.join(docsDir, 'specs/auth.mdx'), 'utf-8')
    expect(updated).toContain('3回失敗で10分間ロックする。')
    expect(updated).toContain('stability="evolving"')
    // 他のブロックや見出しは無傷
    expect(updated).toContain('<Spec id="auth.lockout.notify" stability="evolving">')
    expect(updated).toContain('ロック時に通知を送る。')
    // reviews.json には一切触れない
    expect(existsSync(path.join(docsDir, '.documi/reviews.json'))).toBe(false)
  })

  test('[core.mcp-surgical-edit] add_block と upsert_term と scaffold_document が動作し重複・上書きを拒否する', async () => {
    // add_block (afterHeading)
    const added = await callTool<{ id: string; docId: string; validation: { ok: boolean } }>('add_block', {
      docId: 'specs/auth',
      kind: 'spec',
      id: 'auth.mfa',
      afterHeading: 'Login',
      stability: 'evolving',
      body: '管理者は MFA を必須とする。',
    })
    expect(added.isError).toBe(false)
    expect(added.data?.validation.ok).toBe(true)
    const specFile = await readFile(path.join(docsDir, 'specs/auth.mdx'), 'utf-8')
    expect(specFile.indexOf('auth.mfa')).toBeLessThan(specFile.indexOf('auth.lockout'))

    // 重複 ID は拒否
    const dup = await callTool('add_block', {
      docId: 'specs/auth',
      kind: 'spec',
      id: 'auth.mfa',
      body: '重複',
    })
    expect(dup.isError).toBe(true)

    // upsert_term: 新規追加 → 更新
    const createdTerm = await callTool<{ action: string }>('upsert_term', {
      id: 'Token',
      definition: '認証トークン',
      aliases: ['トークン'],
    })
    expect(createdTerm.isError).toBe(false)
    expect(createdTerm.data?.action).toBe('created')

    const updatedTerm = await callTool<{ action: string }>('upsert_term', {
      id: 'Token',
      definition: 'JWT 形式の認証トークン',
      aliases: ['トークン', 'JWT'],
    })
    expect(updatedTerm.isError).toBe(false)
    expect(updatedTerm.data?.action).toBe('updated')
    const glossary = await readFile(path.join(docsDir, 'domain/glossary.mdx'), 'utf-8')
    expect(glossary).toContain('JWT 形式の認証トークン')

    // scaffold_document: 新規作成 & 既存上書き拒否
    const scaffolded = await callTool<{ docId: string; path: string }>('scaffold_document', {
      path: 'decisions/2026-11-mfa',
      type: 'decision',
      title: 'MFA 方式選定',
      date: '2026-11-22',
      body: '<Outcome id="dec.mfa">TOTP を採用する。</Outcome>',
    })
    expect(scaffolded.isError).toBe(false)
    expect(scaffolded.data?.docId).toBe('decisions/2026-11-mfa')
    expect(existsSync(path.join(docsDir, 'decisions/2026-11-mfa.mdx'))).toBe(true)

    const overwrite = await callTool('scaffold_document', {
      path: 'decisions/2026-11-mfa.mdx',
      title: '上書き禁止',
    })
    expect(overwrite.isError).toBe(true)
  })

  test('[core.mcp-surgical-edit] rename_block_id が dryRun と一括リネームを行い類似プレフィックスを誤置換しない', async () => {
    const dry = await callTool<{ dryRun: boolean; changes: Array<{ path: string; occurrences: number }> }>(
      'rename_block_id',
      { oldId: 'auth.lockout', newId: 'auth.account-lock', dryRun: true },
    )
    expect(dry.isError).toBe(false)
    expect(dry.data?.dryRun).toBe(true)
    expect(dry.data?.changes.map((c) => c.path)).toEqual([
      'docs/designs/auth.mdx',
      'docs/specs/auth.mdx',
      'src/auth.ts',
      'tests/auth.test.ts',
    ])
    // dryRun では未変更
    expect(await readFile(path.join(docsDir, 'specs/auth.mdx'), 'utf-8')).toContain('id="auth.lockout"')

    // 本実行
    const real = await callTool<{ dryRun: boolean; validation: { ok: boolean } }>('rename_block_id', {
      oldId: 'auth.lockout',
      newId: 'auth.account-lock',
    })
    expect(real.isError).toBe(false)
    expect(real.data?.validation.ok).toBe(true)

    const specText = await readFile(path.join(docsDir, 'specs/auth.mdx'), 'utf-8')
    expect(specText).toContain('id="auth.account-lock"')
    // 類似プレフィックス auth.lockout.notify は壊れない
    expect(specText).toContain('id="auth.lockout.notify"')

    const designText = await readFile(path.join(docsDir, 'designs/auth.mdx'), 'utf-8')
    expect(designText).toContain('auth.account-lock')

    const srcText = await readFile(path.join(projectDir, 'src/auth.ts'), 'utf-8')
    expect(srcText).toContain('@implements auth.account-lock')
    expect(srcText).toContain('@implements auth.lockout.notify')

    const testText = await readFile(path.join(projectDir, 'tests/auth.test.ts'), 'utf-8')
    expect(testText).toContain("test('[auth.account-lock] locks account'")
  })

  test('[core.mcp-surgical-edit] MDX 危険構文・パストラバーサル・reviews.json への書き込みをすべて拒否する', async () => {
    // JSX 式を含む更新は拒否されファイルは書き換わらない
    const exprRes = await callTool('update_block', {
      id: 'auth.lockout',
      body: '危険な式 {alert(1)} を含む本文',
    })
    expect(exprRes.isError).toBe(true)
    expect(await readFile(path.join(docsDir, 'specs/auth.mdx'), 'utf-8')).not.toContain('alert(1)')

    // 未許可コンポーネントは拒否
    const compRes = await callTool('add_block', {
      docId: 'specs/auth',
      kind: 'spec',
      id: 'auth.bad',
      body: '<Script>bad()</Script>',
    })
    expect(compRes.isError).toBe(true)

    // パストラバーサルと .documi/reviews.json 書き込みは拒否
    const travRes = await callTool('scaffold_document', {
      path: '../outside.mdx',
      title: 'Escape',
    })
    expect(travRes.isError).toBe(true)

    const revRes = await callTool('scaffold_document', {
      path: '.documi/reviews.json',
      title: 'Forbidden',
    })
    expect(revRes.isError).toBe(true)

    const revMdxRes = await callTool('scaffold_document', {
      path: '.documi/hack.mdx',
      title: 'Forbidden',
    })
    expect(revMdxRes.isError).toBe(true)
  })
})
