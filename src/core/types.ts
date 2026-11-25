export const ARTIFACT_TYPES = [
  'goal',
  'decision',
  'domain',
  'spec',
  'contract',
  'architecture',
  'design',
  'verification',
  'guide',
] as const

export type ArtifactType = (typeof ARTIFACT_TYPES)[number]

export type ArtifactLayer = 'boundary' | 'domain' | 'normative' | 'realization' | 'informative'

export const ARTIFACT_TYPE_LAYERS: Record<ArtifactType, ArtifactLayer> = {
  goal: 'boundary',
  decision: 'boundary',
  domain: 'domain',
  spec: 'normative',
  contract: 'normative',
  architecture: 'realization',
  design: 'realization',
  verification: 'realization',
  guide: 'informative',
}

/** ディレクトリ名・ファイル名から ArtifactType を自動推論するための対応表 */
export const ARTIFACT_TYPE_ALIASES: Record<string, ArtifactType> = {
  goal: 'goal',
  goals: 'goal',
  decision: 'decision',
  decisions: 'decision',
  adr: 'decision',
  adrs: 'decision',
  domain: 'domain',
  domains: 'domain',
  glossary: 'domain',
  spec: 'spec',
  specs: 'spec',
  contract: 'contract',
  contracts: 'contract',
  architecture: 'architecture',
  arch: 'architecture',
  design: 'design',
  designs: 'design',
  verification: 'verification',
  verifications: 'verification',
  guide: 'guide',
  guides: 'guide',
}

/** ドキュメント本文の形式 */
export type DocFormat = 'markdown' | 'mdx'

export const SPEC_INTENTS = ['normative', 'idea', 'rejected'] as const
export type SpecIntent = (typeof SPEC_INTENTS)[number]

export const NOTE_INTENTS = ['idea', 'informative', 'rejected'] as const
export type NoteIntent = (typeof NOTE_INTENTS)[number]

export const STABILITIES = ['stable', 'evolving', 'volatile'] as const
export type Stability = (typeof STABILITIES)[number]

export const REVIEW_STATUSES = ['unreviewed', 'approved', 'stale'] as const
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

export const REALIZATION_STATUSES = ['unimplemented', 'in-progress', 'implemented', 'verified', 'drifted'] as const
export type RealizationStatus = (typeof REALIZATION_STATUSES)[number]

export const BLOCK_KINDS = ['spec', 'constraint', 'outcome', 'note', 'term'] as const
export type BlockKind = (typeof BLOCK_KINDS)[number]

export const EDGE_KINDS = ['derives', 'satisfies', 'verifies', 'supersedes', 'mentions'] as const
export type EdgeKind = (typeof EDGE_KINDS)[number]

/** トレーサビリティの背骨となる意味付きエッジ種別 */
export const TRACE_EDGE_KINDS = ['derives', 'satisfies', 'verifies', 'supersedes'] as const
export type TraceEdgeKind = (typeof TRACE_EDGE_KINDS)[number]

export const BLOCK_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]*$/

export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(value)
}

export function isSpecIntent(value: unknown): value is SpecIntent {
  return typeof value === 'string' && (SPEC_INTENTS as readonly string[]).includes(value)
}

export function isNoteIntent(value: unknown): value is NoteIntent {
  return typeof value === 'string' && (NOTE_INTENTS as readonly string[]).includes(value)
}

export function isStability(value: unknown): value is Stability {
  return typeof value === 'string' && (STABILITIES as readonly string[]).includes(value)
}

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === 'string' && (REVIEW_STATUSES as readonly string[]).includes(value)
}

export interface BlockReviewRecord {
  docPath: string
  hash: string
  approvedCommit?: string
  approvedAt?: string
  approvedBy?: string
  /** 人間が最終確認・承認時に残した確認メモ (任意) */
  note?: string
  upstreamHashes?: Record<string, string>
}

export interface ReviewsFile {
  version: 1
  blocks: Record<string, BlockReviewRecord>
}

