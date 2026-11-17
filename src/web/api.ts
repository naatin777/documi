import type { ArtifactType, DocFormat, DocStatus, Document, Glossary, IndexIssue } from '../core/types'

export interface DocumentSummary {
  ref: string
  type: ArtifactType
  id: string
  title: string
  description: string
  status: DocStatus
  path: string
  format: DocFormat
  issueCount: number
}

export interface StatusResponse {
  rootDir: string
  documentCount: number
  issues: IndexIssue[]
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export interface SourceResponse {
  file: string
  language: string
  symbol?: { name: string; qualifiedName?: string; kind: string }
  startLine: number
  endLine: number
  totalLines: number
  code: string
  truncated?: boolean
}

export const api = {
  status: () => get<StatusResponse>('/api/status'),
  documents: (type?: string) =>
    get<{ documents: DocumentSummary[] }>(`/api/documents${type ? `?type=${encodeURIComponent(type)}` : ''}`),
  document: (type: string, id: string) =>
    get<{ document: Document }>(`/api/documents/${encodeURIComponent(type)}/${encodeURIComponent(id)}`),
  glossary: () => get<{ glossary: Glossary }>('/api/glossary'),
  source: (params: { file: string; symbol?: string; lines?: string }) => {
    const qs = new URLSearchParams({ file: params.file })
    if (params.symbol) qs.set('symbol', params.symbol)
    if (params.lines) qs.set('lines', params.lines)
    return get<SourceResponse>(`/api/source?${qs.toString()}`)
  },
}
