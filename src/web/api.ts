import { hc } from 'hono/client'
import type { ClientResponse, InferResponseType } from 'hono/client'
import type { ResponseFormat } from 'hono/types'
import type { CodeTreeNode } from '../core/code'
import type { ArtifactType, DocTreeNode, Stability } from '../core/types'
import type { ApiRoutes } from '../server/app'

const rpc = hc<ApiRoutes>('/')

/** サーバー側 Hono ルート定義から自動推論されるレスポンス型（手書き二重管理なし） */
// Hono の JSONParsed は再帰型 DocTreeNode[] / CodeTreeNode[] を JSONValue へ丸めるため tree のみ復元する
type TreeResponse = Omit<InferResponseType<typeof rpc.api.tree.$get, 200>, 'tree'> & {
  tree: DocTreeNode[]
}
type CodeTreeResponse = Omit<InferResponseType<typeof rpc.api.code.tree.$get, 200>, 'tree'> & {
  tree: CodeTreeNode[]
}
export type GraphResponse = InferResponseType<typeof rpc.api.graph.$get, 200>
export type GraphNodeItem = GraphResponse['nodes'][number]
export type GraphEdgeItem = GraphResponse['edges'][number]
export type TermEntry = InferResponseType<typeof rpc.api.terms.$get, 200>['terms'][number]
export type ReviewBlocksResponse = InferResponseType<typeof rpc.api.blocks.$get, 200>

type SuccessJson<R> = R extends ClientResponse<infer T, infer S, 'json'> ? (S extends 200 | 201 ? T : never) : never

async function unwrap<R extends ClientResponse<unknown, number, ResponseFormat>>(
  promise: Promise<R>,
): Promise<SuccessJson<R>> {
  const res = await promise
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as SuccessJson<R>
}

export function encodeDocId(docId: string): string {
  return docId
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

export const api = {
  status: () => unwrap(rpc.api.status.$get()),
  overview: () => unwrap(rpc.api.overview.$get()),
  tree: async (): Promise<TreeResponse> => {
    const data = await unwrap(rpc.api.tree.$get())
    return { ...data, tree: data.tree as DocTreeNode[] }
  },
  documents: (type?: ArtifactType) => unwrap(rpc.api.documents.$get({ query: type ? { type } : {} })),
  document: (docId: string) => unwrap(rpc.api.documents[':id{.+}'].$get({ param: { id: encodeDocId(docId) } })),
  graph: (layers: 'all' | 'trace' = 'all', granularity: 'docs' | 'blocks' = 'docs') =>
    unwrap(rpc.api.graph.$get({ query: { layers, granularity } })),
  terms: () => unwrap(rpc.api.terms.$get()),
  search: (q: string, type?: ArtifactType | '', limit = 30) =>
    unwrap(
      rpc.api.search.$get({
        query: {
          q,
          limit: String(limit),
          ...(type ? { type } : {}),
        },
      }),
    ),
  matrix: () => unwrap(rpc.api.matrix.$get()),
  bundle: (params: { scope?: string; ids?: string[]; title?: string }) =>
    unwrap(
      rpc.api.bundle.$get({
        query: {
          ...(params.ids && params.ids.length > 0
            ? { ids: params.ids.join(',') }
            : params.scope
              ? { scope: params.scope }
              : {}),
          ...(params.title ? { title: params.title } : {}),
        },
      }),
    ),
  blocks: () => unwrap(rpc.api.blocks.$get()),
  blockDiff: (blockId: string) =>
    unwrap(rpc.api.blocks[':id'].diff.$get({ param: { id: encodeURIComponent(blockId) } })),
  approveBlock: (blockId: string, author?: string) =>
    unwrap(
      rpc.api.blocks[':id'].approve.$post({
        param: { id: encodeURIComponent(blockId) },
        json: author ? { author } : {},
      }),
    ),
  addFeedback: (blockId: string, body: string, author?: string) =>
    unwrap(
      rpc.api.blocks[':id'].feedback.$post({
        param: { id: encodeURIComponent(blockId) },
        json: author ? { body, author } : { body },
      }),
    ),
  setFeedbackResolved: (blockId: string, feedbackId: string, resolved: boolean) =>
    unwrap(
      rpc.api.blocks[':id'].feedback[':feedbackId'].$patch({
        param: { id: encodeURIComponent(blockId), feedbackId: encodeURIComponent(feedbackId) },
        json: { resolved },
      }),
    ),
  setStability: (blockId: string, stability: Stability | null) =>
    unwrap(
      rpc.api.blocks[':id'].stability.$patch({
        param: { id: encodeURIComponent(blockId) },
        json: { stability },
      }),
    ),
  source: (params: { file: string; symbol?: string; lines?: string }) =>
    unwrap(
      rpc.api.source.$get({
        query: {
          file: params.file,
          ...(params.symbol ? { symbol: params.symbol } : {}),
          ...(params.lines ? { lines: params.lines } : {}),
        },
      }),
    ),
  codeTree: async (): Promise<CodeTreeResponse> => {
    const data = await unwrap(rpc.api.code.tree.$get())
    return { ...data, tree: data.tree as CodeTreeNode[] }
  },
  codeFile: (filePath: string) => unwrap(rpc.api.code.file.$get({ query: { path: filePath } })),
}
