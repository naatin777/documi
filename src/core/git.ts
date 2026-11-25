import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Result } from 'better-result'
import {
  CommitNotFoundError,
  DocumentNotInCommitError,
  GitRepoUnavailableError,
  InvalidCommitShaError,
  type HistoryDomainError,
} from './errors'
import { parseYamlFrontmatter, splitFrontmatter } from './frontmatter'
import type {
  ChangedLineRange,
  DocsIndex,
  Document,
  DocumentFreshness,
  DocumentHistory,
  DocumentRevision,
  GitCommitEntry,
  WorkingTreeStatus,
} from './types'

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i
const HUNK_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

interface GitContext {
  gitRoot: string
  /** gitRoot から docsDir への POSIX 相対パス (同一ディレクトリなら '') */
  relDocs: string
}

function safeRealpath(target: string): string {
  try {
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

function runGit(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
}

function resolveGitContext(docsDir: string): GitContext | undefined {
  const absDocs = safeRealpath(docsDir)
  const rawRoot = runGit(absDocs, ['rev-parse', '--show-toplevel'])
  if (!rawRoot) return undefined
  const gitRoot = safeRealpath(rawRoot.trim())
  const rel = toPosix(path.relative(gitRoot, absDocs))
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  return { gitRoot, relDocs: rel === '.' ? '' : rel }
}

function toGitRelPath(ctx: GitContext, docRelPath: string): string {
  return ctx.relDocs ? `${ctx.relDocs}/${docRelPath}` : docRelPath
}

function stripDocsPrefix(ctx: GitContext, gitRelPath: string): string | undefined {
  if (!ctx.relDocs) return gitRelPath
  const prefix = `${ctx.relDocs}/`
  if (!gitRelPath.startsWith(prefix)) return undefined
  return gitRelPath.slice(prefix.length)
}

function normalizeCommitStatus(raw: string): GitCommitEntry['status'] {
  const ch = raw[0]?.toUpperCase()
  if (ch === 'A' || ch === 'M' || ch === 'R' || ch === 'D' || ch === 'C') return ch
  return 'M'
}

/**
 * Unified Diff (`-U0`) のハンクヘッダから本文（frontmatter 除外後）基準の変更行レンジ一覧を抽出する。
 */
export function parseUnifiedDiffRanges(diffText: string, bodyLineOffset: number): ChangedLineRange[] {
  const ranges: ChangedLineRange[] = []
  for (const line of diffText.split(/\r?\n/)) {
    const match = HUNK_PATTERN.exec(line)
    if (!match) continue
    const oldCount = match[2] !== undefined ? Number(match[2]) : 1
    const newStart = Number(match[3])
    const newCount = match[4] !== undefined ? Number(match[4]) : 1

    const fileStart = newStart
    const fileEnd = newCount === 0 ? newStart : newStart + newCount - 1
    // frontmatter 領域のみの変更は本文ハイライト対象から除外する
    if (fileEnd <= bodyLineOffset) continue

    const startLine = Math.max(1, fileStart - bodyLineOffset)
    const endLine = Math.max(startLine, fileEnd - bodyLineOffset)
    const kind: ChangedLineRange['kind'] = oldCount === 0 && newCount > 0 ? 'added' : 'modified'
    ranges.push({ startLine, endLine, kind })
  }
  return ranges
}

function parseStatusMap(ctx: GitContext): Map<string, WorkingTreeStatus> {
  const result = new Map<string, WorkingTreeStatus>()
  const pathspec = ctx.relDocs || '.'
  const raw = runGit(ctx.gitRoot, ['status', '--porcelain', '-uall', '--', pathspec])
  if (!raw) return result

  for (const line of raw.split(/\r?\n/)) {
    if (line.length < 4) continue
    const xy = line.slice(0, 2)
    let filePath = line.slice(3).trim()
    // リネーム表記 "old -> new" のときは新パスを採用する
    const arrowIdx = filePath.indexOf(' -> ')
    if (arrowIdx >= 0) filePath = filePath.slice(arrowIdx + 4)
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1)
    }

    const docRel = stripDocsPrefix(ctx, filePath)
    if (!docRel) continue

    if (xy === '??') {
      result.set(docRel, 'untracked')
    } else if (xy[0] === 'A' && xy[1] !== 'D') {
      result.set(docRel, 'added')
    } else if (xy[0] !== 'D' && xy[1] !== 'D') {
      result.set(docRel, 'modified')
    }
  }
  return result
}

