import { Hono } from 'hono'
import { z } from 'zod'
import { resolveBundleDocuments, searchIndex } from '../../core/bundle'
import type { RagConfig } from '../../core/config'
import { getDocumentHistory, getDocumentRevision } from '../../core/git'
import { collectWorkspaceHealthSignals, computeDocumentHealth } from '../../core/health'
import { searchIndexHybrid } from '../../core/hybrid-retrieval'
import { buildDocTree, getDocument, resolveDocMount, toDocumentSummary } from '../../core/loader'
import { ARTIFACT_TYPES, REALIZATION_STATUSES, SPEC_INTENTS, STABILITIES } from '../../core/types'
import type {
  ArtifactType,
  BlockKind,
  DocsIndex,
  DocumentSummary,
  RealizationStatus,
  ReviewStatus,
  SpecIntent,
  Stability,
} from '../../core/types'
import { historyErrorToHttp } from '../errors'
import type { DocsStore } from '../store'
import { zValidator } from '../validator'

const artifactTypeSchema = z.enum(ARTIFACT_TYPES)

const documentsQuerySchema = z.object({
  type: artifactTypeSchema.optional(),
})

const searchQuerySchema = z.object({
  q: z.string().optional(),
  type: z.union([artifactTypeSchema, z.literal('')]).optional(),
  limit: z.string().optional(),
  semantic: z.enum(['true', 'false']).optional(),
})

const bundleQuerySchema = z.object({
  scope: z.string().optional(),
  ids: z.string().optional(),
  title: z.string().optional(),
})

const historyQuerySchema = z.object({
  id: z.string().min(1),
  limit: z.string().optional(),
})

const revisionQuerySchema = z.object({
  id: z.string().min(1),
  commit: z.string().min(1),
})

interface OverviewIssueEntry {
  docId: string
  docTitle: string
  code: string
  message: string
  blockId?: string
}

interface OverviewDecisionEntry {
  id: string
  docId: string
  docTitle: string
  date?: string
  rawBody: string
  stability: Stability
  supersededBy?: string[]
}

interface OverviewAttentionBlock {
  id: string
  kind: BlockKind
  docId: string
  docTitle: string
  review: ReviewStatus
  suspect: boolean
  suspectSources: string[]
}

interface OverviewIdeaBlock {
  id: string
  kind: BlockKind
  docId: string
  docTitle: string
  title?: string
  rawBody: string
}

interface TermPayload {
  id: string
  docId: string
  docTitle: string
  aliases: string[]
  antiTerms: string[]
  context?: string
  symbols: string[]
  usedIn: Array<{ docId: string; title: string; type: ArtifactType }>
  rawBody: string
}

function collectTerms(index: DocsIndex): TermPayload[] {
  const usedInByTerm = new Map<string, Map<string, { docId: string; title: string; type: ArtifactType }>>()
  for (const edge of index.edges) {
    if (edge.kind !== 'mentions' || edge.toKind !== 'block') continue
    const fromDoc = index.byId.get(edge.fromDocId)
    if (!fromDoc || fromDoc.id === edge.toDocId) continue
    let map = usedInByTerm.get(edge.to)
    if (!map) {
      map = new Map()
      usedInByTerm.set(edge.to, map)
    }
    map.set(fromDoc.id, { docId: fromDoc.id, title: fromDoc.title, type: fromDoc.type })
  }

  const terms: TermPayload[] = []
  for (const block of index.blocksById.values()) {
    if (block.kind !== 'term') continue
    const doc = index.byId.get(block.docId)
    const usedIn = [...(usedInByTerm.get(block.id)?.values() ?? [])].toSorted((a, b) => a.docId.localeCompare(b.docId))
    terms.push({
      id: block.id,
      docId: block.docId,
      docTitle: doc?.title ?? block.docId,
      aliases: block.aliases,
      antiTerms: block.antiTerms,
      ...(block.context ? { context: block.context } : {}),
      symbols: block.symbols,
      usedIn,
      rawBody: block.rawBody,
    })
  }
  terms.sort((a, b) => a.id.localeCompare(b.id))
  return terms
}

