import { getDocument } from './loader'
import type { ArtifactType, DocsIndex, SemanticBlock } from './types'

export interface SearchHit {
  kind: 'doc' | 'block'
  id: string
  docId: string
  type: ArtifactType
  title: string
  blockKind?: SemanticBlock['kind']
  snippet: string
  score: number
}

const JP_STOPWORDS = new Set([
  'の',
  'を',
  'に',
  'は',
  'が',
  'で',
  'と',
  'て',
  'た',
  'だ',
  'な',
  'も',
  'や',
  'へ',
  'し',
  'する',
  'した',
  'して',
  'され',
  'される',
  'です',
  'ます',
  'こと',
  'もの',
  'ため',
  'よう',
  'ある',
  'いる',
  'なる',
  'から',
  'まで',
  'など',
  'どう',
  'なに',
  'どこ',
  'いつ',
  'これ',
  'それ',
  'あれ',
  'この',
  'その',
  'あの',
  'とき',
  '場合',
  'ついて',
  'において',
  'における',
  'および',
  'または',
  'あるいは',
])

const EN_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'from',
  'by',
  'with',
  'and',
  'or',
  'not',
  'as',
  'if',
  'it',
  'this',
  'that',
  'how',
  'what',
  'when',
  'where',
  'why',
  'do',
  'does',
  'did',
  'can',
  'should',
  'shall',
  'will',
  'would',
])

const JA_SEGMENTER = new Intl.Segmenter('ja', { granularity: 'word' })
const CJK_OR_KANA_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBFー]+/g
const HIRAGANA_ONLY_RE = /^[\u3040-\u309F]+$/
const KANJI_ONLY_RE = /^[\u4E00-\u9FFF\u3400-\u4DBF]+$/
const IDENT_RE = /[A-Za-z0-9][A-Za-z0-9._/-]*/g

/**
 * 日本語（`Intl.Segmenter` による単語分割）および英語・コード識別子（camelCase / kebab-case / dot.id）を
 * 外部形態素解析器なしで高精度に分解する軽量トークナイザ。
 */
export function tokenizeForSearch(raw: string): string[] {
  const normalized = raw.normalize('NFKC')
  const tokens: string[] = []

  // 1. 英数字・コード識別子（camelCase / dot / hyphen / slash も展開）
  for (const match of normalized.matchAll(IDENT_RE)) {
    const token = match[0]
    const low = token.toLowerCase()
    if (low.length >= 2 && !EN_STOPWORDS.has(low)) {
      tokens.push(low)
    }
    const camelSplit = token.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
    const parts = camelSplit.split(/[._/\-\s]+/).filter((p) => p.length >= 2 && !EN_STOPWORDS.has(p))
    if (parts.length > 1) {
      for (const p of parts) tokens.push(p)
    }
  }

  // 2. 日本語・CJK 文字列（Intl.Segmenter で複合カタカナや送り仮名付き和語を自然な単語へ分割）
  for (const match of normalized.matchAll(CJK_OR_KANA_RE)) {
    for (const part of JA_SEGMENTER.segment(match[0])) {
      if (!part.isWordLike) continue
      const seg = part.segment.replace(/^ー+|ー+$/g, '')
      if (!seg || JP_STOPWORDS.has(seg)) continue
      if (seg.length === 1 && HIRAGANA_ONLY_RE.test(seg)) continue
      tokens.push(seg)

      // 分割されなかった 4 文字以上の長い漢字複合語のみ 2-gram で部分一致を補助
      if (seg.length >= 4 && KANJI_ONLY_RE.test(seg)) {
        for (let i = 0; i < seg.length - 1; i++) {
          const bg = seg.slice(i, i + 2)
          if (!JP_STOPWORDS.has(bg)) tokens.push(bg)
        }
      }
    }
  }

  return tokens
}

/**
 * 用語集 (`<TermDef id="..." aliases="...">`) を使って検索クエリの同義語・別名を自動展開する。
 */
