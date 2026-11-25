import type { DocsIndex } from './types'

const DEFAULT_MAX_SPECS_PER_DOC = 10
const STALE_ARCH_MIN_NEWER_DOCS = 5
const STALE_ARCH_GRACE_MS = 24 * 60 * 60 * 1000

type DocumentHealthHintCode = 'missing-design' | 'missing-verification' | 'bloated-spec-doc' | 'stale-architecture'

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

interface StaleArchitectureInfo {
  docId: string
  path: string
  updatedAt?: string
  newerDocsCount: number
}

export interface DocumentHealthSummary {
  totalNormativeSpecs: number
  designCoveredSpecs: number
  verificationCoveredSpecs: number
  uncoveredByDesign: string[]
  uncoveredByVerification: string[]
  bloatedSpecDocs: BloatedSpecDocInfo[]
  staleArchitectureDocs: StaleArchitectureInfo[]
  hints: DocumentHealthHint[]
}

interface ComputeHealthOptions {
  /** 1 つの spec ドキュメントに含める推奨最大 <Spec> 数（超過で分割推奨ヒントを出す） */
  maxSpecsPerDoc?: number
}

// @implements core.doc-health
/**
 * Living Specification 全体の構造健全性（Design / Verification カバレッジ・Spec 肥大化・Architecture 鮮度差）を算出する。
 * 過度な形式主義を避けるため、すべて CI を壊さない Advisory ヒントとして返す。
 */
export function computeDocumentHealth(index: DocsIndex, options: ComputeHealthOptions = {}): DocumentHealthSummary {
  const maxSpecsPerDoc = options.maxSpecsPerDoc ?? DEFAULT_MAX_SPECS_PER_DOC

  const designTargets = new Set<string>()
  const verificationTargets = new Set<string>()

  for (const edge of index.edges) {
    const fromDoc = index.byId.get(edge.fromDocId)
    if (!fromDoc) continue
    if (edge.kind === 'satisfies' && fromDoc.type === 'design') {
      designTargets.add(edge.to)
    } else if (edge.kind === 'verifies' && fromDoc.type === 'verification') {
      verificationTargets.add(edge.to)
    }
  }

  const uncoveredByDesign: string[] = []
  const uncoveredByVerification: string[] = []
  const hints: DocumentHealthHint[] = []
  let totalNormativeSpecs = 0
  let designCoveredSpecs = 0
  let verificationCoveredSpecs = 0

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

    const hasVerification = verificationTargets.has(block.id) || verificationTargets.has(block.docId)
    if (hasVerification) {
      verificationCoveredSpecs++
    } else {
      uncoveredByVerification.push(block.id)
      hints.push({
        code: 'missing-verification',
        message: `<Spec id="${block.id}"> has no verification document verifying it`,
        path: ownerDoc?.path,
        docId: block.docId,
        blockId: block.id,
      })
    }
  }

  uncoveredByDesign.sort()
  uncoveredByVerification.sort()

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

  const staleArchitectureDocs: StaleArchitectureInfo[] = []
  const archDocs = index.documents.filter((d) => d.type === 'architecture')
  const specOrDesignDocs = index.documents.filter((d) => d.type === 'spec' || d.type === 'design')

  for (const arch of archDocs) {
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
      staleArchitectureDocs.push({
        docId: arch.id,
        path: arch.path,
        updatedAt: arch.freshness?.updatedAt,
        newerDocsCount,
      })
      hints.push({
        code: 'stale-architecture',
        message: `${newerDocsCount} spec/design documents were updated after ${arch.path} (consider refreshing the architecture overview)`,
        path: arch.path,
        docId: arch.id,
      })
    }
  }

  return {
    totalNormativeSpecs,
    designCoveredSpecs,
    verificationCoveredSpecs,
    uncoveredByDesign,
    uncoveredByVerification,
    bloatedSpecDocs,
    staleArchitectureDocs,
    hints,
  }
}
