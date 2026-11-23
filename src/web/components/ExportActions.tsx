import { Download, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'
import {
  buildBundleUrl,
  exportBundlePdf,
  exportDocumentHtml,
  exportDocumentPdf,
  printDocument,
  type BundleExportParams,
} from '../export'
import { useDocumentsQuery } from '../queries'
import { AppDialog, DialogClose } from './ui/Dialog'
import { AppTooltip } from './ui/Tooltip'

type ScopeMode = 'current' | 'all' | 'goal' | 'dir' | 'custom'

function chipClass(active: boolean) {
  return `cursor-pointer rounded-full border px-2.5 py-1 text-xs font-semibold ${
    active ? 'border-accent bg-accent text-surface' : 'border-line bg-subtle text-fg-muted hover:text-fg'
  }`
}

/** 単一文書および複数文書バンドルの Export モーダルを開くボタン */
export default function ExportActions() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const isDocPage = pathname.startsWith('/docs/')
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ScopeMode>(isDocPage ? 'current' : 'all')
  const [selectedGoal, setSelectedGoal] = useState('')
  const [selectedDir, setSelectedDir] = useState('')
  const [customIds, setCustomIds] = useState<Set<string>>(new Set())
  const [customTitle, setCustomTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const docsQuery = useDocumentsQuery(open)
  const docs = useMemo(() => docsQuery.data?.documents ?? [], [docsQuery.data])

  const goals = useMemo(() => docs.filter((d) => d.type === 'goal'), [docs])
  const dirs = useMemo(() => [...new Set(docs.map((d) => d.dir).filter(Boolean))].toSorted(), [docs])
  const effectiveGoal = selectedGoal || goals[0]?.id || ''
  const effectiveDir = selectedDir || dirs[0] || ''

  const openModal = () => {
    setMessage(null)
    setMode(isDocPage ? 'current' : 'all')
    setOpen(true)
  }

  const buildParams = (): BundleExportParams | null => {
    const title = customTitle.trim() || undefined
    if (mode === 'all') return { scope: 'all', title }
    if (mode === 'goal') return effectiveGoal ? { scope: `goal:${effectiveGoal}`, title } : null
    if (mode === 'dir') return effectiveDir ? { scope: `dir:${effectiveDir}`, title } : null
    if (mode === 'custom') return customIds.size > 0 ? { ids: [...customIds], title } : null
    return null
  }

  const handlePdf = async () => {
    setBusy(true)
    setMessage(null)
    try {
      if (mode === 'current') {
        if (!(await exportDocumentPdf())) {
          setMessage(t('export.fallbackHtml'))
          exportDocumentHtml()
        } else {
          setOpen(false)
        }
        return
      }
      const params = buildParams()
      if (!params) {
        setMessage(t('export.selectTargetError'))
        return
      }
      const ok = await exportBundlePdf(params)
      if (!ok) {
        setMessage(t('export.fallbackPrint'))
        window.open(buildBundleUrl({ ...params, action: 'print' }), '_blank', 'noopener')
      } else {
        setOpen(false)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleHtml = () => {
    setMessage(null)
    if (mode === 'current') {
      exportDocumentHtml()
      setOpen(false)
      return
    }
    const params = buildParams()
    if (!params) {
      setMessage(t('export.selectTargetError'))
      return
    }
    window.open(buildBundleUrl({ ...params, action: 'download-html' }), '_blank', 'noopener')
    setOpen(false)
  }

  const handlePreviewPrint = () => {
    setMessage(null)
    if (mode === 'current') {
      setOpen(false)
      setTimeout(() => printDocument(), 50)
      return
    }
    const params = buildParams()
    if (!params) {
      setMessage(t('export.selectTargetError'))
      return
    }
    window.open(buildBundleUrl(params), '_blank', 'noopener')
    setOpen(false)
  }

  const toggleCustomId = (id: string) => {
    setCustomIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <>
      <AppTooltip label={t('export.buttonTitle')}>
        <button
          type="button"
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-fg-muted hover:bg-hover hover:text-fg print:hidden"
          onClick={openModal}
          aria-label="Export"
        >
          <ExportIcon />
        </button>
      </AppTooltip>

      <AppDialog open={open} onOpenChange={setOpen} ariaLabel="Export">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="m-0 text-[15px] font-bold">{t('export.modalTitle')}</h2>
          <DialogClose
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-fg-muted hover:bg-hover hover:text-fg"
            aria-label={t('common.close')}
          >
            <X size={15} strokeWidth={1.85} aria-hidden="true" />
          </DialogClose>
        </header>

        <div className="grid gap-3.5 overflow-y-auto px-4 py-3.5">
          <div className="grid gap-1.5">
            <span className="text-xs font-bold text-fg-muted">{t('export.targetLabel')}</span>
            <div className="flex flex-wrap gap-1.5">
              {isDocPage && (
                <button type="button" className={chipClass(mode === 'current')} onClick={() => setMode('current')}>
                  {t('export.currentDoc')}
                </button>
              )}
              <button type="button" className={chipClass(mode === 'all')} onClick={() => setMode('all')}>
                {t('export.allDocs', { count: docs.length })}
              </button>
              <button type="button" className={chipClass(mode === 'goal')} onClick={() => setMode('goal')}>
                {t('export.goalBundle')}
              </button>
              <button type="button" className={chipClass(mode === 'dir')} onClick={() => setMode('dir')}>
                {t('export.directory')}
              </button>
              <button type="button" className={chipClass(mode === 'custom')} onClick={() => setMode('custom')}>
                {t('export.customSelection', { count: customIds.size })}
              </button>
            </div>
          </div>

          {mode === 'goal' && (
            <div className="grid gap-1.5">
              <label className="text-xs font-bold text-fg-muted" htmlFor="export-goal-select">
                {t('export.rootGoal')}
              </label>
              <select
                id="export-goal-select"
                className="w-full rounded-[7px] border border-line bg-surface px-2.5 py-[7px] text-[13px] text-fg"
                value={effectiveGoal}
                onChange={(e) => setSelectedGoal(e.target.value)}
              >
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title} ({g.id})
                  </option>
                ))}
              </select>
            </div>
          )}

          {mode === 'dir' && (
            <div className="grid gap-1.5">
              <label className="text-xs font-bold text-fg-muted" htmlFor="export-dir-select">
                {t('export.targetDir')}
              </label>
              <select
                id="export-dir-select"
                className="w-full rounded-[7px] border border-line bg-surface px-2.5 py-[7px] text-[13px] text-fg"
                value={effectiveDir}
                onChange={(e) => setSelectedDir(e.target.value)}
              >
                {dirs.map((d) => (
                  <option key={d} value={d}>
                    {d}/
                  </option>
                ))}
              </select>
            </div>
          )}

          {mode === 'custom' && (
            <div className="grid gap-1.5">
              <span className="text-xs font-bold text-fg-muted">{t('export.selectDocs')}</span>
              <ul className="m-0 grid max-h-[200px] list-none gap-1 overflow-y-auto rounded-lg border border-line p-1.5">
                {docs.map((d) => (
                  <li key={d.id}>
                    <label className="flex cursor-pointer items-center gap-2 px-1 py-[3px] text-[12.5px]">
                      <input type="checkbox" checked={customIds.has(d.id)} onChange={() => toggleCustomId(d.id)} />
                      <span className={`badge badge-type type-${d.type}`}>{t(`types.singular.${d.type}`)}</span>
                      <span>{d.title}</span>
                      <span className="muted mono">{d.id}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {mode !== 'current' && (
            <div className="grid gap-1.5">
              <label className="text-xs font-bold text-fg-muted" htmlFor="export-title-input">
                {t('export.coverTitle')}
              </label>
              <input
                id="export-title-input"
                type="text"
                className="w-full rounded-[7px] border border-line bg-surface px-2.5 py-[7px] text-[13px] text-fg"
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                placeholder={t('export.coverTitlePlaceholder')}
              />
            </div>
          )}

          {message && <p className="m-0 text-[12.5px] text-amber-700 dark:text-amber-400">{message}</p>}
        </div>

        <footer className="flex justify-end gap-2 border-t border-line bg-sidebar px-4 py-3">
          <button type="button" className="sem-action-btn" disabled={busy} onClick={handlePreviewPrint}>
            {mode === 'current' ? t('export.printDialog') : t('export.bundlePreview')}
          </button>
          <button type="button" className="sem-action-btn" disabled={busy} onClick={handleHtml}>
            {t('export.saveHtml')}
          </button>
          <button
            type="button"
            className="sem-action-btn sem-approve-btn"
            disabled={busy}
            onClick={() => void handlePdf()}
          >
            {busy ? t('export.generating') : t('export.downloadPdf')}
          </button>
        </footer>
      </AppDialog>
    </>
  )
}

function ExportIcon() {
  return <Download size={15} strokeWidth={1.75} aria-hidden="true" />
}