// @implements core.doc-history
/**
 * `docs/` 全体に対して 1 回の `git log` と `git status` で各文書の鮮度情報（作成日時・更新日時・未コミット状態）を付与する。
 * Git 管理外の場合はファイルシステムのタイムスタンプへ安全にフォールバックする。
 */
export async function applyGitFreshness(index: DocsIndex): Promise<void> {
  if (index.documents.length === 0) return

  const docByRelPath = new Map<string, Document>()
  for (const doc of index.documents) {
    docByRelPath.set(doc.path, doc)
  }

  const freshnessMap = new Map<string, DocumentFreshness>()
  const ctx = resolveGitContext(index.rootDir)

  if (ctx) {
    const pathspec = ctx.relDocs || '.'
    const logOutput = runGit(ctx.gitRoot, [
      'log',
      '--format=%x1e%H%x1f%aI%x1f%an%x1f%s',
      '--name-status',
      '-M',
      '--',
      pathspec,
    ])

    if (logOutput) {
      // 新しいコミットから古いコミットへ辿る際に、リネーム前の旧パスを現在パスへ写像する
      const pathAlias = new Map<string, string>()
      for (const chunk of logOutput.split('\x1e')) {
        const trimmed = chunk.trim()
        if (!trimmed) continue
        const lines = trimmed.split(/\r?\n/)
        const header = lines[0]?.split('\x1f')
        if (!header || header.length < 4) continue
        const sha = header[0] ?? ''
        const date = header[1] ?? ''
        const subject = header[3] ?? ''
        if (!sha || !date) continue

        for (let i = 1; i < lines.length; i++) {
          const rawLine = lines[i]?.trim()
          if (!rawLine) continue
          const parts = rawLine.split('\t')
          const rawStatus = parts[0] ?? ''
          let targetGitPath: string | undefined

          if ((rawStatus.startsWith('R') || rawStatus.startsWith('C')) && parts.length >= 3) {
            const oldPath = parts[1]!
            const newPath = parts[2]!
            const resolved = pathAlias.get(newPath) ?? newPath
            if (rawStatus.startsWith('R')) pathAlias.set(oldPath, resolved)
            targetGitPath = resolved
          } else if (parts.length >= 2) {
            const filePath = parts[1]!
            targetGitPath = pathAlias.get(filePath) ?? filePath
          }

          if (!targetGitPath) continue
          const docRel = stripDocsPrefix(ctx, targetGitPath)
          if (!docRel || !docByRelPath.has(docRel)) continue

          const existing = freshnessMap.get(docRel)
          if (!existing) {
            freshnessMap.set(docRel, {
              createdAt: date,
              updatedAt: date,
              lastCommitSha: sha.slice(0, 7),
              lastCommitSubject: subject,
              commitCount: 1,
            })
          } else {
            existing.createdAt = date
            existing.commitCount = (existing.commitCount ?? 0) + 1
          }
        }
      }
    }

    const statusMap = parseStatusMap(ctx)
    for (const [docRel, workingStatus] of statusMap) {
      if (!docByRelPath.has(docRel)) continue
      const existing = freshnessMap.get(docRel) ?? {}
      existing.workingStatus = workingStatus
      freshnessMap.set(docRel, existing)
    }
  }

  // 未コミット変更がある文書や Git 履歴が無い文書は fs.stat で時刻を補完する
  await Promise.all(
    index.documents.map(async (doc) => {
      const f: DocumentFreshness = freshnessMap.get(doc.path) ?? {}
      if (!f.createdAt || !f.updatedAt || f.workingStatus) {
        try {
          const st = await stat(path.join(index.rootDir, doc.path))
          const mtimeIso = st.mtime.toISOString()
          const birthIso = st.birthtimeMs > 0 ? st.birthtime.toISOString() : mtimeIso
          if (f.workingStatus || !f.updatedAt) f.updatedAt = mtimeIso
          if (!f.createdAt) f.createdAt = birthIso
        } catch {
          // stat に失敗しても既存メタデータのみで継続する
        }
      }
      if (f.createdAt || f.updatedAt || f.workingStatus) {
        doc.freshness = f
      }
    }),
  )
}

