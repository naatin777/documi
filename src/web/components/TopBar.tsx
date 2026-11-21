import { Menu } from 'lucide-react'
import { ThemeToggle } from '../theme'
import { BrandMark } from './BrandMark'
import ExportActions from './ExportActions'

interface TopBarProps {
  onMenu: () => void
}

export default function TopBar({ onMenu }: TopBarProps) {
  return (
    <header className="topbar">
      <button type="button" className="topbar-menu" onClick={onMenu} aria-label="Explorerを開く">
        <Menu size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <span className="topbar-title">
        <BrandMark size={20} />
        <span>Documi</span>
      </span>
      <div className="topbar-actions">
        <ExportActions />
        <ThemeToggle />
      </div>
    </header>
  )
}
