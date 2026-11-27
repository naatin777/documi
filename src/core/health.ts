import path from 'node:path'
import { listGitDirtyPaths } from './git'
import { REVIEWS_REL_PATH } from './reviews'
import type { DocsIndex } from './types'

const DEFAULT_MAX_SPECS_PER_DOC = 10
const DEFAULT_MAX_TRACE_TARGETS_PER_DOC = 10
const STALE_ARCH_MIN_NEWER_DOCS = 5
const STALE_ARCH_GRACE_MS = 24 * 60 * 60 * 1000
const CODE_OR_SKILL_PATH_RE = /^(?:src|lib|app|packages|\.(?:agents|claude|cursor)\/skills)\//

type DocumentHealthHintCode =
  | 'missing-design'
  | 'missing-test'
  | 'bloated-spec-doc'
  | 'overloaded-hub-doc'
  | 'stale-system-design'
  | 'anti-term-used'
  | 'source-ref-fragile-lines'
  | 'source-ref-outside-design'
  | 'docs-sync-missing'

interface DocumentHealthHint {
  code: DocumentHealthHintCode
  message: string
  path?: string
  docId?: string
  blockId?: string
}

interface BloatedSpecDocInfo {
  docId: string
  path: string
  specCount: number
  threshold: number
}

interface OverloadedHubDocInfo {
  docId: string
  path: string
  docType: 'design'
  edgeKind: 'satisfies'
  targetCount: number
  threshold: number
}

interface StaleSystemDesignInfo {
  docId: string
  path: string
  updatedAt?: string
  newerDocsCount: number
}

interface AntiTermUsageInfo {
  docId: string
  path: string
  blockId: string
  antiTerm: string
  preferredTermId: string
}

export interface WorkspaceHealthSignals {
  /** Git 作業ツリー／ステージ上の変更パス（projectRoot 相対 POSIX パス） */
  dirtyPaths?: string[]
  /** projectRoot 相対の docs マウントディレクトリ一覧 */
  docsRelDirs?: string[]
}

export interface DocumentHealthSummary {
  totalNormativeSpecs: number
  designCoveredSpecs: number
  testCoveredSpecs: number
  uncoveredByDesign: string[]
  uncoveredByTest: string[]
  bloatedSpecDocs: BloatedSpecDocInfo[]
  overloadedHubDocs: OverloadedHubDocInfo[]
  staleSystemDesignDocs: StaleSystemDesignInfo[]
  antiTermUsages: AntiTermUsageInfo[]
  hints: DocumentHealthHint[]
}

interface ComputeHealthOptions {
  /** 1 つの spec ドキュメントに含める推奨最大 <Spec> 数（超過で分割推奨ヒントを出す） */
  maxSpecsPerDoc?: number
  /** 1 つの design から伸ばす推奨最大トレース辺数（超過で分割推奨ヒントを出す） */
  maxTraceTargetsPerDoc?: number
  /** ワークスペース由来の逆方向漏れシグナル（Git 変更パス） */
  workspace?: WorkspaceHealthSignals
}

/**
 * Git 未コミット変更パスと docs マウント相対パスを収集する。
 * 非 Git 環境では安全に undefined へフォールバックする。
 */
export function collectWorkspaceHealthSignals(projectRoot: string, index: DocsIndex): WorkspaceHealthSignals {
  const absRoot = path.resolve(projectRoot)
  const mountDirs = index.mounts.length > 0 ? index.mounts.map((m) => m.dir) : [index.rootDir]
  const docsRelDirs: string[] = []
  for (const dir of mountDirs) {
    const rel = path.relative(absRoot, path.resolve(dir)).split(path.sep).join('/')
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      docsRelDirs.push(rel.replace(/\/+$/, ''))
    }
  }

  const dirtyPaths = listGitDirtyPaths(absRoot)
  return {
    dirtyPaths,
    docsRelDirs,
  }
}

// @implements core.doc-health
/**
 * Living Specification 全体の構造健全性（Design / Verification カバレッジ・Spec 肥大化・ハブ過密・Architecture 鮮度差）を算出する。
 * 過度な形式主義を避けるため、すべて CI を壊さない Advisory ヒントとして返す。
 */
