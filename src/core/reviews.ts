import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Result } from 'better-result'
import { diffArrays } from 'diff'
import { z } from 'zod'
import { BlockNotFoundError, DocumentNotFoundError, type ReviewDomainError } from './errors'
import { splitFrontmatter } from './frontmatter'
import { getGitHeadShortSha, getGitUserName, readFileAtGitCommit } from './git'
import { computeContentHash, extractMdxArtifacts } from './mdx'
import type {
  BlockDiffResult,
  BlockReviewRecord,
  DiffLine,
  DocsIndex,
  IndexIssue,
  ReviewsFile,
  SemanticBlock,
} from './types'

export const REVIEWS_REL_PATH = 'guard/reviews.json'
const SNAPSHOT_CACHE_REL_PATH = '.documi/cache/approved-bodies.json'

const UPSTREAM_EDGE_KINDS = new Set(['derives', 'satisfies', 'verifies'])

export async function loadReviews(docsDir: string, issues: IndexIssue[]): Promise<ReviewsFile> {
  const filePath = path.join(docsDir, REVIEWS_REL_PATH)
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, blocks: {} }
    }
    issues.push({
      code: 'invalid-reviews',
      message: `Failed to read reviews.json: ${error instanceof Error ? error.message : String(error)}`,
      path: REVIEWS_REL_PATH,
    })
    return { version: 1, blocks: {} }
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    return validateReviewsFile(parsed, issues)
  } catch (error) {
    issues.push({
      code: 'invalid-reviews',
      message: `Failed to parse reviews.json: ${error instanceof Error ? error.message : String(error)}`,
      path: REVIEWS_REL_PATH,
    })
    return { version: 1, blocks: {} }
  }
}

const rawBlockRecordSchema = z
  .object({
    docPath: z.string().min(1),
    hash: z.string().min(1),
    approvedCommit: z.string().optional(),
    approvedAt: z.string().min(1),
    approvedBy: z.string().optional(),
    note: z.string().optional(),
    upstreamHashes: z.record(z.string(), z.unknown()).optional(),
  })
  .loose()

const reviewsFileRootSchema = z
  .object({
    blocks: z.record(z.string(), z.unknown()).optional(),
  })
  .loose()

function validateReviewsFile(parsed: unknown, issues: IndexIssue[]): ReviewsFile {
  const rootResult = reviewsFileRootSchema.safeParse(parsed)
  if (!rootResult.success) {
    issues.push({
      code: 'invalid-reviews',
      message: 'Invalid reviews.json structure (root and blocks must be objects)',
      path: REVIEWS_REL_PATH,
    })
    return { version: 1, blocks: {} }
  }

  const blocks: Record<string, BlockReviewRecord> = {}
  for (const [id, entry] of Object.entries(rootResult.data.blocks ?? {})) {
    const recResult = rawBlockRecordSchema.safeParse(entry)
    if (!recResult.success) {
      issues.push({
        code: 'invalid-reviews',
        message: `Invalid review record for block "${id}": missing or invalid required fields (docPath / hash / approvedAt)`,
        path: REVIEWS_REL_PATH,
        blockId: id,
      })
      continue
    }
    const e = recResult.data

    const upstreamHashes: Record<string, string> = {}
    for (const [k, v] of Object.entries(e.upstreamHashes ?? {})) {
      if (typeof v === 'string') upstreamHashes[k] = v
    }

    const note = e.note?.trim() || undefined
    const approvedBy = e.approvedBy?.trim() || undefined
    blocks[id] = {
      docPath: e.docPath,
      hash: e.hash,
      approvedCommit: e.approvedCommit,
      approvedAt: e.approvedAt,
      ...(approvedBy ? { approvedBy } : {}),
      ...(note ? { note } : {}),
      upstreamHashes: Object.keys(upstreamHashes).length > 0 ? upstreamHashes : undefined,
    }
  }
  return { version: 1, blocks }
}

