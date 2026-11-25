import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { runDocsCheck } from '../src/core/checker'
import { getChangedBlockIds } from '../src/core/git'
import { loadDocuments } from '../src/core/loader'
import {
  addBlockFeedback,
  approveBlock,
  computeLineDiff,
  getBlockDiff,
  loadReviews,
  setBlockStabilityOverride,
  setFeedbackResolved,
  unapproveBlock,
} from '../src/core/reviews'
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

describe('人間レビュー・Stale・Suspect・Diff・Feedback', () => {
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
    await approveBlock(root, idx, 'auth.lockout', { author: 'alice' })
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
    const diff = await getBlockDiff(root, idx, 'auth.lockout')
    expect(diff.hasBase).toBe(true)
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
    const diff = await getBlockDiff(docsDir, idx, 'lock.rule')
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

  test('フィードバックの追加・解決・Stability 上書きが動作する', async () => {
    await writeDoc('goals/main.mdx', { title: 'Goal' }, '# Goal\n')
    await writeDoc(
      'specs/auth.mdx',
      { title: 'Auth', derives: ['goals/main'] },
      '<Spec id="auth.rate" stability="evolving">毎分20回制限</Spec>\n',
    )

    let idx = await loadDocuments(root)
    const fb = await addBlockFeedback(root, idx, 'auth.rate', '60回に緩和したい', 'bob')
    await setBlockStabilityOverride(root, idx, 'auth.rate', 'volatile')

    idx = await loadDocuments(root)
    const block = idx.blocksById.get('auth.rate')!
    expect(block.stability).toBe('volatile')
    expect(block.stabilitySource).toBe('override')
    expect(block.feedback).toHaveLength(1)
    expect(block.feedback[0]?.resolved).toBe(false)

    await setFeedbackResolved(root, 'auth.rate', fb.id, true)
    idx = await loadDocuments(root)
    expect(idx.blocksById.get('auth.rate')?.feedback[0]?.resolved).toBe(true)
  })

  test('[core.human-review] unapproveBlock は承認を取り消し、フィードバックや Stability 上書きは保持しつつ空レコードを削除する', async () => {
    await writeDoc('goals/core.mdx', { title: 'Core' }, '# Core\n')
    await writeDoc(
      'specs/auth.mdx',
      { title: 'Auth', derives: ['goals/core'] },
      [
        '<Spec id="auth.clean" stability="stable">クリーンな仕様</Spec>',
        '<Spec id="auth.withfb" stability="evolving">FB付き仕様</Spec>',
      ].join('\n\n') + '\n',
    )

    let idx = await loadDocuments(root)
    await approveBlock(root, idx, 'auth.clean', { author: 'alice' })
    await approveBlock(root, idx, 'auth.withfb', { author: 'alice' })
    await addBlockFeedback(root, idx, 'auth.withfb', '境界値を確認したい', 'alice')
    await setBlockStabilityOverride(root, idx, 'auth.withfb', 'volatile')

    idx = await loadDocuments(root)
    expect(idx.blocksById.get('auth.clean')?.review).toBe('approved')
    expect(idx.blocksById.get('auth.withfb')?.review).toBe('approved')

    // 1. FB・Stability 上書きが無いブロックはレコード自体が綺麗に削除される
    const r1 = await unapproveBlock(root, idx, 'auth.clean')
    expect(r1.removed).toBe(true)
    const r1Again = await unapproveBlock(root, idx, 'auth.clean')
    expect(r1Again.removed).toBe(false)

    // 2. FB・Stability 上書きがあるブロックは承認情報のみ解除して残す
    const r2 = await unapproveBlock(root, idx, 'auth.withfb')
    expect(r2.removed).toBe(true)

    const saved = await loadReviews(root, [])
    expect(saved.blocks['auth.clean']).toBeUndefined()
    expect(saved.blocks['auth.withfb']?.hash).toBe('')
    expect(saved.blocks['auth.withfb']?.feedback).toHaveLength(1)
    expect(saved.blocks['auth.withfb']?.stabilityOverride).toBe('volatile')

    idx = await loadDocuments(root)
    expect(idx.blocksById.get('auth.clean')?.review).toBe('unreviewed')
    expect(idx.blocksById.get('auth.withfb')?.review).toBe('unreviewed')
    expect(idx.blocksById.get('auth.withfb')?.stability).toBe('volatile')
    expect(idx.blocksById.get('auth.withfb')?.feedback).toHaveLength(1)
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
