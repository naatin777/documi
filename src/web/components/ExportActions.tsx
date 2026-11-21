import { Download, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'
import type { DocumentSummary } from '../../core/types'
import { api } from '../api'
import {
  buildBundleUrl,
  exportBundlePdf,
  exportDocumentHtml,
  exportDocumentPdf,
  printDocument,
  type BundleExportParams,
} from '../export'

type ScopeMode = 'current' | 'all' | 'goal' | 'dir' | 'custom'

/** 単一文書および複数文書バンドルの Export モーダルを開くボタン */
export default function ExportActions() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const isDocPage = pathname.startsWith('/docs/')
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ScopeMode>(isDocPage ? 'current' : 'all')
  const [docs, setDocs] = useState<DocumentSummary[]>([])
  const [selectedGoal, setSelectedGoal] = useState('')
  const [selectedDir, setSelectedDir] = useState('')
  const [customIds, setCustomIds] = useState<Set<string>>(new Set())
  const [customTitle, setCustomTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setMessage(null)
    setMode(isDocPage ? 'current' : 'all')
    api
      .documents()
      .then((res) => {
        setDocs(res.documents)
        const firstGoal = res.documents.find((d) => d.type === 'goal')
        if (firstGoal && !selectedGoal) setSelectedGoal(firstGoal.id)
        const dirs = [...new Set(res.documents.map((d) => d.dir).filter(Boolean))].sort()
        if (dirs[0] && !selectedDir) setSelectedDir(dirs[0])
      })
      .catch(() => {})
  }, [open, isDocPage, selectedGoal, selectedDir])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const goals = useMemo(() => docs.filter((d) => d.type === 'goal'), [docs])
  const dirs = useMemo(() => [...new Set(docs.map((d) => d.dir).filter(Boolean))].sort(), [docs])

  const buildParams = (): BundleExportParams | null => {
    const title = customTitle.trim() || undefined
    if (mode === 'all') return { scope: 'all', title }
    if (mode === 'goal') return selectedGoal ? { scope: `goal:${selectedGoal}`, title } : null
    if (mode === 'dir') return selectedDir ? { scope: `dir:${selectedDir}`, title } : null
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
      <button
        type="button"
        className="topbar-action"
        onClick={() => setOpen(true)}
        title={t('export.buttonTitle')}
        aria-label="Export"
      >
        <ExportIcon />
      </button>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="modal-card export-modal"
            role="dialog"
            aria-label="Export"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-header">
              <h2>{t('export.modalTitle')}</h2>
              <button
                type="button"
                className="modal-close"
                onClick={() => setOpen(false)}
                aria-label={t('common.close')}
              >
                <X size={15} strokeWidth={1.85} aria-hidden="true" />
              </button>
            </header>

            <div className="modal-body">
              <div className="export-field">
                <span className="export-label">{t('export.targetLabel')}</span>
                <div className="export-modes">
                  {isDocPage && (
                    <button
                      type="button"
                      className={`export-mode-chip${mode === 'current' ? ' active' : ''}`}
                      onClick={() => setMode('current')}
                    >
                      {t('export.currentDoc')}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`export-mode-chip${mode === 'all' ? ' active' : ''}`}
                    onClick={() => setMode('all')}
                  >
                    {t('export.allDocs', { count: docs.length })}
                  </button>
                  <button
                    type="button"
                    className={`export-mode-chip${mode === 'goal' ? ' active' : ''}`}
                    onClick={() => setMode('goal')}
                  >
                    {t('export.goalBundle')}
                  </button>
                  <button
                    type="button"
                    className={`export-mode-chip${mode === 'dir' ? ' active' : ''}`}
                    onClick={() => setMode('dir')}
                  >
                    {t('export.directory')}
                  </button>
                  <button
                    type="button"
                    className={`export-mode-chip${mode === 'custom' ? ' active' : ''}`}
                    onClick={() => setMode('custom')}
                  >
                    {t('export.customSelection', { count: customIds.size })}
                  </button>
                </div>
              </div>

              {mode === 'goal' && (
                <div className="export-field">
                  <label className="export-label" htmlFor="export-goal-select">
                    {t('export.rootGoal')}
                  </label>
                  <select
                    id="export-goal-select"
                    className="export-select"
                    value={selectedGoal}
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
                <div className="export-field">
                  <label className="export-label" htmlFor="export-dir-select">
                    {t('export.targetDir')}
                  </label>
                  <select
                    id="export-dir-select"
                    className="export-select"
                    value={selectedDir}
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
                <div className="export-field">
                  <span className="export-label">{t('export.selectDocs')}</span>
                  <ul className="export-doc-list">
                    {docs.map((d) => (
                      <li key={d.id}>
                        <label className="export-doc-check">
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
                <div className="export-field">
                  <label className="export-label" htmlFor="export-title-input">
                    {t('export.coverTitle')}
                  </label>
                  <input
                    id="export-title-input"
                    type="text"
                    className="export-input"
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    placeholder={t('export.coverTitlePlaceholder')}
                  />
                </div>
              )}

              {message && <p className="export-message">{message}</p>}
            </div>

            <footer className="modal-footer">
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
          </div>
        </div>
      )}
    </>
  )
}

function ExportIcon() {
  return <Download size={15} strokeWidth={1.75} aria-hidden="true" />
}
