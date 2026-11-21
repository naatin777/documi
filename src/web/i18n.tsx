import i18n from 'i18next'
import { Check, Globe } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { initReactI18next, useTranslation } from 'react-i18next'
import en from './locales/en.json'
import ja from './locales/ja.json'

/**
 * 対応ロケール一覧。
 * OSS で新言語を追加する場合は `src/web/locales/<code>.json` を追加し、
 * この配列と `LOCALE_RESOURCES` に 1 行追加するだけで有効化できる。
 */
export const SUPPORTED_LOCALES = [
  { code: 'en', shortLabel: 'EN', nativeLabel: 'English' },
  { code: 'ja', shortLabel: 'JA', nativeLabel: '日本語' },
] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]['code']

export const LOCALE_RESOURCES: Record<SupportedLocale, typeof en> = {
  en,
  ja,
}

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: {
      translation: typeof en
    }
  }
}

const STORAGE_KEY = 'documi:lang'

function matchLocale(raw: string | null | undefined): SupportedLocale | null {
  if (!raw) return null
  const normalized = raw.trim().toLowerCase()
  for (const loc of SUPPORTED_LOCALES) {
    if (normalized === loc.code || normalized.startsWith(`${loc.code}-`)) {
      return loc.code
    }
  }
  return null
}

function detectInitialLocale(): SupportedLocale {
  if (typeof window !== 'undefined') {
    try {
      const saved = matchLocale(window.localStorage.getItem(STORAGE_KEY))
      if (saved) return saved
    } catch {
      // localStorage 不可環境は無視
    }
  }
  if (typeof navigator !== 'undefined') {
    const langs =
      Array.isArray(navigator.languages) && navigator.languages.length > 0 ? navigator.languages : [navigator.language]
    for (const candidate of langs) {
      const matched = matchLocale(candidate)
      if (matched) return matched
    }
  }
  return 'en'
}

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources: {
      en: { translation: LOCALE_RESOURCES.en },
      ja: { translation: LOCALE_RESOURCES.ja },
    },
    lng: detectInitialLocale(),
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  })
}

export function setAppLocale(locale: SupportedLocale): void {
  void i18n.changeLanguage(locale)
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, locale)
    } catch {
      // localStorage 不可環境ではメモリ保持のみ
    }
  }
}

export function getActiveLocale(): SupportedLocale {
  return matchLocale(i18n.resolvedLanguage ?? i18n.language) ?? 'en'
}

// 初期描画時に <html lang> を同期
if (typeof document !== 'undefined') {
  document.documentElement.lang = getActiveLocale()
}

export function LanguageToggle() {
  const { t, i18n: instance } = useTranslation()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const activeCode = matchLocale(instance.resolvedLanguage ?? instance.language) ?? 'en'
  const activeLocale = SUPPORTED_LOCALES.find((l) => l.code === activeCode) ?? SUPPORTED_LOCALES[0]

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="lang-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`topbar-action lang-toggle-btn${open ? ' active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t('lang.switchAria', { language: activeLocale.nativeLabel })}
        title={`${t('lang.label')}: ${activeLocale.nativeLabel}`}
      >
        <Globe size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>

      {open && (
        <div className="lang-dropdown" role="menu" aria-label={t('lang.label')}>
          {SUPPORTED_LOCALES.map((loc) => {
            const selected = loc.code === activeCode
            return (
              <button
                key={loc.code}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`lang-option${selected ? ' active' : ''}`}
                onClick={() => {
                  setAppLocale(loc.code)
                  setOpen(false)
                }}
              >
                <span className="lang-option-code mono">{loc.shortLabel}</span>
                <span className="lang-option-label">{loc.nativeLabel}</span>
                {selected && <Check size={13} strokeWidth={2} className="lang-option-check" aria-hidden="true" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default i18n
