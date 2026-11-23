/**
 * ISO 8601 日時文字列を UI 表示用の簡潔な日付・相対時刻へ整形する。
 * Intl API のみを使用し追加ライブラリに依存しない。
 */

function toLocale(lang: string): string {
  return lang.toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

/** YYYY-MM-DD 形式の短い日付文字列へ変換する */
export function formatShortDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** YYYY-MM-DD HH:mm 形式のローカル日時文字列へ変換する（ツールチップ・履歴詳細用） */
export function formatDateTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${formatShortDate(iso)} ${hh}:${mi}`
}

/** 7日以内は相対表記（例: 5分前 / 2 hours ago）、それ以前は YYYY-MM-DD で返す */
export function formatRelativeTime(iso: string | undefined, lang: string, nowMs = Date.now()): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const diffSec = Math.round((d.getTime() - nowMs) / 1000)
  const absSec = Math.abs(diffSec)
  const locale = toLocale(lang)

  if (absSec < 45) {
    return locale === 'ja' ? 'たった今' : 'just now'
  }

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (absSec < 3600) {
    return rtf.format(Math.round(diffSec / 60), 'minute')
  }
  if (absSec < 86_400) {
    return rtf.format(Math.round(diffSec / 3600), 'hour')
  }
  if (absSec < 86_400 * 7) {
    return rtf.format(Math.round(diffSec / 86_400), 'day')
  }
  return formatShortDate(iso)
}
