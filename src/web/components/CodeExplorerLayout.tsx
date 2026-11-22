import { ChevronRight, Columns2, Copy, FileCode2, Folder, FolderOpen, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import type { CodeFileSummary, CodeSpecLink, CodeTreeDir, CodeTreeNode } from '../../core/code'
import { encodeDocId } from '../api'
import { useCopyText, useHighlightedCode } from '../hooks'
import { toErrorMessage, useCodeFileQuery, useCodeTreeQuery } from '../queries'
import DocPeekPane from './DocPeekPane'
import ResizeHandle, { useResizableWidth } from './ResizeHandle'

type CoverageFilter = 'all' | 'covered' | 'uncovered'

interface LineRange {
  start: number
  end: number
}

function parseLineRange(lineParam: string | null, linesParam: string | null): LineRange | null {
  if (linesParam) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(linesParam.trim())
    if (m) {
      const a = Number(m[1])
      const b = m[2] ? Number(m[2]) : a
      if (a >= 1 && b >= a) return { start: a, end: b }
    }
  }
  if (lineParam) {
    const n = Number(lineParam.trim())
    if (Number.isInteger(n) && n >= 1) return { start: n, end: n }
  }
  return null
}

/** Shiki が出力した HTML から 1 行ごとの innerHTML 配列を取り出す */
function extractShikiLines(html: string | null): string[] | null {
  if (!html) return null
  const match = /<code[^>]*>([\s\S]*?)<\/code>/.exec(html)
  if (!match?.[1]) return null
  const inner = match[1]
  const lines: string[] = []
  const re = /<span class="line">([\s\S]*?)<\/span>(?:\n|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(inner)) !== null) {
    lines.push(m[1] ?? '')
  }
  return lines.length > 0 ? lines : null
}

function filterTree(nodes: readonly CodeTreeNode[], coverage: CoverageFilter, query: string): CodeTreeNode[] {
  const q = query.trim().toLowerCase()
  const out: CodeTreeNode[] = []
  for (const node of nodes) {
    if (node.kind === 'dir') {
      const children = filterTree(node.children, coverage, query)
      if (children.length > 0) {
        out.push({ ...node, children })
      }
    } else {
      const f = node.file
      if (coverage === 'covered' && !f.covered) continue
      if (coverage === 'uncovered' && f.covered) continue
      if (q && !f.path.toLowerCase().includes(q)) continue
      out.push(node)
    }
  }
  return out
}

