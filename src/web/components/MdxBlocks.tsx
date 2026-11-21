import { useState, type ReactNode } from 'react'

const CALLOUT_TYPES = new Set(['note', 'tip', 'info', 'warning', 'danger', 'success'])

interface CalloutBlockProps {
  type?: string
  title?: string
  children?: ReactNode
}

export function CalloutBlock({ type, title, children }: CalloutBlockProps) {
  const t = type && CALLOUT_TYPES.has(type) ? type : 'info'
  return (
    <div className={`callout callout-${t}`}>
      {title && <div className="callout-title">{title}</div>}
      <div className="callout-body">{children}</div>
    </div>
  )
}

export interface TabItem {
  label: string
  content: ReactNode
}

export function TabsBlock({ tabs, expandAll = false }: { tabs: TabItem[]; expandAll?: boolean }) {
  const [active, setActive] = useState(0)
  if (expandAll) {
    return (
      <div className="mdx-tabs mdx-tabs-expanded">
        {tabs.map((tab, i) => (
          <div key={i} className="mdx-tab-expanded-item">
            <div className="mdx-tab-expanded-label">{tab.label}</div>
            <div className="mdx-tabs-panel">{tab.content}</div>
          </div>
        ))}
      </div>
    )
  }
  const selected = Math.min(active, tabs.length - 1)
  const current = tabs[selected]
  return (
    <div className="mdx-tabs">
      <div className="mdx-tabs-bar" role="tablist">
        {tabs.map((tab, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === selected}
            className={`mdx-tab${i === selected ? ' active' : ''}`}
            onClick={() => setActive(i)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="mdx-tabs-panel" role="tabpanel">
        {current?.content}
      </div>
    </div>
  )
}

interface StepItem {
  title: string
  content: ReactNode
}

export function StepsBlock({ steps }: { steps: StepItem[] }) {
  return (
    <ol className="mdx-steps">
      {steps.map((step, i) => (
        <li key={i}>
          <div className="mdx-step-title">{step.title}</div>
          <div className="mdx-step-body">{step.content}</div>
        </li>
      ))}
    </ol>
  )
}
