import path from 'node:path'
import type { ReviewGate } from './config'
import { isGitPathDirty } from './git'
import { computeDocumentHealth } from './health'
import type { DocumentHealthSummary } from './health'
import { loadDocuments } from './loader'
import { REVIEWS_REL_PATH } from './reviews'
import { enrichWithRealization, validateSourceLinks } from './trace'
import type { DocsIndex, IndexIssue, RealizationStatus } from './types'

export interface CheckOptions {
  docsDir: string
  projectRoot?: string
  testReportPath?: string
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

  const index = await loadDocuments(docsDir)
  const { issues: sourceIssues, brokenSpecIds } = await validateSourceLinks(projectRoot, index)
  const { unknownAnchors } = await enrichWithRealization(index, {
    projectRoot,
    testReportPath: options.testReportPath,
    fetchPrs: options.fetchPrs,
    brokenSpecIds,
  })

  const errors: CheckFinding[] = []
  const warnings: CheckFinding[] = []

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

  for (const issue of index.issues) pushIssue(issue)
  for (const doc of index.documents) {
    for (const issue of doc.issues) {
      pushIssue({ ...issue, path: doc.path })
    }
  }
  for (const issue of sourceIssues) pushIssue(issue, 'error')

  for (const anchor of unknownAnchors) {
    warnings.push({
      severity: 'warning',
      code: 'unknown-anchor-spec',
      message: `Unknown spec ID "${anchor.specId}" referenced by @${anchor.kind} at ${anchor.file}:L${anchor.line}`,
      path: anchor.file,
      blockId: anchor.specId,
    })
  }

  if (options.noReviewEdit && isReviewsFileModifiedInGit(projectRoot, docsDir)) {
    errors.push({
      severity: 'error',
      code: 'review-file-modified',
      message: `${REVIEWS_REL_PATH} has uncommitted modifications (disallowed by --no-review-edit)`,
      path: REVIEWS_REL_PATH,
    })
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

  const health = computeDocumentHealth(index)

  return {
    ok: errors.length === 0,
    docsDir,
    documentCount: index.documents.length,
    blockCount: index.blocksById.size,
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
