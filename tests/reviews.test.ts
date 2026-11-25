import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { runDocsCheck } from '../src/core/checker'
import { getChangedBlockIds } from '../src/core/git'
import { loadDocuments } from '../src/core/loader'
import { approveBlock, computeLineDiff, getBlockDiff, loadReviews, unapproveBlock } from '../src/core/reviews'
import { enrichWithRealization } from '../src/core/trace'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'documi-reviews-test-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeDoc(relPath: string, fm: Record<string, unknown>, body: string): Promise<void> {
  const file = path.join(root, relPath)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `---\n${stringify(fm)}---\n\n${body}`)
}

describe('人間レビュー・Stale・Suspect・Diff・承認メモ', () => {
  test('[core.human-review] 承認 → 本文変更で stale 化 → ローカルキャッシュから行 diff を取得できる', async () => {
    await writeDoc('goals/main.mdx', { title: 'Main Goal' }, '# Main Goal\n')
    await writeDoc(
      'specs/auth.mdx',
      { title: 'Auth', derives: ['goals/main'] },
      '<Spec id="auth.lockout">\n5回失敗でロックする。\n15分後に解除する。\n</Spec>\n',
    )

    // 初期状態は unreviewed
    let idx = await loadDocuments(root)
    expect(idx.blocksById.get('auth.lockout')?.review).toBe('unreviewed')

    // 承認すると approved
    expect((await approveBlock(root, idx, 'auth.lockout', { author: 'alice' })).isOk()).toBe(true)
    idx = await loadDocuments(root)
    const approved = idx.blocksById.get('auth.lockout')!
    expect(approved.review).toBe('approved')
    expect(approved.approvedBy).toBe('alice')

    // 本文を書き換えると自動で stale になる
    await writeDoc(
      'specs/auth.mdx',
      { title: 'Auth', derives: ['goals/main'] },
      '<Spec id="auth.lockout">\n3回失敗でロックする。\n15分後に解除する。\n</Spec>\n',
    )
    idx = await loadDocuments(root)
    expect(idx.blocksById.get('auth.lockout')?.review).toBe('stale')

    // Diff 取得
    const diffRes = await getBlockDiff(root, idx, 'auth.lockout')
    expect(diffRes.isOk()).toBe(true)
    const diff = diffRes.unwrap()
    expect(diff.baseSource).toBe('cache')
    expect(diff.changed).toBe(true)
    expect(diff.lines.some((l) => l.type === 'del' && l.text.includes('5回失敗'))).toBe(true)
    expect(diff.lines.some((l) => l.type === 'add' && l.text.includes('3回失敗'))).toBe(true)
  })

  test('Git コミット済みの承認から git show ベースで diff を取得できる', async () => {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: root, stdio: 'ignore' })

    const docsDir = path.join(root, 'docs')
    await mkdir(path.join(docsDir, 'goals'), { recursive: true })
    await mkdir(path.join(docsDir, 'specs'), { recursive: true })
    await writeFile(path.join(docsDir, 'goals/main.mdx'), '---\ntitle: Goal\n---\n\n# Goal\n')
    await writeFile(
      path.join(docsDir, 'specs/lock.mdx'),
      '---\ntitle: Lock\nderives: [goals/main]\n---\n\n<Spec id="lock.rule">旧ルール</Spec>\n',
    )
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' })

    let idx = await loadDocuments(docsDir)
    await approveBlock(docsDir, idx, 'lock.rule')

    // ローカルキャッシュを消しても git show から diff が取れる
    await rm(path.join(docsDir, '.documi/cache'), { recursive: true, force: true })
    await writeFile(
      path.join(docsDir, 'specs/lock.mdx'),
      '---\ntitle: Lock\nderives: [goals/main]\n---\n\n<Spec id="lock.rule">新ルール</Spec>\n',
    )

    idx = await loadDocuments(docsDir)
    const diff = (await getBlockDiff(docsDir, idx, 'lock.rule')).unwrap()
    expect(diff.baseSource).toBe('git')
    expect(diff.changed).toBe(true)
    expect(diff.lines).toEqual([
      { type: 'del', text: '旧ルール' },
      { type: 'add', text: '新ルール' },
    ])
  })

  test('上流 Spec の変更で下流の承認済みブロックが Suspect になる', async () => {
    await writeDoc('goals/main.mdx', { title: 'Goal' }, '# Goal\n')
    await writeDoc(
      'specs/auth.mdx',
      { title: 'Auth', derives: ['goals/main'] },
      '<Spec id="auth.lockout">5回失敗でロック</Spec>\n',
    )
    await writeDoc(
      'designs/auth.mdx',
      { title: 'Auth Design', satisfies: ['auth.lockout'] },
      '<Constraint id="design.auth.counter">失敗回数は Redis に保存する</Constraint>\n',
    )

    let idx = await loadDocuments(root)
    await approveBlock(root, idx, 'auth.lockout')
    await approveBlock(root, idx, 'design.auth.counter')

    idx = await loadDocuments(root)
    expect(idx.blocksById.get('design.auth.counter')?.suspect).toBe(false)

    // 上流 Spec を変更
    await writeDoc(
      'specs/auth.mdx',
      { title: 'Auth', derives: ['goals/main'] },
      '<Spec id="auth.lockout">3回失敗でロック</Spec>\n',
    )
    idx = await loadDocuments(root)
    const downstream = idx.blocksById.get('design.auth.counter')!
    expect(downstream.review).toBe('approved')
    expect(downstream.suspect).toBe(true)
    expect(downstream.suspectSources).toContain('auth.lockout')
  })

  test('[core.human-review] suspect は軽量な参考通知に留め、実装済み Spec を drifted にせず --strict でもエラーにしない', async () => {
    const projectDir = root
    const docsDir = path.join(projectDir, 'docs')
    await mkdir(path.join(docsDir, 'goals'), { recursive: true })
    await mkdir(path.join(docsDir, 'specs'), { recursive: true })
    await mkdir(path.join(projectDir, 'src'), { recursive: true })

    await writeFile(path.join(docsDir, 'goals/main.mdx'), '---\ntitle: Goal\n---\n\n# Goal v1\n')
    await writeFile(
      path.join(docsDir, 'specs/auth.mdx'),
      '---\ntitle: Auth\nderives: [goals/main]\n---\n\n<Spec id="auth.lockout" stability="stable">5回失敗でロック</Spec>\n',
    )
    await writeFile(
      path.join(projectDir, 'src/auth.ts'),
      '// @implements auth.lockout\nexport const lock = () => true\n',
    )

    let idx = await loadDocuments(docsDir)
    await approveBlock(docsDir, idx, 'auth.lockout')

    // 上流 Goal の文言だけ軽く修正する
    await writeFile(path.join(docsDir, 'goals/main.mdx'), '---\ntitle: Goal\n---\n\n# Goal v2 (言い回し調整)\n')

    idx = await loadDocuments(docsDir)
    await enrichWithRealization(idx, { projectRoot: projectDir })
    const spec = idx.blocksById.get('auth.lockout')!
    expect(spec.review).toBe('approved')
    expect(spec.suspect).toBe(true)
    expect(spec.realization?.status).toBe('implemented')

    const report = await runDocsCheck({ docsDir, projectRoot: projectDir, strict: true })
    expect(report.ok).toBe(true)
    expect(report.errors).toHaveLength(0)
    expect(report.warnings).toHaveLength(0)
    expect(report.reviewCounts.suspect).toBe(1)
  })

  test('[core.human-review] Suspect は多段依存でもブロックの走査順に依存せず下流まで波及する', async () => {
    await writeDoc('goals/main.mdx', { title: 'Goal' }, '# Goal\n')
    await writeDoc('specs/a.mdx', { title: 'A', derives: ['goals/main'] }, '<Spec id="spec.a">元の仕様</Spec>\n')
    // 走査順で下流 (a-c) が中間 (b-b) より先に処理される配置にする
    await writeDoc(
      'designs/b-b.mdx',
      { title: 'B', satisfies: ['spec.a'] },
      '<Constraint id="design.b">中間制約</Constraint>\n',
    )
    await writeDoc(
      'designs/a-c.mdx',
      { title: 'C', satisfies: ['design.b'] },
      '<Constraint id="design.c">下流制約</Constraint>\n',
    )

    let idx = await loadDocuments(root)
    for (const id of ['spec.a', 'design.b', 'design.c']) {
      expect((await approveBlock(root, idx, id)).isOk()).toBe(true)
    }

    await writeDoc('specs/a.mdx', { title: 'A', derives: ['goals/main'] }, '<Spec id="spec.a">変更後の仕様</Spec>\n')
    idx = await loadDocuments(root)
    expect(idx.blocksById.get('spec.a')?.review).toBe('stale')
    expect(idx.blocksById.get('design.b')?.suspect).toBe(true)
    const downstream = idx.blocksById.get('design.c')!
    expect(downstream.suspect).toBe(true)
    expect(downstream.suspectSources).toContain('design.b')
  })

  test('[core.human-review] 並行承認でも reviews.json の更新が失われず一時ファイルも残らない', async () => {
    await writeDoc('goals/main.mdx', { title: 'Goal' }, '# Goal\n')
    const ids = Array.from({ length: 8 }, (_, i) => `conc.item${i + 1}`)
    await writeDoc(
      'specs/conc.mdx',
      { title: 'Conc', derives: ['goals/main'] },
      ids.map((id) => `<Spec id="${id}">仕様 ${id}</Spec>`).join('\n\n') + '\n',
    )

    const idx = await loadDocuments(root)
    const results = await Promise.all(ids.map((id) => approveBlock(root, idx, id, { author: 'alice' })))
    expect(results.every((r) => r.isOk())).toBe(true)

    const loaded = await loadReviews(root, [])
    expect(Object.keys(loaded.blocks).toSorted()).toEqual(ids.toSorted())
    expect(await readdir(path.join(root, 'guard'))).toEqual(['reviews.json'])
  })

  test('[core.doc-history] getChangedBlockIds は未コミット変更・新規ファイル・ブランチ差分で変更されたブロックのみ抽出する', async () => {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: root, stdio: 'ignore' })

    const docsDir = path.join(root, 'docs')
    await mkdir(path.join(docsDir, 'goals'), { recursive: true })
    await mkdir(path.join(docsDir, 'specs'), { recursive: true })
    await writeFile(path.join(docsDir, 'goals/main.mdx'), '---\ntitle: Goal\n---\n\n# Goal\n')
    await writeFile(
      path.join(docsDir, 'specs/auth.mdx'),
      [
        '---',
        'title: Auth',
        'derives: [goals/main]',
        '---',
        '',
        '<Spec id="auth.first">最初の仕様</Spec>',
        '',
        '<Spec id="auth.second">2番目の仕様</Spec>',
        '',
      ].join('\n'),
    )
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' })

    // 変更なし時は空
    let idx = await loadDocuments(docsDir)
    expect(getChangedBlockIds(idx).size).toBe(0)

    // feature ブランチで 2 番目のブロックだけ編集してコミット + 未追跡の新規ファイルを追加
    execFileSync('git', ['checkout', '-b', 'feat/update-second'], { cwd: root, stdio: 'ignore' })
    await writeFile(
      path.join(docsDir, 'specs/auth.mdx'),
      [
        '---',
        'title: Auth',
        'derives: [goals/main]',
        '---',
        '',
        '<Spec id="auth.first">最初の仕様</Spec>',
        '',
        '<Spec id="auth.second">2番目の仕様を更新</Spec>',
        '',
      ].join('\n'),
    )
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'update second spec'], { cwd: root, stdio: 'ignore' })

    await writeFile(
      path.join(docsDir, 'specs/extra.mdx'),
      '---\ntitle: Extra\nderives: [goals/main]\n---\n\n<Spec id="extra.rule">新規仕様</Spec>\n',
    )

    idx = await loadDocuments(docsDir)
    const changed = getChangedBlockIds(idx)
    expect(changed.has('auth.first')).toBe(false)
    expect(changed.has('auth.second')).toBe(true)
    expect(changed.has('extra.rule')).toBe(true)
  })

  test('[core.human-review] approveBlock は guard/reviews.json へ確認メモ付きで保存し、unapproveBlock はレコードを削除して unreviewed に戻す', async () => {
    await writeDoc('goals/core.mdx', { title: 'Core' }, '# Core\n')
    await writeDoc(
      'specs/auth.mdx',
      { title: 'Auth', derives: ['goals/core'] },
      '<Spec id="auth.clean" stability="stable">クリーンな仕様</Spec>\n',
    )

    let idx = await loadDocuments(root)
    await approveBlock(root, idx, 'auth.clean', { author: 'alice', note: '境界条件を確認済み' })

    idx = await loadDocuments(root)
    const approved = idx.blocksById.get('auth.clean')!
    expect(approved.review).toBe('approved')
    expect(approved.approvedNote).toBe('境界条件を確認済み')

    const r1 = (await unapproveBlock(root, idx, 'auth.clean')).unwrap()
    expect(r1.removed).toBe(true)
    const r1Again = (await unapproveBlock(root, idx, 'auth.clean')).unwrap()
    expect(r1Again.removed).toBe(false)

    const saved = await loadReviews(root, [])
    expect(saved.blocks['auth.clean']).toBeUndefined()

    idx = await loadDocuments(root)
    expect(idx.blocksById.get('auth.clean')?.review).toBe('unreviewed')
    expect(idx.blocksById.get('auth.clean')?.approvedNote).toBeUndefined()
  })

  test('[core.human-review] author と git user.name が無い場合は approvedBy を省略し、OS ユーザー名や "human" へフォールバックしない', async () => {
    await writeDoc('goals/core.mdx', { title: 'Core' }, '# Core\n')
    await writeDoc(
      'specs/auth.mdx',
      { title: 'Auth', derives: ['goals/core'] },
      '<Spec id="auth.anon">承認者未指定の仕様</Spec>\n',
    )

    const idx = await loadDocuments(root)
    const res = await approveBlock(root, idx, 'auth.anon')
    expect(res.isOk()).toBe(true)
    expect(res.unwrap().approvedBy).toBeUndefined()

    const saved = await loadReviews(root, [])
    expect(saved.blocks['auth.anon']?.approvedBy).toBeUndefined()

    // 未存在ブロックは型付き BlockNotFoundError を返す
    const missing = await approveBlock(root, idx, 'non.existent')
    expect(missing.isErr()).toBe(true)
    if (missing.isErr()) expect(missing.error._tag).toBe('BlockNotFoundError')

    const missingDiff = await getBlockDiff(root, idx, 'non.existent')
    expect(missingDiff.isErr()).toBe(true)
    if (missingDiff.isErr()) expect(missingDiff.error._tag).toBe('BlockNotFoundError')

    // 必須フィールド (docPath / hash) 欠損の破損レコードは空文字で通さず invalid-reviews として弾く
    await writeFile(
      path.join(root, 'guard/reviews.json'),
      JSON.stringify({ version: 1, blocks: { 'auth.anon': { approvedBy: 'alice' } } }),
    )
    const issues: import('../src/core/types').IndexIssue[] = []
    const loaded = await loadReviews(root, issues)
    expect(loaded.blocks['auth.anon']).toBeUndefined()
    expect(issues.some((i) => i.code === 'invalid-reviews' && i.blockId === 'auth.anon')).toBe(true)
  })

  test('computeLineDiff は追加・削除・一致行を正しく算出する', () => {
    const diff = computeLineDiff('a\nb\nc', 'a\nx\nc\nd')
    expect(diff).toEqual([
      { type: 'context', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'x' },
      { type: 'context', text: 'c' },
      { type: 'add', text: 'd' },
    ])
  })
})
