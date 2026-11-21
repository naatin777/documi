import { useCallback, useEffect, useState } from 'react'

interface UseResizableWidthOptions {
  storageKey: string
  defaultWidth: number
  minWidth: number
  maxWidth: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return fallback
    return clamp(parsed, min, max)
  } catch {
    return fallback
  }
}

export function useResizableWidth({ storageKey, defaultWidth, minWidth, maxWidth }: UseResizableWidthOptions) {
  const [width, setWidthState] = useState<number>(() => readStoredWidth(storageKey, defaultWidth, minWidth, maxWidth))

  const setWidth = useCallback(
    (next: number) => {
      const clamped = clamp(next, minWidth, maxWidth)
      setWidthState(clamped)
      try {
        window.localStorage.setItem(storageKey, String(clamped))
      } catch {
        // localStorage 不可環境ではメモリ保持のみ
      }
    },
    [storageKey, minWidth, maxWidth],
  )

  const resetWidth = useCallback(() => {
    setWidth(defaultWidth)
  }, [setWidth, defaultWidth])

  return { width, setWidth, resetWidth }
}

interface ResizeHandleProps {
  /** 'right': 左ペインの右端をドラッグ / 'left': 右ペインの左端をドラッグ */
  side: 'left' | 'right'
  width: number
  minWidth: number
  maxWidth: number | (() => number)
  onChange: (nextWidth: number) => void
  onReset: () => void
  label: string
  className?: string
}

/**
 * ペイン境界のドラッグリサイズハンドル。
 * - ポインタードラッグで幅を連続変更、ダブルクリックで既定幅へリセット
 * - キーボード矢印キーでも 16px 単位で調整可能
 */
export default function ResizeHandle({
  side,
  width,
  minWidth,
  maxWidth,
  onChange,
  onReset,
  label,
  className,
}: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false)

  const resolveMax = useCallback(() => {
    const m = typeof maxWidth === 'function' ? maxWidth() : maxWidth
    return Math.max(minWidth, m)
  }, [maxWidth, minWidth])

  useEffect(() => {
    if (!dragging) return
    document.body.classList.add('is-resizing')
    return () => {
      document.body.classList.remove('is-resizing')
    }
  }, [dragging])

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    setDragging(true)

    const onMove = (ev: PointerEvent) => {
      const delta = side === 'right' ? ev.clientX - startX : startX - ev.clientX
      onChange(clamp(startWidth + delta, minWidth, resolveMax()))
    }

    const onUp = () => {
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 16
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      const delta = side === 'right' ? -step : step
      onChange(clamp(width + delta, minWidth, resolveMax()))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      const delta = side === 'right' ? step : -step
      onChange(clamp(width + delta, minWidth, resolveMax()))
    } else if (e.key === 'Home' || e.key === '0') {
      e.preventDefault()
      onReset()
    }
  }

  const classes = ['resize-handle', className ?? '', dragging ? 'dragging' : ''].filter(Boolean).join(' ')

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={minWidth}
      aria-valuemax={typeof maxWidth === 'number' ? maxWidth : undefined}
      title={`${label}（ドラッグで伸縮 / ダブルクリックでリセット）`}
      className={classes}
      onPointerDown={handlePointerDown}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
    />
  )
}
