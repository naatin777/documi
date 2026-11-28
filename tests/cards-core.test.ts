import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { answerCard, createCard, distillCard, flagCard, getCard, listCards } from '../src/core/cards'

function sampleCard(id: string, fillable: 'yes' | 'no' = 'yes') {
  return {
    id,
    fillable,
    title: 'どれにするか',
    whyNow: '今決めないと進まない。',
    defaultPath: '放っておくと、AI は A で仮置きして進める。',
    example: 'たとえば、過去に同様の判断が蒸発した。',
    createdAt: '2026-11-28T00:00:00.000Z',
    options: [
      { id: 'a', label: 'A にする', consequence: '速い', loses: '粗い' },
      { id: 'b', label: 'B にする', consequence: '丁寧', loses: '遅い' },
      { id: 'do-nothing', label: 'やらない', consequence: 'コストなし', loses: '問題は残る', negative: true as const },
    ],
  }
}

// @implements test.core.review-card-store
describe('review card store', () => {
  test('create/get/list roundtrip', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'documi-cards-'))
    const created = await createCard(root, sampleCard('card.one'))
    expect(created.isOk()).toBe(true)
    const got = await getCard(root, 'card.one')
    expect(got.isOk()).toBe(true)
    if (got.isOk()) expect(got.value.title).toBe('どれにするか')
    const cards = await listCards(root)
    expect(cards.length).toBe(1)
  })

  test('rejects card without exactly one negative option', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'documi-cards-'))
    const input = sampleCard('card.two')
    input.options = input.options.filter((option) => option.id !== 'do-nothing')
    const created = await createCard(root, input)
    expect(created.isErr()).toBe(true)
  })

  test('answer validates option and fillability', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'documi-cards-'))
    await createCard(root, sampleCard('card.three', 'no'))
    const bad = await answerCard(root, 'card.three', {
      selectedOptionId: 'a',
      finish: 'provisional',
      answeredAt: '2026-11-28T01:00:00.000Z',
    })
    expect(bad.isErr()).toBe(true)
    const good = await answerCard(root, 'card.three', {
      selectedOptionId: 'other',
      writeIn: 'CLI で一元管理する',
      finish: 'committed',
      answeredAt: '2026-11-28T01:00:00.000Z',
    })
    expect(good.isOk()).toBe(true)
    if (good.isOk()) expect(good.value.answer?.writeIn).toBe('CLI で一元管理する')
    const unknown = await answerCard(root, 'card.three', {
      selectedOptionId: 'zzz',
      finish: 'committed',
      answeredAt: '2026-11-28T01:00:00.000Z',
    })
    expect(unknown.isErr()).toBe(true)
  })

  test('breaking a card clears its answer and blocks new answers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'documi-cards-'))
    await createCard(root, sampleCard('card.broken'))
    const answered = await answerCard(root, 'card.broken', {
      selectedOptionId: 'a',
      finish: 'committed',
      answeredAt: '2026-11-28T01:00:00.000Z',
    })
    expect(answered.isOk()).toBe(true)

    // 破損にすると回答は取り消される
    const flagged = await flagCard(root, 'card.broken', { incomprehensible: true })
    expect(flagged.isOk()).toBe(true)
    if (flagged.isOk()) {
      expect(flagged.value.incomprehensible).toBe(true)
      expect(flagged.value.answer).toBeUndefined()
    }

    // 破損中は回答できない
    const blocked = await answerCard(root, 'card.broken', {
      selectedOptionId: 'a',
      finish: 'committed',
      answeredAt: '2026-11-28T02:00:00.000Z',
    })
    expect(blocked.isErr()).toBe(true)

    // 破損解除で再び回答できる
    await flagCard(root, 'card.broken', { incomprehensible: false })
    const reanswered = await answerCard(root, 'card.broken', {
      selectedOptionId: 'a',
      finish: 'committed',
      answeredAt: '2026-11-28T03:00:00.000Z',
    })
    expect(reanswered.isOk()).toBe(true)
  })

  test('[core.review-card-store] distills committed cards once and rejects uncommitted cards', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'documi-cards-'))
    await createCard(root, sampleCard('card.distill-me'))

    const uncommitted = await distillCard(root, 'card.distill-me')
    expect(uncommitted.isErr()).toBe(true)

    await answerCard(root, 'card.distill-me', {
      selectedOptionId: 'a',
      finish: 'committed',
      answeredAt: '2026-11-28T01:00:00.000Z',
    })
    const distilled = await distillCard(root, 'card.distill-me')
    expect(distilled.isOk()).toBe(true)
    if (distilled.isOk()) expect(distilled.value.distilledAt).toBeDefined()

    const decisionDir = path.join(root, 'docs', 'decisions')
    const files = await readdir(decisionDir)
    expect(files).toEqual(['2026-11-28-distill-me.mdx'])
    const decision = await readFile(path.join(decisionDir, files[0]!), 'utf-8')
    expect(decision).toContain('<Decision id="dec.distill-me"')
    expect(decision).toContain('決定: A にする を選んだ。')

    const repeated = await distillCard(root, 'card.distill-me')
    expect(repeated.isErr()).toBe(true)

    const cardPath = path.join(root, '.documi', 'cards', 'card.distill-me.json')
    const stored = JSON.parse(await readFile(cardPath, 'utf-8')) as { distilledAt?: string }
    delete stored.distilledAt
    await writeFile(cardPath, `${JSON.stringify(stored, null, 2)}\n`, 'utf-8')
    const recovered = await distillCard(root, 'card.distill-me')
    expect(recovered.isOk()).toBe(true)
    expect(await readdir(decisionDir)).toEqual(['2026-11-28-distill-me.mdx'])
  })

  test('[core.review-card-store] distillation does not overwrite an existing decision record', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'documi-cards-'))
    await createCard(root, sampleCard('card.collision'))
    await answerCard(root, 'card.collision', {
      selectedOptionId: 'a',
      finish: 'committed',
      answeredAt: '2026-11-28T01:00:00.000Z',
    })

    const decisionDir = path.join(root, 'docs', 'decisions')
    await mkdir(decisionDir, { recursive: true })
    const existingPath = path.join(decisionDir, '2026-11-28-collision.mdx')
    await writeFile(existingPath, 'human edited decision\n', 'utf-8')

    const distilled = await distillCard(root, 'card.collision')
    expect(distilled.isErr()).toBe(true)
    expect(await readFile(existingPath, 'utf-8')).toBe('human edited decision\n')
  })

  test('rejects invalid card id', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'documi-cards-'))
    const got = await getCard(root, '../escape')
    expect(got.isErr()).toBe(true)
  })
})
