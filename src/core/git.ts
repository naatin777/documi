import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { parsePatch, type StructuredPatchHunk } from 'diff'
import type { ChangedLineRange, DocsIndex, Document, DocumentFreshness, WorkingTreeStatus } from './types'

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

/** 現在の Git HEAD 短縮 SHA を取得する（非 Git 環境や未コミット時は undefined） */
export function getGitHeadShortSha(cwd: string): string | undefined {
  return runGit(cwd, ['rev-parse', '--short', 'HEAD'])?.trim() || undefined
}

/** Git リポジトリの user.name を取得する。非 Git 環境や未設定時は undefined を返し、OS ユーザー名等へフォールバックしない */
export function getGitUserName(cwd: string): string | undefined {
  if (!runGit(cwd, ['rev-parse', '--is-inside-work-tree'])?.trim()) return undefined
  return runGit(cwd, ['config', 'user.name'])?.trim() || undefined
}

/** 指定コミット時点の docsDir 配下ファイルの生テキストを取得する */
export function readFileAtGitCommit(docsDir: string, commit: string, docRelPath: string): string | undefined {
  const ctx = resolveGitContext(docsDir)
  if (!ctx) return undefined
  return runGit(ctx.gitRoot, ['show', `${commit}:${toGitRelPath(ctx, docRelPath)}`])
}

/** 指定パスに未コミット変更または未追跡ファイルがあるかを返す（非 Git 環境では false） */
export function isGitPathDirty(projectRoot: string, targetPath: string): boolean {
  const rel = toPosix(path.relative(projectRoot, targetPath))
  const status = runGit(projectRoot, ['status', '--porcelain=v1', '-z', '--', rel])
  return Boolean(status && status.length > 0)
}

/** projectRoot 配下の未コミット・ステージ・未追跡ファイル一覧（projectRoot 相対 POSIX パス）を返す。非 Git 環境では undefined */
export function listGitDirtyPaths(projectRoot: string): string[] | undefined {
  const absRoot = safeRealpath(projectRoot)
  const rawTop = runGit(absRoot, ['rev-parse', '--show-toplevel'])
  if (!rawTop) return undefined
  const gitRoot = safeRealpath(rawTop.trim())
  const relPrefix = toPosix(path.relative(gitRoot, absRoot))
  if (relPrefix.startsWith('..') || path.isAbsolute(relPrefix)) return undefined
  const prefix = relPrefix === '.' || relPrefix === '' ? '' : `${relPrefix}/`

  const raw = runGit(gitRoot, ['status', '--porcelain=v1', '-z', '-uall', '--', prefix || '.'])
  if (raw === undefined) return undefined
  if (!raw) return []

  const dirty: string[] = []
  const entries = raw.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry || entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const filePath = entry.slice(3)
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      i++
    }
    const rel = prefix ? (filePath.startsWith(prefix) ? filePath.slice(prefix.length) : undefined) : filePath
    if (rel) dirty.push(rel)
  }
  return dirty
}

function hunksToChangedRanges(hunks: readonly StructuredPatchHunk[], bodyLineOffset: number): ChangedLineRange[] {
  const ranges: ChangedLineRange[] = []
  for (const hunk of hunks) {
    const fileStart = hunk.newStart
    const fileEnd = hunk.newLines === 0 ? hunk.newStart : hunk.newStart + hunk.newLines - 1
    // frontmatter 領域のみの変更は本文ハイライト対象から除外する
    if (fileEnd <= bodyLineOffset) continue

    const startLine = Math.max(1, fileStart - bodyLineOffset)
    const endLine = Math.max(startLine, fileEnd - bodyLineOffset)
    const kind: ChangedLineRange['kind'] = hunk.oldLines === 0 && hunk.newLines > 0 ? 'added' : 'modified'
    ranges.push({ startLine, endLine, kind })
  }
  return ranges
}

/**
 * Unified Diff (`-U0`) のハンクから本文（frontmatter 除外後）基準の変更行レンジ一覧を抽出する。
 */
function parseStatusMap(ctx: GitContext): Map<string, WorkingTreeStatus> {
  const result = new Map<string, WorkingTreeStatus>()
  const pathspec = ctx.relDocs || '.'
  // -z (NUL 区切り) を使うことでパスのクォート・エスケープやリネーム表記の揺れを排除する
  const raw = runGit(ctx.gitRoot, ['status', '--porcelain=v1', '-z', '-uall', '--', pathspec])
  if (!raw) return result

  const entries = raw.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry || entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const filePath = entry.slice(3)
    // リネーム/コピー (R/C) の直後に続く旧パス要素をスキップ
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      i++
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

  const mounts =
    index.mounts && index.mounts.length > 0 ? index.mounts : [{ id: 'root', dir: index.rootDir, prefixed: false }]

  // マウント単位で Git 鮮度と status を取得し、doc.id 単位に集約する
  const freshnessByDocId = new Map<string, DocumentFreshness>()

  for (const mount of mounts) {
    const mountDocs = index.documents.filter((d) => d.mountId === mount.id)
    if (mountDocs.length === 0) continue

    const docByMountRel = new Map<string, Document>()
    for (const doc of mountDocs) {
      docByMountRel.set(doc.mountRelPath || doc.path, doc)
    }

    const ctx = resolveGitContext(mount.dir)
    if (!ctx) continue

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
          const matchedDoc = docRel ? docByMountRel.get(docRel) : undefined
          if (!matchedDoc) continue

          const existing = freshnessByDocId.get(matchedDoc.id)
          if (!existing) {
            freshnessByDocId.set(matchedDoc.id, {
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
      const matchedDoc = docByMountRel.get(docRel)
      if (!matchedDoc) continue
      const existing = freshnessByDocId.get(matchedDoc.id) ?? {}
      existing.workingStatus = workingStatus
      freshnessByDocId.set(matchedDoc.id, existing)
    }
  }

  const mountDirById = new Map(mounts.map((m) => [m.id, m.dir]))

  // 未コミット変更がある文書や Git 履歴が無い文書は fs.stat で時刻を補完する
  await Promise.all(
    index.documents.map(async (doc) => {
      const f: DocumentFreshness = freshnessByDocId.get(doc.id) ?? {}
      if (!f.createdAt || !f.updatedAt || f.workingStatus) {
        try {
          const mountDir = mountDirById.get(doc.mountId) ?? index.rootDir
          const st = await stat(path.join(mountDir, doc.mountRelPath || doc.path))
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
    if (diffText.trim()) {
      for (const patch of parsePatch(diffText)) {
        if (patch.isDelete || !patch.newFileName || patch.newFileName === '/dev/null') continue
        const gitPath = patch.newFileName.startsWith('b/') ? patch.newFileName.slice(2) : patch.newFileName
        const docRel = stripDocsPrefix(ctx, gitPath)
        if (!docRel || changedByDoc.get(docRel) === 'all') continue
        const ranges = hunksToChangedRanges(patch.hunks, 0)
        if (ranges.length > 0) changedByDoc.set(docRel, ranges)
      }
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
