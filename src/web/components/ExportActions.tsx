import { Download } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ARTIFACT_TYPE_LABELS } from '../../core/types'
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
          setMessage('Chrome backend を利用できなかったため HTML にフォールバックしました')
          exportDocumentHtml()
        } else {
          setOpen(false)
        }
        return
      }
      const params = buildParams()
      if (!params) {
        setMessage('出力対象を選択してください')
        return
      }
      const ok = await exportBundlePdf(params)
      if (!ok) {
        setMessage('Chrome backend を利用できませんでした。印刷プレビュー画面を開きます。')
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
      setMessage('出力対象を選択してください')
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
      setMessage('出力対象を選択してください')
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
        title="PDF / HTML 書き出し (単体・複数まとめ)"
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
              <h2>Export (PDF / HTML / 印刷)</h2>
              <button type="button" className="modal-close" onClick={() => setOpen(false)} aria-label="閉じる">
                ✕
              </button>
            </header>

            <div className="modal-body">
              <div className="export-field">
                <span className="export-label">出力対象</span>
                <div className="export-modes">
                  {isDocPage && (
                    <button
                      type="button"
                      className={`export-mode-chip${mode === 'current' ? ' active' : ''}`}
                      onClick={() => setMode('current')}
                    >
                      現在の文書
                    </button>
                  )}
                  <button
                    type="button"
                    className={`export-mode-chip${mode === 'all' ? ' active' : ''}`}
                    onClick={() => setMode('all')}
                  >
                    すべて ({docs.length})
                  </button>
                  <button
                    type="button"
                    className={`export-mode-chip${mode === 'goal' ? ' active' : ''}`}
                    onClick={() => setMode('goal')}
                  >
                    Goal 関連一式
                  </button>
                  <button
                    type="button"
                    className={`export-mode-chip${mode === 'dir' ? ' active' : ''}`}
                    onClick={() => setMode('dir')}
                  >
                    ディレクトリ配下
                  </button>
                  <button
                    type="button"
                    className={`export-mode-chip${mode === 'custom' ? ' active' : ''}`}
                    onClick={() => setMode('custom')}
                  >
                    複数選択 ({customIds.size})
                  </button>
                </div>
              </div>

              {mode === 'goal' && (
                <div className="export-field">
                  <label className="export-label" htmlFor="export-goal-select">
                    起点 Goal
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
                    対象ディレクトリ
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
                  <span className="export-label">含める文書を選択</span>
                  <ul className="export-doc-list">
                    {docs.map((d) => (
                      <li key={d.id}>
                        <label className="export-doc-check">
                          <input type="checkbox" checked={customIds.has(d.id)} onChange={() => toggleCustomId(d.id)} />
                          <span className={`badge badge-type type-${d.type}`}>{ARTIFACT_TYPE_LABELS[d.type]}</span>
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
                    表紙タイトル (任意)
                  </label>
                  <input
                    id="export-title-input"
                    type="text"
                    className="export-input"
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    placeholder="省略時はスコープ名を使用"
                  />
                </div>
              )}

              {message && <p className="export-message">{message}</p>}
            </div>

            <footer className="modal-footer">
              <button type="button" className="sem-action-btn" disabled={busy} onClick={handlePreviewPrint}>
                {mode === 'current' ? '印刷ダイアログ' : 'バンドルプレビュー'}
              </button>
              <button type="button" className="sem-action-btn" disabled={busy} onClick={handleHtml}>
                HTML 保存
              </button>
              <button
                type="button"
                className="sem-action-btn sem-approve-btn"
                disabled={busy}
                onClick={() => void handlePdf()}
              >
                {busy ? '生成中…' : 'PDF ダウンロード'}
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
