import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Result, TaggedError } from 'better-result'
import { z } from 'zod'

export const CARDS_REL_DIR = '.documi/cards'

export class CardNotFoundError extends TaggedError('CardNotFoundError')<{
  cardId: string
}> {}
export class InvalidCardError extends TaggedError('InvalidCardError')<{
  cardId: string
  reason: string
}> {}
export class InvalidCardIdError extends TaggedError('InvalidCardIdError')<{
  cardId: string
}> {}

export type CardError = CardNotFoundError | InvalidCardError | InvalidCardIdError

const cardOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  consequence: z.string().min(1),
  loses: z.string().min(1),
  negative: z.literal(true).optional(),
})

const cardAnswerSchema = z.object({
  selectedOptionId: z.string().min(1),
  writeIn: z.string().optional(),
  finish: z.enum(['provisional', 'committed']),
  answeredAt: z.string().min(1),
})

export const storedCardSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'card id must be alphanumeric with . _ - only'),
  fillable: z.enum(['yes', 'no']),
  title: z.string().min(1),
  whyNow: z.string().min(1),
  defaultPath: z.string().min(1),
  example: z.string(),
  options: z.array(cardOptionSchema).min(2),
  createdAt: z.string().min(1),
  answer: cardAnswerSchema.optional(),
  objected: z.boolean().optional(),
  incomprehensible: z.boolean().optional(),
  distilledAt: z.string().optional(),
})

export type StoredCard = z.infer<typeof storedCardSchema>
export type StoredCardAnswer = z.infer<typeof cardAnswerSchema>

function cardFilePath(rootDir: string, cardId: string): Result<string, InvalidCardIdError> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(cardId)) {
    return Result.err(new InvalidCardIdError({ cardId }))
  }
  return Result.ok(path.join(rootDir, CARDS_REL_DIR, `${cardId}.json`))
}

async function writeCardAtomic(filePath: string, card: StoredCard): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, `${JSON.stringify(card, null, 2)}\n`, 'utf-8')
  await rename(tmp, filePath)
}

// @implements core.review-card-store
export async function createCard(rootDir: string, input: unknown): Promise<Result<StoredCard, InvalidCardError>> {
  const parsed = storedCardSchema.safeParse(input)
  if (!parsed.success) {
    return Result.err(new InvalidCardError({ cardId: '', reason: parsed.error.issues[0]?.message ?? 'invalid card' }))
  }
  const card = parsed.data
  const negatives = card.options.filter((option) => option.negative === true)
  if (negatives.length !== 1) {
    return Result.err(new InvalidCardError({ cardId: card.id, reason: 'card must have exactly one negative option' }))
  }
  if (card.answer && card.answer.finish === 'provisional' && card.fillable !== 'yes') {
    return Result.err(new InvalidCardError({ cardId: card.id, reason: 'non-fillable card cannot be provisional' }))
  }
  const filePath = cardFilePath(rootDir, card.id)
  if (filePath.isErr()) return Result.err(new InvalidCardError({ cardId: card.id, reason: 'invalid card id' }))
  await writeCardAtomic(filePath.value, card)
  return Result.ok(card)
}

// @implements core.review-card-store
export async function getCard(rootDir: string, cardId: string): Promise<Result<StoredCard, CardError>> {
  const filePath = cardFilePath(rootDir, cardId)
  if (filePath.isErr()) return Result.err(filePath.error)
  let raw: string
  try {
    raw = await readFile(filePath.value, 'utf-8')
  } catch {
    return Result.err(new CardNotFoundError({ cardId }))
  }
  const parsed = storedCardSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    return Result.err(new InvalidCardError({ cardId, reason: 'stored card is invalid' }))
  }
  return Result.ok(parsed.data)
}

// @implements core.review-card-store
export async function listCards(rootDir: string): Promise<StoredCard[]> {
  const dir = path.join(rootDir, CARDS_REL_DIR)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const cards: StoredCard[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const parsed = storedCardSchema.safeParse(JSON.parse(await readFile(path.join(dir, entry), 'utf-8')))
      if (parsed.success) cards.push(parsed.data)
    } catch {
      // skip unreadable entries
    }
  }
  return cards.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
}

