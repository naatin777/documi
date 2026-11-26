import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Result } from 'better-result'
import { stringify } from 'yaml'
import { runCli } from '../src/cli'
import { createEmbeddingProvider, formatEmbeddingPrompt, normalizeVector } from '../src/core/embeddings'
import type { EmbeddingProvider } from '../src/core/embeddings'
import { EmbeddingRequestError } from '../src/core/errors'
import { retrieveContextHybrid, searchIndexHybrid } from '../src/core/hybrid-retrieval'
import { loadDocuments } from '../src/core/loader'
import { DEFAULT_EMBEDDINGS_CACHE_REL, syncVectorIndex } from '../src/core/vector-store'
import { DocsStore } from '../src/server/store'

let projectDir: string
let docsDir: string

function toConceptVector(text: string): Float32Array {
  const low = text.toLowerCase()
  const v: [number, number, number, number] = [0.05, 0.05, 0.05, 0.05]
  // 概念 0: 認証・不正ログイン・アカウント凍結（語彙が一切重ならなくても近いベクトルになる）
  if (/(lockout|password|auth|ログイン|認証|凍結|乗っ取り|不正侵入|パスワード)/.test(low)) v[0] += 1
  // 概念 1: 課金・決済・請求
  if (/(billing|invoice|stripe|課金|請求|決済|支払い)/.test(low)) v[1] += 1
  // 概念 2: 検索・RAG・Embedding
  if (/(search|bm25|embedding|rag|検索|ベクトル)/.test(low)) v[2] += 1
  // 概念 3: UI・レイアウト・テーマ
  if (/(theme|dark|sidebar|ui|レイアウト|ダークモード)/.test(low)) v[3] += 1
  return normalizeVector(v)
}

/**
 * テスト用の決定論的な概念ベクトルプロバイダ（外部ネットワーク・モデルDL不要）。
 * [auth/security, billing/payment, search/rag, ui/layout] の 4 次元概念空間に射影する。
 */
