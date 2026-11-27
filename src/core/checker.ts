import path from 'node:path'
import type { ReviewGate } from './config'
import { isGitPathDirty } from './git'
import { computeDocumentHealth } from './health'
import type { DocumentHealthSummary } from './health'
import { loadDocuments } from './loader'
import { REVIEWS_REL_PATH } from './reviews'
import { enrichWithRealization, validateSourceLinks } from './trace'
import type { DocsIndex, DocsMount, IndexIssue, RealizationStatus } from './types'

export interface CheckOptions {
  docsDir: string
  /** Monorepo 統合マウント一覧（省略時は docsDir を単一 root マウントとして扱う） */
  mounts?: DocsMount[]
  /** 指定マウント ID へ検証・集計を絞り込む（全体グラフをロードした上で絞り込むため他マウント参照が壊れない） */
  mount?: string
  projectRoot?: string
  testReportPath?: string
  testReportPaths?: string[]
  /** true のとき全 normative ブロックの未承認・stale・drifted もエラー扱いにする（suspect は参考通知のまま） */
  strict?: boolean
  /** 段階的な承認ゲート ("none" | "stable" | "all")。strict: true の場合は常に "all" として扱う */
  reviewGate?: ReviewGate
  /** true のとき Git 作業ツリー／ステージに reviews.json の変更があるとエラーにする (AI 改ざん防止用) */
  noReviewEdit?: boolean
  /** true のとき gh CLI から PR 情報も取得する */
  fetchPrs?: boolean
}

export interface CheckFinding {
  severity: 'error' | 'warning'
  code: string
  message: string
  path?: string
  blockId?: string
}

export interface CheckReport {
  ok: boolean
  docsDir: string
  mount?: string
  documentCount: number
  blockCount: number
  errors: CheckFinding[]
  warnings: CheckFinding[]
  realizationCounts: Record<RealizationStatus, number>
  reviewCounts: { approved: number; unreviewed: number; stale: number; suspect: number }
  health: DocumentHealthSummary
  index: DocsIndex
}

const WARNING_ONLY_CODES = new Set(['missing-frontmatter', 'missing-title', 'inferred-default-type'])

/**
 * ドキュメント構造・Rooted DAG・MDX 安全・AST シンボル・テスト結果・レビュー改ざんを一括検証する。
 */
