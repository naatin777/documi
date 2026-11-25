import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { Result } from 'better-result'
import { dotProduct } from './embeddings'
import type { EmbeddingProvider } from './embeddings'
import type { EmbeddingDomainError } from './errors'
import type { ArtifactType, DocsIndex } from './types'

export const DEFAULT_EMBEDDINGS_CACHE_REL = path.join('.documi', 'cache', 'embeddings.sqlite')

interface EmbeddingChunk {
  key: string
  kind: 'doc' | 'block'
  id: string
  docId: string
  type: ArtifactType
  title: string
  text: string
  contentHash: string
}

export interface SyncVectorIndexResult {
  dbPath: string
  modelId: string
  provider: string
  model: string
  totalChunks: number
  embedded: number
  cached: number
  removed: number
}

interface VectorSearchHit {
  key: string
  score: number
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * DocsIndex からセマンティックチャンク（各ブロック＋各ドキュメント概要/本文）と決定論的な `contentHash` を抽出する。
 * ブロックや文書の変更検知に `contentHash` を使うことで、未変更チャンクの再埋め込みを完全にスキップできる。
 */
function extractEmbeddingChunks(index: DocsIndex, typeFilter?: ArtifactType): EmbeddingChunk[] {
  const chunks: EmbeddingChunk[] = []

  for (const doc of index.documents) {
    if (typeFilter && doc.type !== typeFilter) continue

    const docText = [doc.description, doc.tags.length > 0 ? `tags: ${doc.tags.join(', ')}` : '', doc.body]
      .filter(Boolean)
      .join('\n')
      .slice(0, 4000)

    chunks.push({
      key: `doc:${doc.id}`,
      kind: 'doc',
      id: doc.id,
      docId: doc.id,
      type: doc.type,
      title: doc.title,
      text: docText || doc.title,
      contentHash: sha256(`doc|${doc.title}|${docText}`),
    })

    for (const block of doc.blocks) {
      const blockTitle = block.title ? `${block.id} — ${block.title}` : block.id
      const aliasLine = block.aliases && block.aliases.length > 0 ? `aliases: ${block.aliases.join(', ')}` : ''
      const blockText = [aliasLine, block.rawBody].filter(Boolean).join('\n').slice(0, 3000)

      chunks.push({
        key: `block:${block.id}`,
        kind: 'block',
        id: block.id,
        docId: doc.id,
        type: doc.type,
        title: blockTitle,
        text: blockText || blockTitle,
        contentHash: sha256(`block|${blockTitle}|${blockText}`),
      })
    }
  }

  return chunks
}

function resolveCacheDbPath(docsDir: string, cachePath?: string, projectRoot?: string): string {
  if (cachePath?.trim()) {
    return path.isAbsolute(cachePath) ? cachePath : path.resolve(projectRoot ?? path.dirname(docsDir), cachePath)
  }
  return path.join(path.resolve(projectRoot ?? docsDir), DEFAULT_EMBEDDINGS_CACHE_REL)
}

async function openVectorDb(dbPath: string): Promise<Database> {
  await mkdir(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS embeddings (
      chunk_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (chunk_key, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings (model_id);
  `)
  return db
}

function float32ToBytes(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
}

function bytesToFloat32(bytes: Uint8Array, dim: number): Float32Array {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Float32Array(copy.buffer, 0, dim)
}

/**
 * `bun:sqlite` 上のローカルベクトルキャッシュを `contentHash` 差分で同期する。
 * 変更されたチャンクのみをバッチで Embedding 生成し、未変更チャンクはキャッシュを再利用する。
 * @implements core.hybrid-rag
 */
export async function syncVectorIndex(
  docsDir: string,
  index: DocsIndex,
  provider: EmbeddingProvider,
  options: { cachePath?: string; projectRoot?: string; batchSize?: number } = {},
): Promise<Result<SyncVectorIndexResult, EmbeddingDomainError>> {
  const dbPath = resolveCacheDbPath(docsDir, options.cachePath, options.projectRoot)
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 16, 64))
  const chunks = extractEmbeddingChunks(index)

  const db = await openVectorDb(dbPath)
  try {
    const existingRows = db
      .query<{ chunk_key: string; content_hash: string }, [string]>(
        'SELECT chunk_key, content_hash FROM embeddings WHERE model_id = ?',
      )
      .all(provider.id)

    const existingHashes = new Map<string, string>()
    for (const row of existingRows) {
      existingHashes.set(row.chunk_key, row.content_hash)
    }

    const currentKeys = new Set<string>()
    const toEmbed: EmbeddingChunk[] = []
    let cached = 0

    for (const chunk of chunks) {
      currentKeys.add(chunk.key)
      if (existingHashes.get(chunk.key) === chunk.contentHash) {
        cached++
      } else {
        toEmbed.push(chunk)
      }
    }

    const toRemove: string[] = []
    for (const oldKey of existingHashes.keys()) {
      if (!currentKeys.has(oldKey)) toRemove.push(oldKey)
    }

    if (toRemove.length > 0) {
      const delStmt = db.prepare('DELETE FROM embeddings WHERE model_id = ? AND chunk_key = ?')
      const deleteTx = db.transaction((keys: string[]) => {
        for (const k of keys) delStmt.run(provider.id, k)
      })
      deleteTx(toRemove)
    }

    let embedded = 0
    if (toEmbed.length > 0) {
      const upsertStmt = db.prepare(`
        INSERT INTO embeddings (chunk_key, model_id, content_hash, dim, vector, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(chunk_key, model_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          dim = excluded.dim,
          vector = excluded.vector,
          updated_at = excluded.updated_at
      `)

      for (let i = 0; i < toEmbed.length; i += batchSize) {
        const batch = toEmbed.slice(i, i + batchSize)
        const vectorsRes = await provider.embedDocuments(batch.map((c) => ({ title: c.title, text: c.text })))
        if (vectorsRes.isErr()) return vectorsRes
        const vectors = vectorsRes.value
        const now = new Date().toISOString()
        const upsertTx = db.transaction(() => {
          for (let j = 0; j < batch.length; j++) {
            const chunk = batch[j]!
            const vec = vectors[j]!
            upsertStmt.run(chunk.key, provider.id, chunk.contentHash, vec.length, float32ToBytes(vec), now)
            embedded++
          }
        })
        upsertTx()
      }
    }

    return Result.ok({
      dbPath,
      modelId: provider.id,
      provider: provider.provider,
      model: provider.model,
      totalChunks: chunks.length,
      embedded,
      cached,
      removed: toRemove.length,
    })
  } finally {
    db.close()
  }
}

/**
 * `bun:sqlite` キャッシュからクエリベクトルとのコサイン類似度上位を検索する。
 * 既定では検索前に `contentHash` 差分のみ自動同期する（未変更時は 0ms で通過）。
 * @implements core.hybrid-rag
 */
export async function searchVectorStore(
  docsDir: string,
  index: DocsIndex,
  provider: EmbeddingProvider,
  query: string,
  options: { type?: ArtifactType; limit?: number; cachePath?: string; projectRoot?: string; sync?: boolean } = {},
): Promise<Result<VectorSearchHit[], EmbeddingDomainError>> {
  const cleanQuery = query.trim()
  if (!cleanQuery) return Result.ok([])

  const dbPath = resolveCacheDbPath(docsDir, options.cachePath, options.projectRoot)
  if (options.sync !== false) {
    const syncRes = await syncVectorIndex(docsDir, index, provider, {
      cachePath: options.cachePath,
      projectRoot: options.projectRoot,
    })
    if (syncRes.isErr()) return syncRes
  }

  const allowedKeys = options.type ? new Set(extractEmbeddingChunks(index, options.type).map((c) => c.key)) : undefined

  const queryVecRes = await provider.embedQuery(cleanQuery)
  if (queryVecRes.isErr()) return queryVecRes
  const queryVec = queryVecRes.value
  const db = await openVectorDb(dbPath)
  try {
    const rows = db
      .query<{ chunk_key: string; dim: number; vector: Uint8Array }, [string]>(
        'SELECT chunk_key, dim, vector FROM embeddings WHERE model_id = ?',
      )
      .all(provider.id)

    const scored: VectorSearchHit[] = []
    for (const row of rows) {
      if (allowedKeys && !allowedKeys.has(row.chunk_key)) continue
      if (row.dim !== queryVec.length) continue
      const vec = bytesToFloat32(row.vector, row.dim)
      const sim = dotProduct(queryVec, vec)
      if (Number.isFinite(sim)) {
        scored.push({ key: row.chunk_key, score: sim })
      }
    }

    scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    return Result.ok(scored.slice(0, options.limit ?? 30))
  } finally {
    db.close()
  }
}
