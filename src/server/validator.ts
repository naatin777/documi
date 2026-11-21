import type { Context, Env, MiddlewareHandler, TypedResponse } from 'hono'
import { validator } from 'hono/validator'
import type { z } from 'zod'

type ZodTarget = 'json' | 'query' | 'param'
type HasUndefined<T> = undefined extends T ? true : false

/** エラー応答専用のステータスコード型（200/201 成功型へ { error } が混入するのを防ぐ） */
export type ErrorStatusCode = 400 | 403 | 404 | 409 | 500 | 501

type TargetMap<Target extends ZodTarget, In, Out> = {
  in: HasUndefined<In> extends true ? { [K in Target]?: In } : { [K in Target]: In }
  out: { [K in Target]: Out }
}

/**
 * Zod v4 スキーマを使って Hono の入力 (json / query / param) を検証し、
 * Hono RPC (`hc`) へ入出力型をそのまま伝播するミドルウェア。
 */
export function zValidator<
  Target extends ZodTarget,
  Schema extends z.ZodType,
  In = z.input<Schema>,
  Out = z.output<Schema>,
  E extends Env = Env,
  P extends string = string,
>(
  target: Target,
  schema: Schema,
): MiddlewareHandler<E, P, TargetMap<Target, In, Out>, TypedResponse<{ error: string }, 400, 'json'>> {
  return validator(target, (value, c: Context) => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      const message = first?.path?.length
        ? `${first.path.join('.')}: ${first.message}`
        : (first?.message ?? '不正なリクエストパラメータです')
      return c.json({ error: message }, 400)
    }
    return parsed.data
  }) as unknown as MiddlewareHandler<E, P, TargetMap<Target, In, Out>, TypedResponse<{ error: string }, 400, 'json'>>
}

/** localhost / 127.0.0.1 / ::1 からの Origin のみ許可する */
export function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  } catch {
    return false
  }
}