export function expandQueryWithGlossary(
  index: DocsIndex,
  rawQuery: string,
): {
  baseTokens: string[]
  expandedTerms: string[]
  expandedTokens: string[]
} {
  const normalizedQuery = rawQuery.normalize('NFKC').toLowerCase()
  const baseTokens = [...new Set(tokenizeForSearch(rawQuery))]
  const baseTokenSet = new Set(baseTokens)
  const expandedTermSet = new Set<string>()

  for (const block of index.blocksById.values()) {
    if (block.kind !== 'term') continue
    const variants = [block.id, ...block.aliases].map((v) => v.trim()).filter(Boolean)
    if (variants.length < 2) continue

    const matched = variants.some((v) => {
      const low = v.normalize('NFKC').toLowerCase()
      return (low.length >= 2 && normalizedQuery.includes(low)) || baseTokenSet.has(low)
    })
    if (!matched) continue

    for (const v of variants) {
      const low = v.normalize('NFKC').toLowerCase()
      if (!normalizedQuery.includes(low)) {
        expandedTermSet.add(v)
      }
    }
  }

  const expandedTerms = [...expandedTermSet]
  const expandedTokens = [...new Set(expandedTerms.flatMap((t) => tokenizeForSearch(t)))].filter(
    (t) => !baseTokenSet.has(t),
  )

  return { baseTokens, expandedTerms, expandedTokens }
}

/**
 * 複数のランキングリストを Reciprocal Rank Fusion (RRF) で統合する。
 * BM25 と将来のローカル Embedding 検索を安全に合成するための共通プリミティブ。
 */
export function reciprocalRankFusion(
  rankings: ReadonlyArray<ReadonlyArray<{ key: string; score?: number }>>,
  k = 60,
): Map<string, number> {
  const fused = new Map<string, number>()
  for (const list of rankings) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank]!
      fused.set(item.key, (fused.get(item.key) ?? 0) + 1 / (k + rank + 1))
    }
  }
  return fused
}

interface CorpusEntry {
  key: string
  kind: 'doc' | 'block'
  id: string
  docId: string
  type: ArtifactType
  title: string
  blockKind?: SemanticBlock['kind']
  /** フィールドごとのトークン頻度 */
  fieldFreqs: Array<{ weight: number; tf: Map<string, number>; len: number }>
  /** 正確一致・スニペット用の生テキスト */
  rawExactTexts: Array<{ weight: number; text: string }>
  snippetSources: string[]
  allTokens: Set<string>
}

function countFreqs(tokens: readonly string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1)
  }
  return tf
}

function extractBestSnippet(sources: readonly string[], needles: readonly string[]): string {
  const flats = sources.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (flats.length === 0) return ''

  const cleanNeedles = [...new Set(needles.map((n) => n.normalize('NFKC').toLowerCase()).filter((n) => n.length >= 2))]
  if (cleanNeedles.length === 0) {
    const first = flats[0]!
    return first.length > 140 ? `${first.slice(0, 139)}…` : first
  }

  for (const requireAll of [true, false]) {
    for (const flat of flats) {
      const low = flat.normalize('NFKC').toLowerCase()
      const matched = requireAll
        ? cleanNeedles.every((t) => low.includes(t))
        : cleanNeedles.some((t) => low.includes(t))
      if (!matched) continue

      let bestIdx = -1
      let bestLen = 0
      for (const t of cleanNeedles) {
        const idx = low.indexOf(t)
        if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
          bestIdx = idx
          bestLen = t.length
        }
      }
      if (bestIdx >= 0) {
        const start = Math.max(0, bestIdx - 40)
        const end = Math.min(flat.length, bestIdx + bestLen + 96)
        const prefix = start > 0 ? '…' : ''
        const suffix = end < flat.length ? '…' : ''
        return `${prefix}${flat.slice(start, end)}${suffix}`
      }
    }
  }

  const fallback = flats[0]!
  return fallback.length > 140 ? `${fallback.slice(0, 139)}…` : fallback
}

