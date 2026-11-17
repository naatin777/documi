export const ARTIFACT_TYPES = [
  'goal',
  'requirement',
  'architecture',
  'design',
  'decision',
  'contract',
  'verification',
  'guide',
] as const

export type ArtifactType = (typeof ARTIFACT_TYPES)[number]

export const ARTIFACT_TYPE_DIRECTORIES: Record<ArtifactType, string> = {
  goal: 'goals',
  requirement: 'requirements',
  architecture: 'architecture',
  design: 'designs',
  decision: 'decisions',
  contract: 'contracts',
  verification: 'verification',
  guide: 'guides',
}

export const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = {
  goal: 'Goal',
  requirement: 'Requirement',
  architecture: 'Architecture',
  design: 'Design',
  decision: 'Decision',
  contract: 'Contract',
  verification: 'Verification',
  guide: 'Guide',
}

export const DOC_STATUSES = ['draft', 'accepted', 'deprecated'] as const
export type DocStatus = (typeof DOC_STATUSES)[number]

export const ID_PATTERN = /^\d{5}$/
export const FILENAME_PATTERN = /^(\d{5})-([a-z0-9]+(?:-[a-z0-9]+)*)\.(md|mdx)$/

export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(value)
}

export function documentRef(type: ArtifactType, id: string): string {
  return `${type}:${id}`
}

export interface DocIssue {
  code: string
  message: string
}

export interface IndexIssue extends DocIssue {
  path?: string
}

export interface RelationTarget {
  ref: string
  type: ArtifactType
  id: string
  title: string
  status: DocStatus
  path: string
}

export interface DocumentMeta {
  ref: string
  type: ArtifactType
  id: string
  slug: string
  title: string
  description: string
  status: DocStatus
  tags: string[]
  sources: string[]
  subtype?: string
  perspective?: string
  format: 'markdown' | 'mdx'
  /** rootDir からの相対パス (posix 区切り) */
  path: string
  /** frontmatter を除いた本文 */
  body: string
}

export interface Document extends DocumentMeta {
  /** 検証済みの外向き参照 (type -> id 配列) */
  declaredRelations: Partial<Record<ArtifactType, string[]>>
  /** 解決済みの外向き参照 */
  relations: RelationTarget[]
  /** 解決済みの逆参照 */
  incomingRelations: RelationTarget[]
  /** この文書に紐づく問題 (未解決 relation, 制約違反, MDX未対応構文など) */
  issues: DocIssue[]
}

export interface Glossary {
  title: string
  description: string
  path: string
  body: string
}

export interface DocsIndex {
  rootDir: string
  documents: Document[]
  byRef: Map<string, Document>
  glossary: Glossary | null
  issues: IndexIssue[]
}
