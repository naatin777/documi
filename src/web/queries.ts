import { keepPreviousData, QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import type { ArtifactType } from '../core/types'
import { api } from './api'

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  })
}

const queryKeys = {
  overview: ['overview'] as const,
  tree: ['tree'] as const,
  status: ['status'] as const,
  documents: (type?: ArtifactType) => ['documents', type ?? 'all'] as const,
  document: (docId: string) => ['document', docId] as const,
  terms: ['terms'] as const,
  blocks: ['blocks'] as const,
  graph: (layers: 'all' | 'trace', granularity: 'docs' | 'blocks') => ['graph', layers, granularity] as const,
  matrix: ['matrix'] as const,
  bundle: (params: { scope?: string; ids?: string[]; title?: string }) =>
    ['bundle', params.scope ?? '', params.ids?.join(',') ?? '', params.title ?? ''] as const,
  search: (q: string) => ['search', q] as const,
  source: (params: { file: string; symbol?: string; lines?: string }) =>
    ['source', params.file, params.symbol ?? '', params.lines ?? ''] as const,
  codeTree: ['code', 'tree'] as const,
  codeFile: (filePath: string) => ['code', 'file', filePath] as const,
}

export function toErrorMessage(error: unknown): string | null {
  if (!error) return null
  return error instanceof Error ? error.message : String(error)
}

export function useInvalidateDocs() {
  const queryClient = useQueryClient()
  return useCallback(() => {
    void queryClient.invalidateQueries()
  }, [queryClient])
}

export function useOverviewQuery() {
  return useQuery({
    queryKey: queryKeys.overview,
    queryFn: () => api.overview(),
  })
}

export function useTreeQuery() {
  return useQuery({
    queryKey: queryKeys.tree,
    queryFn: () => api.tree(),
  })
}

export function useStatusQuery() {
  return useQuery({
    queryKey: queryKeys.status,
    queryFn: () => api.status(),
  })
}

export function useDocumentsQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.documents(),
    queryFn: () => api.documents(),
    enabled,
  })
}

export function useDocumentQuery(docId: string) {
  return useQuery({
    queryKey: queryKeys.document(docId),
    queryFn: () => api.document(docId),
    enabled: Boolean(docId),
  })
}

export function useTermsQuery() {
  return useQuery({
    queryKey: queryKeys.terms,
    queryFn: () => api.terms(),
  })
}

export function useBlocksQuery() {
  return useQuery({
    queryKey: queryKeys.blocks,
    queryFn: () => api.blocks(),
  })
}

export function useGraphQuery(layers: 'all' | 'trace', granularity: 'docs' | 'blocks') {
  return useQuery({
    queryKey: queryKeys.graph(layers, granularity),
    queryFn: () => api.graph(layers, granularity),
    placeholderData: keepPreviousData,
  })
}

export function useMatrixQuery() {
  return useQuery({
    queryKey: queryKeys.matrix,
    queryFn: () => api.matrix(),
  })
}

export function useBundleQuery(params: { scope?: string; ids?: string[]; title?: string }) {
  return useQuery({
    queryKey: queryKeys.bundle(params),
    queryFn: () => api.bundle(params),
  })
}

export function useSearchQuery(q: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.search(q),
    queryFn: () => api.search(q, undefined, 25),
    enabled: enabled && q.length > 0,
    placeholderData: keepPreviousData,
  })
}

export function useSourceQuery(params: { file?: string; symbol?: string; lines?: string }, enabled: boolean) {
  const file = params.file ?? ''
  return useQuery({
    queryKey: queryKeys.source({ file, symbol: params.symbol, lines: params.lines }),
    queryFn: () => api.source({ file, symbol: params.symbol, lines: params.lines }),
    enabled: enabled && Boolean(file),
    retry: false,
  })
}

export function useCodeTreeQuery() {
  return useQuery({
    queryKey: queryKeys.codeTree,
    queryFn: () => api.codeTree(),
  })
}

export function useCodeFileQuery(filePath: string) {
  return useQuery({
    queryKey: queryKeys.codeFile(filePath),
    queryFn: () => api.codeFile(filePath),
    enabled: Boolean(filePath),
    retry: false,
  })
}
