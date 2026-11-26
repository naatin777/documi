import {
  ChevronRight,
  Columns2,
  Copy,
  FileCode2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
} from 'lucide-react'
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
type CodeInspectorTab = 'symbols' | 'links'

const SYMBOL_KIND_STYLES: Record<string, string> = {
  class: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  interface: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  type: 'bg-violet-500/15 text-violet-700 dark:text-violet-400',
  enum: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  function: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  method: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  constant: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
  struct: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  trait: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  protocol: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
}

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
  const [treeOpen, setTreeOpen] = useState(true)
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [inspectorTab, setInspectorTab] = useState<CodeInspectorTab>('symbols')
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

  const {
    width: inspectorWidth,
    setWidth: setInspectorWidth,
    resetWidth: resetInspectorWidth,
  } = useResizableWidth({
    storageKey: 'documi:code-inspector-width',
    defaultWidth: 290,
    minWidth: 220,
    maxWidth: 460,
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

  const totalLinksCount = fileData ? fileData.specLinks.length + fileData.docRefs.length + fileData.termLinks.length : 0
  const showRightInspector = Boolean(selectedFile && fileData && inspectorOpen && !peekTarget)

  return (
    <>
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface p-0 max-desktop:flex-none max-desktop:overflow-visible">
        <div className="flex min-h-0 w-full flex-1 overflow-hidden">
          {treeOpen && (
            <>
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
            </>
          )}

          <section
            className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface"
            aria-label={t('codeExplorer.viewerAria')}
          >
            {!selectedFile ? (
              <>
                {!treeOpen && (
                  <header className="flex items-center border-b border-line bg-sidebar px-3 py-1.5">
                    <button
                      type="button"
                      className="sem-action-btn inline-flex items-center gap-1"
                      onClick={() => setTreeOpen(true)}
                      title={t('codeExplorer.toggleTreeOpen')}
                      aria-label={t('codeExplorer.toggleTreeOpen')}
                    >
                      <PanelLeftOpen size={13} strokeWidth={1.8} aria-hidden="true" />
                      <span>{t('codeExplorer.toggleTreeOpen')}</span>
                    </button>
                  </header>
                )}
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
              </>
            ) : (
              <>
                <header className="flex flex-wrap items-center justify-between gap-2.5 border-b border-line bg-sidebar px-3 py-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded border border-transparent bg-transparent text-fg-muted hover:border-line hover:bg-hover hover:text-fg"
                      onClick={() => setTreeOpen((v) => !v)}
                      title={treeOpen ? t('codeExplorer.toggleTreeClose') : t('codeExplorer.toggleTreeOpen')}
                      aria-label={treeOpen ? t('codeExplorer.toggleTreeClose') : t('codeExplorer.toggleTreeOpen')}
                    >
                      {treeOpen ? (
                        <PanelLeftClose size={14} strokeWidth={1.8} aria-hidden="true" />
                      ) : (
                        <PanelLeftOpen size={14} strokeWidth={1.8} aria-hidden="true" />
                      )}
                    </button>
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
                    {fileData && (
                      <button
                        type="button"
                        className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded border border-transparent bg-transparent text-fg-muted hover:border-line hover:bg-hover hover:text-fg"
                        onClick={() => {
                          if (peekTarget) {
                            setPeekTarget(null)
                            setInspectorOpen(true)
                          } else {
                            setInspectorOpen((v) => !v)
                          }
                        }}
                        title={
                          inspectorOpen && !peekTarget
                            ? t('codeExplorer.toggleInspectorClose')
                            : t('codeExplorer.toggleInspectorOpen')
                        }
                        aria-label={
                          inspectorOpen && !peekTarget
                            ? t('codeExplorer.toggleInspectorClose')
                            : t('codeExplorer.toggleInspectorOpen')
                        }
                      >
                        {inspectorOpen && !peekTarget ? (
                          <PanelRightClose size={14} strokeWidth={1.8} aria-hidden="true" />
                        ) : (
                          <PanelRightOpen size={14} strokeWidth={1.8} aria-hidden="true" />
                        )}
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
                              <td
                                className={`sticky left-0 z-10 w-[1%] min-w-10 border-r border-line p-0 text-right align-top select-none ${
                                  isHighlighted ? 'bg-amber-50 dark:bg-amber-950/90' : 'bg-surface'
                                }`}
                              >
                                <button
                                  type="button"
                                  className="mono block w-full cursor-pointer border-0 bg-transparent pr-2 pl-1.5 text-right text-[11.5px] text-fg-faint tabular-nums hover:text-accent"
                                  onClick={(e) => handleLineClick(lineNo, e.shiftKey)}
                                  title={t('codeExplorer.lineSelectHint', { line: lineNo })}
                                >
                                  {lineNo}
                                </button>
                              </td>
                              <td className="px-3 py-0 whitespace-pre">
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
                )}
              </>
            )}
          </section>

          {showRightInspector && fileData && (
            <>
              <ResizeHandle
                side="left"
                width={inspectorWidth}
                minWidth={220}
                maxWidth={460}
                onChange={setInspectorWidth}
                onReset={resetInspectorWidth}
                label={t('resize.codeInspector')}
              />
              <aside
                className="flex min-w-0 shrink-0 flex-col border-l border-line bg-sidebar"
                style={{ width: `${inspectorWidth}px`, flexBasis: `${inspectorWidth}px` }}
                aria-label={t('codeExplorer.inspectorAria')}
              >
                <div className="flex items-center justify-between gap-1 border-b border-line px-2.5 pt-2 pb-1.5">
                  <div className="flex gap-1" role="tablist">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={inspectorTab === 'symbols'}
                      className={`cursor-pointer rounded-md border px-2 py-1 text-[11.5px] font-semibold ${
                        inspectorTab === 'symbols'
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-transparent bg-transparent text-fg-muted hover:text-fg'
                      }`}
                      onClick={() => setInspectorTab('symbols')}
                    >
                      {t('codeExplorer.inspectorSymbolsTab', { count: fileData.exportedSymbols.length })}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={inspectorTab === 'links'}
                      className={`cursor-pointer rounded-md border px-2 py-1 text-[11.5px] font-semibold ${
                        inspectorTab === 'links'
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-transparent bg-transparent text-fg-muted hover:text-fg'
                      }`}
                      onClick={() => setInspectorTab('links')}
                    >
                      {t('codeExplorer.inspectorLinksTab', { count: totalLinksCount })}
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-2.5">
                  {inspectorTab === 'symbols' &&
                    (fileData.exportedSymbols.length === 0 ? (
                      <p className="muted m-0 px-1 py-2 text-xs">{t('codeExplorer.noExports')}</p>
                    ) : (
                      <ul className="m-0 grid list-none gap-1 p-0">
                        {fileData.exportedSymbols.map((sym) => (
                          <li key={`${sym.name}-${sym.startLine}`}>
                            <button
                              type="button"
                              className="flex w-full cursor-pointer flex-col gap-0.5 rounded-md border border-transparent bg-transparent px-2 py-1.5 text-left hover:border-line hover:bg-surface"
                              title={sym.signature}
                              onClick={() =>
                                setSearchParams(
                                  { file: selectedFile, lines: `${sym.startLine}-${sym.endLine}` },
                                  { replace: true },
                                )
                              }
                            >
                              <div className="flex items-center gap-1.5">
                                <span
                                  className={`mono shrink-0 rounded px-1 py-px text-[10px] font-bold ${SYMBOL_KIND_STYLES[sym.kind] ?? 'bg-subtle text-fg-muted'}`}
                                >
                                  {sym.kind}
                                </span>
                                <span className="mono truncate text-[12px] font-semibold text-fg">
                                  {sym.qualifiedName ?? sym.name}
                                </span>
                                <span className="mono ml-auto shrink-0 text-[10.5px] text-fg-faint tabular-nums">
                                  L{sym.startLine}
                                </span>
                              </div>
                              <code className="truncate bg-transparent p-0 text-[10.5px] text-fg-muted">
                                {sym.signature}
                              </code>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ))}

                  {inspectorTab === 'links' &&
                    (totalLinksCount === 0 ? (
                      <p className="muted m-0 px-1 py-2 text-xs">{t('codeExplorer.noLinks')}</p>
                    ) : (
                      <div className="flex flex-col gap-3">
                        {fileData.specLinks.length > 0 && (
                          <div>
                            <div className="mb-1.5 text-[11px] font-bold text-fg-muted">
                              {t('codeExplorer.linkedSpecs', { count: fileData.specLinks.length })}
                            </div>
                            <div className="flex flex-col gap-1">
                              {fileData.specLinks.map((s, i) => (
                                <div
                                  key={`${s.specId}-${s.kind}-${s.line ?? i}`}
                                  className="flex items-center overflow-hidden rounded-md border border-line bg-surface text-[11.5px]"
                                >
                                  <Link
                                    to={`/docs/${encodeDocId(s.docId)}#block-${encodeURIComponent(s.specId)}`}
                                    className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-fg no-underline hover:text-accent"
                                    title={`${s.docTitle}${s.testName ? ` — ${s.testName}` : ''}`}
                                  >
                                    <span
                                      className={`shrink-0 rounded px-1 text-[10px] font-bold ${SPEC_KIND_STYLES[s.kind] ?? 'bg-subtle text-fg-muted'}`}
                                    >
                                      {s.kind}
                                    </span>
                                    <span className="mono truncate">{s.specId}</span>
                                    {s.line && (
                                      <span className="mono ml-auto shrink-0 text-[10px] text-fg-faint">L{s.line}</span>
                                    )}
                                  </Link>
                                  <button
                                    type="button"
                                    className="inline-flex shrink-0 cursor-pointer items-center justify-center border-0 border-l border-line bg-transparent px-1.5 py-1.5 text-fg-muted hover:bg-hover hover:text-accent"
                                    title={t('inspector.peekButtonTitle')}
                                    aria-label={t('inspector.peekButtonAria', { title: s.specId })}
                                    onClick={() => setPeekTarget({ docId: s.docId, focusBlockId: s.specId })}
                                  >
                                    <Columns2 size={11} strokeWidth={1.85} aria-hidden="true" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {fileData.docRefs.length > 0 && (
                          <div>
                            <div className="mb-1.5 text-[11px] font-bold text-fg-muted">
                              {t('codeExplorer.linkedDocs', { count: fileData.docRefs.length })}
                            </div>
                            <div className="flex flex-col gap-1">
                              {fileData.docRefs.map((d, i) => (
                                <div
                                  key={`${d.docId}-${d.symbol ?? d.lines ?? i}`}
                                  className="flex items-center overflow-hidden rounded-md border border-line bg-surface text-[11.5px]"
                                >
                                  <Link
                                    to={`/docs/${encodeDocId(d.docId)}`}
                                    className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-fg no-underline hover:text-accent"
                                  >
                                    <span className={`badge badge-type shrink-0 type-${d.docType}`}>
                                      {t(`types.singular.${d.docType}`)}
                                    </span>
                                    <span className="truncate">{d.docTitle}</span>
                                    {d.symbol && (
                                      <span className="mono shrink-0 text-[10px] text-fg-faint">#{d.symbol}</span>
                                    )}
                                  </Link>
                                  <button
                                    type="button"
                                    className="inline-flex shrink-0 cursor-pointer items-center justify-center border-0 border-l border-line bg-transparent px-1.5 py-1.5 text-fg-muted hover:bg-hover hover:text-accent"
                                    title={t('inspector.peekButtonTitle')}
                                    aria-label={t('inspector.peekButtonAria', { title: d.docTitle })}
                                    onClick={() => setPeekTarget({ docId: d.docId })}
                                  >
                                    <Columns2 size={11} strokeWidth={1.85} aria-hidden="true" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {fileData.termLinks.length > 0 && (
                          <div>
                            <div className="mb-1.5 text-[11px] font-bold text-fg-muted">
                              {t('codeExplorer.linkedTerms', { count: fileData.termLinks.length })}
                            </div>
                            <div className="flex flex-col gap-1">
                              {fileData.termLinks.map((term, i) => (
                                <div
                                  key={`${term.termId}-${term.symbol}-${i}`}
                                  className="flex items-center overflow-hidden rounded-md border border-line bg-surface text-[11.5px]"
                                >
                                  <Link
                                    to={`/docs/${encodeDocId(term.docId)}#block-${encodeURIComponent(term.termId)}`}
                                    className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-fg no-underline hover:text-accent"
                                  >
                                    <span className="shrink-0 rounded bg-sky-500/14 px-1 text-[10px] font-bold text-sky-700 dark:text-sky-400">
                                      term
                                    </span>
                                    <span className="truncate">{term.termId}</span>
                                    <span className="mono shrink-0 text-[10px] text-fg-faint">#{term.symbol}</span>
                                  </Link>
                                  <button
                                    type="button"
                                    className="inline-flex shrink-0 cursor-pointer items-center justify-center border-0 border-l border-line bg-transparent px-1.5 py-1.5 text-fg-muted hover:bg-hover hover:text-accent"
                                    title={t('inspector.peekButtonTitle')}
                                    aria-label={t('inspector.peekButtonAria', { title: term.termId })}
                                    onClick={() => setPeekTarget({ docId: term.docId, focusBlockId: term.termId })}
                                  >
                                    <Columns2 size={11} strokeWidth={1.85} aria-hidden="true" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              </aside>
            </>
          )}
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
