import { Hono } from 'hono'
import { z } from 'zod'
import {
  answerCard,
  CardNotFoundError,
  distillCard,
  flagCard,
  getCard,
  InvalidCardIdError,
  listCards,
  type CardError,
} from '../../core/cards'
import { zValidator } from '../validator'

const answerBodySchema = z.object({
  selectedOptionId: z.string().min(1),
  writeIn: z.string().optional(),
  finish: z.enum(['provisional', 'committed']),
})

const flagBodySchema = z.object({
  objected: z.boolean().optional(),
  incomprehensible: z.boolean().optional(),
})

function cardErrorResponse(error: CardError): { status: 400 | 404 | 409; message: string } {
  if (error instanceof CardNotFoundError) return { status: 404, message: 'card not found' }
  if (error instanceof InvalidCardIdError) return { status: 400, message: 'invalid card id' }
  if (error.reason === 'card is already distilled' || error.reason === 'decision record already exists') {
    return { status: 409, message: error.reason }
  }
  return { status: 400, message: error.reason }
}

// @implements core.review-card-store
export function createCardsRoutes(projectRoot: string) {
  return new Hono()
    .get('/cards', async (c) => {
      const cards = (await listCards(projectRoot)).filter((card) => card.distilledAt === undefined)
      return c.json({ cards })
    })
    .get('/cards/:id', async (c) => {
      const result = await getCard(projectRoot, c.req.param('id'))
      if (result.isErr()) return c.json({ error: 'card not found' }, 404)
      return c.json(result.value)
    })
    .post('/cards/:id/answer', zValidator('json', answerBodySchema), async (c) => {
      const body = c.req.valid('json')
      const result = await answerCard(projectRoot, c.req.param('id'), {
        ...body,
        answeredAt: new Date().toISOString(),
      })
      if (result.isErr()) {
        const error = cardErrorResponse(result.error)
        return c.json({ error: error.message }, error.status)
      }
      return c.json(result.value)
    })
    .post('/cards/:id/flag', zValidator('json', flagBodySchema), async (c) => {
      const result = await flagCard(projectRoot, c.req.param('id'), c.req.valid('json'))
      if (result.isErr()) {
        const error = cardErrorResponse(result.error)
        return c.json({ error: error.message }, error.status)
      }
      return c.json(result.value)
    })
    .post('/cards/:id/distill', async (c) => {
      const result = await distillCard(projectRoot, c.req.param('id'))
      if (result.isErr()) {
        const error = cardErrorResponse(result.error)
        return c.json({ error: error.message }, error.status)
      }
      return c.json(result.value)
    })
}
