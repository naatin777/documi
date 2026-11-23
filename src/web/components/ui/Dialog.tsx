import { Dialog } from '@base-ui/react/dialog'
import type { ComponentPropsWithoutRef, ReactNode, RefObject } from 'react'

interface AppDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  ariaLabel: string
  /** ダイアログの位置寄せ（検索・Export は上寄せ、図拡大などは中央） */
  align?: 'top' | 'center'
  /** 開いた直後にフォーカスを当てる要素 */
  initialFocus?: RefObject<HTMLElement | null>
  /** Popup カードの追加クラス */
  className?: string
  children: ReactNode
}

/**
 * `@base-ui/react/dialog` ベースの共通モーダルダイアログ。
 * クライアントでは Portal・フォーカストラップ・Escape 閉じる・背面スクロールロックを提供し、
 * SSR (`renderToStaticMarkup`) 時も安全に `role="dialog"` を描画する。
 */
export function AppDialog({
  open,
  onOpenChange,
  ariaLabel,
  align = 'top',
  initialFocus,
  className = '',
  children,
}: AppDialogProps) {
  const positionClass =
    align === 'center'
      ? 'fixed inset-0 z-80 flex items-center justify-center p-6 sm:p-10 pointer-events-none'
      : 'fixed inset-0 z-80 flex items-start justify-center px-4 pt-[8vh] pb-6 pointer-events-none'

  const popupClass =
    `pointer-events-auto flex max-h-[82vh] w-full max-w-[600px] flex-col overflow-hidden rounded-xl border border-line bg-surface text-fg shadow-[0_20px_48px_rgba(0,0,0,0.24)] outline-none transition-all duration-150 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 dark:shadow-[0_20px_54px_rgba(0,0,0,0.55)] ${className}`.trim()

  if (typeof document === 'undefined') {
    if (!open) return null
    return (
      <div className={positionClass}>
        <div role="dialog" aria-modal="true" aria-label={ariaLabel} className={popupClass}>
          {children}
        </div>
      </div>
    )
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-80 bg-slate-900/45 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 dark:bg-black/60" />
        <div className={positionClass}>
          <Dialog.Popup aria-label={ariaLabel} initialFocus={initialFocus} className={popupClass}>
            {children}
          </Dialog.Popup>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function DialogClose(props: ComponentPropsWithoutRef<'button'>) {
  if (typeof document === 'undefined') {
    return <button type="button" {...props} />
  }
  return <Dialog.Close {...props} />
}
