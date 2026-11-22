import { Menu } from '@base-ui/react/menu'
import i18n from 'i18next'
import { Check, Globe } from 'lucide-react'
import { initReactI18next, useTranslation } from 'react-i18next'
import { AppTooltip } from './components/ui/Tooltip'
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
  const activeCode = matchLocale(instance.resolvedLanguage ?? instance.language) ?? 'en'
  const activeLocale = SUPPORTED_LOCALES.find((l) => l.code === activeCode) ?? SUPPORTED_LOCALES[0]

  return (
    <Menu.Root>
      <AppTooltip label={`${t('lang.label')}: ${activeLocale.nativeLabel}`}>
        <Menu.Trigger
          className="topbar-action data-[popup-open]:bg-hover data-[popup-open]:text-fg"
          aria-label={t('lang.switchAria', { language: activeLocale.nativeLabel })}
        >
          <Globe size={14} strokeWidth={1.75} aria-hidden="true" />
        </Menu.Trigger>
      </AppTooltip>

      {typeof document !== 'undefined' && (
        <Menu.Portal>
          <Menu.Positioner align="end" sideOffset={4} collisionPadding={8} className="z-60">
            <Menu.Popup
              aria-label={t('lang.label')}
              className="flex min-w-[148px] flex-col gap-0.5 rounded-lg border border-line bg-surface p-1 shadow-[0_10px_26px_rgba(15,23,42,0.16)] outline-none transition-all duration-100 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 dark:shadow-[0_10px_28px_rgba(0,0,0,0.5)]"
            >
              <Menu.RadioGroup value={activeCode} onValueChange={(v) => setAppLocale(v as SupportedLocale)}>
                {SUPPORTED_LOCALES.map((loc) => (
                  <Menu.RadioItem
                    key={loc.code}
                    value={loc.code}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-fg outline-none data-[checked]:bg-accent-soft data-[checked]:font-semibold data-[highlighted]:bg-hover"
                  >
                    <span className="mono w-[22px] shrink-0 text-[10.5px] text-fg-muted">{loc.shortLabel}</span>
                    <span className="flex-1">{loc.nativeLabel}</span>
                    <Menu.RadioItemIndicator className="shrink-0 text-accent">
                      <Check size={13} strokeWidth={2} aria-hidden="true" />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      )}
    </Menu.Root>
  )
}

export default i18n
