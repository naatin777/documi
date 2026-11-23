import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { hc } from 'hono/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { stringify } from 'yaml'
import type { SemanticBlock } from '../src/core/types'
import { createApp, type ApiRoutes } from '../src/server/app'
import { DocsStore } from '../src/server/store'
import DocTabs from '../src/web/components/DocTabs'
import Explorer from '../src/web/components/Explorer'
import Markdown from '../src/web/components/Markdown'
import OverviewLayout from '../src/web/components/OverviewLayout'
import ReviewLayout from '../src/web/components/ReviewLayout'
import SearchModal from '../src/web/components/SearchModal'
import { DocReviewProvider, SpecBlock } from '../src/web/components/SemanticBlocks'
import SidePanel from '../src/web/components/SidePanel'
import { setAppLocale } from '../src/web/i18n'
import { LiveProvider } from '../src/web/live'
import { TabsProvider } from '../src/web/tabs'
import { ThemeProvider } from '../src/web/theme'

let root: string

beforeEach(async () => {
  setAppLocale('ja')
  root = await mkdtemp(path.join(tmpdir(), 'documi-ui-test-'))
  const write = async (rel: string, fm: Record<string, unknown>, body: string) => {
    const file = path.join(root, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `---\n${stringify(fm)}---\n\n${body}`)
  }

  await write('goals/core.mdx', { title: 'コア目標' }, '# コア目標\n')
  await write(
    'domain/glossary.mdx',
    { title: '用語集' },
    '<TermDef id="SpecBlock" aliases="仕様ブロック" symbols="src/core/types.ts#SemanticBlock">仕様の最小単位</TermDef>\n',
  )
  await write(
    'specs/sample.mdx',
    { title: 'サンプル仕様', derives: ['goals/core'] },
    '<Spec id="sample.rule" stability="stable">仕様ブロックを正しく描画する。</Spec>\n',
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('Web UI & Live Spec Dogfooding', () => {
  test('[ui.web-viewer] OverviewLayout と /api/overview が統計・Goal・Review・Realization 構造を提供する', async () => {
    const store = await DocsStore.open(root, { enrichTrace: false })
    const app = createApp(store)
    const client = hc<ApiRoutes>('http://localhost', {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init)),
    })

    const res = await client.api.overview.$get()
    expect(res.status).toBe(200)
    const overview = await res.json()
    expect(overview.documentCount).toBe(3)
    expect(overview.goals).toHaveLength(1)
    expect(overview.reviews.unreviewed).toBeGreaterThan(0)

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LiveProvider>
          <TabsProvider>
            <OverviewLayout />
          </TabsProvider>
        </LiveProvider>
      </MemoryRouter>,
    )
    expect(html).toContain('プロジェクト概要')
  })

  test('[ui.explorer-modes] 1 本サイドバーが Home / Review Queue / Graph と Flow・Files 切替を提供する', async () => {
    const store = await DocsStore.open(root, { enrichTrace: false })
    const app = createApp(store)
    const treeRes = await app.fetch(new Request('http://localhost/api/tree'))
    expect(treeRes.status).toBe(200)
    const treeBody = (await treeRes.json()) as { tree: { kind: string; name: string }[] }
    expect(treeBody.tree.some((n) => n.kind === 'dir' && n.name === 'specs')).toBe(true)

    const blocksRes = await app.fetch(new Request('http://localhost/api/blocks'))
    expect(blocksRes.status).toBe(200)
    const blocksBody = (await blocksRes.json()) as { blocks: { id: string }[]; counts: { unreviewed: number } }
    expect(blocksBody.blocks.some((b) => b.id === 'sample.rule')).toBe(true)
    expect(blocksBody.counts.unreviewed).toBeGreaterThan(0)

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ThemeProvider>
          <LiveProvider>
            <Explorer reviewBadgeCount={3} onClose={() => {}} onOpenSearch={() => {}} />
          </LiveProvider>
        </ThemeProvider>
      </MemoryRouter>,
    )
    expect(html).toContain('ホーム')
    expect(html).toContain('レビュー')
    expect(html).toContain('>3<')
    expect(html).toContain('グラフ・関連表')
    expect(html).toContain('流れ順')
    expect(html).toContain('フォルダ順')
    expect(html).toContain('目標')

    setAppLocale('en')
    const enHtml = renderToStaticMarkup(
      <MemoryRouter>
        <ThemeProvider>
          <LiveProvider>
            <Explorer reviewBadgeCount={3} onClose={() => {}} onOpenSearch={() => {}} />
          </LiveProvider>
        </ThemeProvider>
      </MemoryRouter>,
    )
    expect(enHtml).toContain('Home')
    expect(enHtml).toContain('Review Queue')
    expect(enHtml).toContain('Goals')
    setAppLocale('ja')

    const reviewHtml = renderToStaticMarkup(
      <MemoryRouter>
        <LiveProvider>
          <TabsProvider>
            <ReviewLayout />
          </TabsProvider>
        </LiveProvider>
      </MemoryRouter>,
    )
    expect(reviewHtml).toContain('レビュー')

    const sampleDoc = store.getIndex().byId.get('specs/sample')!
    const sideHtml = renderToStaticMarkup(
      <MemoryRouter>
        <SidePanel doc={sampleDoc} headings={[]} onPeek={() => {}} onCollapse={() => {}} />
      </MemoryRouter>,
    )
    expect(sideHtml).toContain('目次')
    expect(sideHtml).toContain('関連リンク')
    expect(sideHtml).toContain('sample.rule')

    const tabsHtml = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/graph']}>
        <TabsProvider>
          <DocTabs sidebarOpen onToggleSidebar={() => {}} />
        </TabsProvider>
      </MemoryRouter>,
    )
    expect(tabsHtml).toContain('グラフ・関連表')
    expect(tabsHtml).toContain('サイドバーを閉じる')
  })

  test('[ui.live-reload] SSE /api/events は接続イベントと store.reload 後の reload イベントを配信する', async () => {
    const store = await DocsStore.open(root, { enrichTrace: false })
    const app = createApp(store)
    const res = await app.fetch(new Request('http://localhost/api/events'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    const first = await reader.read()
    expect(decoder.decode(first.value)).toContain('event: connected')

    await store.reload()
    const second = await reader.read()
    expect(decoder.decode(second.value)).toContain('event: reload')

    await reader.cancel()
  })

  test('[ui.human-review] SemanticBlocks はレビュー状態・Realization・未解決フィードバックを UI に描画する', () => {
    const block: SemanticBlock = {
      id: 'sample.rule',
      kind: 'spec',
      docId: 'specs/sample',
      intent: 'normative',
      stability: 'stable',
      review: 'stale',
      suspect: true,
      suspectSources: ['goals/core'],
      feedback: [
        {
          id: 'fb-1',
          author: 'reviewer',
          body: 'エッジケースを追記してほしい',
          createdAt: '2026-11-21T00:00:00Z',
          resolved: false,
        },
      ],
      rawBody: '仕様ブロックを正しく描画する。',
      contentHash: 'sha256:test',
      startLine: 1,
      endLine: 1,
      derives: [],
      supersedes: [],
      realization: {
        status: 'verified',
        implementations: [{ kind: 'implements', specId: 'sample.rule', file: 'src/a.ts', line: 1 }],
        verifications: [{ kind: 'verifies', specId: 'sample.rule', file: 'tests/a.test.ts', line: 1 }],
        testResults: [{ specId: 'sample.rule', name: '[sample.rule] ok', status: 'passed' }],
        pullRequests: [],
        reasons: [],
      },
    }

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <DocReviewProvider blocks={[block]} onMutate={() => {}}>
          <SpecBlock id="sample.rule" stability="stable">
            仕様ブロックを正しく描画する。
          </SpecBlock>
        </DocReviewProvider>
      </MemoryRouter>,
    )

    expect(html).toContain('sample.rule')
    expect(html).toContain('要再確認（承認後に変更）')
    expect(html).toContain('上流変更')
    expect(html).toContain('検証済み (1/1)')
    expect(html).toContain('差分')
    expect(html).toContain('💬 1')
    expect(html).toContain('>承認</button>')
  })

  test('[ui.glossary-autolink] Markdown は登録済み用語・別名を本文中で自動リンクしコードや見出し内は除外する', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LiveProvider>
          <Markdown
            body={'# 仕様ブロックの見出し\n\n本文中の仕様ブロックと `仕様ブロック` の扱い。'}
            format="mdx"
            terms={[
              {
                id: 'SpecBlock',
                docId: 'domain/glossary',
                docTitle: '用語集',
                aliases: ['仕様ブロック'],
                symbols: ['src/core/types.ts#SemanticBlock'],
                rawBody: '仕様の最小単位',
              },
            ]}
          />
        </LiveProvider>
      </MemoryRouter>,
    )

    // 本文中の「仕様ブロック」は用語リンク化される
    expect(html).toContain('term-inline')
    expect(html).toContain('/docs/domain/glossary')
    // インラインコード内はリンク化されず生テキストのまま
    expect(html).toContain('<code>仕様ブロック</code>')
    // 見出し内はリンク化されない
    expect(html).toContain('>仕様ブロックの見出し</h1>')
  })

  test('[ui.graph-matrix] /api/graph (docs/blocks) と /api/matrix がネットワークと追跡表データを返す', async () => {
    const store = await DocsStore.open(root, { enrichTrace: false })
    const app = createApp(store)
    const client = hc<ApiRoutes>('http://localhost', {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init)),
    })

    const gRes = await client.api.graph.$get({ query: { layers: 'all', granularity: 'blocks' } })
    expect(gRes.status).toBe(200)
    if (gRes.status === 200) {
      const g = await gRes.json()
      expect(g.granularity).toBe('blocks')
      expect(g.nodes.some((n) => n.kind === 'block' && n.id === 'sample.rule')).toBe(true)
    }

    const mRes = await client.api.matrix.$get()
    expect(mRes.status).toBe(200)
    const m = await mRes.json()
    expect(m.rows.map((r) => r.specId)).toEqual(['sample.rule'])
  })

  test('[ui.search-palette] SearchModal が検索ダイアログを描画し /api/search と連携する', async () => {
    const store = await DocsStore.open(root, { enrichTrace: false })
    const app = createApp(store)
    const res = await app.fetch(new Request('http://localhost/api/search?q=sample.rule'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { count: number; results: { id: string }[] }
    expect(body.count).toBeGreaterThan(0)
    expect(body.results[0]?.id).toBe('sample.rule')

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LiveProvider>
          <SearchModal open onClose={() => {}} />
        </LiveProvider>
      </MemoryRouter>,
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('検索')
  })

  test('documi init CLI は新規プロジェクト向け docs/ 雛形を生成し documi check をパスする', async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), 'documi-init-test-'))
    try {
      const docsDir = path.join(targetDir, 'docs')
      const initProc = Bun.spawnSync(['bun', 'src/cli.ts', 'init', '--docs', docsDir], {
        cwd: process.cwd(),
      })
      expect(initProc.exitCode).toBe(0)

      const checkProc = Bun.spawnSync(['bun', 'src/cli.ts', 'check', '--docs', docsDir, '--project', targetDir], {
        cwd: process.cwd(),
      })
      expect(checkProc.exitCode).toBe(0)
    } finally {
      await rm(targetDir, { recursive: true, force: true })
    }
  })
})