interface ParsedFileCommit extends GitCommitEntry {
  /** そのコミット時点での gitRoot からの相対パス */
  gitPath: string
}

function loadFileCommits(ctx: GitContext, docRelPath: string, limit: number): ParsedFileCommit[] {
  const gitRel = toGitRelPath(ctx, docRelPath)
  const raw = runGit(ctx.gitRoot, [
    'log',
    '--follow',
    '-n',
    String(limit),
    '--format=%x1e%H%x1f%aI%x1f%an%x1f%s',
    '--name-status',
    '-M',
    '--',
    gitRel,
  ])
  if (!raw) return []

  const commits: ParsedFileCommit[] = []
  for (const chunk of raw.split('\x1e')) {
    const trimmed = chunk.trim()
    if (!trimmed) continue
    const lines = trimmed.split(/\r?\n/)
    const header = lines[0]?.split('\x1f')
    if (!header || header.length < 4) continue
    const sha = header[0] ?? ''
    const date = header[1] ?? ''
    const author = header[2] ?? ''
    const subject = header[3] ?? ''
    if (!sha || !date) continue

    let status: GitCommitEntry['status'] = 'M'
    let gitPath = gitRel
    for (let i = 1; i < lines.length; i++) {
      const fileLine = lines[i]?.trim()
      if (!fileLine) continue
      const parts = fileLine.split('\t')
      if (parts.length >= 2) {
        status = normalizeCommitStatus(parts[0] ?? 'M')
        gitPath = (status === 'R' || status === 'C') && parts[2] ? parts[2] : parts[1]!
        break
      }
    }

    commits.push({
      sha,
      shortSha: sha.slice(0, 7),
      date,
      author,
      subject,
      status,
      gitPath,
    })
  }
  return commits
}

async function computeBodyLineOffset(docsDir: string, docRelPath: string): Promise<number> {
  try {
    const raw = await readFile(path.join(docsDir, docRelPath), 'utf-8')
    const fm = splitFrontmatter(raw)
    return fm.isOk() ? fm.value.bodyStartLine - 1 : 0
  } catch {
    return 0
  }
}

// @implements core.doc-history
/**
 * 指定ドキュメントのコミット履歴と、最新変更箇所（未コミット変更または最新コミット）の本文基準行レンジを取得する。
 */