function buildCorpusEntries(index: DocsIndex, typeFilter?: ArtifactType): CorpusEntry[] {
  const entries: CorpusEntry[] = []

  for (const doc of index.documents) {
    if (typeFilter && doc.type !== typeFilter) continue

    const docFields = [
      { weight: 4.0, tokens: tokenizeForSearch(doc.title) },
      { weight: 3.5, tokens: tokenizeForSearch(doc.id) },
      { weight: 2.5, tokens: tokenizeForSearch(doc.tags.join(' ')) },
      { weight: 2.0, tokens: tokenizeForSearch(doc.description) },
      { weight: 1.2, tokens: tokenizeForSearch(doc.body) },
    ]
    const docAll = new Set<string>()
    for (const f of docFields) {
      for (const t of f.tokens) docAll.add(t)
    }
    entries.push({
      key: `doc:${doc.id}`,
      kind: 'doc',
      id: doc.id,
      docId: doc.id,
      type: doc.type,
      title: doc.title,
      fieldFreqs: docFields.map((f) => ({ weight: f.weight, tf: countFreqs(f.tokens), len: f.tokens.length })),
      rawExactTexts: [
        { weight: 10, text: doc.title.normalize('NFKC').toLowerCase() },
        { weight: 9, text: doc.id.normalize('NFKC').toLowerCase() },
        { weight: 6, text: doc.tags.join(' ').normalize('NFKC').toLowerCase() },
        { weight: 5, text: doc.description.normalize('NFKC').toLowerCase() },
        { weight: 2.5, text: doc.body.normalize('NFKC').toLowerCase() },
      ],
      snippetSources: [doc.description, doc.body],
      allTokens: docAll,
    })

    for (const block of doc.blocks) {
      const aliasText = block.kind === 'term' ? block.aliases.join(' ') : ''
      const bFields = [
        { weight: 5.5, tokens: tokenizeForSearch(block.id) },
        { weight: 4.5, tokens: tokenizeForSearch(aliasText) },
        { weight: 3.2, tokens: tokenizeForSearch(block.title ?? '') },
        { weight: 1.6, tokens: tokenizeForSearch(block.rawBody) },
      ]
      const bAll = new Set<string>()
      for (const f of bFields) {
        for (const t of f.tokens) bAll.add(t)
      }
      entries.push({
        key: `block:${block.id}`,
        kind: 'block',
        id: block.id,
        docId: doc.id,
        type: doc.type,
        title: block.title ? `${block.id} — ${block.title}` : block.id,
        blockKind: block.kind,
        fieldFreqs: bFields.map((f) => ({ weight: f.weight, tf: countFreqs(f.tokens), len: f.tokens.length })),
        rawExactTexts: [
          { weight: 14, text: block.id.normalize('NFKC').toLowerCase() },
          { weight: 10, text: aliasText.normalize('NFKC').toLowerCase() },
          { weight: 8, text: (block.title ?? '').normalize('NFKC').toLowerCase() },
          { weight: 3.5, text: block.rawBody.normalize('NFKC').toLowerCase() },
        ],
        snippetSources: [block.rawBody],
        allTokens: bAll,
      })
    }
  }

  return entries
}

/**
 * BM25（日英＋コード識別子トークナイザ）＋ `<TermDef aliases>` 同義語展開による全文検索。
 * `searchIndex`・Web UI (`Cmd+K`)・CLI (`documi search`)・MCP (`search_documents`) の共通エンジン。
 * @implements core.full-text-search
 * @implements core.graph-retrieval
 */
