import { Monitor, Moon, Sun } from 'lucide-react'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export type ThemeMode = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

interface ThemeContextValue {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const STORAGE_KEY = 'documi:theme'
const MEDIA_QUERY = '(prefers-color-scheme: dark)'

function loadMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // localStorage が使えない環境では既定値を使う
  }
  return 'system'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(loadMode)
  const [systemDark, setSystemDark] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(MEDIA_QUERY).matches
      : false,
  )

  useEffect(() => {
    const mq = window.matchMedia(MEDIA_QUERY)
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolved: ResolvedTheme = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode

  useEffect(() => {
    document.documentElement.dataset.theme = resolved
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // 永続化に失敗しても表示には影響しない
    }
  }, [mode, resolved])

  return <ThemeContext.Provider value={{ mode, resolved, setMode }}>{children}</ThemeContext.Provider>
}

const FALLBACK_THEME: ThemeContextValue = { mode: 'system', resolved: 'light', setMode: () => {} }

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext) ?? FALLBACK_THEME
}

const MODE_ORDER: ThemeMode[] = ['light', 'dark', 'system']

export function ThemeToggle() {
  const { t } = useTranslation()
  const { mode, setMode } = useTheme()
  const next = MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length] ?? mode
  const modeLabel = t(`theme.${mode}`)

  return (
    <button
      type="button"
      className="theme-toggle"
      title={t('theme.tooltip', { mode: modeLabel })}
      aria-label={t('theme.ariaLabel', { mode: modeLabel })}
      onClick={() => setMode(next)}
    >
      {mode === 'light' && <Sun size={15} strokeWidth={1.75} aria-hidden="true" />}
      {mode === 'dark' && <Moon size={15} strokeWidth={1.75} aria-hidden="true" />}
      {mode === 'system' && <Monitor size={15} strokeWidth={1.75} aria-hidden="true" />}
    </button>
  )
}
