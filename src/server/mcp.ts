import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { ZodTypeAny } from 'zod'
import { ARTIFACT_TYPES, ID_PATTERN, documentRef } from '../core/types'
import type { ArtifactType, Document, DocsIndex } from '../core/types'
import { getDocument } from '../core/loader'

// registerTool のジェネリクス推論が深くなりすぎるのを防ぐため ZodTypeAny に広げる。
// 実行時のバリデーション (enum / regex) はスキーマ自体がそのまま担う。
const artifactTypeSchema: ZodTypeAny = z.enum(ARTIFACT_TYPES)
const optionalTypeSchema: ZodTypeAny = artifactTypeSchema.optional().describe('絞り込む Artifact Type (省略時は全件)')

const docRefSchema = {
  type: artifactTypeSchema.describe(
    'Artifact Type (goal / requirement / architecture / design / decision / contract / verification / guide)',
  ),
  id: z.string().regex(ID_PATTERN).describe('5桁の Artifact ID (例: "00001")'),
}

interface ListDocumentsArgs {
  type?: ArtifactType
}

interface DocumentRefArgs {
  type: ArtifactType
  id: string
}

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

function toSummary(doc: Document) {
  return {
    ref: doc.ref,
    type: doc.type,
    id: doc.id,
    title: doc.title,
    description: doc.description,
    status: doc.status,
    path: doc.path,
  }
}

function createDocumiMcpServer(index: DocsIndex): McpServer {
  const server = new McpServer({
    name: 'documi',
    version: '0.1.0',
  })

  // registerTool のジェネリクス型推論 (ZodRawShapeCompat 経由) が深すぎて
  // TS2589 になるため、境界を緩めた汎用ラッパーを使う。
  // 引数のバリデーションは実行時に zod スキーマが行い、コールバック側には
  // バリデーション済みの型を渡す。
  const registerTool = server.registerTool.bind(server) as unknown as <Args>(
    name: string,
    config: { description: string; inputSchema?: Record<string, ZodTypeAny> },
    cb: (args: Args) => Promise<CallToolResult>,
  ) => void

  registerTool(
    'list_documents',
    {
      description: 'Documi の Artifact 一覧を取得します。type で絞り込み可能です。',
      inputSchema: { type: optionalTypeSchema },
    },
    async ({ type }: ListDocumentsArgs) => {
      const docs = index.documents.filter((d) => !type || d.type === type)
      return jsonResult({ documents: docs.map(toSummary), count: docs.length })
    },
  )

  registerTool(
    'get_document',
    {
      description:
        'Type と ID からドキュメントを取得します。frontmatter メタデータと Markdown/MDX のソース本文を返します。',
      inputSchema: docRefSchema,
    },
    async ({ type, id }: DocumentRefArgs) => {
      if (!type || !id) return errorResult('type と id は必須です')
      const doc = getDocument(index, type, id)
      if (!doc) return errorResult(`ドキュメントが見つかりません: ${documentRef(type, id)}`)
      return jsonResult({
        ...toSummary(doc),
        slug: doc.slug,
        format: doc.format,
        tags: doc.tags,
        sources: doc.sources,
        subtype: doc.subtype,
        perspective: doc.perspective,
        body: doc.body,
        declaredRelations: doc.declaredRelations,
        relations: doc.relations,
        incomingRelations: doc.incomingRelations,
        issues: doc.issues,
      })
    },
  )

  registerTool(
    'get_relations',
    {
      description: '指定した Artifact の参照関係 (外向き / 逆参照) を解決済みの情報とともに取得します。',
      inputSchema: docRefSchema,
    },
    async ({ type, id }: DocumentRefArgs) => {
      if (!type || !id) return errorResult('type と id は必須です')
      const doc = getDocument(index, type, id)
      if (!doc) return errorResult(`ドキュメントが見つかりません: ${documentRef(type, id)}`)
      return jsonResult({
        ref: doc.ref,
        outgoing: doc.relations,
        incoming: doc.incomingRelations,
      })
    },
  )

  registerTool(
    'get_glossary',
    {
      description: 'プロジェクトの用語集 (glossary) を取得します。',
      inputSchema: {},
    },
    async () => {
      const glossary = index.glossary
      if (!glossary) return errorResult('glossary が見つかりません (docs/glossary.mdx)')
      return jsonResult({
        title: glossary.title,
        description: glossary.description,
        path: glossary.path,
        format: glossary.format,
        body: glossary.body,
      })
    },
  )

  return server
}

/**
 * Stateless な Streamable HTTP として MCP リクエストを処理する。
 * リクエストごとに McpServer と Transport を生成する (公式サンプルと同じ方式)。
 */
export async function handleMcpRequest(index: DocsIndex, request: Request): Promise<Response> {
  const server = createDocumiMcpServer(index)
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await server.connect(transport)
  return transport.handleRequest(request)
}
