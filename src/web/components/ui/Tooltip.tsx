import { Tooltip } from '@base-ui/react/tooltip'
import type { ReactElement, ReactNode } from 'react'

export function TooltipProvider({ children, delay = 320 }: { children: ReactNode; delay?: number }) {
  return <Tooltip.Provider delay={delay}>{children}</Tooltip.Provider>
}

interface AppTooltipProps {
  label: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  sideOffset?: number
  children: ReactElement
}

/** `@base-ui/react/tooltip` ベースの軽量ツールチップ */
export function AppTooltip({ label, side = 'bottom', sideOffset = 6, children }: AppTooltipProps) {
  if (!label) return children
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      {typeof document !== 'undefined' && (
        <Tooltip.Portal>
          <Tooltip.Positioner side={side} sideOffset={sideOffset} className="z-90">
            <Tooltip.Popup className="max-w-64 rounded-md border border-line bg-fg px-2 py-1 text-[11.5px] leading-snug font-medium text-surface shadow-md transition-opacity duration-100 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 print:hidden">
              {label}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      )}
    </Tooltip.Root>
  )
}