function createConceptMockProvider(id = 'mock:concept-v1'): {
  provider: EmbeddingProvider
  embedDocCalls: number
  embedQueryCalls: number
} {
  const state = { embedDocCalls: 0, embedQueryCalls: 0 }

  const provider: EmbeddingProvider = {
    id,
    provider: 'ollama',
    model: 'mock-concept',
    async embedDocuments(items) {
      state.embedDocCalls += items.length
      return Result.ok(items.map((i) => toConceptVector(`${i.title}\n${i.text}`)))
    },
    async embedQuery(query) {
      state.embedQueryCalls++
      return Result.ok(toConceptVector(query))
    },
  }

  return {
    provider,
    get embedDocCalls() {
      return state.embedDocCalls
    },
    get embedQueryCalls() {
      return state.embedQueryCalls
    },
  }
}

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), 'documi-hybrid-rag-'))
  docsDir = path.join(projectDir, 'docs')

  const writeDoc = async (rel: string, fm: Record<string, unknown>, body: string) => {
    const file = path.join(docsDir, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `---\n${stringify(fm).trim()}\n---\n\n${body}`)
  }
  const writeSrc = async (rel: string, content: string) => {
    const file = path.join(projectDir, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }

  await writeDoc(
    'goals/security.mdx',
    { type: 'goal', title: 'Security Goal', description: 'Protect user accounts from brute-force attacks' },
    '# Security Goal\n',
  )
  await writeDoc(
    'specs/auth.mdx',
    { type: 'spec', title: 'Password Lockout Spec', derives: ['goals/security'] },
    [
      '# Password Lockout Spec',
      '',
      '<Spec id="auth.lockout" stability="stable">',
      '  **When** a user enters an invalid password 5 times in a row,',
      '  **the** system **shall** trigger lockout for 15 minutes.',
      '</Spec>',
      '',
    ].join('\n'),
  )
  await writeDoc(
    'specs/billing.mdx',
    { type: 'spec', title: 'Invoice Billing Spec', derives: ['goals/security'] },
    [
      '# Invoice Billing Spec',
      '',
      '<Spec id="billing.invoice" stability="evolving">',
      '  **When** a monthly subscription renews,',
      '  **the** billing engine **shall** issue a Stripe invoice.',
      '</Spec>',
      '',
    ].join('\n'),
  )
  await writeDoc(
    'designs/auth.mdx',
    { type: 'design', title: 'Auth Design', satisfies: ['auth.lockout'] },
    '# Auth Design\n\n<SourceRef file="src/auth.ts" symbol="lockAccount" satisfies="auth.lockout" />\n',
  )
  await writeSrc('src/auth.ts', '// @implements auth.lockout\nexport function lockAccount() { return true }\n')
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

describe('Local Hybrid RAG (bun:sqlite + RRF + Providers)', () => {
  test('[core.hybrid-rag] bun:sqlite キャッシュが contentHash 差分で増分更新・未変更スキップ・削除掃除を行う', async () => {
    const mock = createConceptMockProvider()
    const index1 = await loadDocuments(docsDir)

    // 初回は全チャンク (4 docs + 2 blocks = 6) を埋め込み
    const first = (await syncVectorIndex(docsDir, index1, mock.provider)).unwrap()
    expect(first.totalChunks).toBe(6)
    expect(first.embedded).toBe(6)
    expect(first.cached).toBe(0)
    expect(first.removed).toBe(0)
    expect(existsSync(path.join(docsDir, DEFAULT_EMBEDDINGS_CACHE_REL))).toBe(true)

    // 2 回目（変更なし）はすべてキャッシュヒット（0 件再埋め込み）
    const second = (await syncVectorIndex(docsDir, index1, mock.provider)).unwrap()
    expect(second.embedded).toBe(0)
    expect(second.cached).toBe(6)
    expect(mock.embedDocCalls).toBe(6)

    // 1 つのブロックだけ編集 → 該当ブロック＋親文書の 2 チャンクのみ再埋め込み
    await writeFile(
      path.join(docsDir, 'specs/billing.mdx'),
      [
        '---',
        'type: spec',
        'title: Invoice Billing Spec',
        'derives:',
        '  - goals/security',
        '---',
        '',
        '# Invoice Billing Spec',
        '',
        '<Spec id="billing.invoice" stability="evolving">',
        '  **When** a monthly subscription renews,',
        '  **the** billing engine **shall** issue a Stripe invoice with tax breakdown.',
        '</Spec>',
        '',
      ].join('\n'),
    )
    const index2 = await loadDocuments(docsDir)
    const third = (await syncVectorIndex(docsDir, index2, mock.provider)).unwrap()
    expect(third.embedded).toBe(2)
    expect(third.cached).toBe(4)

    // ドキュメント削除 → 古いベクトル行が掃除される
    await rm(path.join(docsDir, 'specs/billing.mdx'))
    const index3 = await loadDocuments(docsDir)
    const fourth = (await syncVectorIndex(docsDir, index3, mock.provider)).unwrap()
    expect(fourth.totalChunks).toBe(4)
    expect(fourth.embedded).toBe(0)
    expect(fourth.removed).toBe(2)
  })

  test('[core.hybrid-rag] 語彙が一切重ならない日本語クエリでも RRF ハイブリッド検索＋グラフ展開で英語仕様と SourceRef を引ける', async () => {
    const mock = createConceptMockProvider()
    const store = await DocsStore.open(docsDir, { projectRoot: projectDir })

    // 本文は英語 ("invalid password ... lockout") のみだが、「不正侵入による乗っ取り防止」という語彙ゼロ一致の日本語クエリで引ける
    const res = await retrieveContextHybrid(docsDir, store.getIndex(), '不正侵入による乗っ取り防止', {
      provider: mock.provider,
      limit: 4,
      budget: 5000,
    })

    expect(res.mode).toBe('hybrid+graph')
    expect(res.modelId).toBe('mock:concept-v1')
    expect(res.hits.some((h) => h.id === 'auth.lockout')).toBe(true)
    expect(res.upstreamGoals.map((g) => g.id)).toContain('goals/security')
    expect(res.sourceRefs.some((r) => r.file === 'src/auth.ts')).toBe(true)

    // プロバイダ障害時は BM25 へ安全にフォールバックする
    const failingProvider: EmbeddingProvider = {
      id: 'mock:fail',
      provider: 'ollama',
      model: 'broken',
      async embedDocuments() {
        return Result.err(
          new EmbeddingRequestError({ provider: 'ollama', model: 'broken', message: 'connection refused' }),
        )
      },
      async embedQuery() {
        return Result.err(
          new EmbeddingRequestError({ provider: 'ollama', model: 'broken', message: 'connection refused' }),
        )
      },
    }
    const fallback = await searchIndexHybrid(docsDir, store.getIndex(), 'Stripe invoice', {
      provider: failingProvider,
    })
    expect(fallback.mode).toBe('bm25')
    expect(fallback.fallbackReason).toContain('connection refused')
    expect(fallback.hits.some((h) => h.id === 'billing.invoice')).toBe(true)
  })

  test('[core.hybrid-rag] モデル別プロンプト接頭辞（EmbeddingGemma / Qwen3 / ruri-v3）および Ollama / OpenAI HTTP プロバイダと CLI 引数検証が動作する', async () => {
    // EmbeddingGemma 公式プロンプト形式
    expect(formatEmbeddingPrompt('embeddinggemma', 'query', 'auth rules')).toBe(
      'task: search result | query: auth rules',
    )
    expect(formatEmbeddingPrompt('embeddinggemma', 'document', 'body text', 'Auth')).toBe(
      'title: Auth | text: body text',
    )
    expect(formatEmbeddingPrompt('ruri-v3-130m', 'query', '認証')).toBe('検索クエリ: 認証')
    expect(formatEmbeddingPrompt('qwen3-embedding:0.6b', 'query', 'auth')).toContain('Instruct:')

    // Ollama プロバイダ (/api/embed)
    let capturedOllamaUrl = ''
    const ollamaProvider = createEmbeddingProvider(
      { provider: 'ollama', model: 'embeddinggemma', endpoint: 'http://127.0.0.1:11434' },
      {
        fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
          capturedOllamaUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
          const rawBody = typeof init?.body === 'string' ? init.body : '{}'
          const body = JSON.parse(rawBody) as { input: string[] }
          return new Response(JSON.stringify({ embeddings: body.input.map(() => [3, 4]) }), { status: 200 })
        }) as unknown as typeof fetch,
      },
    )
    const ollamaVecs = (await ollamaProvider.embedDocuments([{ title: 'T', text: 'hello' }])).unwrap()
    expect(capturedOllamaUrl).toBe('http://127.0.0.1:11434/api/embed')
    expect(ollamaVecs[0]![0]).toBeCloseTo(0.6, 5)
    expect(ollamaVecs[0]![1]).toBeCloseTo(0.8, 5)

    // OpenAI 互換 HTTP プロバイダ (/embeddings)
    let capturedOpenAiUrl = ''
    const openaiProvider = createEmbeddingProvider(
      { provider: 'openai', model: 'text-embedding-3-small', endpoint: 'http://127.0.0.1:8000/v1' },
      {
        fetchFn: (async (url: string | URL | Request) => {
          capturedOpenAiUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
          return new Response(
            JSON.stringify({
              data: [
                { index: 1, embedding: [0, 1] },
                { index: 0, embedding: [1, 0] },
              ],
            }),
            { status: 200 },
          )
        }) as unknown as typeof fetch,
      },
    )
    const openaiVecs = (
      await openaiProvider.embedDocuments([
        { title: 'A', text: 'a' },
        { title: 'B', text: 'b' },
      ])
    ).unwrap()
    expect(capturedOpenAiUrl).toBe('http://127.0.0.1:8000/v1/embeddings')
    expect(openaiVecs[0]![0]).toBeCloseTo(1, 5)
    expect(openaiVecs[1]![1]).toBeCloseTo(1, 5)

    // CLI 引数バリデーション (--semantic と --no-semantic の同時指定や不正 --provider を拒否)
    const errs: string[] = []
    const badCode = await runCli(['retrieve', 'auth', '--project', projectDir, '--semantic', '--no-semantic'], {
      out: () => {},
      err: (l) => errs.push(l),
      readStdin: async () => '',
    })
    expect(badCode).toBe(1)
    expect(errs.join('\n')).toContain('--semantic and --no-semantic cannot be used together')

    const badProviderErrs: string[] = []
    const badProviderCode = await runCli(['index', '--project', projectDir, '--provider', 'unknown'], {
      out: () => {},
      err: (l) => badProviderErrs.push(l),
      readStdin: async () => '',
    })
    expect(badProviderCode).toBe(1)
    expect(badProviderErrs.join('\n')).toContain('Invalid --provider')
  })
})