export function computeDocumentHealth(index: DocsIndex, options: ComputeHealthOptions = {}): DocumentHealthSummary {
  const maxSpecsPerDoc = options.maxSpecsPerDoc ?? DEFAULT_MAX_SPECS_PER_DOC
  const maxTraceTargetsPerDoc = options.maxTraceTargetsPerDoc ?? DEFAULT_MAX_TRACE_TARGETS_PER_DOC

  const designTargets = new Set<string>()
  const verificationTargets = new Set<string>()
  const outgoingTargetsByDoc = new Map<string, Set<string>>()

  for (const edge of index.edges) {
    const fromDoc = index.byId.get(edge.fromDocId)
    if (!fromDoc) continue
    if (edge.kind === 'satisfies' && fromDoc.type === 'design') {
      designTargets.add(edge.to)
      let set = outgoingTargetsByDoc.get(fromDoc.id)
      if (!set) {
        set = new Set<string>()
        outgoingTargetsByDoc.set(fromDoc.id, set)
      }
      set.add(edge.to)
    } else if (edge.kind === 'verifies') {
      verificationTargets.add(edge.to)
    }
  }

  const uncoveredByDesign: string[] = []
  const uncoveredByTest: string[] = []
  const hints: DocumentHealthHint[] = []
  let totalNormativeSpecs = 0
  let designCoveredSpecs = 0
  let testCoveredSpecs = 0

  for (const block of index.blocksById.values()) {
    if (block.kind !== 'spec' || block.intent !== 'normative') continue
    totalNormativeSpecs++
    const ownerDoc = index.byId.get(block.docId)

    const hasDesign = designTargets.has(block.id) || designTargets.has(block.docId)
    if (hasDesign) {
      designCoveredSpecs++
    } else {
      uncoveredByDesign.push(block.id)
      hints.push({
        code: 'missing-design',
        message: `<Spec id="${block.id}"> has no design document satisfying it`,
        path: ownerDoc?.path,
        docId: block.docId,
        blockId: block.id,
      })
    }

    const hasTest = verificationTargets.has(block.id) || verificationTargets.has(block.docId)
    if (hasTest) {
      testCoveredSpecs++
    } else {
      uncoveredByTest.push(block.id)
      hints.push({
        code: 'missing-test',
        message: `<Spec id="${block.id}"> has no <Test verifies="${block.id}"> or verifies edge covering it`,
        path: ownerDoc?.path,
        docId: block.docId,
        blockId: block.id,
      })
    }
  }

  uncoveredByDesign.sort()
  uncoveredByTest.sort()

  const bloatedSpecDocs: BloatedSpecDocInfo[] = []
  for (const doc of index.documents) {
    if (doc.type !== 'spec') continue
    const specCount = doc.blocks.filter((b) => b.kind === 'spec').length
    if (specCount > maxSpecsPerDoc) {
      bloatedSpecDocs.push({
        docId: doc.id,
        path: doc.path,
        specCount,
        threshold: maxSpecsPerDoc,
      })
      hints.push({
        code: 'bloated-spec-doc',
        message: `${doc.path} contains ${specCount} <Spec> blocks (recommended max: ${maxSpecsPerDoc}; consider splitting by domain)`,
        path: doc.path,
        docId: doc.id,
      })
    }
  }

  const overloadedHubDocs: OverloadedHubDocInfo[] = []
  for (const doc of index.documents) {
    if (doc.type !== 'design') continue
    const targets = outgoingTargetsByDoc.get(doc.id)
    const targetCount = targets?.size ?? 0
    if (targetCount > maxTraceTargetsPerDoc) {
      overloadedHubDocs.push({
        docId: doc.id,
        path: doc.path,
        docType: 'design',
        edgeKind: 'satisfies',
        targetCount,
        threshold: maxTraceTargetsPerDoc,
      })
      hints.push({
        code: 'overloaded-hub-doc',
        message: `${doc.path} has ${targetCount} satisfies targets (recommended max: ${maxTraceTargetsPerDoc}; consider splitting by capability/domain)`,
        path: doc.path,
        docId: doc.id,
      })
    }
  }

  const staleSystemDesignDocs: StaleSystemDesignInfo[] = []
  const systemDesignDocs = index.documents.filter((d) => d.type === 'design' && d.scope === 'system')
  const specOrDesignDocs = index.documents.filter(
    (d) => d.type === 'spec' || (d.type === 'design' && d.scope !== 'system'),
  )

  for (const arch of systemDesignDocs) {
    const archUpdatedMs = arch.freshness?.updatedAt ? Date.parse(arch.freshness.updatedAt) : Number.NaN
    if (!Number.isFinite(archUpdatedMs)) continue
    let newerDocsCount = 0
    for (const d of specOrDesignDocs) {
      const updatedMs = d.freshness?.updatedAt ? Date.parse(d.freshness.updatedAt) : Number.NaN
      if (Number.isFinite(updatedMs) && updatedMs - archUpdatedMs > STALE_ARCH_GRACE_MS) {
        newerDocsCount++
      }
    }
    if (newerDocsCount >= STALE_ARCH_MIN_NEWER_DOCS) {
      staleSystemDesignDocs.push({
        docId: arch.id,
        path: arch.path,
        updatedAt: arch.freshness?.updatedAt,
        newerDocsCount,
      })
      hints.push({
        code: 'stale-system-design',
        message: `${newerDocsCount} spec/design documents were updated after ${arch.path} (consider refreshing the system design overview)`,
        path: arch.path,
        docId: arch.id,
      })
    }
  }

  const antiTermUsages = detectAntiTermUsages(index, hints)
  detectFragileSourceRefs(index, hints)
  detectWorkspaceReverseLeaks(options.workspace, hints)

  return {
    totalNormativeSpecs,
    designCoveredSpecs,
    testCoveredSpecs,
    uncoveredByDesign,
    uncoveredByTest,
    bloatedSpecDocs,
    overloadedHubDocs,
    staleSystemDesignDocs,
    antiTermUsages,
    hints,
  }
}

