import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { ZodTypeAny } from 'zod'
import type { RagConfig } from '../core/config'
import {
  addBlockToDoc,
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
  getImpactAnalysis,
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
  DOC_SCOPES,
  REALIZATION_STATUSES,
  REVIEW_STATUSES,
  SPEC_INTENTS,
  STABILITIES,
  TEST_LEVELS,
} from '../core/types'
import type {
  ArtifactType,
  BlockKind,
  DocScope,
  NoteIntent,
  RealizationStatus,
  ReviewStatus,
  SpecIntent,
  Stability,
  TestLevel,
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
  '   - Call search_documents with includeContext: true for a natural-language task or question when you do not know the exact Spec ID — it runs BM25 + glossary alias expansion + graph traversal (upstream Goals, <Decision> conclusions, related docs, Terms, <SourceRef>s) within a character budget.',
  '   - Call get_project_map for a project-wide overview (Goal / System Design summaries, top-level <Decision> conclusions, Domain Terms, Review/Realization summaries; pass full: true only if full bodies are needed).',
  '   - Call query_specs or search_documents to filter/search specific blocks or docs (query_specs returns compact summaries by default; pass full: true only when full trace arrays are needed).',
  '   - Call get_spec_context for a known Spec ID to inspect its exact body, upstream Goals, inline micro-ADR <Decision>s, and linked code/docs.',
  '   - Before changing any Spec/Goal/Term, call get_impact to list all affected downstream docs, blocks, <SourceRef>s, and code/test anchors.',
  '   - Only call get_document or get_relations when full document prose or graph edges are needed.',
  '2. Spec-First & surgical editing (update docs/ before src/, prefer over full-file rewrites):',
  '   - Update docs/ BEFORE editing src/ or tests/. Keep one fact in one place (Single Source of Truth) and mark retired ADRs with `supersedes`.',
  '   - Persist chat decisions immediately into `<Decision>` (top-level ADR or inline micro-ADR), `<Spec>`, `<Constraint>`, `<Test>`, or `<Note intent="idea">` so future sessions do not lose agreed decisions.',
  '   - Keep docs scannable and visual-first (<= 3 lines per paragraph, bold-first bullets, Mermaid for flows, tables for rules, `<Details>` for deep dives, `<Columns>` for comparisons, `<Timeline>` for sequences).',
  '   - Use update_block, add_block, upsert_term, scaffold_document, and rename_block_id (always preview with dryRun: true first).',
  '3. Code, tests & documentation sync triggers:',
  '   - Link implementation code with `// @implements <spec.id>` (or `<SourceRef file="src/..." satisfies="<spec.id>" />`).',
  '   - Link tests with `test(\'[<spec.id>] ...\', ...)` (or `// @verifies <spec.id>`) and colocate declarative guarantee scenarios in `<Test id="..." verifies="<spec.id>" level="unit|integration|e2e|contract|manual">` right next to `<Spec>`.',
  '   - Always write `<SourceRef file="...">` and `<TermDef symbols="...">` as project-root-relative POSIX paths.',
  '   - Surface public boundary symbols (exported classes, interfaces, types, public functions) via `<SourceRef file="..." mode="exports" />` or `<SourceRef symbol="..." />` rather than hand-copying code; never write internal if/for pseudocode or private helper steps in docs.',
  '   - Update triggers before finishing: new subsystem/module -> update system-scope design (`type: design`, `scope: system`) + add/update feature design (with `satisfies` + `<SourceRef>`); hard-to-reverse system choice -> add top-level `decision` (ADR with `<Decision>`); local design trade-off -> add inline `<Decision>` micro-ADR; new spec -> colocate `<Test verifies="...">` guarantee scenario; organize spec files by Capability (one capability per file; split if > 10 blocks).',
  '4. Strict invariants:',
  '   - NEVER edit `docs/guard/reviews.json` directly (human approvals only).',
  '   - NEVER write executable JS in MDX (no ESM import/export, no JSX `{...}` expressions, no unapproved components).',
  '   - NEVER create temporary `tasks.md` checklists inside docs/; realization is derived automatically from code, tests, and PRs.',
  '5. Always call validate_docs before finishing, fix all errors, and review health coverage hints (missing design / missing verification / bloated spec docs).',
].join('\n')

