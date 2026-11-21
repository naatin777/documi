import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { DocsStore } from './store'
import { z } from 'zod'
import type { ZodTypeAny } from 'zod'
import {
  ARTIFACT_TYPES,
  BLOCK_KINDS,
  REALIZATION_STATUSES,
  REVIEW_STATUSES,
  SPEC_INTENTS,
  STABILITIES,
} from '../core/types'
import type {
  ArtifactType,
  BlockKind,
  DocsIndex,
  RealizationStatus,
  ReviewStatus,
  SemanticBlock,
  SpecIntent,
  Stability,
} from '../core/types'
import { getDocument, toDocumentSummary } from '../core/loader'
import { searchIndex } from '../core/bundle'
import { validateSourceLinks } from '../core/trace'

const artifactTypeSchema: ZodTypeAny = z.enum(ARTIFACT_TYPES)
const optionalTypeSchema: ZodTypeAny = artifactTypeSchema.optional().describe('絞り込む Artifact Type (省略時は全件)')
const optionalKindSchema: ZodTypeAny = z
  .enum(BLOCK_KINDS)
  .optional()
  .describe('ブロック種別 (spec / constraint / outcome / note / term)')
const optionalIntentSchema: ZodTypeAny = z
  .enum(SPEC_INTENTS)
  .optional()
  .describe('採用意思 (normative / idea / rejected)')
const optionalStabilitySchema: ZodTypeAny = z
  .enum(STABILITIES)
  .optional()
  .describe('安定度 (stable / evolving / volatile)')
const optionalReviewSchema: ZodTypeAny = z
  .enum(REVIEW_STATUSES)
  .optional()
  .describe('人間レビュー状態 (unreviewed / approved / stale)')
const optionalRealizationSchema: ZodTypeAny = z
  .enum(REALIZATION_STATUSES)
  .optional()
  .describe('実装・検証状態 (unimplemented / in-progress / implemented / verified / drifted)')
const optionalBoolSchema = (desc: string): ZodTypeAny => z.boolean().optional().describe(desc)
const optionalQuerySchema: ZodTypeAny = z.string().optional().describe('ID または本文に含まれるキーワード')
const docIdSchema: ZodTypeAny = z
  .string()
  .min(1)
  .describe('ドキュメント ID (例: "goals/document-centric", "specs/artifact-model")')
const nodeIdSchema: ZodTypeAny = z
  .string()
  .min(1)
  .describe('ドキュメント ID またはブロック ID (例: "auth.lockout", "specs/artifact-model")')

