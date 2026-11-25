import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { stringify } from 'yaml'
import { resolveBundleDocuments, searchIndex } from '../src/core/bundle'
import { loadDocuments } from '../src/core/loader'
import { createApp } from '../src/server/app'
import { DocsStore } from '../src/server/store'
import Markdown from '../src/web/components/Markdown'
import { bundleDocAnchor } from '../src/web/mdast'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'documi-phase4-test-'))
  const write = async (rel: string, fm: Record<string, unknown>, body: string) => {
    const file = path.join(root, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `---\n${stringify(fm)}---\n\n${body}`)
  }

  await write('goals/security.mdx', { title: 'セキュリティ目標' }, '# セキュリティ目標\n')
  await write('goals/other.mdx', { title: '別目標' }, '# 別目標\n')
  await write(
    'domain/glossary.mdx',
    { title: '用語集' },
    '<TermDef id="Account" aliases="アカウント">利用者単位</TermDef>\n',
  )
  await write(
    'specs/auth/lockout.mdx',
    { title: 'アカウントロック仕様', derives: ['goals/security'], tags: ['auth'] },
    '<Spec id="auth.lockout" stability="stable"><Term name="Account" /> を5回失敗でロックする。</Spec>\n',
  )
  await write('designs/auth.mdx', { title: '認証設計', satisfies: ['auth.lockout'] }, 'ロック処理の詳細設計。\n')
  await write('verification/auth.mdx', { title: '認証検証', verifies: ['auth.lockout'] }, 'ロック動作のテスト方針。\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('Bundle / Search', () => {
  test('[core.bundle-export] resolveBundleDocuments は all / dir / goal / ids スコープで正しく解決する', async () => {
    const idx = await loadDocuments(root)

    expect(resolveBundleDocuments(idx, { scope: 'all' }).documents).toHaveLength(6)
    expect(resolveBundleDocuments(idx, { scope: 'dir:specs' }).documents.map((d) => d.id)).toEqual([
      'specs/auth/lockout',
    ])

    // goal:goals/security から下流 Spec / Design / Verification と関連用語集を自動収集し、無関係な goals/other は含めない
    const goalBundle = resolveBundleDocuments(idx, { scope: 'goal:goals/security' })
    const goalIds = goalBundle.documents.map((d) => d.id)
    expect(goalIds).toContain('goals/security')
    expect(goalIds).toContain('specs/auth/lockout')
    expect(goalIds).toContain('designs/auth')
    expect(goalIds).toContain('verification/auth')
    expect(goalIds).toContain('domain/glossary')
    expect(goalIds).not.toContain('goals/other')

    const custom = resolveBundleDocuments(idx, { ids: ['designs/auth', 'goals/security'] })
    expect(custom.documents.map((d) => d.id)).toEqual(['designs/auth', 'goals/security'])
  })

  test('[core.full-text-search] searchIndex はドキュメントとブロックをスコアリング検索する', async () => {
    const idx = await loadDocuments(root)
    const hits = searchIndex(idx, 'auth.lockout')
    expect(hits[0]?.kind).toBe('block')
    expect(hits[0]?.id).toBe('auth.lockout')

    const byTag = searchIndex(idx, 'アカウント')
    expect(byTag.some((h) => h.id === 'Account')).toBe(true)
    expect(byTag.some((h) => h.docId === 'specs/auth/lockout')).toBe(true)

    // description にクエリ語が含まれない場合でも、本文のヒット箇所前後をスニペット抽出する
    const bodyOnly = searchIndex(idx, 'テスト方針')
    const verDocHit = bodyOnly.find((h) => h.kind === 'doc' && h.id === 'verification/auth')
    expect(verDocHit?.snippet).toContain('テスト方針')
  })

  test('REST API (/api/search, /api/bundle) と MCP search_documents が動作する', async () => {
    const store = await DocsStore.open(root, { enrichTrace: false })
    const app = createApp(store)

    const searchRes = await app.fetch(new Request('http://localhost/api/search?q=ロック'))
    expect(searchRes.status).toBe(200)
    const searchBody = (await searchRes.json()) as { count: number }
    expect(searchBody.count).toBeGreaterThan(0)

    const bundleRes = await app.fetch(new Request('http://localhost/api/bundle?scope=goal:goals/security'))
    expect(bundleRes.status).toBe(200)
    const bundleBody = (await bundleRes.json()) as { documents: { id: string }[]; summary: { documentCount: number } }
    expect(bundleBody.summary.documentCount).toBe(5)

    const mcpRes = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: { name: 'search_documents', arguments: { query: 'ロック' } },
        }),
      }),
    )
    expect(mcpRes.status).toBe(200)
    const mcpBody = (await mcpRes.json()) as { result?: { structuredContent?: { count: number } } }
    expect(mcpBody.result?.structuredContent?.count).toBeGreaterThan(0)
  })

  test('[ui.bundle-export] バンドルモード描画: リンクのページ内アンカー化・見出し ID 名前空間化・全タブ展開', () => {
    const bundleIds = new Set(['goals/security', 'specs/auth/lockout'])
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Markdown
          body={[
            '## 目的',
            '',
            '[目標](../../goals/security.mdx)',
            '',
            '<Tabs>',
            '<Tabs.Tab label="TabA">内容A</Tabs.Tab>',
            '<Tabs.Tab label="TabB">内容B</Tabs.Tab>',
            '</Tabs>',
          ].join('\n')}
          format="mdx"
          currentDir="specs/auth"
          bundleDocIds={bundleIds}
          headingPrefix={bundleDocAnchor('specs/auth/lockout')}
          expandAllTabs
        />
      </MemoryRouter>,
    )

    expect(html).toContain(`id="${bundleDocAnchor('specs/auth/lockout')}-目的"`)
    expect(html).toContain(`href="#${bundleDocAnchor('goals/security')}"`)
    expect(html).toContain('mdx-tabs-expanded')
    expect(html).toContain('内容A')
    expect(html).toContain('内容B')
  })
})