export function searchIndexBm25(
  index: DocsIndex,
  rawQuery: string,
  options: { type?: ArtifactType; limit?: number } = {},
): { hits: SearchHit[]; expandedTerms: string[] } {
  const query = rawQuery.trim()
  if (!query) return { hits: [], expandedTerms: [] }

  const { baseTokens, expandedTerms, expandedTokens } = expandQueryWithGlossary(index, query)
  const rawPhrases = query
    .normalize('NFKC')
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p.length >= 1)

  if (baseTokens.length === 0 && rawPhrases.length === 0) {
    return { hits: [], expandedTerms }
  }

  const entries = buildCorpusEntries(index, options.type)
  if (entries.length === 0) return { hits: [], expandedTerms }

  // コーパス全体の Document Frequency とフィールド平均長を算出
  const N = entries.length
  const df = new Map<string, number>()
  const fieldTotals: number[] = []
  const fieldCounts: number[] = []

  for (const e of entries) {
    for (const t of e.allTokens) {
      df.set(t, (df.get(t) ?? 0) + 1)
    }
    for (let i = 0; i < e.fieldFreqs.length; i++) {
      fieldTotals[i] = (fieldTotals[i] ?? 0) + e.fieldFreqs[i]!.len
      fieldCounts[i] = (fieldCounts[i] ?? 0) + 1
    }
  }

  const avgFieldLens = fieldTotals.map((sum, i) => Math.max(1, sum / Math.max(1, fieldCounts[i] ?? 1)))
  const k1 = 1.2
  const b = 0.75

  const idf = (term: string): number => {
    const freq = df.get(term) ?? 0
    return Math.log(1 + (N - freq + 0.5) / (freq + 0.5))
  }

  const weightedQueryTerms: Array<{ term: string; boost: number; isBase: boolean }> = [
    ...baseTokens.map((term) => ({ term, boost: 1.0, isBase: true })),
    ...expandedTokens.map((term) => ({ term, boost: 0.65, isBase: false })),
  ]

  const queryLow = query.normalize('NFKC').toLowerCase()
  const snippetNeedles = [...rawPhrases, ...baseTokens, ...expandedTerms]
  const scored: SearchHit[] = []

  for (const entry of entries) {
    let bm25Score = 0
    let matchedBaseCount = 0
    let matchedExpandedCount = 0

    for (const qt of weightedQueryTerms) {
      const termIdf = idf(qt.term)
      let termHit = false
      for (let i = 0; i < entry.fieldFreqs.length; i++) {
        const field = entry.fieldFreqs[i]!
        const tf = field.tf.get(qt.term)
        if (!tf) continue
        termHit = true
        const dl = field.len
        const avgdl = avgFieldLens[i] ?? 1
        const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgdl))
        bm25Score += field.weight * termIdf * tfNorm * qt.boost
      }
      if (termHit) {
        if (qt.isBase) matchedBaseCount++
        else matchedExpandedCount++
      }
    }

    // 生フレーズ / 正確な ID 一致に対するブースト（記号・英数字 ID・短いキーワードの精度を保証）
    let exactBoost = 0
    let matchedAllPhrases = rawPhrases.length > 0
    for (const phrase of rawPhrases) {
      let bestForPhrase = 0
      for (const rawField of entry.rawExactTexts) {
        if (!rawField.text) continue
        if (rawField.text === phrase) {
          bestForPhrase = Math.max(bestForPhrase, rawField.weight * 2.2)
        } else if (rawField.text.includes(phrase)) {
          bestForPhrase = Math.max(bestForPhrase, rawField.weight)
        }
      }
      if (bestForPhrase === 0) matchedAllPhrases = false
      exactBoost += bestForPhrase
    }

    // 展開された用語フレーズがそのまま含まれる場合も加点
    for (const expTerm of expandedTerms) {
      const lowExp = expTerm.normalize('NFKC').toLowerCase()
      for (const rawField of entry.rawExactTexts) {
        if (rawField.text.includes(lowExp)) {
          exactBoost += rawField.weight * 0.55
          matchedExpandedCount++
          break
        }
      }
    }

    if (queryLow.length >= 3 && entry.rawExactTexts.some((r) => r.text.includes(queryLow))) {
      exactBoost += 4
    }

    if (bm25Score === 0 && exactBoost === 0) continue

    // 複数トークンのクエリでは、より多くのベース概念を網羅している候補を優先する
    const coverageRatio = baseTokens.length > 0 ? matchedBaseCount / baseTokens.length : matchedAllPhrases ? 1 : 0.5
    const coverageMultiplier = 0.55 + 0.75 * coverageRatio + (matchedAllPhrases ? 0.35 : 0)
    const blockTieBreak = entry.kind === 'block' ? 0.5 : 0
    const finalScore = Math.round(((bm25Score + exactBoost) * coverageMultiplier + blockTieBreak) * 100) / 100

    if (finalScore <= 0 && matchedExpandedCount === 0) continue

    scored.push({
      kind: entry.kind,
      id: entry.id,
      docId: entry.docId,
      type: entry.type,
      title: entry.title,
      ...(entry.blockKind ? { blockKind: entry.blockKind } : {}),
      snippet: extractBestSnippet(entry.snippetSources, snippetNeedles),
      score: finalScore,
    })
  }

  scored.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id))
  return {
    hits: scored.slice(0, options.limit ?? 30),
    expandedTerms,
  }
}

export interface RetrieveContextOptions {
  type?: ArtifactType
  /** 指定マウント ID のヒットのみに絞り込む（グラフ展開は全体グラフから関連 Goal / Contract を辿る） */
  mount?: string
  limit?: number
  /** 返却ペイロードの文字数予算（既定: 6000、範囲: 500〜40000） */
  budget?: number
  /** グラフ近傍（上流 Goal・<Decision>・関連文書・用語・SourceRef）を展開するか（既定: true） */
  includeGraph?: boolean
}

