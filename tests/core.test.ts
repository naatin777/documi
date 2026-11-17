import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { getDocument, loadDocuments } from '../src/core/loader'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'documi-test-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeDoc(relPath: string, frontmatter: string, body = '# Body\n\ncontent\n'): Promise<void> {
  const file = path.join(root, relPath)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `---\n${frontmatter}---\n\n${body}`)
}

function fm(fields: Record<string, unknown>): string {
  return stringify(fields)
}

async function writeValidDocs(): Promise<void> {
  await writeDoc(
    'requirements/00001-alpha.md',
    fm({ type: 'requirement', title: 'Req Alpha', description: 'req desc', status: 'accepted' }),
  )
  await writeDoc(
    'designs/00001-beta.md',
    fm({
      type: 'design',
      title: 'Design Beta',
      description: 'design desc',
      status: 'draft',
      relations: { requirement: ['00001'], architecture: ['00001'] },
    }),
  )
  await writeDoc(
    'architecture/00001-system.md',
    fm({ type: 'architecture', title: 'Arch', description: 'arch desc', status: 'accepted' }),
  )
}

describe('loadDocuments', () => {
  test('Markdown / MDX を読み込み frontmatter を解析する', async () => {
    await writeDoc('goals/00001-g.md', fm({ type: 'goal', title: 'Goal', description: 'd', status: 'draft' }))
    await writeDoc('guides/00001-h.mdx', fm({ type: 'guide', title: 'Guide', description: 'd', status: 'accepted' }))

    const index = await loadDocuments(root)
    expect(index.documents).toHaveLength(2)

    const md = getDocument(index, 'goal', '00001')
    expect(md?.format).toBe('markdown')
    expect(md?.title).toBe('Goal')
    expect(md?.ref).toBe('goal:00001')
    expect(md?.body).toContain('# Body')
    expect(md?.body).not.toContain('type:')

    const mdx = getDocument(index, 'guide', '00001')
    expect(mdx?.format).toBe('mdx')
    expect(mdx?.status).toBe('accepted')
  })

  test('同じIDが異なるTypeに存在しても type:id で区別できる', async () => {
    await writeDoc('requirements/00001-x.md', fm({ type: 'requirement', title: 'R', description: 'd', status: 'draft' }))
    await writeDoc('designs/00001-y.md', fm({ type: 'design', title: 'D', description: 'd', status: 'draft', relations: { requirement: ['00001'] } }))

    const index = await loadDocuments(root)
    expect(getDocument(index, 'requirement', '00001')?.title).toBe('R')
    expect(getDocument(index, 'design', '00001')?.title).toBe('D')
    expect(index.byRef.size).toBe(2)
  })

  test('Relations を解決し逆参照を算出する', async () => {
    await writeValidDocs()
    const index = await loadDocuments(root)

    const design = getDocument(index, 'design', '00001')!
    expect(design.relations.map((r) => r.ref).sort()).toEqual(['architecture:00001', 'requirement:00001'])

    const req = getDocument(index, 'requirement', '00001')!
    expect(req.incomingRelations.map((r) => r.ref)).toEqual(['design:00001'])

    const arch = getDocument(index, 'architecture', '00001')!
    expect(arch.incomingRelations.map((r) => r.ref)).toEqual(['design:00001'])
  })

  test('不正な frontmatter を検出して文書を除外する', async () => {
    await writeDoc('goals/00001-ok.md', fm({ type: 'goal', title: 'OK', description: 'd', status: 'draft' }))
    // title 欠落
    await writeDoc('goals/00002-ng.md', 'type: goal\ndescription: d\nstatus: draft\n')
    // YAML 構文エラー
    const bad = path.join(root, 'requirements')
    await mkdir(bad, { recursive: true })
    await writeFile(path.join(bad, '00001-broken.md'), '---\ntype: [unclosed\n---\nbody')

    const index = await loadDocuments(root)
    expect(index.documents).toHaveLength(1)
    expect(index.issues.some((i) => i.code === 'invalid-frontmatter' && i.path?.includes('00002-ng'))).toBe(true)
    expect(index.issues.some((i) => i.path?.includes('00001-broken'))).toBe(true)
  })

  test('不正なファイル名を検出する', async () => {
    await writeDoc('goals/bad-name.md', fm({ type: 'goal', title: 'T', description: 'd', status: 'draft' }))
    await writeDoc('goals/00001-UPPER.md', fm({ type: 'goal', title: 'T', description: 'd', status: 'draft' }))

    const index = await loadDocuments(root)
    expect(index.documents).toHaveLength(0)
    expect(index.issues.filter((i) => i.code === 'invalid-filename')).toHaveLength(2)
  })

  test('存在しない Relation を検出する', async () => {
    await writeDoc(
      'designs/00001-d.md',
      fm({
        type: 'design',
        title: 'D',
        description: 'd',
        status: 'draft',
        relations: { requirement: ['00001', '00999'] },
      }),
    )
    await writeDoc('requirements/00001-r.md', fm({ type: 'requirement', title: 'R', description: 'd', status: 'draft' }))

    const index = await loadDocuments(root)
    const design = getDocument(index, 'design', '00001')!
    expect(design.relations.map((r) => r.ref)).toEqual(['requirement:00001'])
    expect(design.issues.some((i) => i.code === 'missing-relation' && i.message.includes('requirement:00999'))).toBe(true)
  })

  test('自己参照・重複参照・不正な relation を検出する', async () => {
    await writeDoc(
      'decisions/00001-self.md',
      fm({
        type: 'decision',
        title: 'Self',
        description: 'd',
        status: 'draft',
        relations: {
          decision: ['00001', '00001'],
          bogus: ['00001'],
          requirement: ['abc'],
        },
      }),
    )

    const index = await loadDocuments(root)
    const doc = getDocument(index, 'decision', '00001')!
    const codes = doc.issues.map((i) => i.code)
    expect(codes).toContain('self-relation')
    expect(codes).toContain('invalid-relation-type')
    expect(codes).toContain('invalid-relation-id')
    expect(codes).toContain('duplicate-relation')
    expect(doc.relations).toHaveLength(0)
  })

  test('Design は Requirement 参照が必須', async () => {
    await writeDoc('designs/00001-noreq.md', fm({ type: 'design', title: 'D', description: 'd', status: 'draft' }))
    await writeDoc(
      'designs/00002-ok.md',
      fm({ type: 'design', title: 'D2', description: 'd', status: 'draft', relations: { requirement: ['00001'] } }),
    )
    await writeDoc('requirements/00001-r.md', fm({ type: 'requirement', title: 'R', description: 'd', status: 'draft' }))

    const index = await loadDocuments(root)
    expect(getDocument(index, 'design', '00001')!.issues.map((i) => i.code)).toContain('design-requires-requirement')
    expect(getDocument(index, 'design', '00002')!.issues.map((i) => i.code)).not.toContain('design-requires-requirement')
  })

  test('Verification は対象参照が必須', async () => {
    await writeDoc('verification/00001-empty.md', fm({ type: 'verification', title: 'V', description: 'd', status: 'draft' }))
    await writeDoc(
      'verification/00002-ok.md',
      fm({ type: 'verification', title: 'V2', description: 'd', status: 'draft', relations: { contract: ['00001'] } }),
    )
    await writeDoc('contracts/00001-c.md', fm({ type: 'contract', title: 'C', description: 'd', status: 'draft' }))

    const index = await loadDocuments(root)
    expect(getDocument(index, 'verification', '00001')!.issues.map((i) => i.code)).toContain('verification-requires-target')
    expect(getDocument(index, 'verification', '00002')!.issues).toHaveLength(0)
  })

  test('type とディレクトリの不一致を検出する', async () => {
    await writeDoc('requirements/00001-x.md', fm({ type: 'design', title: 'T', description: 'd', status: 'draft', relations: { requirement: ['00001'] } }))

    const index = await loadDocuments(root)
    expect(index.documents).toHaveLength(0)
    expect(index.issues.some((i) => i.code === 'type-mismatch')).toBe(true)
  })

  test('同一Type内のID重複を検出する', async () => {
    await writeDoc('goals/00001-a.md', fm({ type: 'goal', title: 'A', description: 'd', status: 'draft' }))
    await writeDoc('goals/00001-b.md', fm({ type: 'goal', title: 'B', description: 'd', status: 'draft' }))

    const index = await loadDocuments(root)
    expect(index.documents).toHaveLength(1)
    expect(index.documents[0]!.title).toBe('A')
    expect(index.issues.some((i) => i.code === 'duplicate-id')).toBe(true)
  })

  test('MDX の危険な構文を検出しコードブロック内は無視する', async () => {
    await writeDoc(
      'guides/00001-mdx.mdx',
      fm({ type: 'guide', title: 'MDX', description: 'd', status: 'draft' }),
      [
        '# MDX',
        '',
        'import foo from "./foo"',
        '',
        'export const x = 1',
        '',
        '<Note>jsx</Note>',
        '',
        '値は {expr} です',
        '',
        '```js',
        'const a = { safe: true } // import export <div> {}',
        '```',
        '',
      ].join('\n'),
    )

    const index = await loadDocuments(root)
    const doc = getDocument(index, 'guide', '00001')!
    const messages = doc.issues.filter((i) => i.code === 'mdx-unsupported').map((i) => i.message)
    expect(messages.some((m) => m.includes('ESM'))).toBe(true)
    expect(messages.some((m) => m.includes('JSX'))).toBe(true)
    // コードブロック内の { safe: true } 等で誤検出しない (JSX式は本文の {expr} のみ)
    expect(doc.issues.filter((i) => i.code === 'mdx-unsupported')).toHaveLength(3)
  })

  test('glossary を読み込む', async () => {
    await writeFile(
      path.join(root, 'glossary.md'),
      '---\ntitle: 用語集\ndescription: desc\n---\n\n# 用語\n\nbody\n',
    )
    const index = await loadDocuments(root)
    expect(index.glossary?.title).toBe('用語集')
    expect(index.glossary?.body).toContain('# 用語')
  })

  test('glossary がなくても読み込みできる', async () => {
    const index = await loadDocuments(root)
    expect(index.glossary).toBeNull()
    expect(index.documents).toHaveLength(0)
    expect(index.issues).toHaveLength(0)
  })

  test('documents は type 順・ID 順にソートされる', async () => {
    await writeDoc('guides/00002-b.md', fm({ type: 'guide', title: 'B', description: 'd', status: 'draft' }))
    await writeDoc('goals/00002-z.md', fm({ type: 'goal', title: 'Z', description: 'd', status: 'draft' }))
    await writeDoc('goals/00001-a.md', fm({ type: 'goal', title: 'A', description: 'd', status: 'draft' }))

    const index = await loadDocuments(root)
    expect(index.documents.map((d) => d.ref)).toEqual(['goal:00001', 'goal:00002', 'guide:00002'])
  })
})