export interface DiffLine {
  type: 'context' | 'add' | 'del'
  text: string
}

export interface BlockDiffResult {
  blockId: string
  hasBase: boolean
  baseSource: 'git' | 'cache' | 'none'
  baseCommit?: string
  changed: boolean
  lines: DiffLine[]
}

export type WorkingTreeStatus = 'modified' | 'added' | 'untracked'

export interface DocumentFreshness {
  /** 初回作成日時 (ISO 8601。Git 初回コミット日時、未追跡/非 Git はファイル作成・更新時刻) */
  createdAt?: string
  /** 最終更新日時 (ISO 8601。未コミット変更時は mtime、それ以外は最新コミット日時) */
  updatedAt?: string
  /** 作業ツリー上の未コミット変更状態 */
  workingStatus?: WorkingTreeStatus
  /** 最新コミットの短縮 SHA (7文字) */
  lastCommitSha?: string
  /** 最新コミットの件名 */
  lastCommitSubject?: string
  /** この文書の総コミット数 */
  commitCount?: number
}

export interface GitCommitEntry {
  sha: string
  shortSha: string
  date: string
  author: string
  subject: string
  status: 'A' | 'M' | 'R' | 'D' | 'C'
}

export interface ChangedLineRange {
  /** 本文（frontmatter 除外後）基準の 1-indexed 開始行 */
  startLine: number
  /** 本文（frontmatter 除外後）基準の 1-indexed 終了行 */
  endLine: number
  kind: 'added' | 'modified'
}

export interface DocumentHistory {
  docId: string
  path: string
  gitAvailable: boolean
  freshness: DocumentFreshness
  /** 最新変更ハイライトの対象基準 */
  highlightBasis: 'working' | 'last-commit' | 'none'
  /** highlightBasis === 'last-commit' 時の対象コミット */
  highlightCommit?: GitCommitEntry
  /** 本文（frontmatter 除外後）基準の最新変更行レンジ一覧 */
  changedRanges: ChangedLineRange[]
  /** 対象文書のコミット履歴（新しい順） */
  commits: GitCommitEntry[]
}

export interface DocumentRevision {
  docId: string
  path: string
  commit: GitCommitEntry
  title: string
  description: string
  format: DocFormat
  dir: string
  body: string
}

export interface CodeAnchor {
  kind: 'implements' | 'verifies'
  specId: string
  file: string
  line: number
  testName?: string
  fromDoc?: boolean
}

export interface TestCaseResult {
  specId: string
  name: string
  file?: string
  status: 'passed' | 'failed' | 'skipped'
  message?: string
}

export interface PullRequestLink {
  number: number
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  url: string
  relation: 'implements' | 'verifies' | 'mentions'
}

export interface RealizationSummary {
  status: RealizationStatus
  implementations: CodeAnchor[]
  verifications: CodeAnchor[]
  testResults: TestCaseResult[]
  pullRequests: PullRequestLink[]
  reasons: string[]
}

export interface DocIssue {
  code: string
  message: string
  /** 問題が特定ブロックに紐づく場合のブロック ID */
  blockId?: string
}

export interface IndexIssue extends DocIssue {
  path?: string
}

export interface SemanticBlock {
  id: string
  kind: BlockKind
  docId: string
  startLine: number
  endLine: number
  /** 正規化済み本文の SHA-256 ハッシュ (sha256:...) */
  contentHash: string
  rawBody: string
  title?: string
  intent: SpecIntent | NoteIntent
  stability: Stability
  /** 人間レビュー状態 (guard/reviews.json と contentHash から自動算出) */
  review: ReviewStatus
  approvedAt?: string
  approvedBy?: string
  approvedCommit?: string
  approvedNote?: string
  /** 上流の変更により要再確認になっているか (Suspect Link) */
  suspect: boolean
  suspectSources: string[]
  /** コード・テスト・PR から自動算出された実装/検証状態 */
  realization?: RealizationSummary
  /** 明示的な上流参照 (derives) */
  derives: string[]
  /** 置き換え対象 (supersedes) */
  supersedes: string[]
  /** Constraint 用の適用範囲 */
  scope?: string
  /** TermDef 用の別名一覧 */
  aliases?: string[]
  /** TermDef 用のコードシンボル参照一覧 (例: src/core/types.ts#Document) */
  symbols?: string[]
}