interface RetrievedHitItem {
  kind: 'doc' | 'block'
  id: string
  docId: string
  docPath: string
  type: ArtifactType
  title: string
  blockKind?: SemanticBlock['kind']
  startLine?: number
  endLine?: number
  review?: string
  realizationStatus?: string
  score: number
  excerpt: string
}

export interface RetrieveContextResult {
  query: string
  mode: 'bm25+graph' | 'bm25' | 'hybrid+graph' | 'hybrid'
  modelId?: string
  fallbackReason?: string
  expandedTerms: string[]
  hits: RetrievedHitItem[]
  upstreamGoals: Array<{ id: string; title: string; description: string }>
  decisions: Array<{ id: string; docId: string; date?: string; body: string }>
  relatedDocuments: Array<{ id: string; type: ArtifactType; title: string; description: string; relation: string }>
  relevantTerms: Array<{ id: string; aliases: string[]; symbols: string[]; definition: string }>
  sourceRefs: Array<{ file: string; symbol?: string; lines?: string; fromDocId: string }>
  budgetUsed: number
  budgetLimit: number
}

function summarize(raw: string, maxChars: number): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, maxChars - 1)}…`
}

/**
 * ランキング済みの一次ヒット群から、重複排除・明示グラフ展開・文字数予算パッキングを行って RetrieveContextResult を組み立てる。
 * BM25 単体 (`retrieveContext`) と Hybrid RRF (`retrieveContextHybrid`) の双方が共通利用する。
 */
export function assembleGraphContext(
  index: DocsIndex,
  query: string,
  rawHits: readonly SearchHit[],
  expandedTerms: string[],
  options: {
    limit?: number
    budget?: number
    includeGraph?: boolean
    mode?: RetrieveContextResult['mode']
    modelId?: string
    fallbackReason?: string
  } = {},
): RetrieveContextResult {
  const limit = Math.max(1, Math.min(options.limit ?? 8, 30))
  const budgetLimit = Math.max(500, Math.min(options.budget ?? 6000, 40000))
  const includeGraph = options.includeGraph !== false
  const mode = options.mode ?? (includeGraph ? 'bm25+graph' : 'bm25')

  let budgetUsed = 0
  const tryConsume = (text: string): boolean => {
    const cost = text.length
    if (budgetUsed > 0 && budgetUsed + cost > budgetLimit) return false
    budgetUsed += cost
    return true
  }

  // 1. 一次ヒット（Spec / Block / Doc）を予算内で詰める（同一文書のブロックが既に上位ヒットしている場合、重複する親文書ヒットを省いて枠を有効活用）
  const hits: RetrievedHitItem[] = []
  const seedNodeIds = new Set<string>()
  const seedDocIds = new Set<string>()
  const blockHitDocIds = new Set<string>()

  for (const hit of rawHits) {
    if (hits.length >= limit) break
    if (hit.kind === 'doc' && blockHitDocIds.has(hit.docId)) continue
    const doc = getDocument(index, hit.docId)
    if (!doc) continue
    const block = hit.kind === 'block' ? index.blocksById.get(hit.id) : undefined
    const excerpt = block ? summarize(block.rawBody, 420) : hit.snippet || summarize(doc.description || doc.body, 260)

    const item: RetrievedHitItem = {
      kind: hit.kind,
      id: hit.id,
      docId: doc.id,
      docPath: doc.path,
      type: doc.type,
      title: hit.title,
      ...(block ? { blockKind: block.kind, startLine: block.startLine, endLine: block.endLine } : {}),
      ...(block ? { review: block.review } : {}),
      ...(block?.realization ? { realizationStatus: block.realization.status } : {}),
      score: hit.score,
      excerpt,
    }
    if (!tryConsume(`${item.id} ${item.title} ${item.excerpt}`)) break
    hits.push(item)
    seedNodeIds.add(hit.id)
    seedNodeIds.add(doc.id)
    seedDocIds.add(doc.id)
    if (hit.kind === 'block') blockHitDocIds.add(doc.id)
  }

  const upstreamGoals: RetrieveContextResult['upstreamGoals'] = []
  const decisions: RetrieveContextResult['decisions'] = []
  const relatedDocuments: RetrieveContextResult['relatedDocuments'] = []
  const relevantTerms: RetrieveContextResult['relevantTerms'] = []
  const sourceRefs: RetrieveContextResult['sourceRefs'] = []

  if (!includeGraph || hits.length === 0) {
    return {
      query,
      mode,
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(options.fallbackReason ? { fallbackReason: options.fallbackReason } : {}),
      expandedTerms,
      hits,
      upstreamGoals,
      decisions,
      relatedDocuments,
      relevantTerms,
      sourceRefs,
      budgetUsed,
      budgetLimit,
    }
  }

  // 2. 上流 Goal を derives 辺から再帰収集
  const queue = [...seedNodeIds]
  const visited = new Set<string>()
  const seenGoalIds = new Set<string>()
  while (queue.length > 0) {
    const cur = queue.shift()!
    if (visited.has(cur)) continue
    visited.add(cur)
    for (const e of index.edges) {
      if (e.kind !== 'derives' || e.from !== cur) continue
      const targetDoc = index.byId.get(e.toDocId)
      if (targetDoc?.type === 'goal' && !seenGoalIds.has(targetDoc.id)) {
        seenGoalIds.add(targetDoc.id)
        const desc = summarize(targetDoc.description || targetDoc.body, 180)
        if (tryConsume(`${targetDoc.id} ${targetDoc.title} ${desc}`)) {
          upstreamGoals.push({ id: targetDoc.id, title: targetDoc.title, description: desc })
        }
      }
      queue.push(e.to, e.toDocId)
    }
  }

  // 3. 1-hop 関連ドキュメント（Decision / Contract / Design / Verification 等）を収集
  const relatedByDocId = new Map<string, string>()
  for (const e of index.edges) {
    if (seedNodeIds.has(e.from) || seedDocIds.has(e.fromDocId)) {
      if (!seedDocIds.has(e.toDocId) && !relatedByDocId.has(e.toDocId)) {
        relatedByDocId.set(e.toDocId, e.kind)
      }
    }
    if (seedNodeIds.has(e.to) || seedDocIds.has(e.toDocId)) {
      if (!seedDocIds.has(e.fromDocId) && !relatedByDocId.has(e.fromDocId)) {
        relatedByDocId.set(e.fromDocId, e.kind)
      }
    }
  }

  // 3a. 関連 Decision（独立 ADR および設計/仕様内のインラインマイクロ ADR）の現行 <Decision> 結論を優先収録（廃止済みは除外）
  const seenDecisionIds = new Set<string>()
  for (const docId of [...seedDocIds, ...relatedByDocId.keys()]) {
    const d = index.byId.get(docId)
    if (!d) continue
    for (const b of d.blocks) {
      if (b.kind !== 'decision' || seenDecisionIds.has(b.id)) continue
      if (b.supersededBy && b.supersededBy.length > 0) continue
      seenDecisionIds.add(b.id)
      const body = summarize(b.summary ?? b.chosen ?? b.rawBody, 240)
      if (!tryConsume(`${b.id} ${body}`)) break
      const date = b.date ?? d.date
      decisions.push({
        id: b.id,
        docId: d.id,
        ...(date ? { date } : {}),
        body,
      })
    }
  }

  // 3b. 関連ドキュメント（Goal 以外、Contract / Design / Spec 優先）
  const typePriority: Record<ArtifactType, number> = {
    contract: 1,
    design: 2,
    spec: 3,
    decision: 4,
    domain: 5,
    guide: 6,
    goal: 7,
  }
  const sortedRelated = [...relatedByDocId.entries()]
    .map(([docId, relation]) => ({ doc: index.byId.get(docId), relation }))
    .filter((x): x is { doc: NonNullable<typeof x.doc>; relation: string } => Boolean(x.doc && x.doc.type !== 'goal'))
    .toSorted((a, b) => typePriority[a.doc.type] - typePriority[b.doc.type] || a.doc.id.localeCompare(b.doc.id))

  for (const { doc, relation } of sortedRelated) {
    const desc = summarize(doc.description, 140)
    if (!tryConsume(`${doc.id} ${doc.title} ${desc}`)) break
    relatedDocuments.push({
      id: doc.id,
      type: doc.type,
      title: doc.title,
      description: desc,
      relation,
    })
    if (relatedDocuments.length >= 10) break
  }

  // 4. 関連用語（クエリ・ヒット文書本文に出現する <TermDef>）
  const combinedHay = [query, ...hits.map((h) => `${h.id} ${h.title} ${h.excerpt}`)]
    .join('\n')
    .normalize('NFKC')
    .toLowerCase()

  for (const b of index.blocksById.values()) {
    if (b.kind !== 'term') continue
    const variants = [b.id, ...b.aliases].map((v) => v.normalize('NFKC').toLowerCase()).filter(Boolean)
    if (!variants.some((v) => v.length >= 2 && combinedHay.includes(v))) continue
    const definition = summarize(b.rawBody, 160)
    if (!tryConsume(`${b.id} ${definition}`)) break
    relevantTerms.push({
      id: b.id,
      aliases: b.aliases,
      symbols: b.symbols,
      definition,
    })
    if (relevantTerms.length >= 8) break
  }

  // 5. 関連 <SourceRef>（一次ヒット文書＋関連 Design/Contract）および実装コードアンカー
  const seenRefs = new Set<string>()
  const pushRef = (file: string, fromDocId: string, symbol?: string, lines?: string) => {
    const key = `${file}|${symbol ?? ''}|${lines ?? ''}`
    if (seenRefs.has(key)) return
    seenRefs.add(key)
    if (!tryConsume(`${file}#${symbol ?? ''}`)) return
    sourceRefs.push({
      file,
      ...(symbol ? { symbol } : {}),
      ...(lines ? { lines } : {}),
      fromDocId,
    })
  }

  for (const hit of hits) {
    const block = hit.kind === 'block' ? index.blocksById.get(hit.id) : undefined
    if (block?.realization) {
      for (const impl of block.realization.implementations.slice(0, 3)) {
        pushRef(impl.file, hit.docId, undefined, String(impl.line))
      }
    }
    const doc = index.byId.get(hit.docId)
    if (doc) {
      for (const ref of doc.sourceRefs) {
        pushRef(
          ref.file,
          doc.id,
          ref.mode === 'symbol' ? ref.symbol : undefined,
          ref.mode === 'lines' ? ref.lines : undefined,
        )
      }
    }
  }
  for (const rel of relatedDocuments.slice(0, 4)) {
    const doc = index.byId.get(rel.id)
    if (!doc) continue
    for (const ref of doc.sourceRefs) {
      pushRef(
        ref.file,
        doc.id,
        ref.mode === 'symbol' ? ref.symbol : undefined,
        ref.mode === 'lines' ? ref.lines : undefined,
      )
      if (sourceRefs.length >= 16) break
    }
    if (sourceRefs.length >= 16) break
  }

  return {
    query,
    mode,
    ...(options.modelId ? { modelId: options.modelId } : {}),
    ...(options.fallbackReason ? { fallbackReason: options.fallbackReason } : {}),
    expandedTerms,
    hits,
    upstreamGoals,
    decisions,
    relatedDocuments,
    relevantTerms,
    sourceRefs,
    budgetUsed,
    budgetLimit,
  }
}