export async function runDocsCheck(options: CheckOptions): Promise<CheckReport> {
  const docsDir = path.resolve(options.docsDir)
  const projectRoot = path.resolve(options.projectRoot ?? path.dirname(docsDir))

  const index = await loadDocuments(docsDir, { mounts: options.mounts })
  const mount = options.mount?.trim() || undefined
  const targetMount = mount ? index.mounts.find((m) => m.id === mount) : undefined

  const { issues: sourceIssues, brokenSpecIds } = await validateSourceLinks(projectRoot, index)
  const { unknownAnchors } = await enrichWithRealization(index, {
    projectRoot,
    testReportPath: options.testReportPath,
    testReportPaths: options.testReportPaths,
    fetchPrs: options.fetchPrs,
    brokenSpecIds,
  })

  const scopedDocs = mount ? index.documents.filter((d) => d.mountId === mount) : index.documents
  const scopedDocIds = new Set(scopedDocs.map((d) => d.id))
  const scopedDocPaths = new Set(scopedDocs.map((d) => d.path))
  const scopedBlockIds = new Set<string>()
  for (const doc of scopedDocs) {
    for (const b of doc.blocks) scopedBlockIds.add(b.id)
  }

  const errors: CheckFinding[] = []
  const warnings: CheckFinding[] = []

  if (mount && !targetMount) {
    const available = index.mounts.map((m) => m.id).join(', ')
    errors.push({
      severity: 'error',
      code: 'unknown-mount',
      message: `Unknown docs mount "${mount}" (available mounts: ${available})`,
    })
  }

  const pushIssue = (issue: IndexIssue, defaultSeverity: 'error' | 'warning' = 'error') => {
    const severity = WARNING_ONLY_CODES.has(issue.code) ? 'warning' : defaultSeverity
    const finding: CheckFinding = {
      severity,
      code: issue.code,
      message: issue.message,
      path: issue.path,
      blockId: issue.blockId,
    }
    if (severity === 'error') errors.push(finding)
    else warnings.push(finding)
  }

  for (const issue of index.issues) {
    if (mount) {
      const matchesPath =
        issue.path && (scopedDocPaths.has(issue.path) || (targetMount?.prefixed && issue.path.startsWith(`${mount}/`)))
      const matchesBlock = issue.blockId && scopedBlockIds.has(issue.blockId)
      if (!matchesPath && !matchesBlock) continue
    }
    pushIssue(issue)
  }
  for (const doc of scopedDocs) {
    for (const issue of doc.issues) {
      pushIssue({ ...issue, path: doc.path })
    }
  }
  for (const issue of sourceIssues) {
    if (mount && issue.path && !scopedDocPaths.has(issue.path)) continue
    pushIssue(issue, 'error')
  }

  if (!mount) {
    for (const anchor of unknownAnchors) {
      warnings.push({
        severity: 'warning',
        code: 'unknown-anchor-spec',
        message: `Unknown spec ID "${anchor.specId}" referenced by @${anchor.kind} at ${anchor.file}:L${anchor.line}`,
        path: anchor.file,
        blockId: anchor.specId,
      })
    }
  }

  if (options.noReviewEdit) {
    const mountsToCheck = targetMount ? [targetMount] : index.mounts
    for (const m of mountsToCheck) {
      if (isReviewsFileModifiedInGit(projectRoot, m.dir)) {
        const displayPath = m.prefixed ? `${m.id}/${REVIEWS_REL_PATH}` : REVIEWS_REL_PATH
        errors.push({
          severity: 'error',
          code: 'review-file-modified',
          message: `${displayPath} has uncommitted modifications (disallowed by --no-review-edit)`,
          path: displayPath,
        })
      }
    }
  }

  const realizationCounts: Record<RealizationStatus, number> = {
    unimplemented: 0,
    'in-progress': 0,
    implemented: 0,
    verified: 0,
    drifted: 0,
  }
  const reviewCounts = { approved: 0, unreviewed: 0, stale: 0, suspect: 0 }

  const effectiveReviewGate: ReviewGate = options.strict ? 'all' : (options.reviewGate ?? 'none')

  for (const block of index.blocksById.values()) {
    if (mount && !scopedDocIds.has(block.docId)) continue
    if (block.kind !== 'note') {
      reviewCounts[block.review]++
      if (block.suspect) reviewCounts.suspect++
    }
    if (block.realization) {
      realizationCounts[block.realization.status]++
      if (block.realization.status === 'drifted') {
        const finding: CheckFinding = {
          severity: options.strict ? 'error' : 'warning',
          code: 'spec-drifted',
          message: `<Spec id="${block.id}"> is drifted: ${block.realization.reasons.join(' / ')}`,
          path: index.byId.get(block.docId)?.path,
          blockId: block.id,
        }
        if (finding.severity === 'error') errors.push(finding)
        else warnings.push(finding)
      }
    }
    const requiresApproval =
      effectiveReviewGate === 'all' || (effectiveReviewGate === 'stable' && block.stability === 'stable')
    if (requiresApproval && block.kind !== 'note' && block.intent === 'normative') {
      if (block.review !== 'approved') {
        const reason = options.strict ? '--strict' : `--review-gate ${effectiveReviewGate}`
        errors.push({
          severity: 'error',
          code: `review-${block.review}`,
          message: `Block "${block.id}" is not approved (${block.review}) (${reason})`,
          path: index.byId.get(block.docId)?.path,
          blockId: block.id,
        })
      }
    }
  }

  const fullHealth = computeDocumentHealth(index)
  const health: DocumentHealthSummary = mount
    ? {
        ...fullHealth,
        bloatedSpecDocs: fullHealth.bloatedSpecDocs.filter((d) => scopedDocIds.has(d.docId)),
        overloadedHubDocs: fullHealth.overloadedHubDocs.filter((d) => scopedDocIds.has(d.docId)),
        staleSystemDesignDocs: fullHealth.staleSystemDesignDocs.filter((d) => scopedDocIds.has(d.docId)),
        hints: fullHealth.hints.filter(
          (h) => (h.docId && scopedDocIds.has(h.docId)) || (h.blockId && scopedBlockIds.has(h.blockId)),
        ),
      }
    : fullHealth

  return {
    ok: errors.length === 0,
    docsDir,
    ...(mount ? { mount } : {}),
    documentCount: scopedDocs.length,
    blockCount: scopedBlockIds.size,
    errors,
    warnings,
    realizationCounts,
    reviewCounts,
    health,
    index,
  }
}

function isReviewsFileModifiedInGit(projectRoot: string, docsDir: string): boolean {
  return isGitPathDirty(projectRoot, path.join(docsDir, REVIEWS_REL_PATH))
}