function jsonResult(data: unknown): CallToolResult {
  const text = JSON.stringify(data, null, 2)
  return {
    content: [{ type: 'text', text }],
    structuredContent: data as Record<string, unknown>,
  }
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

function createDocumiMcpServer(getIndex: () => DocsIndex, projectRoot?: string): McpServer {
  const server = new McpServer({
    name: 'documi',
    version: '0.1.0',
  })

  const registerTool = server.registerTool.bind(server) as unknown as <Args>(
    name: string,
    config: { description: string; inputSchema?: Record<string, ZodTypeAny> },
    cb: (args: Args) => Promise<CallToolResult>,
  ) => void

  registerTool(
    'get_project_map',
    {
      description:
        'プロジェクトの初期コンテキスト (Goal 全文・Architecture 全文・Decision の Outcome 結論一覧・Domain 用語一覧・統計) を一括取得します。',
      inputSchema: {},
    },
    async () => {
      const index = getIndex()
      const goals = index.documents
        .filter((d) => d.type === 'goal')
        .map((d) => ({ id: d.id, title: d.title, description: d.description, body: d.body }))
      const architecture = index.documents
        .filter((d) => d.type === 'architecture')
        .map((d) => ({ id: d.id, title: d.title, description: d.description, body: d.body }))
      const outcomes = [...index.blocksById.values()]
        .filter((b) => b.kind === 'outcome')
        .map((b) => {
          const doc = index.byId.get(b.docId)
          return {
            id: b.id,
            docId: b.docId,
            ...(doc?.date ? { date: doc.date } : {}),
            stability: b.stability,
            body: b.rawBody,
          }
        })
      const terms = [...index.blocksById.values()]
        .filter((b) => b.kind === 'term')
        .map((b) => ({
          id: b.id,
          docId: b.docId,
          aliases: b.aliases ?? [],
          symbols: b.symbols ?? [],
          definition: b.rawBody,
        }))

      const reviewSummary = { approved: 0, unreviewed: 0, stale: 0, suspect: 0, openFeedback: 0 }
      const realizationSummary: Record<RealizationStatus, number> = {
        unimplemented: 0,
        'in-progress': 0,
        implemented: 0,
        verified: 0,
        drifted: 0,
      }
      for (const b of index.blocksById.values()) {
        if (b.kind !== 'note') {
          reviewSummary[b.review]++
          if (b.suspect) reviewSummary.suspect++
        }
        if (b.realization) realizationSummary[b.realization.status]++
        reviewSummary.openFeedback += b.feedback.filter((f) => !f.resolved).length
      }

      return jsonResult({
        documentCount: index.documents.length,
        blockCount: index.blocksById.size,
        issueCount: index.issues.length + index.documents.reduce((acc, d) => acc + d.issues.length, 0),
        reviewSummary,
        realizationSummary,
        goals,
        architecture,
        decisionOutcomes: outcomes,
        terms,
      })
    },
  )

  registerTool(
    'list_documents',
    {
      description: 'Documi のドキュメント一覧を取得します。type で絞り込み可能です。',
      inputSchema: { type: optionalTypeSchema },
    },
    async ({ type }: { type?: ArtifactType }) => {
      const index = getIndex()
      const docs = index.documents.filter((d) => !type || d.type === type)
      return jsonResult({ documents: docs.map(toDocumentSummary), count: docs.length })
    },
  )

  registerTool(
    'get_document',
    {
      description:
        'ドキュメント ID (拡張子なし相対パス) から本文・セマンティックブロック・関係・問題一覧を取得します。',
      inputSchema: { id: docIdSchema },
    },
    async ({ id }: { id: string }) => {
      const index = getIndex()
      const doc = getDocument(index, id)
      if (!doc) return errorResult(`ドキュメントが見つかりません: ${id}`)
      return jsonResult({
        ...toDocumentSummary(doc),
        body: doc.body,
        blocks: doc.blocks,
        sourceRefs: doc.sourceRefs,
        outgoing: doc.outgoing,
        incoming: doc.incoming,
        issues: doc.issues,
      })
    },
  )

  registerTool(
    'get_relations',
    {
      description: '指定したドキュメント ID またはブロック ID の参照関係 (外向き / 逆参照) を取得します。',
      inputSchema: { id: nodeIdSchema },
    },
    async ({ id }: { id: string }) => {
      const index = getIndex()
      const doc = getDocument(index, id)
      if (doc) {
        return jsonResult({ id: doc.id, kind: 'doc', outgoing: doc.outgoing, incoming: doc.incoming })
      }
      const block = index.blocksById.get(id)
      if (block) {
        const outgoing = index.edges.filter((e) => e.from === block.id)
        const incoming = index.edges.filter((e) => e.to === block.id)
        return jsonResult({ id: block.id, kind: 'block', docId: block.docId, outgoing, incoming })
      }
      return errorResult(`ドキュメントまたはブロックが見つかりません: ${id}`)
    },
  )

  registerTool(
    'query_specs',
    {
      description:
        'セマンティックブロック (<Spec> / <Constraint> / <Outcome> / <Note> / <TermDef>) をレビュー状態・Suspect・未解決フィードバック・安定度などで検索します。',
      inputSchema: {
        kind: optionalKindSchema,
        intent: optionalIntentSchema,
        stability: optionalStabilitySchema,
        review: optionalReviewSchema,
        realization: optionalRealizationSchema,
        suspect: optionalBoolSchema('上流変更により Suspect になっているブロックのみ抽出'),
        hasFeedback: optionalBoolSchema('未解決の人間フィードバックがあるブロックのみ抽出'),
        query: optionalQuerySchema,
      },
    },
    async ({
      kind,
      intent,
      stability,
      review,
      realization,
      suspect,
      hasFeedback,
      query,
    }: {
      kind?: BlockKind
      intent?: SpecIntent
      stability?: Stability
      review?: ReviewStatus
      realization?: RealizationStatus
      suspect?: boolean
      hasFeedback?: boolean
      query?: string
    }) => {
      const index = getIndex()
      const q = query?.trim().toLowerCase()
      const matched = [...index.blocksById.values()].filter((b) => {
        if (kind && b.kind !== kind) return false
        if (intent && b.intent !== intent) return false
        if (stability && b.stability !== stability) return false
        if (review && b.review !== review) return false
        if (realization && b.realization?.status !== realization) return false
        if (suspect !== undefined && b.suspect !== suspect) return false
        if (hasFeedback !== undefined) {
          const open = b.feedback.some((f) => !f.resolved)
          if (open !== hasFeedback) return false
        }
        if (q && !b.id.toLowerCase().includes(q) && !b.rawBody.toLowerCase().includes(q)) return false
        return true
      })
      return jsonResult({ blocks: matched, count: matched.length })
    },
  )

  registerTool(
    'get_spec_context',
    {
      description:
        '指定した Spec ブロック ID (またはドキュメント ID) の実装・検証に必要な上流 Goal・関連 Design/Contract・関連 Decision Outcome・用語・SourceRef をまとめて返します。',
      inputSchema: { id: nodeIdSchema },
    },
    async ({ id }: { id: string }) => {
      const index = getIndex()
      const block = index.blocksById.get(id)
      const doc = block ? index.byId.get(block.docId) : getDocument(index, id)
      if (!doc) return errorResult(`対象が見つかりません: ${id}`)

      const targetIds = new Set<string>([doc.id, ...(block ? [block.id] : doc.blocks.map((b) => b.id))])
      const relatedDocIds = new Set<string>()

      // 上流 (derives) を再帰的に辿る
      const queue = [...targetIds]
      const visited = new Set<string>()
      const upstreamGoals: { id: string; title: string; body: string }[] = []
      while (queue.length > 0) {
        const cur = queue.shift()!
        if (visited.has(cur)) continue
        visited.add(cur)
        for (const e of index.edges) {
          if (e.kind !== 'derives' || e.from !== cur) continue
          const targetDoc = index.byId.get(e.toDocId)
          if (targetDoc?.type === 'goal' && !upstreamGoals.some((g) => g.id === targetDoc.id)) {
            upstreamGoals.push({ id: targetDoc.id, title: targetDoc.title, body: targetDoc.body })
          }
          queue.push(e.to, e.toDocId)
        }
      }

      // 直接繋がる Design / Contract / Verification / Decision を収集
      for (const e of index.edges) {
        if (targetIds.has(e.from) || targetIds.has(e.fromDocId)) relatedDocIds.add(e.toDocId)
        if (targetIds.has(e.to) || targetIds.has(e.toDocId)) relatedDocIds.add(e.fromDocId)
      }
      relatedDocIds.delete(doc.id)

      const relatedDocs = [...relatedDocIds]
        .map((rid) => index.byId.get(rid))
        .filter((d): d is NonNullable<typeof d> => Boolean(d))

      const outcomes: SemanticBlock[] = relatedDocs
        .filter((d) => d.type === 'decision')
        .flatMap((d) => d.blocks.filter((b) => b.kind === 'outcome'))

      const terms: SemanticBlock[] = [...index.blocksById.values()].filter(
        (b) =>
          b.kind === 'term' &&
          (doc.body.toLowerCase().includes(b.id.toLowerCase()) ||
            (b.aliases ?? []).some((a) => doc.body.toLowerCase().includes(a.toLowerCase()))),
      )

      const openFeedback = (block ? [block] : doc.blocks).flatMap((b) =>
        b.feedback.filter((f) => !f.resolved).map((f) => ({ blockId: b.id, ...f })),
      )

      return jsonResult({
        target: block ?? toDocumentSummary(doc),
        document: toDocumentSummary(doc),
        openFeedback,
        upstreamGoals,
        relatedDocuments: relatedDocs.map(toDocumentSummary),
        decisionOutcomes: outcomes.map((o) => ({ id: o.id, docId: o.docId, body: o.rawBody })),
        relevantTerms: terms.map((t) => ({
          id: t.id,
          aliases: t.aliases ?? [],
          symbols: t.symbols ?? [],
          body: t.rawBody,
        })),
        sourceRefs: [...doc.sourceRefs, ...relatedDocs.flatMap((d) => d.sourceRefs)],
      })
    },
  )

  registerTool(
    'search_documents',
    {
      description: 'ドキュメント本文・タイトル・タグおよびセマンティックブロックを横断して全文検索します。',
      inputSchema: {
        query: z.string().min(1).describe('検索キーワード (スペース区切りで AND 検索)'),
        type: optionalTypeSchema,
        limit: z.number().int().min(1).max(100).optional().describe('最大返却件数 (既定 20)'),
      },
    },
    async ({ query, type, limit }: { query: string; type?: ArtifactType; limit?: number }) => {
      const index = getIndex()
      const results = searchIndex(index, query, { type, limit: limit ?? 20 })
      return jsonResult({ query, results, count: results.length })
    },
  )

  registerTool(
    'validate_docs',
    {
      description:
        '全ドキュメントの整合性問題 (orphan-spec・参照切れ・循環・重複 ID・MDX 未対応構文など) を一括検証して返します。',
      inputSchema: {},
    },
    async () => {
      const index = getIndex()
      const docIssues = index.documents.flatMap((d) =>
        d.issues.map((issue) => ({
          docId: d.id,
          path: d.path,
          code: issue.code,
          message: issue.message,
          blockId: issue.blockId,
        })),
      )
      const sourceIssues = projectRoot ? (await validateSourceLinks(projectRoot, index)).issues : []
      const totalIssues = index.issues.length + docIssues.length + sourceIssues.length
      return jsonResult({
        ok: totalIssues === 0,
        indexIssues: index.issues,
        docIssues,
        sourceIssues,
        totalIssues,
      })
    },
  )

  return server
}

/**
 * Stateless な Streamable HTTP として MCP リクエストを処理する。
 */
export async function handleMcpRequest(index: DocsIndex, request: Request, projectRoot?: string): Promise<Response> {
  const server = createDocumiMcpServer(() => index, projectRoot)
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)
  return transport.handleRequest(request)
}

/**
 * stdio トランスポートで MCP サーバーを起動する（AI エディタ・CLI エージェント向け）。
 * DocsStore から毎回最新インデックスを読むため、起動中の docs/ 変更も即時反映される。
 */
export async function startMcpStdio(store: DocsStore, projectRoot?: string): Promise<McpServer> {
  const server = createDocumiMcpServer(() => store.getIndex(), projectRoot)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  return server
}