// @implements core.review-card-store
export async function answerCard(
  rootDir: string,
  cardId: string,
  answer: StoredCardAnswer,
): Promise<Result<StoredCard, CardError>> {
  const existing = await getCard(rootDir, cardId)
  if (existing.isErr()) return existing
  const card = existing.value
  if (card.incomprehensible === true) {
    return Result.err(new InvalidCardError({ cardId, reason: 'broken card cannot be answered' }))
  }
  if (answer.finish === 'provisional' && card.fillable !== 'yes') {
    return Result.err(new InvalidCardError({ cardId, reason: 'non-fillable card cannot be provisional' }))
  }
  if (answer.selectedOptionId !== 'other' && !card.options.some((option) => option.id === answer.selectedOptionId)) {
    return Result.err(new InvalidCardError({ cardId, reason: `unknown option: ${answer.selectedOptionId}` }))
  }
  const next: StoredCard = { ...card, answer }
  const filePath = cardFilePath(rootDir, cardId)
  if (filePath.isErr()) return Result.err(filePath.error)
  await writeCardAtomic(filePath.value, next)
  return Result.ok(next)
}

/** 確定済みカードを docs/decisions/ に決定レコードとして蒸留し、カードに distilledAt を刻む。 */
// @implements core.review-card-store
export async function distillCard(rootDir: string, cardId: string): Promise<Result<StoredCard, CardError>> {
  const existing = await getCard(rootDir, cardId)
  if (existing.isErr()) return existing
  const card = existing.value
  if (card.distilledAt !== undefined) {
    return Result.err(new InvalidCardError({ cardId, reason: 'card is already distilled' }))
  }
  if (card.answer?.finish !== 'committed') {
    return Result.err(new InvalidCardError({ cardId, reason: 'only committed cards can be distilled' }))
  }
  const chosen =
    card.answer.selectedOptionId === 'other'
      ? { label: card.answer.writeIn ?? '', consequence: '', loses: '' }
      : card.options.find((option) => option.id === card.answer?.selectedOptionId)
  if (!chosen) return Result.err(new InvalidCardError({ cardId, reason: 'answer references unknown option' }))

  const slug = cardId.replace(/^card\./, '')
  const date = (card.answer.answeredAt ?? new Date().toISOString()).slice(0, 10)
  const decisionBody = [
    `問い: ${card.title}`,
    ``,
    `決定: ${chosen.label} を選んだ。`,
    ...(chosen.consequence ? [`得るもの: ${chosen.consequence}。失うもの: ${chosen.loses}。`] : []),
    ``,
    `判断材料: ${card.whyNow}${card.defaultPath}${card.example}`,
  ].join('\n')
  const doc = `---
type: decision
title: ${card.title}
description: 判断カード ${cardId} から蒸留された決定レコード
date: ${date}
tags: [decision, review-card]
---

# ${card.title}

<Decision id="dec.${slug}" summary="${chosen.label}" stability="evolving">
  ${decisionBody}
</Decision>
`
  const decisionsDir = path.join(rootDir, 'docs', 'decisions')
  await mkdir(decisionsDir, { recursive: true })
  const decisionPath = path.join(decisionsDir, `${date}-${slug}.mdx`)
  try {
    await writeFile(decisionPath, doc, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existingDoc = await readFile(decisionPath, 'utf-8').catch(() => undefined)
    if (existingDoc !== doc) {
      return Result.err(new InvalidCardError({ cardId, reason: 'decision record already exists' }))
    }
  }

  const next: StoredCard = { ...card, distilledAt: new Date().toISOString() }
  const filePath = cardFilePath(rootDir, cardId)
  if (filePath.isErr()) return Result.err(filePath.error)
  await writeCardAtomic(filePath.value, next)
  return Result.ok(next)
}

// @implements core.review-card-store
export async function flagCard(
  rootDir: string,
  cardId: string,
  flag: { objected?: boolean; incomprehensible?: boolean },
): Promise<Result<StoredCard, CardError>> {
  const existing = await getCard(rootDir, cardId)
  if (existing.isErr()) return existing
  const next: StoredCard = { ...existing.value, ...flag }
  if (flag.incomprehensible === true) delete next.answer
  const filePath = cardFilePath(rootDir, cardId)
  if (filePath.isErr()) return Result.err(filePath.error)
  await writeCardAtomic(filePath.value, next)
  return Result.ok(next)
}
