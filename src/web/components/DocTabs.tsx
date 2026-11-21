import { useEffect, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { encodeDocId } from '../api'
import { docIdFromPath, useTabs } from '../tabs'

export default function DocTabs() {
  const { tabs, closeTab } = useTabs()
  const { pathname } = useLocation()
  const stripRef = useRef<HTMLElement>(null)
  const activeId = docIdFromPath(pathname)

  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const el = strip.querySelector<HTMLElement>('.doc-tab.active')
    if (!el) {
      strip.scrollLeft = 0
      return
    }
    const left = el.offsetLeft - (strip.clientWidth - el.offsetWidth) / 2
    strip.scrollTo({ left: Math.max(0, left), behavior: 'smooth' })
  }, [pathname, tabs])

  if (tabs.length === 0) return null

  return (
    <nav className="doc-tabs" aria-label="開いている文書" ref={stripRef}>
      {tabs.map((tab) => {
        const isActive = activeId === tab.id
        return (
          <div key={tab.id} className={`doc-tab${isActive ? ' active' : ''} type-${tab.type}`}>
            <Link
              to={`/docs/${encodeDocId(tab.id)}`}
              className="doc-tab-link"
              title={`${tab.id} — ${tab.title}`}
              aria-current={isActive ? 'page' : undefined}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  closeTab(tab)
                }
              }}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault()
              }}
            >
              <span className="doc-tab-dot" aria-hidden="true" />
              <span className="doc-tab-title">{tab.title}</span>
            </Link>
            <button
              type="button"
              className="doc-tab-close"
              aria-label={`${tab.title} を閉じる`}
              onClick={() => closeTab(tab)}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        )
      })}
    </nav>
  )
}
