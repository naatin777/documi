import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { runCli } from '../src/cli'
import { loadDocuments } from '../src/core/loader'
import {
  expandQueryWithGlossary,
  reciprocalRankFusion,
  retrieveContext,
  searchIndexBm25,
  tokenizeForSearch,
} from '../src/core/retrieval'
import { createApp } from '../src/server/app'
import { DocsStore } from '../src/server/store'

let projectDir: string
let docsDir: string

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), 'documi-retrieval-'))
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

  await writeDoc(
    'goals/security.mdx',
    { type: 'goal', title: '認証セキュリティ目標', description: '不正ログインと乗っ取りを構造で防ぐ' },
    '# 認証セキュリティ目標\n',
  )
  await writeDoc(
    'domain/glossary.mdx',
    { type: 'domain', title: 'ドメイン用語集' },
    [
      '# ドメイン用語集',
      '',
      '<TermDef id="AccountLockout" aliases="アカウント凍結, ロックアウト" symbols="src/auth.ts#lockAccount">',
      '  連続認証失敗時にログインを一時停止する保護機構。',
      '</TermDef>',
      '',
    ].join('\n'),
  )
  await writeDoc(
    'decisions/2026-11-lockout-policy.mdx',
    { type: 'decision', title: 'ロックアウト方式の選定', date: '2026-11-20', derives: ['goals/security'] },
    [
      '# ロックアウト方式の選定',
      '',
      '<Decision id="dec.lockout-policy" stability="stable">',
      '  5回連続失敗で 15 分間の指数バックオフ付きロックを適用する。',
      '</Decision>',
      '',
      '関連仕様: [認証仕様](../specs/auth.mdx)',
      '',
    ].join('\n'),
  )
  await writeDoc(
    'specs/auth.mdx',
    { type: 'spec', title: '認証仕様', derives: ['goals/security'] },
    [
      '# 認証仕様',
      '',
      '<Spec id="auth.lockout" stability="stable">',
      '  **When** ユーザーが 5 回連続でパスワード認証に失敗したとき、',
      '  **the** 認証システム **shall** 対象アカウントに AccountLockout を適用し 15 分間ログインを拒否する。',
      '</Spec>',
      '',
    ].join('\n'),
  )
  await writeDoc(
    'designs/auth.mdx',
    { type: 'design', title: '認証設計', satisfies: ['auth.lockout'] },
    '# 認証設計\n\n<SourceRef file="src/auth.ts" symbol="lockAccount" satisfies="auth.lockout" />\n',
  )
  await writeSrc('src/auth.ts', '// @implements auth.lockout\nexport function lockAccount() { return true }\n')
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

