import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { ZodTypeAny } from 'zod'
import type { RagConfig } from '../core/config'
import {
  addBlockToDoc,
  EditError,
  renameBlockIdAcrossProject,
  scaffoldDocument,
  updateBlockInDocs,
  upsertTermInDocs,
} from '../core/editor'
import { retrieveContextHybrid, searchIndexHybrid } from '../core/hybrid-retrieval'
import {
  buildProjectMap,
  buildValidationPayload,
  collectSourceRefExports,
  getDocumentDetail,
  getNodeRelations,
  getSpecContext,
  listDocuments,
  querySpecs,
  searchDocuments,
} from '../core/query'
import { retrieveContext } from '../core/retrieval'
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
  NoteIntent,
  RealizationStatus,
  ReviewStatus,
  SpecIntent,
  Stability,
} from '../core/types'
import type { DocsStore } from './store'

/**
 * MCP クライアント単体で Documi の運用手順・制約を完結させるためのサーバー instructions。
 * Agent Skills を導入していない環境でも、MCP だけで適切な呼び順・外科的編集・不変ルールに従えるようにする。
 */
const DOCUMI_MCP_INSTRUCTIONS = [
  'Documi manages Living Specifications in docs/ (or the configured docs directory).',
  '',
  'Recommended workflow:',
  '1. Progressive disclosure (read before editing):',
  '   - Call retrieve_context with a natural-language task or question when you do not know the exact Spec ID — it runs BM25 + glossary alias expansion + graph traversal (upstream Goals, Decision <Outcome>s, related docs, Terms, <SourceRef>s) within a character budget.',
  '   - Call get_project_map for a project-wide overview (Goal/Architecture summaries, Decision <Outcome>s, Domain Terms, Review/Realization summaries; pass full: true only if full bodies are needed).',
  '   - Call query_specs or search_documents to filter/search specific blocks or docs (query_specs returns compact summaries by default; pass full: true only when full trace arrays are needed).',
  '   - Call get_spec_context for a known Spec ID to inspect its exact body, upstream Goals, and linked code/docs.',
  '   - Only call get_document or get_relations when full document prose or graph edges are needed.',
  '2. Surgical editing (prefer over full-file rewrites):',
  '   - Use update_block, add_block, upsert_term, scaffold_document, and rename_block_id (always preview with dryRun: true first).',
  '3. Code, tests & documentation sync triggers:',
  '   - Link implementation code with `// @implements <spec.id>` (or `<SourceRef file="src/..." satisfies="<spec.id>" />`).',
  "   - Link tests with `test('[<spec.id>] ...', ...)` (or `// @verifies <spec.id>`).",
  '   - Always write `<SourceRef file="...">` and `<TermDef symbols="...">` as project-root-relative POSIX paths.',
  '   - Surface public boundary symbols (exported classes, interfaces, types, public functions) via `<SourceRef file="..." mode="exports" />` or `<SourceRef symbol="..." />` rather than hand-copying code; never write internal if/for pseudocode or private helper steps in docs.',
  '   - Update triggers before finishing: new subsystem/module -> update architecture + add/update design (with `satisfies` + `<SourceRef>`); high-reversibility structural choice -> add decision (ADR); new spec/test suite -> update verification (`verifies`); spec file > 10 blocks -> split by domain.',
  '4. Strict invariants:',
  '   - NEVER edit `docs/guard/reviews.json` directly (human approvals only).',
  '   - NEVER write executable JS in MDX (no ESM import/export, no JSX `{...}` expressions, no unapproved components).',
  '   - NEVER create temporary `tasks.md` checklists inside docs/; realization is derived automatically from code, tests, and PRs.',
  '5. Always call validate_docs before finishing, fix all errors, and review health coverage hints (missing design / missing verification / bloated spec docs).',
].join('\n')

const artifactTypeSchema = z.enum(ARTIFACT_TYPES)
const optionalTypeSchema = artifactTypeSchema.optional().describe('絞り込む Artifact Type (省略時は全件)')
const optionalKindSchema = z
  .enum(BLOCK_KINDS)
  .optional()
  .describe('ブロック種別 (spec / constraint / outcome / note / term)')
const optionalIntentSchema = z.enum(SPEC_INTENTS).optional().describe('採用意思 (normative / idea / rejected)')
const optionalStabilitySchema = z.enum(STABILITIES).optional().describe('安定度 (stable / evolving / volatile)')
const optionalReviewSchema = z
  .enum(REVIEW_STATUSES)
  .optional()
  .describe('人間レビュー状態 (unreviewed / approved / stale)')