export type SourceRefMode = 'snippet' | 'exports'

export interface SourceRefDecl {
  file: string
  symbol?: string
  lines?: string
  mode?: SourceRefMode
  satisfies: string[]
  verifies: string[]
  startLine: number
}

export interface GraphEdge {
  /** 参照元 (docId または blockId) */
  from: string
  /** 参照元の所属ドキュメント ID */
  fromDocId: string
  /** 参照先 (docId または blockId) */
  to: string
  /** 参照先の所属ドキュメント ID */
  toDocId: string
  toKind: 'doc' | 'block'
  kind: EdgeKind
}

export interface ResolvedRelation {
  /** 参照先/参照元の識別子 (docId または blockId) */
  ref: string
  targetKind: 'doc' | 'block'
  docId: string
  type: ArtifactType
  title: string
  kind: EdgeKind
  path: string
}

export interface DocumentMeta {
  /** docs/ からの拡張子なし POSIX 相対パス (例: goals/core, auth/lockout) */
  id: string
  type: ArtifactType
  /** frontmatter ではなくパス/ファイル名から推論された場合 true */
  typeInferred: boolean
  title: string
  description: string
  /** 作成日・決定日 (任意、ISO 8601 の YYYY-MM-DD または YYYY-MM。ADR 等で時系列管理に利用) */
  date?: string
  tags: string[]
  format: DocFormat
  /** rootDir からの相対パス (posix 区切り、拡張子あり) */
  path: string
  /** 親ディレクトリ (posix 区切り、ルート直下は '') */
  dir: string
  /** frontmatter を除いた本文 */
  body: string
}

export interface Document extends DocumentMeta {
  /** 文書内の構造化セマンティックブロック */
  blocks: SemanticBlock[]
  /** 文書内の SourceRef 宣言 */
  sourceRefs: SourceRefDecl[]
  /** Frontmatter で宣言された意味付き参照 */
  declaredEdges: Partial<Record<TraceEdgeKind, string[]>>
  /** 解決済みの外向き参照 */
  outgoing: ResolvedRelation[]
  /** 解決済みの逆参照 */
  incoming: ResolvedRelation[]
  /** Git 履歴またはファイル時刻から算出した鮮度情報 */
  freshness?: DocumentFreshness
  /** この文書に紐づく問題 (未解決リンク, orphan-spec, 循環, MDX未対応構文など) */
  issues: DocIssue[]
}

export interface DocumentSummary {
  id: string
  type: ArtifactType
  title: string
  description: string
  /** 作成日・決定日 (任意、ISO 8601 の YYYY-MM-DD または YYYY-MM。ADR 等で時系列管理に利用) */
  date?: string
  tags: string[]
  path: string
  dir: string
  format: DocFormat
  blockCount: number
  specCount: number
  issueCount: number
  /** Git 履歴またはファイル時刻から算出した鮮度情報 */
  freshness?: DocumentFreshness
}

export interface DocTreeDir {
  kind: 'dir'
  name: string
  path: string
  children: DocTreeNode[]
}

export interface DocTreeFile {
  kind: 'doc'
  name: string
  doc: DocumentSummary
}

export type DocTreeNode = DocTreeDir | DocTreeFile

export interface DocsIndex {
  rootDir: string
  loadedAt: string
  documents: Document[]
  byId: Map<string, Document>
  blocksById: Map<string, SemanticBlock>
  /** 用語名および別名 (小文字正規化) -> TermDef ブロック */
  termsByName: Map<string, SemanticBlock>
  edges: GraphEdge[]
  issues: IndexIssue[]
}
