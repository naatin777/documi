import { ChevronRight, Columns2, Copy, FileCode2, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import type { CodeFileSummary, CodeSpecLink, CodeTreeDir, CodeTreeNode } from '../../core/code'
import { encodeDocId } from '../api'
import { useCopyText, useHighlightedCode } from '../hooks'
import { toErrorMessage, useCodeFileQuery, useCodeTreeQuery } from '../queries'
import DocPeekPane from './DocPeekPane'
import { MaterialFileIcon, MaterialFolderIcon } from './MaterialIcon'
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

const SPEC_KIND_STYLES: Record<string, string> = {
  implements: 'bg-teal-500/14 text-teal-700 dark:text-teal-400',
  verifies: 'bg-green-500/14 text-green-700 dark:text-green-400',
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

  const unlinkedCount = treeData ? treeData.totalFiles - treeData.coveredFiles : 0
  const filterCounts: Record<CoverageFilter, number | null> = {
    all: treeData ? treeData.totalFiles : null,
    covered: treeData ? treeData.coveredFiles : null,
    uncovered: treeData ? unlinkedCount : null,
  }

  return (
    <>
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface p-0 max-[900px]:flex-none max-[900px]:overflow-visible">
        <div className="flex min-h-0 w-full flex-1 overflow-hidden">
          <aside
            className="flex min-w-0 shrink-0 flex-col border-r border-line bg-sidebar"
            style={{ width: `${treeWidth}px`, flexBasis: `${treeWidth}px` }}
          >
            <div className="flex flex-col gap-[7px] border-b border-line px-2.5 pt-2.5 pb-2">
              <div className="relative flex items-center">
                <Search
                  size={12}
                  strokeWidth={1.9}
                  className="pointer-events-none absolute left-2 text-fg-muted"
                  aria-hidden="true"
                />
                <input
                  type="search"
                  className="w-full rounded-md border border-line bg-surface py-[5px] pr-2 pl-[26px] text-xs text-fg focus:border-accent focus:outline-none"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder={t('codeExplorer.filterPlaceholder')}
                  aria-label={t('codeExplorer.filterPlaceholder')}
                />
              </div>

              <div className="grid grid-cols-3 gap-[3px]" role="tablist" aria-label={t('codeExplorer.filterAria')}>
                {(['all', 'covered', 'uncovered'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={coverageFilter === mode}
                    className={`inline-flex cursor-pointer items-center justify-center gap-1 rounded-[5px] border px-1 py-[3px] text-[11px] ${
                      coverageFilter === mode
                        ? 'border-accent bg-accent-soft font-semibold text-accent'
                        : 'border-line bg-surface font-medium text-fg-muted hover:text-fg'
                    }`}
                    onClick={() => setCoverageFilter(mode)}
                  >
                    <span>{t(`codeExplorer.filters.${mode}`)}</span>
                    {filterCounts[mode] !== null && (
                      <span className="mono text-[10px] tabular-nums opacity-72">{filterCounts[mode]}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-1 pt-1.5 pb-4">
              {treeError && <p className="error-text m-0 p-3 text-[12.5px]">{treeError}</p>}
              {!treeData && !treeError && <p className="muted m-0 p-3 text-[12.5px]">{t('common.loading')}</p>}
              {treeData && filteredTree.length === 0 && (
                <p className="muted m-0 p-3 text-[12.5px]">{t('codeExplorer.emptyTree')}</p>
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

          <section
            className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface"
            aria-label={t('codeExplorer.viewerAria')}
          >
            {!selectedFile ? (
              <div className="mx-auto flex max-w-[560px] flex-1 flex-col items-center justify-center px-6 py-9 text-center">
                <FileCode2 size={32} strokeWidth={1.4} className="mb-2.5 text-fg-faint" aria-hidden="true" />
                <h2 className="m-0 mb-2 text-lg font-bold">{t('codeExplorer.emptyTitle')}</h2>
                <p className="muted">{t('codeExplorer.emptyDescription')}</p>
                {treeData && treeData.files.some((f) => f.covered) && (
                  <div className="mt-5 flex w-full flex-col gap-2">
                    <span className="text-[11.5px] font-semibold text-fg-muted">
                      {t('codeExplorer.coveredFilesQuick')}
                    </span>
                    <div className="flex flex-wrap justify-center gap-1.5">
                      {treeData.files
                        .filter((f) => f.covered)
                        .slice(0, 8)
                        .map((f) => (
                          <button
                            key={f.path}
                            type="button"
                            className="mono inline-flex cursor-pointer items-center gap-1.5 rounded-[7px] border border-line bg-sidebar px-2.5 py-[5px] text-xs text-fg hover:border-accent hover:text-accent"
                            onClick={() => selectFile(f.path)}
                          >
                            <MaterialFileIcon name={f.name} size={14} />
                            <span>{f.path}</span>
                            {f.specCount > 0 && (
                              <span className="rounded-full bg-green-600/14 px-[5px] text-[10.5px] font-semibold text-green-700 tabular-nums dark:text-green-400">
                                {f.specCount}
                              </span>
                            )}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <>
                <header className="flex flex-wrap items-center justify-between gap-2.5 border-b border-line bg-sidebar px-3.5 py-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <MaterialFileIcon name={selectedFile} size={16} />
                    <span className="mono text-[12.5px] font-semibold break-all text-fg">{selectedFile}</span>
                    {fileData && (
                      <>
                        <span className="badge badge-id">{fileData.language}</span>
                        <span className="mono text-[11.5px] text-fg-muted">
                          {t('codeExplorer.linesCount', { count: fileData.totalLines })}
                        </span>
                      </>
                    )}
                    <span className="rounded-full border border-line px-1.5 py-px text-[10.5px] text-fg-muted">
                      {t('codeExplorer.readOnly')}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      className="sem-action-btn inline-flex items-center gap-1"
                      onClick={() => copyPath(selectedFile)}
                    >
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
                  <div className="p-4">
                    <p className="error-text">{fileError}</p>
                  </div>
                )}

                {!fileData && !fileError && <p className="muted m-0 p-3 text-[12.5px]">{t('common.loading')}</p>}

                {fileData && (
                  <>
                    <div className="flex flex-col gap-1.5 border-b border-line bg-subtle px-3.5 py-2">
                      {fileData.specLinks.length === 0 &&
                      fileData.docRefs.length === 0 &&
                      fileData.termLinks.length === 0 ? (
                        <span className="muted text-xs">{t('codeExplorer.noLinks')}</span>
                      ) : (
                        <>
                          {fileData.specLinks.length > 0 && (
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span className="shrink-0 text-[11px] font-bold text-fg-muted">
                                {t('codeExplorer.linkedSpecs', { count: fileData.specLinks.length })}
                              </span>
                              <div className="flex flex-wrap gap-[5px]">
                                {fileData.specLinks.map((s, i) => (
                                  <span
                                    key={`${s.specId}-${s.kind}-${s.line ?? i}`}
                                    className="inline-flex items-center overflow-hidden rounded-md border border-line bg-surface text-[11.5px]"
                                  >
                                    <Link
                                      to={`/docs/${encodeDocId(s.docId)}#block-${encodeURIComponent(s.specId)}`}
                                      className="inline-flex items-center gap-[5px] px-[7px] py-0.5 text-fg no-underline hover:text-accent"
                                      title={`${s.docTitle}${s.testName ? ` — ${s.testName}` : ''}`}
                                    >
                                      <span
                                        className={`rounded px-1 text-[10px] font-bold ${SPEC_KIND_STYLES[s.kind] ?? 'bg-subtle text-fg-muted'}`}
                                      >
                                        {s.kind}
                                      </span>
                                      <span className="mono">{s.specId}</span>
                                      {s.line && <span className="mono text-[10.5px] text-fg-faint">:L{s.line}</span>}
                                    </Link>
                                    <button
                                      type="button"
                                      className="inline-flex cursor-pointer items-center justify-center border-0 border-l border-line bg-transparent px-1.5 py-1 text-fg-muted hover:bg-hover hover:text-accent"
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
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span className="shrink-0 text-[11px] font-bold text-fg-muted">
                                {t('codeExplorer.linkedDocs', { count: fileData.docRefs.length })}
                              </span>
                              <div className="flex flex-wrap gap-[5px]">
                                {fileData.docRefs.map((d, i) => (
                                  <span
                                    key={`${d.docId}-${d.symbol ?? d.lines ?? i}`}
                                    className="inline-flex items-center overflow-hidden rounded-md border border-line bg-surface text-[11.5px]"
                                  >
                                    <Link
                                      to={`/docs/${encodeDocId(d.docId)}`}
                                      className="inline-flex items-center gap-[5px] px-[7px] py-0.5 text-fg no-underline hover:text-accent"
                                    >
                                      <span className={`badge badge-type type-${d.docType}`}>
                                        {t(`types.singular.${d.docType}`)}
                                      </span>
                                      <span>{d.docTitle}</span>
                                      {d.symbol && (
                                        <span className="mono text-[10.5px] text-fg-faint">#{d.symbol}</span>
                                      )}
                                    </Link>
                                    <button
                                      type="button"
                                      className="inline-flex cursor-pointer items-center justify-center border-0 border-l border-line bg-transparent px-1.5 py-1 text-fg-muted hover:bg-hover hover:text-accent"
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
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span className="shrink-0 text-[11px] font-bold text-fg-muted">
                                {t('codeExplorer.linkedTerms', { count: fileData.termLinks.length })}
                              </span>
                              <div className="flex flex-wrap gap-[5px]">
                                {fileData.termLinks.map((term, i) => (
                                  <span
                                    key={`${term.termId}-${term.symbol}-${i}`}
                                    className="inline-flex items-center overflow-hidden rounded-md border border-line bg-surface text-[11.5px]"
                                  >
                                    <Link
                                      to={`/docs/${encodeDocId(term.docId)}#block-${encodeURIComponent(term.termId)}`}
                                      className="inline-flex items-center gap-[5px] px-[7px] py-0.5 text-fg no-underline hover:text-accent"
                                    >
                                      <span className="rounded bg-sky-500/14 px-1 text-[10px] font-bold text-sky-700 dark:text-sky-400">
                                        term
                                      </span>
                                      <span>{term.termId}</span>
                                      <span className="mono text-[10.5px] text-fg-faint">#{term.symbol}</span>
                                    </Link>
                                    <button
                                      type="button"
                                      className="inline-flex cursor-pointer items-center justify-center border-0 border-l border-line bg-transparent px-1.5 py-1 text-fg-muted hover:bg-hover hover:text-accent"
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

                    <div ref={codeBodyRef} className="flex-1 overflow-auto font-mono text-[12.5px] leading-[1.62]">
                      <table className="w-full border-collapse" aria-label={selectedFile}>
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
                                className={isHighlighted ? 'bg-amber-500/16 dark:bg-amber-500/22' : 'hover:bg-hover'}
                              >
                                <td className="w-[1%] min-w-12 border-r border-line p-0 text-right align-top select-none">
                                  <button
                                    type="button"
                                    className="mono block w-full cursor-pointer border-0 bg-transparent pr-2.5 pl-2 text-right text-[11.5px] text-fg-faint tabular-nums hover:text-accent"
                                    onClick={(e) => handleLineClick(lineNo, e.shiftKey)}
                                    title={t('codeExplorer.lineSelectHint', { line: lineNo })}
                                  >
                                    {lineNo}
                                  </button>
                                </td>
                                <td className="px-3.5 py-0 whitespace-pre">
                                  <div className="flex items-baseline justify-between gap-3">
                                    {htmlLine !== null ? (
                                      <span
                                        className="shiki bg-transparent"
                                        dangerouslySetInnerHTML={{ __html: htmlLine || ' ' }}
                                      />
                                    ) : (
                                      <span className="bg-transparent">{lineText || ' '}</span>
                                    )}
                                    {lineSpecs && (
                                      <span className="inline-flex shrink-0 gap-1">
                                        {lineSpecs.map((s) => (
                                          <button
                                            key={`${s.specId}-${s.kind}`}
                                            type="button"
                                            className="mono cursor-pointer rounded border border-blue-500/35 bg-blue-500/10 px-1.5 py-0 text-[10.5px] text-blue-600 dark:text-blue-400"
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
  const { t } = useTranslation()
  if (node.kind === 'dir') {
    const dir: CodeTreeDir = node
    const isCollapsed = !forceExpand && collapsedDirs.has(dir.path)
    return (
      <div className="group/dir">
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-1.5 rounded-[5px] border-0 bg-transparent px-2 py-1 text-left text-[12.5px] text-fg-muted hover:bg-hover hover:text-fg"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          aria-expanded={!isCollapsed}
          onClick={() => onToggleDir(dir.path)}
        >
          <ChevronRight
            size={12}
            strokeWidth={2}
            className={`shrink-0 text-fg-muted transition-transform duration-150 motion-reduce:transition-none ${isCollapsed ? 'rotate-0' : 'rotate-90'}`}
            aria-hidden="true"
          />
          <MaterialFolderIcon name={dir.name} open={!isCollapsed} size={15} />
          <span className="min-w-0 flex-1 truncate">{dir.name}</span>
          {dir.coveredCount > 0 && (
            <span
              className="mono text-[10.5px] text-fg-faint tabular-nums"
              title={t('codeExplorer.dirLinkedTitle', { count: dir.coveredCount })}
            >
              {dir.coveredCount}
            </span>
          )}
        </button>
        {!isCollapsed && (
          <div
            className="relative before:pointer-events-none before:absolute before:top-0 before:bottom-0.5 before:left-[calc(14px+var(--tree-depth,0)*14px)] before:w-px before:bg-line before:opacity-70 before:transition-colors before:duration-140 before:content-[''] group-hover/dir:before:bg-fg-faint group-hover/dir:before:opacity-90"
            style={{ '--tree-depth': depth } as CSSProperties}
          >
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
      className={`flex w-full cursor-pointer items-center gap-1.5 rounded-[5px] border-0 px-2 py-1 text-left text-[12.5px] ${
        isActive
          ? 'bg-accent-soft font-semibold text-accent'
          : 'bg-transparent text-fg-muted hover:bg-hover hover:text-fg'
      }`}
      style={{ paddingLeft: `${26 + depth * 14}px` }}
      title={file.path}
      onClick={() => onSelectFile(file.path)}
    >
      <MaterialFileIcon name={file.name} size={15} />
      <span className="min-w-0 flex-1 truncate">{file.name}</span>
      {file.specCount > 0 ? (
        <span className="mono rounded-full bg-green-600/14 px-[5px] text-[10.5px] font-semibold text-green-700 tabular-nums dark:text-green-400">
          {file.specCount}
        </span>
      ) : file.covered ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-600" aria-hidden="true" />
      ) : null}
    </button>
  )
}