const artifactTypeSchema = z.enum(ARTIFACT_TYPES)
const optionalTypeSchema = artifactTypeSchema.optional().describe('Filter by Artifact Type (omit for all)')
const optionalKindSchema = z
  .enum(BLOCK_KINDS)
  .optional()
  .describe('Block kind (spec / constraint / decision / test / note / term)')
const optionalIntentSchema = z.enum(SPEC_INTENTS).optional().describe('Intent (normative / idea / rejected)')
const optionalStabilitySchema = z.enum(STABILITIES).optional().describe('Stability (stable / evolving / volatile)')
const optionalReviewSchema = z
  .enum(REVIEW_STATUSES)
  .optional()
  .describe('Human review status (unreviewed / approved / stale)')
const optionalRealizationSchema = z
  .enum(REALIZATION_STATUSES)
  .optional()
  .describe('Realization status (unimplemented / in-progress / implemented / verified / drifted)')
const optionalBoolSchema = (desc: string) => z.boolean().optional().describe(desc)
const optionalQuerySchema = z.string().optional().describe('Keyword matching block ID or body')
const docIdSchema = z
  .string()
  .min(1)
  .describe('Document ID (extensionless relative path, e.g. "goals/document-centric", "specs/artifact-model")')
const nodeIdSchema = z.string().min(1).describe('Document ID or block ID (e.g. "auth.lockout", "specs/artifact-model")')

