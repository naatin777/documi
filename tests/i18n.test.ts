import { describe, expect, test } from 'bun:test'
import i18n, { getActiveLocale, LOCALE_RESOURCES, setAppLocale, SUPPORTED_LOCALES } from '../src/web/i18n'

function flattenKeys(obj: Record<string, unknown>, prefix = ''): Map<string, string> {
  const result = new Map<string, string>()
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      result.set(fullKey, value)
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of flattenKeys(value as Record<string, unknown>, fullKey)) {
        result.set(k, v)
      }
    }
  }
  return result
}

function extractPlaceholders(template: string): string[] {
  return [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!).sort()
}

describe('Web UI i18n catalogs', () => {
  test('全ロケールがベース言語 (en) と完全に一致するキーとプレースホルダを持つ', () => {
    const base = flattenKeys(LOCALE_RESOURCES.en)
    expect(base.size).toBeGreaterThan(50)

    for (const loc of SUPPORTED_LOCALES) {
      const target = flattenKeys(LOCALE_RESOURCES[loc.code])
      const missing = [...base.keys()].filter((k) => !target.has(k))
      const extra = [...target.keys()].filter((k) => !base.has(k))
      expect(missing, `${loc.code} に不足キーがあります`).toEqual([])
      expect(extra, `${loc.code} に未定義キーがあります`).toEqual([])

      for (const [key, baseValue] of base) {
        const targetValue = target.get(key) ?? ''
        expect(targetValue.trim().length, `${loc.code}.${key} が空です`).toBeGreaterThan(0)
        expect(extractPlaceholders(targetValue), `${loc.code}.${key} のプレースホルダが en と不一致です`).toEqual(
          extractPlaceholders(baseValue),
        )
      }
    }
  })

  test('setAppLocale で en / ja を安全に切り替えられる', () => {
    setAppLocale('en')
    expect(getActiveLocale()).toBe('en')
    expect(i18n.t('review.approve')).toBe('Approve')

    setAppLocale('ja')
    expect(getActiveLocale()).toBe('ja')
    expect(i18n.t('review.approve')).toBe('承認')
  })
})
