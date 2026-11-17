import ExportActions from './ExportActions'
import { ThemeToggle } from '../theme'

interface TopBarProps {
  onMenu: () => void
}

export default function TopBar({ onMenu }: TopBarProps) {
  return (
    <header className="topbar">
      <button type="button" className="topbar-menu" onClick={onMenu} aria-label="Explorerを開く">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <span className="topbar-title">Documi</span>
      <div className="topbar-actions">
        <ExportActions />
        <ThemeToggle />
      </div>
    </header>
  )
}