function detectFragileSourceRefs(index: DocsIndex, hints: DocumentHealthHint[]): void {
  for (const doc of index.documents) {
    if (doc.sourceRefs.length === 0) continue
    if (doc.type !== 'design') {
      hints.push({
        code: 'source-ref-outside-design',
        message: `${doc.path} (type: ${doc.type}) contains ${doc.sourceRefs.length} <SourceRef> tag(s) (keep code references inside design docs so specs/contracts stay coupled to behavior)`,
        path: doc.path,
        docId: doc.id,
      })
    }
    for (const ref of doc.sourceRefs) {
      if (ref.mode !== 'lines') continue
      hints.push({
        code: 'source-ref-fragile-lines',
        message: `${doc.path} uses fragile line-range <SourceRef file="${ref.file}" lines="${ref.lines}" /> (prefer mode="exports" or symbol="..." for refactoring resilience)`,
        path: doc.path,
        docId: doc.id,
      })
    }
  }
}

function detectWorkspaceReverseLeaks(workspace: WorkspaceHealthSignals | undefined, hints: DocumentHealthHint[]): void {
  if (!workspace) return

  const dirtyPaths = workspace.dirtyPaths
  if (!dirtyPaths || dirtyPaths.length === 0) return

  const docsRelDirs = workspace.docsRelDirs && workspace.docsRelDirs.length > 0 ? workspace.docsRelDirs : ['docs']
  let hasDocsChange = false
  const codeOrSkillChanges: string[] = []

  for (const p of dirtyPaths) {
    const isUnderDocs = docsRelDirs.some((dir) => p === dir || p.startsWith(`${dir}/`))
    if (isUnderDocs) {
      const isReviewsGuard = p === REVIEWS_REL_PATH || p.endsWith(`/${REVIEWS_REL_PATH}`)
      if (!isReviewsGuard) hasDocsChange = true
      continue
    }
    if (CODE_OR_SKILL_PATH_RE.test(p)) {
      codeOrSkillChanges.push(p)
    }
  }

  if (codeOrSkillChanges.length > 0 && !hasDocsChange) {
    const sample = codeOrSkillChanges.slice(0, 3).join(', ')
    const suffix = codeOrSkillChanges.length > 3 ? `, +${codeOrSkillChanges.length - 3} more` : ''
    hints.push({
      code: 'docs-sync-missing',
      message: `${codeOrSkillChanges.length} code/skill file(s) changed (${sample}${suffix}) with no docs/ updates — verify whether goals, specs, designs, or decisions need syncing`,
    })
  }
}

function stripCodeFromMarkdown(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildAntiTermMatcher(antiTerm: string): RegExp {
  const escaped = escapeRegExp(antiTerm)
  if (/^[a-zA-Z0-9_-]+$/.test(antiTerm)) {
    return new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`, 'i')
  }
  return new RegExp(escaped, 'i')
}

function detectAntiTermUsages(index: DocsIndex, hints: DocumentHealthHint[]): AntiTermUsageInfo[] {
  const rules: Array<{ antiTerm: string; preferredTermId: string; matcher: RegExp }> = []
  for (const block of index.blocksById.values()) {
    if (block.kind !== 'term' || block.antiTerms.length === 0) continue
    for (const anti of block.antiTerms) {
      rules.push({ antiTerm: anti, preferredTermId: block.id, matcher: buildAntiTermMatcher(anti) })
    }
  }
  if (rules.length === 0) return []

  const usages: AntiTermUsageInfo[] = []
  for (const doc of index.documents) {
    if (doc.type !== 'spec' && doc.type !== 'contract' && doc.type !== 'design') continue
    for (const block of doc.blocks) {
      if ((block.kind !== 'spec' && block.kind !== 'decision') || block.intent !== 'normative') continue
      const prose = stripCodeFromMarkdown(block.rawBody)
      for (const rule of rules) {
        if (!rule.matcher.test(prose)) continue
        usages.push({
          docId: doc.id,
          path: doc.path,
          blockId: block.id,
          antiTerm: rule.antiTerm,
          preferredTermId: rule.preferredTermId,
        })
        hints.push({
          code: 'anti-term-used',
          message: `<${block.kind === 'spec' ? 'Spec' : 'Decision'} id="${block.id}"> uses anti-term "${rule.antiTerm}" (prefer "${rule.preferredTermId}")`,
          path: doc.path,
          docId: doc.id,
          blockId: block.id,
        })
      }
    }
  }
  return usages
}