export async function getDocumentHistory(docsDir: string, doc: Document, limit = 20): Promise<DocumentHistory> {
  const freshness: DocumentFreshness = doc.freshness ? { ...doc.freshness } : {}
  const ctx = resolveGitContext(docsDir)

  if (!ctx) {
    return {
      docId: doc.id,
      path: doc.path,
      gitAvailable: false,
      freshness,
      highlightBasis: 'none',
      changedRanges: [],
      commits: [],
    }
  }

  const parsedCommits = loadFileCommits(ctx, doc.path, Math.max(1, Math.min(limit, 50)))
  const commits: GitCommitEntry[] = parsedCommits.map((c) => ({
    sha: c.sha,
    shortSha: c.shortSha,
    date: c.date,
    author: c.author,
    subject: c.subject,
    status: c.status,
  }))

  const statusMap = parseStatusMap(ctx)
  const workingStatus = statusMap.get(doc.path)
  if (workingStatus) freshness.workingStatus = workingStatus
  else delete freshness.workingStatus

  const bodyLineOffset = await computeBodyLineOffset(docsDir, doc.path)
  const bodyLineCount = Math.max(1, doc.body.split(/\r?\n/).length)
  const gitRel = toGitRelPath(ctx, doc.path)

  if (workingStatus === 'untracked' || workingStatus === 'added') {
    return {
      docId: doc.id,
      path: doc.path,
      gitAvailable: true,
      freshness,
      highlightBasis: 'working',
      changedRanges: [{ startLine: 1, endLine: bodyLineCount, kind: 'added' }],
      commits,
    }
  }

  if (workingStatus === 'modified') {
    const diffText = runGit(ctx.gitRoot, ['diff', '-U0', 'HEAD', '--', gitRel]) ?? ''
    const changedRanges = parseUnifiedDiffRanges(diffText, bodyLineOffset)
    return {
      docId: doc.id,
      path: doc.path,
      gitAvailable: true,
      freshness,
      highlightBasis: changedRanges.length > 0 ? 'working' : 'none',
      changedRanges,
      commits,
    }
  }

  const latest = parsedCommits[0]
  const latestEntry = commits[0]
  if (latest && latestEntry) {
    const diffText = runGit(ctx.gitRoot, ['show', '-U0', '--format=', latest.sha, '--', latest.gitPath]) ?? ''
    const changedRanges = parseUnifiedDiffRanges(diffText, bodyLineOffset)
    if (changedRanges.length > 0) {
      return {
        docId: doc.id,
        path: doc.path,
        gitAvailable: true,
        freshness,
        highlightBasis: 'last-commit',
        highlightCommit: latestEntry,
        changedRanges,
        commits,
      }
    }
    return {
      docId: doc.id,
      path: doc.path,
      gitAvailable: true,
      freshness,
      highlightBasis: 'none',
      changedRanges: [],
      commits,
    }
  }

  return {
    docId: doc.id,
    path: doc.path,
    gitAvailable: true,
    freshness,
    highlightBasis: 'none',
    changedRanges: [],
    commits,
  }
}

// @implements core.doc-history
/**
 * 指定コミット SHA 時点のドキュメント本文・メタデータを読み取り専用で取得する。
 */
export function getDocumentRevision(
  docsDir: string,
  doc: Document,
  commitSha: string,
): Result<DocumentRevision, HistoryDomainError> {
  const trimmed = commitSha.trim()
  if (!SHA_PATTERN.test(trimmed)) {
    return Result.err(new InvalidCommitShaError({ commitSha, message: `Invalid commit SHA: ${commitSha}` }))
  }

  const ctx = resolveGitContext(docsDir)
  if (!ctx) {
    return Result.err(new GitRepoUnavailableError({ message: 'Document directory is not inside a Git repository' }))
  }

  const commitHeaderRaw = runGit(ctx.gitRoot, ['log', '-1', '--format=%H%x1f%aI%x1f%an%x1f%s', trimmed])
  if (!commitHeaderRaw?.trim()) {
    return Result.err(new CommitNotFoundError({ commitSha: trimmed, message: `Commit not found: ${trimmed}` }))
  }
  const [sha = '', date = '', author = '', subject = ''] = commitHeaderRaw.trim().split('\x1f')

  const gitRel = toGitRelPath(ctx, doc.path)
  let rawContent = runGit(ctx.gitRoot, ['show', `${sha}:${gitRel}`])
  let commitStatus: GitCommitEntry['status'] = 'M'

  if (rawContent === undefined) {
    // リネーム前の旧パスを履歴から探索して取得する
    const history = loadFileCommits(ctx, doc.path, 100)
    const matched = history.find((c) => c.sha === sha || c.sha.startsWith(trimmed))
    if (matched) {
      commitStatus = matched.status
      rawContent = runGit(ctx.gitRoot, ['show', `${sha}:${matched.gitPath}`])
    }
  }

  if (rawContent === undefined) {
    return Result.err(
      new DocumentNotInCommitError({
        commitSha: sha,
        docPath: doc.path,
        message: `Document does not exist at commit ${sha.slice(0, 7)}`,
      }),
    )
  }

  let title = doc.title
  let description = ''
  let body = rawContent
  const fmRes = splitFrontmatter(rawContent)
  if (fmRes.isOk()) {
    const fm = fmRes.value
    body = fm.body
    if (fm.hasFrontmatter) {
      const parsedRes = parseYamlFrontmatter(fm.data)
      if (parsedRes.isOk()) {
        const parsed = parsedRes.value
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>
          if (typeof record.title === 'string' && record.title.trim()) title = record.title.trim()
          if (typeof record.description === 'string') description = record.description
        }
      }
    }
  }

  return Result.ok({
    docId: doc.id,
    path: doc.path,
    commit: {
      sha,
      shortSha: sha.slice(0, 7),
      date,
      author,
      subject,
      status: commitStatus,
    },
    title,
    description,
    format: doc.format,
    dir: doc.dir,
    body,
  })
}