// @implements ui.code-explorer
export default function CodeExplorerLayout() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedFile = searchParams.get('file') ?? ''
  const highlightRange = useMemo(
    () => parseLineRange(searchParams.get('line'), searchParams.get('lines')),
    [searchParams],
  )

  const [coverageFilter, setCoverageFilter] = useState<CoverageFilter>('all')
  const [filterText, setFilterText] = useState('')
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(new Set())
  const [peekTarget, setPeekTarget] = useState<{ docId: string; focusBlockId?: string } | null>(null)
  const codeBodyRef = useRef<HTMLDivElement>(null)

  const {
    width: treeWidth,
    setWidth: setTreeWidth,
    resetWidth: resetTreeWidth,
  } = useResizableWidth({
    storageKey: 'documi:code-tree-width',
    defaultWidth: 260,
    minWidth: 190,
    maxWidth: 440,
  })

  const treeQuery = useCodeTreeQuery()
  const fileQuery = useCodeFileQuery(selectedFile)
  const treeData = treeQuery.data
  const fileData = fileQuery.data
  const treeError = toErrorMessage(treeQuery.error)
  const fileError = toErrorMessage(fileQuery.error)

  const filteredTree = useMemo(
    () => filterTree(treeData?.tree ?? [], coverageFilter, filterText),
    [treeData, coverageFilter, filterText],
  )

  const highlightedHtml = useHighlightedCode(fileData?.code ?? '', fileData?.language)
  const shikiLines = useMemo(() => extractShikiLines(highlightedHtml), [highlightedHtml])
  const plainLines = useMemo(() => {
    if (!fileData) return []
    const raw = fileData.code.endsWith('\n') ? fileData.code.slice(0, -1) : fileData.code
    return raw === '' ? [] : raw.split('\n')
  }, [fileData])

  const specsByLine = useMemo(() => {
    const map = new Map<number, CodeSpecLink[]>()
    for (const s of fileData?.specLinks ?? []) {
      if (s.line) {
        const list = map.get(s.line) ?? []
        list.push(s)
        map.set(s.line, list)
      }
    }
    return map
  }, [fileData])

  const { copied: pathCopied, copy: copyPath } = useCopyText()
  const { copied: codeCopied, copy: copyCode } = useCopyText()

  // 行ハイライト指定があれば該当行へスクロール
  useEffect(() => {
    const container = codeBodyRef.current
    if (!container || !fileData || !highlightRange) return
    const row = container.querySelector<HTMLElement>(`[data-line="${highlightRange.start}"]`)
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [fileData, highlightRange])

  const selectFile = (filePath: string) => {
    setSearchParams({ file: filePath })
  }

  const handleLineClick = (lineNo: number, shiftKey: boolean) => {
    if (!selectedFile) return
    if (shiftKey && highlightRange) {
      const start = Math.min(highlightRange.start, lineNo)
      const end = Math.max(highlightRange.start, lineNo)
      setSearchParams(
        start === end ? { file: selectedFile, line: String(start) } : { file: selectedFile, lines: `${start}-${end}` },
        { replace: true },
      )
    } else {
      setSearchParams({ file: selectedFile, line: String(lineNo) }, { replace: true })
    }
  }

  const toggleDir = (dirPath: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
  }

  const coveragePct =
    treeData && treeData.totalFiles > 0 ? Math.round((treeData.coveredFiles / treeData.totalFiles) * 100) : 0

  return (
    <>
      <main className="content content-code-explorer">
        <div className="code-explorer-shell">
          <aside className="code-tree-pane" style={{ width: `${treeWidth}px`, flexBasis: `${treeWidth}px` }}>
            <div className="code-tree-header">
              <div className="code-coverage-row">
                <span className="code-coverage-title">{t('codeExplorer.coverageLabel')}</span>
                {treeData && (
                  <span className="code-coverage-stat mono">
                    {treeData.coveredFiles}/{treeData.totalFiles} ({coveragePct}%)
                  </span>
                )}
              </div>
              <div className="code-coverage-bar" aria-hidden="true">
                <div className="code-coverage-fill" style={{ width: `${coveragePct}%` }} />
              </div>

              <div className="code-filter-input-wrap">
                <Search size={12} strokeWidth={1.9} className="code-filter-icon" aria-hidden="true" />
                <input
                  type="search"
                  className="code-filter-input"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder={t('codeExplorer.filterPlaceholder')}
                  aria-label={t('codeExplorer.filterPlaceholder')}
                />
              </div>

              <div className="code-filter-chips" role="tablist" aria-label={t('codeExplorer.filterAria')}>
                {(['all', 'covered', 'uncovered'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={coverageFilter === mode}
                    className={`code-filter-chip${coverageFilter === mode ? ' active' : ''}`}
                    onClick={() => setCoverageFilter(mode)}
                  >
                    {t(`codeExplorer.filters.${mode}`)}
                  </button>
                ))}
              </div>
            </div>

            <div className="code-tree-scroll">
              {treeError && <p className="error-text code-tree-status">{treeError}</p>}
              {!treeData && !treeError && <p className="muted code-tree-status">{t('common.loading')}</p>}
              {treeData && filteredTree.length === 0 && (
                <p className="muted code-tree-status">{t('codeExplorer.emptyTree')}</p>
              )}
              {filteredTree.map((node) => (
                <CodeTreeBranch
                  key={node.kind === 'dir' ? `dir:${node.path}` : `file:${node.file.path}`}
                  node={node}
                  depth={0}
                  selectedFile={selectedFile}
                  collapsedDirs={collapsedDirs}
                  forceExpand={Boolean(filterText.trim())}
                  onToggleDir={toggleDir}
                  onSelectFile={selectFile}
                />
              ))}
            </div>
          </aside>

          <ResizeHandle
            side="right"
            width={treeWidth}
            minWidth={190}
            maxWidth={440}
            onChange={setTreeWidth}
            onReset={resetTreeWidth}
            label={t('resize.codeTree')}
          />

          <section className="code-viewer-pane" aria-label={t('codeExplorer.viewerAria')}>
            {!selectedFile ? (
              <div className="code-empty-state">
                <FileCode2 size={32} strokeWidth={1.4} className="code-empty-icon" aria-hidden="true" />
                <h2>{t('codeExplorer.emptyTitle')}</h2>
                <p className="muted">{t('codeExplorer.emptyDescription')}</p>
                {treeData && treeData.files.some((f) => f.covered) && (
                  <div className="code-quick-list">
                    <span className="code-quick-label">{t('codeExplorer.coveredFilesQuick')}</span>
                    <div className="code-quick-chips">
                      {treeData.files
                        .filter((f) => f.covered)
                        .slice(0, 8)
                        .map((f) => (
                          <button
                            key={f.path}
                            type="button"
                            className="code-quick-chip mono"
                            onClick={() => selectFile(f.path)}
                          >
                            <span>{f.path}</span>
                            {f.specCount > 0 && <span className="code-file-badge">{f.specCount}</span>}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <>
                <header className="code-file-header">
                  <div className="code-file-header-main">
                    <FileCode2 size={15} strokeWidth={1.8} aria-hidden="true" />
                    <span className="code-file-path mono">{selectedFile}</span>
                    {fileData && (
                      <>
                        <span className="badge badge-id">{fileData.language}</span>
                        <span className="code-file-lines-meta mono">
                          {t('codeExplorer.linesCount', { count: fileData.totalLines })}
                        </span>
                      </>
                    )}
                    <span className="code-readonly-pill">{t('codeExplorer.readOnly')}</span>
                  </div>
                  <div className="code-file-header-actions">
                    <button type="button" className="sem-action-btn" onClick={() => copyPath(selectedFile)}>
                      <Copy size={12} strokeWidth={1.8} aria-hidden="true" />
                      <span>{pathCopied ? t('code.copied') : t('codeExplorer.copyPath')}</span>
                    </button>
                    {fileData && (
                      <button type="button" className="sem-action-btn" onClick={() => copyCode(fileData.code)}>
                        <span>{codeCopied ? t('code.copied') : t('code.copy')}</span>
                      </button>
                    )}
                  </div>
                </header>

                {fileError && (
                  <div className="code-file-error">
                    <p className="error-text">{fileError}</p>
                  </div>
                )}

                {!fileData && !fileError && <p className="muted code-tree-status">{t('common.loading')}</p>}

                {fileData && (
                  <>
                    <div className="code-links-bar">
                      {fileData.specLinks.length === 0 &&
                      fileData.docRefs.length === 0 &&
                      fileData.termLinks.length === 0 ? (
                        <span className="muted code-links-empty">{t('codeExplorer.noLinks')}</span>
                      ) : (
                        <>
                          {fileData.specLinks.length > 0 && (
                            <div className="code-link-group">
                              <span className="code-link-group-label">
                                {t('codeExplorer.linkedSpecs', { count: fileData.specLinks.length })}
                              </span>
                              <div className="code-link-chips">
                                {fileData.specLinks.map((s, i) => (
                                  <span key={`${s.specId}-${s.kind}-${s.line ?? i}`} className="code-link-chip">
                                    <Link
                                      to={`/docs/${encodeDocId(s.docId)}#block-${encodeURIComponent(s.specId)}`}
                                      className="code-link-chip-main"
                                      title={`${s.docTitle}${s.testName ? ` — ${s.testName}` : ''}`}
                                    >
                                      <span className={`code-link-kind code-link-kind-${s.kind}`}>{s.kind}</span>
                                      <span className="mono">{s.specId}</span>
                                      {s.line && <span className="code-link-line mono">:L{s.line}</span>}
                                    </Link>
                                    <button
                                      type="button"
                                      className="code-link-peek-btn"
                                      title={t('inspector.peekButtonTitle')}
                                      aria-label={t('inspector.peekButtonAria', { title: s.specId })}
                                      onClick={() => setPeekTarget({ docId: s.docId, focusBlockId: s.specId })}
                                    >
                                      <Columns2 size={11} strokeWidth={1.85} aria-hidden="true" />
                                    </button>
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {fileData.docRefs.length > 0 && (
                            <div className="code-link-group">
                              <span className="code-link-group-label">
                                {t('codeExplorer.linkedDocs', { count: fileData.docRefs.length })}
                              </span>
                              <div className="code-link-chips">
                                {fileData.docRefs.map((d, i) => (
                                  <span key={`${d.docId}-${d.symbol ?? d.lines ?? i}`} className="code-link-chip">
                                    <Link to={`/docs/${encodeDocId(d.docId)}`} className="code-link-chip-main">
                                      <span className={`badge badge-type type-${d.docType}`}>
                                        {t(`types.singular.${d.docType}`)}
                                      </span>
                                      <span>{d.docTitle}</span>
                                      {d.symbol && <span className="code-link-line mono">#{d.symbol}</span>}
                                    </Link>
                                    <button
                                      type="button"
                                      className="code-link-peek-btn"
                                      title={t('inspector.peekButtonTitle')}
                                      aria-label={t('inspector.peekButtonAria', { title: d.docTitle })}
                                      onClick={() => setPeekTarget({ docId: d.docId })}
                                    >
                                      <Columns2 size={11} strokeWidth={1.85} aria-hidden="true" />
                                    </button>
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {fileData.termLinks.length > 0 && (
                            <div className="code-link-group">
                              <span className="code-link-group-label">
                                {t('codeExplorer.linkedTerms', { count: fileData.termLinks.length })}
                              </span>
                              <div className="code-link-chips">
                                {fileData.termLinks.map((term, i) => (
                                  <span key={`${term.termId}-${term.symbol}-${i}`} className="code-link-chip">
                                    <Link
                                      to={`/docs/${encodeDocId(term.docId)}#block-${encodeURIComponent(term.termId)}`}
                                      className="code-link-chip-main"
                                    >
                                      <span className="code-link-kind code-link-kind-term">term</span>
                                      <span>{term.termId}</span>
                                      <span className="code-link-line mono">#{term.symbol}</span>
                                    </Link>
                                    <button
                                      type="button"
                                      className="code-link-peek-btn"
                                      title={t('inspector.peekButtonTitle')}
                                      aria-label={t('inspector.peekButtonAria', { title: term.termId })}
                                      onClick={() => setPeekTarget({ docId: term.docId, focusBlockId: term.termId })}
                                    >
                                      <Columns2 size={11} strokeWidth={1.85} aria-hidden="true" />
                                    </button>
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>

                    <div ref={codeBodyRef} className="code-source-scroll">
                      <table className="code-source-table" aria-label={selectedFile}>
                        <tbody>
                          {plainLines.map((lineText, idx) => {
                            const lineNo = idx + 1
                            const isHighlighted =
                              highlightRange !== null && lineNo >= highlightRange.start && lineNo <= highlightRange.end
                            const lineSpecs = specsByLine.get(lineNo)
                            const htmlLine =
                              shikiLines && shikiLines.length === plainLines.length ? shikiLines[idx] : null
                            return (
                              <tr
                                key={lineNo}
                                data-line={lineNo}
                                className={`code-source-row${isHighlighted ? ' highlighted' : ''}`}
                              >
                                <td className="code-line-num">
                                  <button
                                    type="button"
                                    className="code-line-num-btn mono"
                                    onClick={(e) => handleLineClick(lineNo, e.shiftKey)}
                                    title={t('codeExplorer.lineSelectHint', { line: lineNo })}
                                  >
                                    {lineNo}
                                  </button>
                                </td>
                                <td className="code-line-cell">
                                  <div className="code-line-inner">
                                    {htmlLine !== null ? (
                                      <span
                                        className="code-line-text shiki"
                                        dangerouslySetInnerHTML={{ __html: htmlLine || ' ' }}
                                      />
                                    ) : (
                                      <span className="code-line-text">{lineText || ' '}</span>
                                    )}
                                    {lineSpecs && (
                                      <span className="code-inline-specs">
                                        {lineSpecs.map((s) => (
                                          <button
                                            key={`${s.specId}-${s.kind}`}
                                            type="button"
                                            className="code-inline-spec-pill mono"
                                            onClick={() => setPeekTarget({ docId: s.docId, focusBlockId: s.specId })}
                                            title={s.docTitle}
                                          >
                                            {s.specId}
                                          </button>
                                        ))}
                                      </span>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        </div>
      </main>
      {peekTarget && (
        <DocPeekPane
          docId={peekTarget.docId}
          focusBlockId={peekTarget.focusBlockId}
          onClose={() => setPeekTarget(null)}
        />
      )}
    </>
  )
}

function CodeTreeBranch({
  node,
  depth,
  selectedFile,
  collapsedDirs,
  forceExpand,
  onToggleDir,
  onSelectFile,
}: {
  node: CodeTreeNode
  depth: number
  selectedFile: string
  collapsedDirs: ReadonlySet<string>
  forceExpand: boolean
  onToggleDir: (dirPath: string) => void
  onSelectFile: (filePath: string) => void
}) {
  if (node.kind === 'dir') {
    const dir: CodeTreeDir = node
    const isCollapsed = !forceExpand && collapsedDirs.has(dir.path)
    return (
      <div className="code-tree-dir">
        <button
          type="button"
          className="code-tree-dir-btn"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          aria-expanded={!isCollapsed}
          onClick={() => onToggleDir(dir.path)}
        >
          <ChevronRight
            size={12}
            strokeWidth={2}
            className={`nav-chevron${isCollapsed ? ' collapsed' : ''}`}
            aria-hidden="true"
          />
          {isCollapsed ? (
            <Folder size={13} strokeWidth={1.75} className="code-tree-icon" aria-hidden="true" />
          ) : (
            <FolderOpen size={13} strokeWidth={1.75} className="code-tree-icon" aria-hidden="true" />
          )}
          <span className="code-tree-name">{dir.name}</span>
          <span className="code-tree-dir-count mono">
            {dir.coveredCount}/{dir.totalCount}
          </span>
        </button>
        {!isCollapsed && (
          <div>
            {dir.children.map((child) => (
              <CodeTreeBranch
                key={child.kind === 'dir' ? `dir:${child.path}` : `file:${child.file.path}`}
                node={child}
                depth={depth + 1}
                selectedFile={selectedFile}
                collapsedDirs={collapsedDirs}
                forceExpand={forceExpand}
                onToggleDir={onToggleDir}
                onSelectFile={onSelectFile}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  const file: CodeFileSummary = node.file
  const isActive = file.path === selectedFile
  return (
    <button
      type="button"
      className={`code-tree-file-btn${isActive ? ' active' : ''}${file.covered ? ' covered' : ''}`}
      style={{ paddingLeft: `${12 + depth * 14}px` }}
      title={file.path}
      onClick={() => onSelectFile(file.path)}
    >
      <span className={`code-cov-dot${file.covered ? ' covered' : ''}`} aria-hidden="true" />
      <span className="code-tree-name">{file.name}</span>
      {file.specCount > 0 && <span className="code-file-badge mono">{file.specCount}</span>}
    </button>
  )
}
