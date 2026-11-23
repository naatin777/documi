import { Menu } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LanguageToggle } from '../i18n'
import { ThemeToggle } from '../theme'
import { BrandMark } from './BrandMark'
import ExportActions from './ExportActions'

interface TopBarProps {
  onMenu: () => void
}

export default function TopBar({ onMenu }: TopBarProps) {
  const { t } = useTranslation()
  return (
    <header className="hidden h-[var(--topbar-height)] shrink-0 items-center gap-2 border-b border-line bg-sidebar px-2 max-[900px]:flex print:hidden">
      <button
        type="button"
        className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-fg hover:bg-hover"
        onClick={onMenu}
        aria-label={t('nav.openMenu')}
      >
        <Menu size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <span className="inline-flex items-center gap-[7px] text-[15px] font-bold tracking-[-0.01em]">
        <BrandMark size={20} />
        <span>Documi</span>
      </span>
      <div className="ml-auto flex items-center">
        <ExportActions />
        <LanguageToggle />
        <ThemeToggle />
      </div>
    </header>
  )
}
