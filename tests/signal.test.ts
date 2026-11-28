import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runDocsCheck } from '../src/core/checker'
import { extractMdxArtifacts } from '../src/core/mdx'

describe('[core.mdx-blocks] <Signal> パース', () => {
  test('machine / experiment の Signal を属性つきで抽出する', () => {
    const body = `
<Signal id="sig.no-errors" method="machine" metric="check.errors" op="lte" value="0" cadence="always">
  条件: エラーがないこと
</Signal>

<Signal id="sig.human-check" method="manual-review" cadence="monthly">
  条件: 人間が説明できること
</Signal>
`
    const { blocks, issues } = extractMdxArtifacts(body, 'mdx', 'goals/test')
    const machine = blocks.find((b) => b.id === 'sig.no-errors')
    const manual = blocks.find((b) => b.id === 'sig.human-check')
    expect(issues).toEqual([])
    expect(machine?.kind).toBe('signal')
    if (machine?.kind === 'signal') {
      expect(machine.method).toBe('machine')
      expect(machine.metric).toBe('check.errors')
      expect(machine.op).toBe('lte')
      expect(machine.value).toBe(0)
      expect(machine.cadence).toBe('always')
    }
    if (manual?.kind === 'signal') {
      expect(manual.method).toBe('manual-review')
      expect(manual.metric).toBeUndefined()
    }
  })

  test('method 欠落・未知メトリクス・非整数 value は invalid-block-attr', () => {
    const noMethod = extractMdxArtifacts('<Signal id="sig.a">x</Signal>', 'mdx', 'd')
    expect(noMethod.issues.some((i) => i.code === 'invalid-block-attr')).toBe(true)
    expect(noMethod.blocks).toEqual([])

    const badMetric = extractMdxArtifacts(
      '<Signal id="sig.b" method="machine" metric="anything.count" value="0">x</Signal>',
      'mdx',
      'd',
    )
    expect(badMetric.issues.some((i) => i.code === 'invalid-block-attr')).toBe(true)

    const badValue = extractMdxArtifacts(
      '<Signal id="sig.c" method="machine" metric="check.errors" value="zero">x</Signal>',
      'mdx',
      'd',
    )
    expect(badValue.issues.some((i) => i.code === 'invalid-block-attr')).toBe(true)

    const badOp = extractMdxArtifacts(
      '<Signal id="sig.d" method="machine" metric="check.errors" op="approx" value="0">x</Signal>',
      'mdx',
      'd',
    )
    expect(badOp.issues.some((i) => i.code === 'invalid-block-attr')).toBe(true)
  })
})

async function withDocs(files: Record<string, string>, fn: (docsDir: string, root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'documi-signal-'))
  const docsDir = path.join(root, 'docs')
  await mkdir(docsDir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(docsDir, rel)), { recursive: true })
    await writeFile(path.join(docsDir, rel), content)
  }
  try {
    await fn(docsDir, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const goal = (signals: string) => `---
type: goal
title: テスト Goal
---

# テスト Goal

${signals}
`

describe('[core.signal-evaluation] machine 評価', () => {
  test('達成・未達・未評価を算出し check の ok には影響しない', async () => {
    await withDocs(
      {
        'goals/g.mdx': goal(`
<Signal id="sig.errors-zero" method="machine" metric="check.errors" value="0">
  エラーがないこと
</Signal>

<Signal id="sig.approved-many" method="machine" metric="review.approved" op="gte" value="100">
  承認が多いこと（未達になるはず）
</Signal>

<Signal id="sig.manual" method="manual-review" cadence="monthly">
  人間が確認する
</Signal>
`),
      },
      async (docsDir, root) => {
        const report = await runDocsCheck({ docsDir, projectRoot: root })
        expect(report.ok).toBe(true)
        const byId = new Map(report.signalEvaluations.map((s) => [s.id, s]))
        expect(byId.get('sig.errors-zero')?.status).toBe('achieved')
        expect(byId.get('sig.errors-zero')?.actual).toBe(0)
        expect(byId.get('sig.approved-many')?.status).toBe('not-achieved')
        expect(byId.get('sig.manual')?.status).toBe('unevaluated')
      },
    )
  })

  test('machine の未達があっても ok は true のまま', async () => {
    await withDocs(
      {
        'goals/g.mdx': goal(`
<Signal id="sig.impossible" method="machine" metric="check.warnings" op="lt" value="0">
  警告が負であること（あり得ない=未達）
</Signal>
`),
      },
      async (docsDir, root) => {
        const report = await runDocsCheck({ docsDir, projectRoot: root })
        expect(report.signalEvaluations.find((s) => s.id === 'sig.impossible')?.status).toBe('not-achieved')
        expect(report.ok).toBe(true)
        expect(report.errors).toEqual([])
      },
    )
  })
})
