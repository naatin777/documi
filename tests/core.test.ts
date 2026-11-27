import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { buildDocTree, getDocument, loadDocuments } from '../src/core/loader'
import { buildProjectMap, getSpecContext } from '../src/core/query'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'documi-test-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeDoc(
  relPath: string,
  frontmatter: Record<string, unknown> | null,
  body = '# Body\n\ncontent\n',
): Promise<void> {
  const file = path.join(root, relPath)
  await mkdir(path.dirname(file), { recursive: true })
  const content = frontmatter === null ? body : `---\n${stringify(frontmatter)}---\n\n${body}`
  await writeFile(file, content)
}

describe('loadDocuments', () => {
  test('[core.document-model] 連番なしで任意階層の Markdown / MDX を再帰走査しパス ID を付与する', async () => {
    await writeDoc('goals/product.mdx', { title: 'Product Goal', description: '目的' })
    await writeDoc('features/auth/spec.mdx', { title: 'Auth Spec', derives: ['goals/product'] })
    await writeDoc('guides/getting-started.md', { title: 'Getting Started' })

    const index = await loadDocuments(root)
    expect(index.documents).toHaveLength(3)

    const goal = getDocument(index, 'goals/product')
    expect(goal?.type).toBe('goal')
    expect(goal?.typeInferred).toBe(true)
    expect(goal?.format).toBe('mdx')

    const authSpec = getDocument(index, 'features/auth/spec')
    expect(authSpec?.type).toBe('spec')
    expect(authSpec?.dir).toBe('features/auth')
    expect(authSpec?.issues).toHaveLength(0)

    const guide = getDocument(index, 'guides/getting-started')
    expect(guide?.format).toBe('markdown')
    expect(guide?.type).toBe('guide')
  })

  test('[core.type-inference] frontmatter が無いファイルでも H1 見出しとパス推論で読み込める', async () => {
    await writeDoc('guides/quick-note.md', null, '# クイックメモ\n\n本文です。\n')

    const index = await loadDocuments(root)
    const doc = getDocument(index, 'guides/quick-note')!
    expect(doc.title).toBe('クイックメモ')
    expect(doc.type).toBe('guide')
    expect(doc.issues.some((i) => i.code === 'missing-frontmatter')).toBe(true)
  })

  test('[core.mdx-blocks] MDX セマンティックブロックを AST 抽出し contentHash を計算する', async () => {
    await writeDoc(
      'goals/core.mdx',
      { title: 'Core Goal' },
      [
        '# Core Goal',
        '',
        '<Constraint id="core.no-eval" scope="mdx" stability="stable">',
        '任意の JavaScript は実行しない。',
        '</Constraint>',
        '',
      ].join('\n'),
    )

    await writeDoc(
      'domain/glossary.mdx',
      { title: '用語集' },
      [
        '# 用語集',
        '',
        '<TermDef id="Artifact" aliases="成果物, 文書" symbols="src/core/types.ts#Document">',
        '管理対象の文書単位。',
        '</TermDef>',
        '',
      ].join('\n'),
    )

    await writeDoc(
      'specs/auth/lockout.mdx',
      { title: 'ロックアウト', derives: ['goals/core'] },
      [
        '# ロックアウト',
        '',
        '<Spec id="auth.lockout" stability="stable">',
        '連続 5 回失敗で <Term name="Artifact" /> をロックする。',
        '</Spec>',
        '',
        '<Note intent="idea" title="将来検討">',
        'パスキー対応は未定。',
        '</Note>',
        '',
      ].join('\n'),
    )

    await writeDoc(
      'decisions/2026-11-bun.mdx',
      { title: 'Bun 採用' },
      [
        '# Bun 採用',
        '',
        '<Decision id="dec.runtime" summary="Bun + Hono を採用する" stability="stable">',
        '  <Context>高速起動と単一ランタイムが必要。</Context>',
        '  <Chosen>Bun + Hono を採用する。</Chosen>',
        '  <Rejected option="Node">起動とビルドが遅い。</Rejected>',
        '  <Tradeoff>一部 Node ネイティブ拡張の互換性に注意。</Tradeoff>',
        '</Decision>',
        '',
      ].join('\n'),
    )

    const index = await loadDocuments(root)
    expect(index.blocksById.size).toBe(5)

    const spec = index.blocksById.get('auth.lockout')!
    expect(spec.kind).toBe('spec')
    expect(spec.intent).toBe('normative')
    expect(spec.stability).toBe('stable')
    expect(spec.contentHash.startsWith('sha256:')).toBe(true)

    const term = index.termsByName.get('成果物')
    expect(term?.id).toBe('Artifact')
    expect(term?.symbols).toEqual(['src/core/types.ts#Document'])

    const decision = index.blocksById.get('dec.runtime')!
    expect(decision.kind).toBe('decision')
    if (decision.kind === 'decision') {
      expect(decision.summary).toBe('Bun + Hono を採用する')
      expect(decision.chosen).toContain('Bun + Hono')
      expect(decision.rejected?.[0]?.option).toBe('Node')
      expect(decision.tradeoff).toContain('互換性')
    }
  })

  test('[core.mdx-blocks] scope:system 全体設計・インラインマイクロ ADR・<Test> 仕様同居が map と context で段階開示される', async () => {
    await writeDoc('goals/core.mdx', { type: 'goal', title: 'Core Goal' })
    await writeDoc(
      'designs/overview.mdx',
      { type: 'design', scope: 'system', title: 'System Overview' },
      '# System Overview\n',
    )
    await writeDoc(
      'decisions/2026-11-global.mdx',
      { type: 'decision', title: 'Global Decision', date: '2026-11-27' },
      '<Decision id="dec.global" summary="全体方針を採用">詳細</Decision>\n',
    )
    await writeDoc(
      'specs/cache.mdx',
      { type: 'spec', title: 'Cache Spec', derives: ['goals/core'] },
      [
        '<Spec id="cache.ttl" derives="goals/core">キャッシュは TTL で失効する。</Spec>',
        '',
        '<Test id="test.cache.ttl" verifies="cache.ttl" level="unit">Given/When/Then</Test>',
      ].join('\n'),
    )
    await writeDoc(
      'designs/cache.mdx',
      { type: 'design', title: 'Cache Design', satisfies: ['cache.ttl'] },
      '<Decision id="dec.cache-ttl" summary="TTL は 5 分にする"><Rejected option="永続">整合性コスト高</Rejected></Decision>\n',
    )

    const index = await loadDocuments(root)
    const map = buildProjectMap(index)
    // map には scope: system の design と独立 decision のみ含まれる（機能 design やインラインマイクロ ADR は含めない）
    expect(map.architecture.map((d) => d.id)).toEqual(['designs/overview'])
    expect(map.decisionOutcomes.map((d) => d.id)).toEqual(['dec.global'])

    // getSpecContext では関連 design 内のインラインマイクロ ADR が返る
    const ctx = getSpecContext(index, 'cache.ttl')
    expect(ctx?.decisionOutcomes.map((d) => d.id)).toEqual(['dec.cache-ttl'])
    expect(ctx?.decisionOutcomes[0]?.body).toBe('TTL は 5 分にする')

    // <Test verifies="cache.ttl"> から verifies エッジが張られる
    expect(index.edges.some((e) => e.from === 'test.cache.ttl' && e.to === 'cache.ttl' && e.kind === 'verifies')).toBe(
      true,
    )
  })

  test('[core.auto-mentions] 本文リンク・Term・SourceRef・Frontmatter からグラフエッジと逆参照を構築する', async () => {
    await writeDoc('goals/core.mdx', { title: 'Core Goal' })
    await writeDoc('domain/glossary.mdx', { title: '用語集' }, '<TermDef id="Account">アカウント</TermDef>\n')
    await writeDoc(
      'specs/auth.mdx',
      { title: 'Auth Spec', derives: ['goals/core'] },
      [
        '<Spec id="auth.login">',
        '<Term name="Account" /> でログインする。詳細は [設計](../designs/auth.mdx) を参照。',
        '</Spec>',
      ].join('\n'),
    )
    await writeDoc(
      'designs/auth.mdx',
      { title: 'Auth Design', satisfies: ['auth.login'] },
      '<SourceRef file="src/auth.ts" symbol="login" satisfies="auth.login" />\n',
    )

    const index = await loadDocuments(root)
    const spec = getDocument(index, 'specs/auth')!
    expect(spec.issues).toHaveLength(0)

    // outgoing: derives -> goals/core, mentions -> designs/auth & Account
    expect(spec.outgoing.some((r) => r.kind === 'derives' && r.ref === 'goals/core')).toBe(true)
    expect(spec.outgoing.some((r) => r.kind === 'mentions' && r.ref === 'designs/auth')).toBe(true)
    expect(spec.outgoing.some((r) => r.kind === 'mentions' && r.ref === 'Account')).toBe(true)

    // incoming: designs/auth --satisfies--> auth.login
    expect(spec.incoming.some((r) => r.kind === 'satisfies' && r.docId === 'designs/auth')).toBe(true)
  })

  test('[core.rooted-dag] Rooted DAG: Goal に繋がっていない normative Spec を orphan-spec として検知する', async () => {
    await writeDoc('goals/main.mdx', { title: 'Main Goal' })
    await writeDoc(
      'specs/linked.mdx',
      { title: 'Linked', derives: ['goals/main'] },
      '<Spec id="ok.spec">上流 Goal あり</Spec>\n',
    )
    await writeDoc(
      'specs/orphan.mdx',
      { title: 'Orphan' },
      [
        '<Spec id="bad.orphan">上流なし</Spec>',
        '',
        '<Spec id="ok.idea" intent="idea">検討中メモは Goal 未接続でも OK</Spec>',
      ].join('\n'),
    )

    const index = await loadDocuments(root)
    expect(getDocument(index, 'specs/linked')!.issues).toHaveLength(0)

    const orphanDoc = getDocument(index, 'specs/orphan')!
    const orphanIssues = orphanDoc.issues.filter((i) => i.code === 'orphan-spec')
    expect(orphanIssues).toHaveLength(1)
    expect(orphanIssues[0]?.blockId).toBe('bad.orphan')
  })

  test('derives の循環参照とブロック ID 重複を検出する', async () => {
    await writeDoc('specs/a.mdx', { title: 'A', derives: ['specs/b'] }, '<Spec id="dup.id">A</Spec>\n')
    await writeDoc('specs/b.mdx', { title: 'B', derives: ['specs/a'] }, '<Spec id="dup.id">B</Spec>\n')

    const index = await loadDocuments(root)
    const allIssues = index.documents.flatMap((d) => d.issues)
    expect(allIssues.some((i) => i.code === 'cycle-detected')).toBe(true)
    expect(allIssues.some((i) => i.code === 'duplicate-block-id')).toBe(true)
  })

  test('[core.mdx-safety] MDX の危険な構文を検出しコードブロック内は無視する', async () => {
    await writeDoc(
      'guides/unsafe.mdx',
      { title: 'Unsafe' },
      [
        '# Unsafe',
        '',
        'import foo from "./foo"',
        '',
        '<Unknown>jsx</Unknown>',
        '',
        '値は {expr} です',
        '',
        '```ts',
        'const a = { safe: true } // import export <div> {}',
        '```',
      ].join('\n'),
    )

    const index = await loadDocuments(root)
    const doc = getDocument(index, 'guides/unsafe')!
    const mdxIssues = doc.issues.filter((i) => i.code === 'mdx-unsupported')
    expect(mdxIssues).toHaveLength(3)
    expect(mdxIssues.some((i) => i.message.includes('ESM'))).toBe(true)
    expect(mdxIssues.some((i) => i.message.includes('JSX'))).toBe(true)
    expect(mdxIssues.some((i) => i.message.includes('<Unknown>'))).toBe(true)
  })

  test('buildDocTree でディレクトリ優先の階層ツリーを構築する', async () => {
    await writeDoc('overview.mdx', { type: 'guide', title: 'Top' })
    await writeDoc('auth/spec.mdx', { title: 'Auth Spec' })
    await writeDoc('auth/sub/detail.mdx', { type: 'design', title: 'Detail' })

    const index = await loadDocuments(root)
    const tree = buildDocTree(index.documents)
    expect(tree[0]?.kind).toBe('dir')
    expect(tree[0]?.name).toBe('auth')
    expect(tree[1]?.kind).toBe('doc')
    expect(tree[1]?.name).toBe('overview')
  })

  test('frontmatter の任意 date (YYYY-MM-DD / YYYY-MM) を解析し decision を新しい決定日順に整列する', async () => {
    await writeDoc('decisions/older.mdx', { title: '古い決定', date: '2026-01-10' })
    await writeDoc('decisions/newer.mdx', { title: '新しい決定', date: '2026-11-21' })
    await writeDoc('decisions/month-only.mdx', { title: '年月のみ', date: '2026-06' })
    await writeDoc('decisions/undated.mdx', { title: '日付なし' })
    await writeDoc('decisions/bad-date.mdx', { title: '不正日付', date: '2026/99/99' })

    const index = await loadDocuments(root)
    const decisions = index.documents.filter((d) => d.type === 'decision')
    expect(decisions.map((d) => d.id)).toEqual([
      'decisions/newer',
      'decisions/month-only',
      'decisions/older',
      'decisions/bad-date',
      'decisions/undated',
    ])
    expect(getDocument(index, 'decisions/newer')?.date).toBe('2026-11-21')
    expect(getDocument(index, 'decisions/bad-date')?.issues.some((i) => i.code === 'invalid-date')).toBe(true)
  })
})