/**
 * 自然文の質問・タスク記述から、BM25 + 用語集同義語展開 + 明示グラフ展開（Goal / Decision Outcome / Contract / Design / 用語 / SourceRef）を
 * トークン（文字数）予算内にパックして 1 発で返す Graph-aware Retrieval。
 * CLI (`documi search --context`) および MCP (`search_documents` with `includeContext: true`) が共通利用する。
 * @implements core.graph-retrieval
 */
export function retrieveContext(
  index: DocsIndex,
  rawQuery: string,
  options: RetrieveContextOptions = {},
): RetrieveContextResult {
  const query = rawQuery.trim()
  const limit = Math.max(1, Math.min(options.limit ?? 8, 30))
  const includeGraph = options.includeGraph !== false

  const mount = options.mount?.trim() || undefined
  const { hits: rawHits, expandedTerms } = searchIndexBm25(index, query, {
    type: options.type,
    limit: mount ? Math.max(limit * 4, 80) : Math.min(limit * 2 + 4, 60),
  })
  const filteredHits = mount ? rawHits.filter((h) => index.byId.get(h.docId)?.mountId === mount) : rawHits

  return assembleGraphContext(index, query, filteredHits, expandedTerms, {
    limit,
    budget: options.budget,
    includeGraph,
    mode: includeGraph ? 'bm25+graph' : 'bm25',
  })
}