/** reviews.json をキー昇順・決定論的フォーマットで保存する (Git diff のノイズを防ぐ) */
export async function saveReviews(docsDir: string, reviews: ReviewsFile): Promise<void> {
  const filePath = path.join(docsDir, REVIEWS_REL_PATH)
  await mkdir(path.dirname(filePath), { recursive: true })

  const sortedBlocks: Record<string, BlockReviewRecord> = {}
  for (const id of Object.keys(reviews.blocks).toSorted()) {
    const rec = reviews.blocks[id]!
    const sortedUpstreams =
      rec.upstreamHashes && Object.keys(rec.upstreamHashes).length > 0
        ? Object.fromEntries(
            Object.keys(rec.upstreamHashes)
              .toSorted()
              .map((k) => [k, rec.upstreamHashes![k]!]),
          )
        : undefined
    const note = rec.note?.trim() || undefined
    const approvedBy = rec.approvedBy?.trim() || undefined
    sortedBlocks[id] = {
      docPath: rec.docPath,
      hash: rec.hash,
      ...(rec.approvedCommit ? { approvedCommit: rec.approvedCommit } : {}),
      approvedAt: rec.approvedAt,
      ...(approvedBy ? { approvedBy } : {}),
      ...(note ? { note } : {}),
      ...(sortedUpstreams ? { upstreamHashes: sortedUpstreams } : {}),
    }
  }

  const normalized: ReviewsFile = { version: 1, blocks: sortedBlocks }
  await atomicWriteFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`)
}

/** 一時ファイルへ書いてから rename することで、途中失敗や並行読み取りで半端な JSON を見せない */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, filePath)
}

/** reviews.json / スナップショットキャッシュの read-modify-write をプロセス内で直列化する */
let reviewWriteQueue: Promise<unknown> = Promise.resolve()
function withReviewLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = reviewWriteQueue.then(fn, fn)
  reviewWriteQueue = run.catch(() => undefined)
  return run
}

function resolveSnapshotCachePath(docsDir: string, cacheRoot?: string): string {
  return path.join(cacheRoot ?? docsDir, SNAPSHOT_CACHE_REL_PATH)
}

async function readBodyCache(docsDir: string, cacheRoot?: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(resolveSnapshotCachePath(docsDir, cacheRoot), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

async function writeBodyCache(docsDir: string, blockId: string, rawBody: string, cacheRoot?: string): Promise<void> {
  const cachePath = resolveSnapshotCachePath(docsDir, cacheRoot)
  const current = await readBodyCache(docsDir, cacheRoot)
  current[blockId] = rawBody
  await mkdir(path.dirname(cachePath), { recursive: true })
  await atomicWriteFile(cachePath, `${JSON.stringify(current, null, 2)}\n`)
}

async function removeBodyCache(docsDir: string, blockId: string, cacheRoot?: string): Promise<void> {
  const cachePath = resolveSnapshotCachePath(docsDir, cacheRoot)
  const current = await readBodyCache(docsDir, cacheRoot)
  if (!(blockId in current)) return
  delete current[blockId]
  await mkdir(path.dirname(cachePath), { recursive: true })
  await atomicWriteFile(cachePath, `${JSON.stringify(current, null, 2)}\n`)
}

/** 現在の対象 (ブロック ID またはドキュメント ID) のハッシュを取得する */
function currentTargetHash(index: DocsIndex, targetId: string): string | undefined {
  const block = index.blocksById.get(targetId)
  if (block) return block.contentHash
  const doc = index.byId.get(targetId)
  if (doc) return computeContentHash(doc.body)
  return undefined
}

/** ブロックおよび所属文書から伸びる上流参照 (derives / satisfies / verifies) の現在ハッシュを収集する */
function collectUpstreamHashes(index: DocsIndex, block: SemanticBlock): Record<string, string> {
  const hashes: Record<string, string> = {}
  for (const edge of index.edges) {
    if (!UPSTREAM_EDGE_KINDS.has(edge.kind)) continue
    if (edge.from !== block.id && edge.from !== block.docId) continue
    const h = currentTargetHash(index, edge.to)
    if (h) hashes[edge.to] = h
  }
  return hashes
}

/**
 * DocsIndex に guard/reviews.json の承認状態・確認メモ・Suspect Links を適用する。
 */
export function applyReviewsAndSuspects(index: DocsIndex, reviews: ReviewsFile): void {
  // 1. 孤立レビューレコード検出
  for (const id of Object.keys(reviews.blocks)) {
    if (!index.blocksById.has(id)) {
      index.issues.push({
        code: 'orphan-review',
        message: `reviews.json references non-existent block ID "${id}"`,
        path: REVIEWS_REL_PATH,
        blockId: id,
      })
    }
  }

  // 2. 各ブロックに review / 承認メタデータを反映
  for (const block of index.blocksById.values()) {
    const rec = reviews.blocks[block.id]
    if (!rec) continue

    block.approvedAt = rec.approvedAt
    block.approvedBy = rec.approvedBy
    block.approvedCommit = rec.approvedCommit
    block.approvedNote = rec.note

    if (rec.hash) {
      block.review = rec.hash === block.contentHash ? 'approved' : 'stale'
    } else {
      block.review = 'unreviewed'
    }
  }

  // 3. Suspect Links 判定:
  //    (a) 承認時に記録した上流ハッシュと現在の上流ハッシュを比較
  //    (b) 承認済みブロックの上流ブロック自身が stale / suspect の場合も波及
  //    (b) は多段依存でもブロックの走査順に依存しないよう、変化がなくなるまで固定点反復する
  let changed = true
  while (changed) {
    changed = false
    for (const block of index.blocksById.values()) {
      if (block.review !== 'approved') continue
      const rec = reviews.blocks[block.id]
      const sources = new Set<string>()

      if (rec?.upstreamHashes) {
        for (const [upId, savedHash] of Object.entries(rec.upstreamHashes)) {
          const nowHash = currentTargetHash(index, upId)
          if (!nowHash || nowHash !== savedHash) {
            sources.add(upId)
          }
        }
      }

      for (const edge of index.edges) {
        if (!UPSTREAM_EDGE_KINDS.has(edge.kind)) continue
        if (edge.from !== block.id && edge.from !== block.docId) continue
        const upBlock = index.blocksById.get(edge.to)
        if (upBlock && (upBlock.review === 'stale' || upBlock.suspect)) {
          sources.add(upBlock.id)
        }
      }

      if (sources.size === 0) continue
      const sorted = [...sources].toSorted()
      if (!block.suspect || block.suspectSources?.join('\n') !== sorted.join('\n')) {
        block.suspect = true
        block.suspectSources = sorted
        changed = true
      }
    }
  }
}

/** ブロックを承認し guard/reviews.json とローカルキャッシュを更新する */
export async function approveBlock(
  docsDir: string,
  index: DocsIndex,
  blockId: string,
  options: { author?: string; note?: string; cacheRoot?: string } = {},
): Promise<Result<BlockReviewRecord, ReviewDomainError>> {
  const block = index.blocksById.get(blockId)
  if (!block) {
    return Result.err(new BlockNotFoundError({ blockId, message: `Block not found: ${blockId}` }))
  }
  const doc = index.byId.get(block.docId)
  if (!doc) {
    return Result.err(
      new DocumentNotFoundError({ docId: block.docId, message: `Owner document not found: ${block.docId}` }),
    )
  }

  const upstreamHashes = collectUpstreamHashes(index, block)
  const note = options.note?.trim() || undefined
  const approvedBy = options.author?.trim() || getGitUserName(docsDir)

  const record: BlockReviewRecord = {
    docPath: doc.path,
    hash: block.contentHash,
    approvedCommit: getGitHeadShortSha(docsDir),
    approvedAt: new Date().toISOString(),
    ...(approvedBy ? { approvedBy } : {}),
    ...(note ? { note } : {}),
    upstreamHashes: Object.keys(upstreamHashes).length > 0 ? upstreamHashes : undefined,
  }

  await withReviewLock(async () => {
    const reviews = await loadReviews(docsDir, [])
    reviews.blocks[blockId] = record
    await saveReviews(docsDir, reviews)
    await writeBodyCache(docsDir, blockId, block.rawBody, options.cacheRoot)
  })
  return Result.ok(record)
}

/**
 * ブロックの承認を取り消し未承認 (unreviewed) へ戻す。
 * 承認レコードとローカルスナップショットキャッシュを綺麗に削除する。
 */
export async function unapproveBlock(
  docsDir: string,
  index: DocsIndex,
  blockId: string,
  options: { cacheRoot?: string } = {},
): Promise<Result<{ removed: boolean }, BlockNotFoundError>> {
  const block = index.blocksById.get(blockId)
  if (!block) {
    return Result.err(new BlockNotFoundError({ blockId, message: `Block not found: ${blockId}` }))
  }

  const removed = await withReviewLock(async () => {
    const reviews = await loadReviews(docsDir, [])
    const prev = reviews.blocks[blockId]
    if (!prev || !prev.hash) return false

    delete reviews.blocks[blockId]
    await saveReviews(docsDir, reviews)
    await removeBodyCache(docsDir, blockId, options.cacheRoot)
    return true
  })
  return Result.ok({ removed })
}

/** Git コミットから指定ブロックの本文を取り出す */
function readBlockFromGitCommit(docsDir: string, commit: string, docPath: string, blockId: string): string | undefined {
  const content = readFileAtGitCommit(docsDir, commit, docPath)
  if (content === undefined) return undefined

  const format = docPath.toLowerCase().endsWith('.mdx') ? 'mdx' : 'markdown'
  const docId = docPath.replace(/\.(mdx|md)$/i, '')
  const fm = splitFrontmatter(content)
  if (fm.isErr()) return undefined
  const extracted = extractMdxArtifacts(fm.value.body, format, docId)
  return extracted.blocks.find((b) => b.id === blockId)?.rawBody
}

/** 承認時点の本文 (Git またはローカルキャッシュ) と現在の本文の行 diff を算出する */
export async function getBlockDiff(
  docsDir: string,
  index: DocsIndex,
  blockId: string,
  options: { cacheRoot?: string } = {},
): Promise<Result<BlockDiffResult, BlockNotFoundError>> {
  const block = index.blocksById.get(blockId)
  if (!block) {
    return Result.err(new BlockNotFoundError({ blockId, message: `Block not found: ${blockId}` }))
  }

  const reviews = await loadReviews(docsDir, [])
  const rec = reviews.blocks[blockId]
  if (!rec || !rec.hash) {
    return Result.ok({ blockId, baseSource: 'none', changed: false, lines: [] })
  }

  if (rec.approvedCommit && rec.docPath) {
    const fromGit = readBlockFromGitCommit(docsDir, rec.approvedCommit, rec.docPath, blockId)
    if (fromGit !== undefined && computeContentHash(fromGit) === rec.hash) {
      const lines = computeLineDiff(fromGit, block.rawBody)
      return Result.ok({
        blockId,
        baseSource: 'git',
        baseCommit: rec.approvedCommit,
        changed: lines.some((l) => l.type !== 'context'),
        lines,
      })
    }
  }

  const cache = await readBodyCache(docsDir, options.cacheRoot)
  const fromCache = cache[blockId]
  if (typeof fromCache === 'string') {
    const lines = computeLineDiff(fromCache, block.rawBody)
    return Result.ok({
      blockId,
      baseSource: 'cache',
      ...(rec.approvedCommit ? { baseCommit: rec.approvedCommit } : {}),
      changed: lines.some((l) => l.type !== 'context'),
      lines,
    })
  }

  return Result.ok({
    blockId,
    baseSource: 'none',
    ...(rec.approvedCommit ? { baseCommit: rec.approvedCommit } : {}),
    changed: rec.hash !== block.contentHash,
    lines: [],
  })
}

/** Myers アルゴリズム (`diff` パッケージ) による行単位 diff を計算する */
export function computeLineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, '\n').split('\n')
  const b = after.replace(/\r\n/g, '\n').split('\n')
  const lines: DiffLine[] = []
  for (const part of diffArrays(a, b)) {
    const type: DiffLine['type'] = part.added ? 'add' : part.removed ? 'del' : 'context'
    for (const text of part.value) {
      lines.push({ type, text })
    }
  }
  return lines
}
