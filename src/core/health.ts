import type { DocsIndex } from './types'

const DEFAULT_MAX_SPECS_PER_DOC = 10
const DEFAULT_MAX_TRACE_TARGETS_PER_DOC = 10
const STALE_ARCH_MIN_NEWER_DOCS = 5
const STALE_ARCH_GRACE_MS = 24 * 60 * 60 * 1000

type DocumentHealthHintCode =
  | 'missing-design'
  | 'missing-test'
  | 'bloated-spec-doc'
  | 'overloaded-hub-doc'
  | 'stale-system-design'

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

export interface DocumentHealthSummary {
  totalNormativeSpecs: number
  designCoveredSpecs: number
  testCoveredSpecs: number
  uncoveredByDesign: string[]
  uncoveredByTest: string[]
  bloatedSpecDocs: BloatedSpecDocInfo[]
  overloadedHubDocs: OverloadedHubDocInfo[]
  staleSystemDesignDocs: StaleSystemDesignInfo[]
  hints: DocumentHealthHint[]
}

interface ComputeHealthOptions {
  /** 1 つの spec ドキュメントに含める推奨最大 <Spec> 数（超過で分割推奨ヒントを出す） */
  maxSpecsPerDoc?: number
  /** 1 つの design / verification から伸ばす推奨最大トレース辺数（超過で分割推奨ヒントを出す） */
  maxTraceTargetsPerDoc?: number
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

  return {
    totalNormativeSpecs,
    designCoveredSpecs,
    testCoveredSpecs,
    uncoveredByDesign,
    uncoveredByTest,
    bloatedSpecDocs,
    overloadedHubDocs,
    staleSystemDesignDocs,
    hints,
  }
}