const optionalRealizationSchema = z
  .enum(REALIZATION_STATUSES)
  .optional()
  .describe('実装・検証状態 (unimplemented / in-progress / implemented / verified / drifted)')
const optionalBoolSchema = (desc: string) => z.boolean().optional().describe(desc)
const optionalQuerySchema = z.string().optional().describe('ID または本文に含まれるキーワード')
const docIdSchema = z.string().min(1).describe('ドキュメント ID (例: "goals/document-centric", "specs/artifact-model")')
const nodeIdSchema = z
  .string()
  .min(1)
  .describe('ドキュメント ID またはブロック ID (例: "auth.lockout", "specs/artifact-model")')

const optionalStringListSchema = (desc: string) => z.array(z.string().min(1)).optional().describe(desc)
const optionalBlockIntentSchema = z
  .enum(['normative', 'idea', 'rejected', 'informative'] as const)
  .optional()
  .describe('採用意思 (normative / idea / rejected / informative)')

function jsonResult(data: unknown): CallToolResult {
  const text = JSON.stringify(data)
  return {
    content: [{ type: 'text', text }],
    structuredContent: data as Record<string, unknown>,
  }
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

function createDocumiMcpServer(store: DocsStore, projectRoot?: string, ragConfig?: RagConfig): McpServer {
  const getIndex = () => store.getIndex()
  const server = new McpServer(
    {
      name: 'documi',
      version: '0.1.0',
    },
    {
      instructions: DOCUMI_MCP_INSTRUCTIONS,
    },
  )

  const registerTool = server.registerTool.bind(server) as unknown as <S extends Record<string, ZodTypeAny>>(
    name: string,
    config: { description: string; inputSchema: S },
    cb: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
  ) => void

  registerTool(
    'get_project_map',
    {
      description:
        'プロジェクトの初期コンテキスト (Goal / Architecture 概要・Decision の Outcome 結論一覧・Domain 用語一覧・統計) を一括取得します。full: true で Goal / Architecture 全文も含めます。',
      inputSchema: {
        full: optionalBoolSchema('true のとき Goal / Architecture 全文と長い説明も省略せず返却 (既定: false)'),
      },
    },
    async ({ full }: { full?: boolean }) => jsonResult(buildProjectMap(getIndex(), { full })),
  )

  registerTool(
    'list_documents',
    {
      description: 'Documi のドキュメント一覧を取得します。type で絞り込み可能です。',
      inputSchema: { type: optionalTypeSchema },
    },
    async ({ type }: { type?: ArtifactType }) => jsonResult(listDocuments(getIndex(), type)),
  )

  registerTool(
    'get_document',
    {
      description:
        'ドキュメント ID (拡張子なし相対パス) から本文・セマンティックブロック・関係・問題一覧を取得します。',
      inputSchema: { id: docIdSchema },
    },
    async ({ id }: { id: string }) => {
      const detail = getDocumentDetail(getIndex(), id)
      if (!detail) return errorResult(`ドキュメントが見つかりません: ${id}`)
      return jsonResult(detail)
    },
  )

  registerTool(
    'get_relations',
    {
      description: '指定したドキュメント ID またはブロック ID の参照関係 (外向き / 逆参照) を取得します。',
      inputSchema: { id: nodeIdSchema },
    },
    async ({ id }: { id: string }) => {
      const relations = getNodeRelations(getIndex(), id)
      if (!relations) return errorResult(`ドキュメントまたはブロックが見つかりません: ${id}`)
      return jsonResult(relations)
    },
  )

  registerTool(
    'query_specs',
    {
      description:
        'セマンティックブロック (<Spec> / <Constraint> / <Outcome> / <Note> / <TermDef>) をレビュー状態・Suspect・安定度などで検索します。',
      inputSchema: {
        kind: optionalKindSchema,
        intent: optionalIntentSchema,
        stability: optionalStabilitySchema,
        review: optionalReviewSchema,
        realization: optionalRealizationSchema,
        suspect: optionalBoolSchema('上流変更により Suspect になっているブロックのみ抽出'),
        query: optionalQuerySchema,
        full: optionalBoolSchema('true のとき realization 詳細配列・本文全文まで含めて返却 (既定: false の軽量サマリ)'),
      },
    },
    async (args: {
      kind?: BlockKind
      intent?: SpecIntent
      stability?: Stability
      review?: ReviewStatus
      realization?: RealizationStatus
      suspect?: boolean
      query?: string
      full?: boolean
    }) => jsonResult(querySpecs(getIndex(), args)),
  )

  registerTool(
    'get_spec_context',
    {
      description:
        '指定した Spec ブロック ID (またはドキュメント ID) の実装・検証に必要な上流 Goal・関連 Design/Contract・関連 Decision Outcome・用語・SourceRef をまとめて返します。',
      inputSchema: {
        id: nodeIdSchema,
        full: optionalBoolSchema('true のとき上流 Goal 全文や realization 完全配列も含めて返却 (既定: false)'),
      },
    },
    async ({ id, full }: { id: string; full?: boolean }) => {
      const context = getSpecContext(getIndex(), id, { full })
      if (!context) return errorResult(`対象が見つかりません: ${id}`)
      // 既定は mode="exports" を明示した参照のみ展開し、full: true 時のみ全参照ファイルの公開シンボルを展開する
      const exportRefs = full === true ? context.sourceRefs : context.sourceRefs.filter((r) => r.mode === 'exports')
      const exportedSymbols = projectRoot ? await collectSourceRefExports(projectRoot, exportRefs) : []
      return jsonResult(exportedSymbols.length > 0 ? { ...context, exportedSymbols } : context)
    },
  )

  registerTool(
    'search_documents',
    {
      description:
        'ドキュメント本文・タイトル・タグおよびセマンティックブロックを BM25＋用語集同義語展開（semantic: true または rag.enabled 設定時はローカル Embedding＋RRF ハイブリッド）で横断検索します。',
      inputSchema: {
        query: z.string().min(1).describe('検索キーワードまたは自然文'),
        type: optionalTypeSchema,
        limit: z.number().int().min(1).max(100).optional().describe('最大返却件数 (既定 20)'),
        semantic: optionalBoolSchema('true のときローカル Embedding との RRF ハイブリッド検索を実行'),
      },
    },
    async ({
      query,
      type,
      limit,
      semantic,
    }: {
      query: string
      type?: ArtifactType
      limit?: number
      semantic?: boolean
    }) => {
      const useSemantic = semantic ?? ragConfig?.enabled === true
      if (useSemantic) {
        const res = await searchIndexHybrid(store.rootDir, getIndex(), query, {
          type,
          limit: limit ?? 20,
          ragConfig,
          projectRoot,
        })
        return jsonResult({
          query,
          results: res.hits,
          count: res.hits.length,
          mode: res.mode,
          ...(res.modelId ? { modelId: res.modelId } : {}),
          ...(res.fallbackReason ? { fallbackReason: res.fallbackReason } : {}),
        })
      }
      return jsonResult(searchDocuments(getIndex(), query, { type, limit }))
    },
  )

  registerTool(
    'retrieve_context',
    {
      description:
        '自然文の質問・タスク記述から、BM25＋用語集同義語展開（semantic: true または rag.enabled 設定時はローカル Embedding＋RRF）＋明示グラフ展開（上流 Goal・Decision Outcome・関連 Contract/Design・用語・SourceRef）を文字数予算内で 1 発取得します。',
      inputSchema: {
        query: z.string().min(1).describe('自然文の質問またはタスク内容 (例: "静的サイト書き出しの仕様と制約")'),
        type: optionalTypeSchema,
        limit: z.number().int().min(1).max(30).optional().describe('一次ヒットの最大件数 (既定 8)'),
        budget: z.number().int().min(500).max(40000).optional().describe('返却コンテキストの文字数予算 (既定 6000)'),
        includeGraph: optionalBoolSchema('グラフ近傍の関連文脈を含めるか (既定: true)'),
        semantic: optionalBoolSchema('true のときローカル Embedding との RRF ハイブリッド検索を実行'),
      },
    },
    async ({
      query,
      type,
      limit,
      budget,
      includeGraph,
      semantic,
    }: {
      query: string
      type?: ArtifactType
      limit?: number
      budget?: number
      includeGraph?: boolean
      semantic?: boolean
    }) => {
      const useSemantic = semantic ?? ragConfig?.enabled === true
      if (useSemantic) {
        return jsonResult(
          await retrieveContextHybrid(store.rootDir, getIndex(), query, {
            type,
            limit,
            budget,
            includeGraph,
            ragConfig,
            projectRoot,
          }),
        )
      }
      return jsonResult(retrieveContext(getIndex(), query, { type, limit, budget, includeGraph }))
    },
  )

  registerTool(
    'validate_docs',
    {
      description:
        '全ドキュメントの整合性問題 (orphan-spec・参照切れ・循環・重複 ID・MDX 未対応構文など) を一括検証して返します。',
      inputSchema: {},
    },
    async () => jsonResult(await buildValidationPayload(getIndex(), projectRoot)),
  )

  // ---------- 精密編集・構造操作ツール (Surgical Write) ----------
  // @implements core.mcp-surgical-edit

  registerTool(
    'update_block',
    {
      description:
        '既存セマンティックブロック (<Spec> / <Constraint> / <Outcome> / <TermDef> / <Note>) の該当行範囲のみを安全に書き換え、再読込後の検証結果を返します。reviews.json には一切触れません。',
      inputSchema: {
        id: z.string().min(1).describe('更新対象のブロック ID'),
        body: z.string().min(1).describe('新しいブロック本文 (MDX 安全構文のみ)'),
        title: z.string().optional().describe('ブロックタイトル (任意)'),
        stability: optionalStabilitySchema,
        intent: optionalBlockIntentSchema,
        derives: optionalStringListSchema('上流の derives 参照一覧'),
        supersedes: optionalStringListSchema('supersedes 参照一覧'),
        scope: z.string().optional().describe('Constraint の scope (任意)'),
        aliases: optionalStringListSchema('TermDef の別名一覧'),
        symbols: optionalStringListSchema('TermDef のコードシンボル一覧 (src/...#Symbol)'),
      },
    },
    async (args: {
      id: string
      body: string
      title?: string
      stability?: Stability
      intent?: SpecIntent | NoteIntent
      derives?: string[]
      supersedes?: string[]
      scope?: string
      aliases?: string[]
      symbols?: string[]
    }) => {
      try {
        const result = await updateBlockInDocs(store.rootDir, getIndex(), args)
        const nextIndex = await store.reload()
        const validation = await buildValidationPayload(nextIndex, projectRoot)
        return jsonResult({ ...result, validation })
      } catch (e) {
        if (e instanceof EditError) return errorResult(e.message)
        throw e
      }
    },
  )

  registerTool(
    'add_block',
    {
      description:
        '指定ドキュメント末尾（または指定見出し直下）にセマンティックブロックを 1 件追記し、再読込後の検証結果を返します。',
      inputSchema: {
        docId: docIdSchema,
        kind: z.enum(BLOCK_KINDS).describe('ブロック種別 (spec / constraint / outcome / note / term)'),
        id: z.string().min(1).describe('新規ブロック ID (プロジェクト全体で一意)'),
        body: z.string().min(1).describe('ブロック本文 (MDX 安全構文のみ)'),
        afterHeading: z.string().optional().describe('挿入先の見出しテキスト (省略時は文書末尾)'),
        title: z.string().optional().describe('ブロックタイトル (任意)'),
        stability: optionalStabilitySchema,
        intent: optionalBlockIntentSchema,
        derives: optionalStringListSchema('上流の derives 参照一覧'),
        supersedes: optionalStringListSchema('supersedes 参照一覧'),
        scope: z.string().optional().describe('Constraint の scope (任意)'),
        aliases: optionalStringListSchema('TermDef の別名一覧'),
        symbols: optionalStringListSchema('TermDef のコードシンボル一覧 (src/...#Symbol)'),
      },
    },
    async (args: {
      docId: string
      kind: BlockKind
      id: string
      body: string
      afterHeading?: string
      title?: string
      stability?: Stability
      intent?: SpecIntent | NoteIntent
      derives?: string[]
      supersedes?: string[]
      scope?: string
      aliases?: string[]
      symbols?: string[]
    }) => {
      try {
        const result = await addBlockToDoc(store.rootDir, getIndex(), args)
        const nextIndex = await store.reload()
        const validation = await buildValidationPayload(nextIndex, projectRoot)
        return jsonResult({ ...result, validation })
      } catch (e) {
        if (e instanceof EditError) return errorResult(e.message)
        throw e
      }
    },
  )

  registerTool(
    'upsert_term',
    {
      description: '用語集 (既定: domain/glossary) に <TermDef> を追加または更新し、検証結果を返します。',
      inputSchema: {
        id: z.string().min(1).describe('用語 ID (例: "Artifact")'),
        definition: z.string().min(1).describe('用語の定義本文'),
        aliases: optionalStringListSchema('別名一覧'),
        symbols: optionalStringListSchema('コードシンボル一覧 (src/...#Symbol)'),
        docId: z.string().optional().describe('追加先の用語集ドキュメント ID (既定: domain/glossary)'),
      },
    },
    async (args: { id: string; definition: string; aliases?: string[]; symbols?: string[]; docId?: string }) => {
      try {
        const result = await upsertTermInDocs(store.rootDir, getIndex(), args)
        const nextIndex = await store.reload()
        const validation = await buildValidationPayload(nextIndex, projectRoot)
        return jsonResult({ ...result, validation })
      } catch (e) {
        if (e instanceof EditError) return errorResult(e.message)
        throw e
      }
    },
  )

  registerTool(
    'scaffold_document',
    {
      description:
        '規約通りの YAML frontmatter を持つ新規 .mdx ドキュメントを作成します（既存ファイルの上書きは拒否）。',
      inputSchema: {
        path: z.string().min(1).describe('docs/ からの相対パス (例: "specs/auth/oauth.mdx")'),
        title: z.string().min(1).describe('ドキュメントタイトル'),
        type: optionalTypeSchema,
        description: z.string().optional().describe('概要説明'),
        date: z.string().optional().describe('決定日 (YYYY-MM-DD または YYYY-MM、ADR 用)'),
        tags: optionalStringListSchema('タグ一覧'),
        derives: optionalStringListSchema('frontmatter の derives 一覧'),
        satisfies: optionalStringListSchema('frontmatter の satisfies 一覧'),
        verifies: optionalStringListSchema('frontmatter の verifies 一覧'),
        body: z.string().optional().describe('初期本文 (省略可)'),
      },
    },
    async (args: {
      path: string
      title: string
      type?: ArtifactType
      description?: string
      date?: string
      tags?: string[]
      derives?: string[]
      satisfies?: string[]
      verifies?: string[]
      body?: string
    }) => {
      try {
        const result = await scaffoldDocument(store.rootDir, getIndex(), args)
        const nextIndex = await store.reload()
        const validation = await buildValidationPayload(nextIndex, projectRoot)
        return jsonResult({ ...result, validation })
      } catch (e) {
        if (e instanceof EditError) return errorResult(e.message)
        throw e
      }
    },
  )

  registerTool(
    'rename_block_id',
    {
      description:
        '全 docs/ のブロック定義・参照・SourceRef および projectRoot 配下の @implements / @verifies / test("[id]") を一括リネームします。dryRun: true で変更予定一覧のみ確認できます。',
      inputSchema: {
        oldId: z.string().min(1).describe('変更前のブロック ID'),
        newId: z.string().min(1).describe('変更後のブロック ID'),
        dryRun: optionalBoolSchema('true のときファイルを変更せず対象箇所一覧のみ返却'),
      },
    },
    async (args: { oldId: string; newId: string; dryRun?: boolean }) => {
      try {
        const result = await renameBlockIdAcrossProject(store.rootDir, projectRoot, getIndex(), args)
        if (!result.dryRun && result.changes.length > 0) {
          const nextIndex = await store.reload()
          const validation = await buildValidationPayload(nextIndex, projectRoot)
          return jsonResult({ ...result, validation })
        }
        return jsonResult(result)
      } catch (e) {
        if (e instanceof EditError) return errorResult(e.message)
        throw e
      }
    },
  )

  return server
}

/**
 * Stateless な Streamable HTTP として MCP リクエストを処理する。
 */
export async function handleMcpRequest(
  store: DocsStore,
  request: Request,
  projectRoot?: string,
  ragConfig?: RagConfig,
): Promise<Response> {
  const server = createDocumiMcpServer(store, projectRoot, ragConfig)
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)
  return transport.handleRequest(request)
}

/**
 * stdio トランスポートで MCP サーバーを起動する（AI エディタ・CLI エージェント向け）。
 * DocsStore から毎回最新インデックスを読むため、起動中の docs/ 変更も即時反映される。
 */
export async function startMcpStdio(store: DocsStore, projectRoot?: string, ragConfig?: RagConfig): Promise<McpServer> {
  const server = createDocumiMcpServer(store, projectRoot, ragConfig)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  return server
}