export function createDocumentsRoutes(store: DocsStore, projectRoot?: string, ragConfig?: RagConfig) {
  return (
    new Hono()
      .get('/overview', (c) => {
        const index = store.getIndex()
        const byType = Object.fromEntries(ARTIFACT_TYPES.map((t) => [t, 0])) as Record<ArtifactType, number>
        const specsByIntent = Object.fromEntries(SPEC_INTENTS.map((i) => [i, 0])) as Record<SpecIntent, number>
        const specsByStability = Object.fromEntries(STABILITIES.map((s) => [s, 0])) as Record<Stability, number>

        const goals: DocumentSummary[] = []
        const decisions: OverviewDecisionEntry[] = []
        const supersededDecisions: OverviewDecisionEntry[] = []
        const orphanSpecs: OverviewIssueEntry[] = []
        const docIssues: OverviewIssueEntry[] = []
        const attentionBlocks: OverviewAttentionBlock[] = []
        const ideaBlocks: OverviewIdeaBlock[] = []
        const reviews = { approved: 0, unreviewed: 0, stale: 0, suspect: 0 }
        const realizations = Object.fromEntries(REALIZATION_STATUSES.map((s) => [s, 0])) as Record<
          RealizationStatus,
          number
        >
        let termCount = 0

        for (const doc of index.documents) {
          byType[doc.type]++
          if (doc.type === 'goal') goals.push(toDocumentSummary(doc))
          for (const block of doc.blocks) {
            if (block.realization) {
              realizations[block.realization.status]++
            }
            if (block.kind !== 'note') {
              reviews[block.review]++
              if (block.suspect) reviews.suspect++
              if (block.review === 'stale' || block.suspect) {
                attentionBlocks.push({
                  id: block.id,
                  kind: block.kind,
                  docId: doc.id,
                  docTitle: doc.title,
                  review: block.review,
                  suspect: block.suspect,
                  suspectSources: block.suspectSources,
                })
              }
            }
            if (block.intent === 'idea') {
              ideaBlocks.push({
                id: block.id,
                kind: block.kind,
                docId: doc.id,
                docTitle: doc.title,
                ...(block.title ? { title: block.title } : {}),
                rawBody: block.rawBody,
              })
            }
            if (block.kind === 'spec') {
              specsByIntent[block.intent]++
              specsByStability[block.stability]++
            } else if (block.kind === 'decision' && doc.type === 'decision') {
              const entry: OverviewDecisionEntry = {
                id: block.id,
                docId: doc.id,
                docTitle: doc.title,
                ...((block.date ?? doc.date) ? { date: block.date ?? doc.date } : {}),
                rawBody: block.summary ?? block.chosen ?? block.rawBody,
                stability: block.stability,
                ...(block.supersededBy && block.supersededBy.length > 0 ? { supersededBy: block.supersededBy } : {}),
              }
              if (entry.supersededBy) {
                supersededDecisions.push(entry)
              } else {
                decisions.push(entry)
              }
            } else if (block.kind === 'term') {
              termCount++
            }
          }
          for (const issue of doc.issues) {
            const entry: OverviewIssueEntry = {
              docId: doc.id,
              docTitle: doc.title,
              code: issue.code,
              message: issue.message,
              blockId: issue.blockId,
            }
            docIssues.push(entry)
            if (issue.code === 'orphan-spec') orphanSpecs.push(entry)
          }
        }

        const recentDocuments = index.documents
          .filter((d) => Boolean(d.freshness?.updatedAt))
          .toSorted((a, b) => (b.freshness?.updatedAt ?? '').localeCompare(a.freshness?.updatedAt ?? ''))
          .slice(0, 8)
          .map(toDocumentSummary)
        const uncommittedCount = index.documents.filter((d) => Boolean(d.freshness?.workingStatus)).length
        const health = computeDocumentHealth(
          index,
          projectRoot ? { workspace: collectWorkspaceHealthSignals(projectRoot, index) } : undefined,
        )

        return c.json(
          {
            rootDir: index.rootDir,
            loadedAt: index.loadedAt,
            documentCount: index.documents.length,
            blockCount: index.blocksById.size,
            termCount,
            edgeCount: index.edges.length,
            byType,
            specsByIntent,
            specsByStability,
            reviews,
            realizations,
            health,
            attentionBlocks,
            ideaBlocks,
            goals,
            decisions,
            supersededDecisions,
            orphanSpecs,
            indexIssues: index.issues,
            docIssues,
            recentDocuments,
            uncommittedCount,
          },
          200,
        )
      })
      .get('/tree', (c) => {
        const index = store.getIndex()
        const mounts = index.mounts.map((m) => ({
          id: m.id,
          label: m.label ?? m.id,
          docCount: index.documents.filter((d) => d.mountId === m.id).length,
        }))
        return c.json(
          {
            tree: buildDocTree(index.documents),
            documents: index.documents.map(toDocumentSummary),
            mounts,
          },
          200,
        )
      })
      .get('/documents', zValidator('query', documentsQuerySchema), (c) => {
        const index = store.getIndex()
        const { type } = c.req.valid('query')
        const documents = index.documents.filter((d) => !type || d.type === type).map(toDocumentSummary)
        return c.json({ documents }, 200)
      })
      // 任意階層のドキュメント ID (/api/documents/goals/core, /api/documents/auth/lockout 等)
      .get('/documents/:id{.+}', (c) => {
        const index = store.getIndex()
        const rawPath = c.req.param('id')
        let docId: string
        try {
          docId = decodeURIComponent(rawPath)
        } catch {
          return c.json({ error: `Invalid document ID: ${rawPath}` }, 400)
        }
        if (!docId || docId.includes('..')) {
          return c.json({ error: `Invalid document ID: ${docId}` }, 400)
        }
        const doc = getDocument(index, docId)
        if (!doc) return c.json({ code: 'DocumentNotFoundError', error: `Document not found: ${docId}` }, 404)
        return c.json({ document: doc }, 200)
      })
      .get('/history', zValidator('query', historyQuerySchema), async (c) => {
        const index = store.getIndex()
        const { id: docId, limit: rawLimitStr } = c.req.valid('query')
        if (docId.includes('..')) {
          return c.json({ error: `Invalid document ID: ${docId}` }, 400)
        }
        const doc = getDocument(index, docId)
        if (!doc) return c.json({ code: 'DocumentNotFoundError', error: `Document not found: ${docId}` }, 404)
        const rawLimit = Number(rawLimitStr ?? 20)
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 20
        const history = await getDocumentHistory(resolveDocMount(index, doc).dir, doc, limit)
        return c.json(history, 200)
      })
      .get('/history/revision', zValidator('query', revisionQuerySchema), (c) => {
        const index = store.getIndex()
        const { id: docId, commit } = c.req.valid('query')
        if (docId.includes('..')) {
          return c.json({ error: `Invalid document ID: ${docId}` }, 400)
        }
        const doc = getDocument(index, docId)
        if (!doc) return c.json({ code: 'DocumentNotFoundError', error: `Document not found: ${docId}` }, 404)
        const revisionRes = getDocumentRevision(resolveDocMount(index, doc).dir, doc, commit)
        if (revisionRes.isErr()) {
          const http = historyErrorToHttp(revisionRes.error)
          return c.json(http.body, http.status)
        }
        return c.json(revisionRes.value, 200)
      })
      .get('/terms', (c) => {
        return c.json({ terms: collectTerms(store.getIndex()) }, 200)
      })
      .get('/search', zValidator('query', searchQuerySchema), async (c) => {
        const { q = '', type: rawType, limit: rawLimitStr, semantic } = c.req.valid('query')
        const rawLimit = Number(rawLimitStr ?? 30)
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 30
        const useSemantic = semantic === 'true' || (semantic !== 'false' && ragConfig?.enabled === true)
        if (useSemantic) {
          const hybrid = await searchIndexHybrid(store.rootDir, store.getIndex(), q, {
            type: rawType ? rawType : undefined,
            limit,
            ragConfig,
            projectRoot,
          })
          return c.json(
            {
              query: q,
              results: hybrid.hits,
              count: hybrid.hits.length,
              mode: hybrid.mode,
              ...(hybrid.modelId ? { modelId: hybrid.modelId } : {}),
            },
            200,
          )
        }
        const results = searchIndex(store.getIndex(), q, {
          type: rawType ? rawType : undefined,
          limit,
        })
        return c.json({ query: q, results, count: results.length, mode: 'bm25' as const }, 200)
      })
      .get('/bundle', zValidator('query', bundleQuerySchema), (c) => {
        const index = store.getIndex()
        const { scope, ids: rawIds, title } = c.req.valid('query')
        const ids = rawIds
          ? rawIds
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined
        const customTitle = title?.trim()
        const resolved = resolveBundleDocuments(index, { scope, ids })
        const terms = collectTerms(index)

        let blockCount = 0
        let approvedCount = 0
        let verifiedCount = 0
        for (const doc of resolved.documents) {
          for (const b of doc.blocks) {
            blockCount++
            if (b.review === 'approved') approvedCount++
            if (b.realization?.status === 'verified') verifiedCount++
          }
        }

        return c.json(
          {
            title: customTitle || resolved.scopeLabel,
            scopeLabel: resolved.scopeLabel,
            generatedAt: new Date().toISOString(),
            documents: resolved.documents,
            terms,
            summary: {
              documentCount: resolved.documents.length,
              blockCount,
              approvedCount,
              verifiedCount,
            },
          },
          200,
        )
      })
  )
}