const optionalStringListSchema = (desc: string) => z.array(z.string().min(1)).optional().describe(desc)
const optionalBlockIntentSchema = z
  .enum(['normative', 'idea', 'rejected', 'informative'] as const)
  .optional()
  .describe('Block intent (normative / idea / rejected / informative)')

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
        'Return the project-wide overview (Goal / System Design summaries, top-level <Decision> conclusions, Domain Terms, Review/Realization stats, and health hints). Pass full: true to include full Goal / System Design bodies.',
      inputSchema: {
        full: optionalBoolSchema('Include full Goal/Architecture bodies and unabridged descriptions (default: false)'),
      },
    },
    async ({ full }: { full?: boolean }) => jsonResult(buildProjectMap(getIndex(), { full })),
  )

  const optionalMountSchema = z
    .string()
    .min(1)
    .optional()
    .describe('Filter or target a specific docs mount ID in multi-docs projects (e.g. "web", "api", "root")')

  registerTool(
    'list_documents',
    {
      description: 'List all Documi documents, optionally filtered by Artifact Type or docs mount.',
      inputSchema: { type: optionalTypeSchema, mount: optionalMountSchema },
    },
    async ({ type, mount }: { type?: ArtifactType; mount?: string }) =>
      jsonResult(listDocuments(getIndex(), type, mount)),
  )

  registerTool(
    'get_document',
    {
      description: 'Return full body, semantic blocks, relations, and issues for a document ID.',
      inputSchema: { id: docIdSchema },
    },
    async ({ id }: { id: string }) => {
      const detail = getDocumentDetail(getIndex(), id)
      if (!detail) return errorResult(`Document not found: ${id}`)
      return jsonResult(detail)
    },
  )

  registerTool(
    'get_relations',
    {
      description: 'Return outgoing and incoming graph edges for a document ID or block ID.',
      inputSchema: { id: nodeIdSchema },
    },
    async ({ id }: { id: string }) => {
      const relations = getNodeRelations(getIndex(), id)
      if (!relations) return errorResult(`Document or block not found: ${id}`)
      return jsonResult(relations)
    },
  )

  registerTool(
    'get_impact',
    {
      description:
        'Recursively list downstream documents, blocks, <SourceRef>s, and code/test anchors affected by changing a document ID or block ID. Call before editing specs to prevent contradictions.',
      inputSchema: {
        id: nodeIdSchema,
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(12)
          .optional()
          .describe('Maximum downstream traversal depth (default: 4)'),
      },
    },
    async ({ id, maxDepth }: { id: string; maxDepth?: number }) => {
      const impact = getImpactAnalysis(getIndex(), id, { maxDepth })
      if (!impact) return errorResult(`Document or block not found: ${id}`)
      return jsonResult(impact)
    },
  )

  registerTool(
    'query_specs',
    {
      description:
        'Filter semantic blocks (<Spec> / <Constraint> / <Decision> / <Test> / <Note> / <TermDef>) by kind, intent, stability, review, realization, suspect, or keyword.',
      inputSchema: {
        kind: optionalKindSchema,
        intent: optionalIntentSchema,
        stability: optionalStabilitySchema,
        review: optionalReviewSchema,
        realization: optionalRealizationSchema,
        suspect: optionalBoolSchema('Only return blocks flagged as suspect due to upstream changes'),
        mount: optionalMountSchema,
        query: optionalQuerySchema,
        full: optionalBoolSchema('Include full realization trace arrays and full bodies (default: false)'),
      },
    },
    async (args: {
      kind?: BlockKind
      intent?: SpecIntent
      stability?: Stability
      review?: ReviewStatus
      realization?: RealizationStatus
      suspect?: boolean
      mount?: string
      query?: string
      full?: boolean
    }) => jsonResult(querySpecs(getIndex(), args)),
  )

  registerTool(
    'get_spec_context',
    {
      description:
        'Assemble implementation/verification context for a Spec block ID (or document ID): upstream Goals, related Design/Contract docs, <Decision> conclusions (including micro-ADRs), colocated <Test> scenarios, Terms, and <SourceRef>s.',
      inputSchema: {
        id: nodeIdSchema,
        full: optionalBoolSchema(
          'Include full upstream Goal bodies, full realization arrays, and all exported symbols (default: false)',
        ),
      },
    },
    async ({ id, full }: { id: string; full?: boolean }) => {
      const context = getSpecContext(getIndex(), id, { full })
      if (!context) return errorResult(`Target not found: ${id}`)
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
        'Search documents and semantic blocks using BM25 + glossary alias expansion (or local Embedding + RRF hybrid search when semantic: true or rag.enabled is configured). Pass includeContext: true to expand graph-neighbor context (upstream Goals, <Decision> conclusions, related Contract/Design docs, Terms, and <SourceRef>s) within a character budget.',
      inputSchema: {
        query: z.string().min(1).describe('Search keywords or natural-language query'),
        type: optionalTypeSchema,
        mount: optionalMountSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum number of hits (default: 20, or 8 when includeContext: true)'),
        semantic: optionalBoolSchema('Run hybrid RRF search with local embeddings'),
        includeContext: optionalBoolSchema(
          'Return budgeted graph-expanded context (Goals, Outcomes, Terms, SourceRefs) instead of flat hits',
        ),
        budget: z
          .number()
          .int()
          .min(500)
          .max(40000)
          .optional()
          .describe('Character budget when includeContext: true (default: 6000)'),
        includeGraph: optionalBoolSchema('Include graph-neighbor expansion when includeContext: true (default: true)'),
      },
    },
    async ({
      query,
      type,
      mount,
      limit,
      semantic,
      includeContext,
      budget,
      includeGraph,
    }: {
      query: string
      type?: ArtifactType
      mount?: string
      limit?: number
      semantic?: boolean
      includeContext?: boolean
      budget?: number
      includeGraph?: boolean
    }) => {
      const useSemantic = semantic ?? ragConfig?.enabled === true
      if (includeContext) {
        if (useSemantic) {
          return jsonResult(
            await retrieveContextHybrid(store.rootDir, getIndex(), query, {
              type,
              mount,
              limit,
              budget,
              includeGraph,
              ragConfig,
              projectRoot,
            }),
          )
        }
        return jsonResult(retrieveContext(getIndex(), query, { type, mount, limit, budget, includeGraph }))
      }
      if (useSemantic) {
        const res = await searchIndexHybrid(store.rootDir, getIndex(), query, {
          type,
          mount,
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
      return jsonResult(searchDocuments(getIndex(), query, { type, mount, limit }))
    },
  )

  registerTool(
    'validate_docs',
    {
      description:
        'Validate all documents for structural integrity (orphan-spec, broken refs, cycles, duplicate IDs, MDX safety, broken <SourceRef>s, and health coverage hints).',
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
        'Surgically update an existing semantic block (<Spec> / <Constraint> / <Decision> / <Test> / <TermDef> / <Note>) in place and return post-reload validation results. Never touches docs/guard/reviews.json.',
      inputSchema: {
        id: z.string().min(1).describe('Target block ID to update'),
        body: z.string().min(1).describe('New block body (safe MDX syntax only)'),
        title: z.string().optional().describe('Block title (optional)'),
        summary: z.string().optional().describe('One-line conclusion summary for <Decision> (optional)'),
        date: z.string().optional().describe('Decision date YYYY-MM-DD for <Decision> (optional)'),
        level: z.enum(TEST_LEVELS).optional().describe('Test level for <Test>: unit|integration|e2e|contract|manual'),
        verifies: optionalStringListSchema('Target Spec IDs verified by <Test>'),
        stability: optionalStabilitySchema,
        intent: optionalBlockIntentSchema,
        derives: optionalStringListSchema('Upstream derives references'),
        supersedes: optionalStringListSchema('Supersedes references'),
        scope: z.string().optional().describe('Constraint scope (optional)'),
        aliases: optionalStringListSchema('TermDef aliases'),
        symbols: optionalStringListSchema('TermDef code symbols (src/...#Symbol)'),
      },
    },
    async (args: {
      id: string
      body: string
      title?: string
      summary?: string
      date?: string
      level?: TestLevel
      verifies?: string[]
      stability?: Stability
      intent?: SpecIntent | NoteIntent
      derives?: string[]
      supersedes?: string[]
      scope?: string
      aliases?: string[]
      symbols?: string[]
    }) => {
      const res = await updateBlockInDocs(store.rootDir, getIndex(), args)
      if (res.isErr()) return errorResult(res.error.message)
      const nextIndex = await store.reload()
      const validation = await buildValidationPayload(nextIndex, projectRoot)
      return jsonResult({ ...res.value, validation })
    },
  )

  registerTool(
    'add_block',
    {
      description:
        'Append a new semantic block to the end of a document (or immediately after a specified heading) and return post-reload validation results.',
      inputSchema: {
        docId: docIdSchema,
        kind: z.enum(BLOCK_KINDS).describe('Block kind (spec / constraint / decision / test / note / term)'),
        id: z.string().min(1).describe('New globally unique block ID'),
        body: z.string().min(1).describe('Block body (safe MDX syntax only)'),
        afterHeading: z.string().optional().describe('Insert immediately after this heading (omit to append at EOF)'),
        title: z.string().optional().describe('Block title (optional)'),
        summary: z.string().optional().describe('One-line conclusion summary for <Decision> (optional)'),
        date: z.string().optional().describe('Decision date YYYY-MM-DD for <Decision> (optional)'),
        level: z.enum(TEST_LEVELS).optional().describe('Test level for <Test>: unit|integration|e2e|contract|manual'),
        verifies: optionalStringListSchema('Target Spec IDs verified by <Test>'),
        stability: optionalStabilitySchema,
        intent: optionalBlockIntentSchema,
        derives: optionalStringListSchema('Upstream derives references'),
        supersedes: optionalStringListSchema('Supersedes references'),
        scope: z.string().optional().describe('Constraint scope (optional)'),
        aliases: optionalStringListSchema('TermDef aliases'),
        symbols: optionalStringListSchema('TermDef code symbols (src/...#Symbol)'),
      },
    },
    async (args: {
      docId: string
      kind: BlockKind
      id: string
      body: string
      afterHeading?: string
      title?: string
      summary?: string
      date?: string
      level?: TestLevel
      verifies?: string[]
      stability?: Stability
      intent?: SpecIntent | NoteIntent
      derives?: string[]
      supersedes?: string[]
      scope?: string
      aliases?: string[]
      symbols?: string[]
    }) => {
      const res = await addBlockToDoc(store.rootDir, getIndex(), args)
      if (res.isErr()) return errorResult(res.error.message)
      const nextIndex = await store.reload()
      const validation = await buildValidationPayload(nextIndex, projectRoot)
      return jsonResult({ ...res.value, validation })
    },
  )

  registerTool(
    'upsert_term',
    {
      description:
        'Create or update a <TermDef> block in the glossary document (default: domain/glossary) and return validation results.',
      inputSchema: {
        id: z.string().min(1).describe('Term ID (e.g. "Artifact")'),
        definition: z.string().min(1).describe('Term definition body'),
        aliases: optionalStringListSchema('Term aliases'),
        symbols: optionalStringListSchema('Code symbols (src/...#Symbol)'),
        docId: z.string().optional().describe('Target glossary document ID (default: domain/glossary)'),
      },
    },
    async (args: { id: string; definition: string; aliases?: string[]; symbols?: string[]; docId?: string }) => {
      const res = await upsertTermInDocs(store.rootDir, getIndex(), args)
      if (res.isErr()) return errorResult(res.error.message)
      const nextIndex = await store.reload()
      const validation = await buildValidationPayload(nextIndex, projectRoot)
      return jsonResult({ ...res.value, validation })
    },
  )

  registerTool(
    'scaffold_document',
    {
      description: 'Create a new .mdx document with standard YAML frontmatter (refuses to overwrite existing files).',
      inputSchema: {
        path: z.string().min(1).describe('Relative path under docs/ (e.g. "specs/auth/oauth.mdx")'),
        title: z.string().min(1).describe('Document title'),
        mount: optionalMountSchema,
        type: optionalTypeSchema,
        scope: z
          .enum(DOC_SCOPES)
          .optional()
          .describe('Document scope ("system" for system-wide overview design pinned to map)'),
        description: z.string().optional().describe('Short description'),
        date: z.string().optional().describe('Decision date (YYYY-MM-DD or YYYY-MM, for ADRs)'),
        tags: optionalStringListSchema('Document tags'),
        derives: optionalStringListSchema('Frontmatter derives references'),
        satisfies: optionalStringListSchema('Frontmatter satisfies references'),
        verifies: optionalStringListSchema('Frontmatter verifies references'),
        body: z.string().optional().describe('Initial body content (optional)'),
      },
    },
    async (args: {
      path: string
      title: string
      mount?: string
      type?: ArtifactType
      scope?: DocScope
      description?: string
      date?: string
      tags?: string[]
      derives?: string[]
      satisfies?: string[]
      verifies?: string[]
      body?: string
    }) => {
      const res = await scaffoldDocument(store.rootDir, getIndex(), args)
      if (res.isErr()) return errorResult(res.error.message)
      const nextIndex = await store.reload()
      const validation = await buildValidationPayload(nextIndex, projectRoot)
      return jsonResult({ ...res.value, validation })
    },
  )

  registerTool(
    'rename_block_id',
    {
      description:
        'Rename a block ID across all docs/ definitions, references, <SourceRef>s, and code/test anchors (@implements / @verifies / test("[id]")). Pass dryRun: true to preview planned changes.',
      inputSchema: {
        oldId: z.string().min(1).describe('Current block ID'),
        newId: z.string().min(1).describe('New block ID'),
        dryRun: optionalBoolSchema('Preview affected files without writing changes'),
      },
    },
    async (args: { oldId: string; newId: string; dryRun?: boolean }) => {
      const res = await renameBlockIdAcrossProject(store.rootDir, projectRoot, getIndex(), args)
      if (res.isErr()) return errorResult(res.error.message)
      const result = res.value
      if (!result.dryRun && result.changes.length > 0) {
        const nextIndex = await store.reload()
        const validation = await buildValidationPayload(nextIndex, projectRoot)
        return jsonResult({ ...result, validation })
      }
      return jsonResult(result)
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
