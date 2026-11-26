import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { runDocsCheck } from '../src/core/checker'
import { loadDocuments } from '../src/core/loader'
import { approveBlock } from '../src/core/reviews'
import { enrichWithRealization, parseJunitXml, validateSourceLinks } from '../src/core/trace'

let projectDir: string
let docsDir: string

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), 'documi-trace-test-'))
  docsDir = path.join(projectDir, 'docs')
  await mkdir(docsDir, { recursive: true })
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

async function writeProjectFile(rel: string, content: string): Promise<void> {
  const abs = path.join(projectDir, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf-8')
}

async function writeDoc(rel: string, fm: Record<string, unknown>, body: string): Promise<void> {
  await writeProjectFile(`docs/${rel}`, `---\n${stringify(fm)}---\n\n${body}`)
}

describe('Trace / Realization / AST Check / PR / CLI', () => {
  test('[core.realization] ソースの @implements・@verifies・test("[id]") と JUnit XML・PR から全 5 状態の realization を算出する', async () => {
    await writeDoc('goals/main.mdx', { title: 'Goal' }, '# Goal\n')
    await writeDoc(
      'specs/all.mdx',
      { title: 'Specs', derives: ['goals/main'] },
      [
        '<Spec id="spec.verified">テスト通過済み仕様</Spec>',
        '<Spec id="spec.implemented">実装済みだがテスト結果なし</Spec>',
        '<Spec id="spec.inprog">Open PR で作業中</Spec>',
        '<Spec id="spec.unimpl">未実装仕様</Spec>',
        '<Spec id="spec.drifted">テスト失敗で乖離</Spec>',
      ].join('\n\n'),
    )

    await writeProjectFile(
      'src/service.ts',
      [
        '// @implements spec.verified, spec.implemented',
        'export function run() { return true }',
        '// @implements spec.drifted',
        'export function broken() { return false }',
      ].join('\n'),
    )

    await writeProjectFile(
      'tests/service.test.ts',
      ['test("[spec.verified] 仕様通りに動く", () => {})', 'test("[spec.drifted] 壊れたテスト", () => {})'].join('\n'),
    )

    await writeProjectFile(
      'docs/.documi/test-results.xml',
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<testsuites>',
        '  <testsuite name="service">',
        '    <testcase name="[spec.verified] 仕様通りに動く" classname="tests/service.test.ts" />',
        '    <testcase name="[spec.drifted] 壊れたテスト" classname="tests/service.test.ts">',
        '      <failure message="expected true, got false">AssertionError</failure>',
        '    </testcase>',
        '  </testsuite>',
        '</testsuites>',
      ].join('\n'),
    )

    const index = await loadDocuments(docsDir)
    await enrichWithRealization(index, {
      projectRoot: projectDir,
      pullRequests: [
        {
          number: 42,
          title: 'feat: implement inprog',
          state: 'OPEN',
          url: 'https://example.com/pr/42',
          body: 'Implements: spec.inprog',
        },
      ],
    })

    expect(index.blocksById.get('spec.verified')?.realization?.status).toBe('verified')
    expect(index.blocksById.get('spec.implemented')?.realization?.status).toBe('implemented')
    expect(index.blocksById.get('spec.inprog')?.realization?.status).toBe('in-progress')
    expect(index.blocksById.get('spec.inprog')?.realization?.pullRequests[0]?.number).toBe(42)
    expect(index.blocksById.get('spec.unimpl')?.realization?.status).toBe('unimplemented')
    expect(index.blocksById.get('spec.drifted')?.realization?.status).toBe('drifted')
  })

  test('[core.ast-check] validateSourceLinks が壊れた <SourceRef> と <TermDef symbols> を AST 検証で検出する', async () => {
    await writeProjectFile('src/app.ts', 'export function existingFn() { return 1 }\n')
    await writeDoc('goals/main.mdx', { title: 'Goal' }, '# Goal\n')
    await writeDoc(
      'domain/terms.mdx',
      { title: 'Terms' },
      '<TermDef id="BrokenTerm" symbols="src/app.ts#MissingSymbol">壊れた参照</TermDef>\n',
    )
    await writeDoc('specs/s.mdx', { title: 'S', derives: ['goals/main'] }, '<Spec id="s.one">spec</Spec>\n')
    await writeDoc(
      'designs/d.mdx',
      { title: 'D', satisfies: ['s.one'] },
      [
        '<SourceRef file="src/app.ts" symbol="existingFn" satisfies="s.one" />',
        '<SourceRef file="src/app.ts" symbol="renamedFn" satisfies="s.one" />',
      ].join('\n'),
    )

    const index = await loadDocuments(docsDir)
    const { issues, brokenSpecIds } = await validateSourceLinks(projectDir, index)
    expect(issues.some((i) => i.code === 'broken-source-ref' && i.message.includes('renamedFn'))).toBe(true)
    expect(issues.some((i) => i.code === 'broken-term-symbol' && i.message.includes('MissingSymbol'))).toBe(true)
    expect(brokenSpecIds.has('s.one')).toBe(true)
  })

  test('runDocsCheck の --strict と --no-review-edit が期待通りにエラー検知する', async () => {
    execFileSync('git', ['init'], { cwd: projectDir, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: projectDir, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: projectDir, stdio: 'ignore' })

    await writeDoc('goals/main.mdx', { title: 'Goal' }, '# Goal\n')
    await writeDoc('specs/a.mdx', { title: 'A', derives: ['goals/main'] }, '<Spec id="a.rule">ルール</Spec>\n')
    execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'ignore' })

    // 通常 check は OK、--strict は未承認エラー
    const normal = await runDocsCheck({ docsDir, projectRoot: projectDir })
    expect(normal.ok).toBe(true)

    const strictBefore = await runDocsCheck({ docsDir, projectRoot: projectDir, strict: true })
    expect(strictBefore.ok).toBe(false)
    expect(strictBefore.errors.some((e) => e.code === 'review-unreviewed')).toBe(true)

    // 承認すると --no-review-edit で未コミット変更を検知する
    const idx = await loadDocuments(docsDir)
    await approveBlock(docsDir, idx, 'a.rule')
    const guarded = await runDocsCheck({ docsDir, projectRoot: projectDir, noReviewEdit: true })
    expect(guarded.ok).toBe(false)
    expect(guarded.errors.some((e) => e.code === 'review-file-modified')).toBe(true)

    // 承認ファイルをコミット後は --strict も --no-review-edit も通過
    execFileSync('git', ['add', 'docs/guard/reviews.json'], { cwd: projectDir, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'approve'], { cwd: projectDir, stdio: 'ignore' })
    const strictAfter = await runDocsCheck({ docsDir, projectRoot: projectDir, strict: true, noReviewEdit: true })
    expect(strictAfter.ok).toBe(true)
  })

  test('[core.ast-check] --review-gate stable は stability=stable のブロックだけ未承認エラーにし、evolving は通す', async () => {
    await writeDoc('goals/main.mdx', { title: 'Goal' }, '# Goal\n')
    await writeDoc(
      'specs/tiered.mdx',
      { title: 'Tiered', derives: ['goals/main'] },
      [
        '<Spec id="spec.core" stability="stable">確定済みコア仕様</Spec>',
        '',
        '<Spec id="spec.wip" stability="evolving">進化中の仕様</Spec>',
        '',
      ].join('\n'),
    )

    // reviewGate: 'none' は両方未承認でも通過
    expect((await runDocsCheck({ docsDir, projectRoot: projectDir, reviewGate: 'none' })).ok).toBe(true)

    // reviewGate: 'stable' は spec.core のみエラー（spec.wip は除外）
    const gateBefore = await runDocsCheck({ docsDir, projectRoot: projectDir, reviewGate: 'stable' })
    expect(gateBefore.ok).toBe(false)
    expect(gateBefore.errors.map((e) => e.blockId)).toEqual(['spec.core'])

    // spec.core のみ承認すれば reviewGate: 'stable' は通過するが、--strict は spec.wip 未承認で落ちる
    const idx = await loadDocuments(docsDir)
    await approveBlock(docsDir, idx, 'spec.core')
    expect((await runDocsCheck({ docsDir, projectRoot: projectDir, reviewGate: 'stable' })).ok).toBe(true)

    const strictRes = await runDocsCheck({ docsDir, projectRoot: projectDir, strict: true })
    expect(strictRes.ok).toBe(false)
    expect(strictRes.errors.map((e) => e.blockId)).toEqual(['spec.wip'])
  })

  test('parseJunitXml は passed / failed / skipped を正しく解釈する', () => {
    const xml = `
      <testsuite>
        <testcase name="[a.1] ok" />
        <testcase name="[a.2] ng"><failure message="boom">stack</failure></testcase>
        <testcase name="[a.3] skip"><skipped /></testcase>
        <testcase name="untagged test" />
      </testsuite>
    `
    const parsed = parseJunitXml(xml)
    expect(parsed).toHaveLength(3)
    expect(parsed.map((p) => `${p.specId}:${p.status}`)).toEqual(['a.1:passed', 'a.2:failed', 'a.3:skipped'])
  })
})