const DEFAULT_BASE_BRANCHES = ['origin/main', 'main', 'origin/master', 'master'] as const

function resolveDiffBaseRef(ctx: GitContext): string | undefined {
  const head = runGit(ctx.gitRoot, ['rev-parse', '--verify', 'HEAD'])?.trim()
  if (!head) return undefined

  const currentBranch = runGit(ctx.gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim()
  if (currentBranch && currentBranch !== 'HEAD' && currentBranch !== 'main' && currentBranch !== 'master') {
    for (const candidate of DEFAULT_BASE_BRANCHES) {
      const mergeBase = runGit(ctx.gitRoot, ['merge-base', candidate, 'HEAD'])?.trim()
      if (mergeBase) return mergeBase
    }
  }
  return 'HEAD'
}

// @implements core.doc-history
/**
 * 現在の作業ツリー（未コミット変更・新規ファイル）およびデフォルトブランチ分岐以降の差分に含まれる
 * セマンティックブロック ID の集合を返す。Git 管理外の場合は空集合を返す。
 */
export function getChangedBlockIds(index: DocsIndex): Set<string> {
  const changedIds = new Set<string>()
  const ctx = resolveGitContext(index.rootDir)
  if (!ctx) return changedIds

  const changedByDoc = new Map<string, ChangedLineRange[] | 'all'>()
  const statusMap = parseStatusMap(ctx)
  for (const [docRel, status] of statusMap) {
    if (status === 'untracked' || status === 'added') {
      changedByDoc.set(docRel, 'all')
    }
  }

  const baseRef = resolveDiffBaseRef(ctx)
  if (baseRef) {
    const pathspec = ctx.relDocs || '.'
    const diffText = runGit(ctx.gitRoot, ['diff', '-U0', baseRef, '--', pathspec]) ?? ''
    if (diffText) {
      let currentDocRel: string | undefined
      let currentLines: string[] = []
      const flush = () => {
        if (!currentDocRel || changedByDoc.get(currentDocRel) === 'all') return
        const ranges = parseUnifiedDiffRanges(currentLines.join('\n'), 0)
        if (ranges.length > 0) changedByDoc.set(currentDocRel, ranges)
      }

      for (const line of diffText.split(/\r?\n/)) {
        if (line.startsWith('diff --git ')) {
          flush()
          currentDocRel = undefined
          currentLines = []
          continue
        }
        if (line.startsWith('+++ ')) {
          const rawPath = line.slice(4).trim()
          if (rawPath === '/dev/null') {
            currentDocRel = undefined
          } else {
            const gitPath = rawPath.startsWith('b/') ? rawPath.slice(2) : rawPath
            currentDocRel = stripDocsPrefix(ctx, gitPath)
          }
          continue
        }
        if (currentDocRel && line.startsWith('@@ ')) {
          currentLines.push(line)
        }
      }
      flush()
    }
  }

  for (const doc of index.documents) {
    const entry = changedByDoc.get(doc.path)
    if (!entry) continue
    for (const block of doc.blocks) {
      if (entry === 'all' || entry.some((r) => r.startLine <= block.endLine && r.endLine >= block.startLine)) {
        changedIds.add(block.id)
      }
    }
  }

  return changedIds
}