describe('BM25 + Glossary Alias Expansion + Graph-Aware Retrieval', () => {
  test('[core.graph-retrieval] 日本語自然文（Intl.Segmenter 単語分割）と camelCase/dot ID をトークナイズして BM25 検索できる', async () => {
    const jpTokens = tokenizeForSearch('認証のロックアウト仕様はどうなっている？')
    expect(jpTokens).toContain('認証')
    expect(jpTokens).toContain('ロックアウト')
    expect(jpTokens).toContain('仕様')
    expect(jpTokens).not.toContain('の')

    // 複合カタカナや送り仮名付き和語も自然に単語分割される
    const compoundTokens = tokenizeForSearch('アカウントロックアウトの書き出しと取り消し')
    expect(compoundTokens).toContain('アカウント')
    expect(compoundTokens).toContain('ロックアウト')
    expect(compoundTokens).toContain('書き出し')
    expect(compoundTokens).toContain('取り消し')
    expect(compoundTokens).not.toContain('の')
    expect(compoundTokens).not.toContain('と')

    const idTokens = tokenizeForSearch('core.static-site buildProjectMap')
    expect(idTokens).toContain('core.static-site')
    expect(idTokens).toContain('static')
    expect(idTokens).toContain('project')

    const index = await loadDocuments(docsDir)
    // スペース無しの日本語自然文でも auth.lockout が上位ヒットする
    const { hits } = searchIndexBm25(index, 'パスワード認証に失敗したときのロック')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.id === 'auth.lockout')).toBe(true)
  })

  test('[core.graph-retrieval] 用語集 aliases でクエリを自動拡張し、別名クエリから仕様を引ける', async () => {
    const index = await loadDocuments(docsDir)
    const expanded = expandQueryWithGlossary(index, 'アカウント凍結のルール')
    expect(expanded.expandedTerms).toContain('AccountLockout')
    expect(expanded.expandedTerms).toContain('ロックアウト')

    // 本文に「アカウント凍結」の文字は無いが、TermDef alias 展開で auth.lockout がヒットする
    const { hits, expandedTerms } = searchIndexBm25(index, 'アカウント凍結のルール')
    expect(expandedTerms).toContain('AccountLockout')
    expect(hits.some((h) => h.id === 'auth.lockout')).toBe(true)
  })

  test('[core.graph-retrieval] retrieveContext がグラフ展開（Goal / Decision Outcome / Design / 用語 / SourceRef）と予算制限を行う', async () => {
    const store = await DocsStore.open(docsDir, { projectRoot: projectDir })
    // クエリに「設計」を含めなくても、auth.lockout からのグラフ辺 (satisfies) 経由で designs/auth と SourceRef が自動収集される
    const res = retrieveContext(store.getIndex(), 'アカウント凍結の条件', { limit: 3, budget: 4000 })

    expect(res.mode).toBe('bm25+graph')
    expect(res.expandedTerms).toContain('AccountLockout')
    expect(res.hits.some((h) => h.id === 'auth.lockout')).toBe(true)
    expect(res.upstreamGoals.map((g) => g.id)).toContain('goals/security')
    expect(res.decisions.map((o) => o.id)).toContain('dec.lockout-policy')
    expect(res.relatedDocuments.map((d) => d.id)).toContain('designs/auth')
    expect(res.relevantTerms.map((t) => t.id)).toContain('AccountLockout')
    expect(res.sourceRefs.some((r) => r.file === 'src/auth.ts')).toBe(true)
    expect(res.budgetUsed).toBeLessThanOrEqual(res.budgetLimit)

    // 厳しい予算では出力が予算内に収まる
    const tight = retrieveContext(store.getIndex(), 'アカウント凍結の仕様', { budget: 500 })
    expect(tight.budgetLimit).toBe(500)
    expect(tight.budgetUsed).toBeLessThanOrEqual(500)
  })

  test('[core.graph-retrieval] RRF 統合・CLI documi search --context・MCP search_documents (includeContext) が動作する', async () => {
    // RRF は複数ランキングで上位に共通出現する要素を最上位にする
    const fused = reciprocalRankFusion([
      [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
      [{ key: 'b' }, { key: 'c' }, { key: 'd' }],
    ])
    expect((fused.get('b') ?? 0) > (fused.get('a') ?? 0)).toBe(true)
    expect((fused.get('b') ?? 0) > (fused.get('d') ?? 0)).toBe(true)

    // CLI documi search --context (--json & テキスト)
    const out: string[] = []
    const code = await runCli(['search', 'アカウント凍結', '--context', '--project', projectDir, '--json'], {
      out: (l) => out.push(l),
      err: () => {},
      readStdin: async () => '',
    })
    expect(code).toBe(0)
    const parsed = JSON.parse(out.join('\n')) as { hits: Array<{ id: string }>; upstreamGoals: Array<{ id: string }> }
    expect(parsed.hits.some((h) => h.id === 'auth.lockout')).toBe(true)
    expect(parsed.upstreamGoals.map((g) => g.id)).toContain('goals/security')

    const textOut: string[] = []
    const textCode = await runCli(['search', 'アカウント凍結', '--context', '--project', projectDir], {
      out: (l) => textOut.push(l),
      err: () => {},
      readStdin: async () => '',
    })
    expect(textCode).toBe(0)
    expect(textOut.join('\n')).toContain('Retrieve "アカウント凍結"')
    expect(textOut.join('\n')).toContain('auth.lockout')

    // MCP search_documents (includeContext: true)
    const store = await DocsStore.open(docsDir, { projectRoot: projectDir })
    const app = createApp(store, { projectRoot: projectDir })
    const res = await app.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'search_documents',
            arguments: { query: 'アカウント凍結の設計', includeContext: true, budget: 4000 },
          },
        }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result?: { structuredContent?: { hits: Array<{ id: string }>; decisions: Array<{ id: string }> } }
    }
    expect(body.result?.structuredContent?.hits.some((h) => h.id === 'auth.lockout')).toBe(true)
    expect(body.result?.structuredContent?.decisions.map((o) => o.id)).toContain('dec.lockout-policy')
  })
})
