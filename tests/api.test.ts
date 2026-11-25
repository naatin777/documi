import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { hc } from 'hono/client'
import { stringify } from 'yaml'
import { createApp, type ApiRoutes } from '../src/server/app'
import { DocsStore } from '../src/server/store'

let root: string
let store: DocsStore
let app: Hono

async function writeDoc(rel: string, fm: Record<string, unknown>, body = '# Body\n'): Promise<void> {
  const file = path.join(root, rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `---\n${stringify(fm)}---\n\n${body}`)
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'documi-api-test-'))
  await writeDoc('goals/core.mdx', { title: 'Core Goal', description: 'プロジェクト目的' }, '# Core Goal\n')
  await writeDoc(
    'domain/glossary.mdx',
    { title: '用語集', description: '共通言語' },
    '<TermDef id="Artifact" aliases="成果物" symbols="src/core/types.ts#Document">管理対象文書</TermDef>\n',
  )
  await writeDoc(
    'specs/auth/lockout.mdx',
    { title: 'Lockout Spec', description: 'ロック仕様', derives: ['goals/core'] },
    '<Spec id="auth.lockout" stability="stable">5回失敗でロック</Spec>\n',
  )
  await writeDoc(
    'specs/orphan.mdx',
    { title: 'Orphan Spec', description: '孤立仕様' },
    '<Spec id="orphan.item">Goal未接続</Spec>\n',
  )
  await writeDoc('designs/auth.mdx', { title: 'Auth Design', satisfies: ['auth.lockout'] }, '# Auth Design\n')
  await writeDoc(
    'decisions/bun.mdx',
    { title: 'Bun 採用' },
    '<Outcome id="dec.bun">Bun を採用する。</Outcome>\n\n詳細な比較メモ。\n',
  )

  store = await DocsStore.open(root, { projectRoot: root })
  app = createApp(store)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('REST API', () => {
  test('GET /api/health', async () => {
    const res = await app.fetch(new Request('http://localhost/api/health'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('GET /api/overview は統計・Goals・Outcomes・Orphan Specs を返す', async () => {
    const res = await app.fetch(new Request('http://localhost/api/overview'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      documentCount: number
      termCount: number
      goals: { id: string }[]
      outcomes: { id: string }[]
      orphanSpecs: { blockId?: string }[]
    }
    expect(body.documentCount).toBe(6)
    expect(body.termCount).toBe(1)
    expect(body.goals.map((g) => g.id)).toEqual(['goals/core'])
    expect(body.outcomes.map((o) => o.id)).toEqual(['dec.bun'])
    expect(body.orphanSpecs.map((o) => o.blockId)).toEqual(['orphan.item'])
  })

  test('GET /api/tree は階層ツリーとドキュメント一覧を返す', async () => {
    const res = await app.fetch(new Request('http://localhost/api/tree'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { tree: { kind: string; name: string }[]; documents: { id: string }[] }
    expect(body.documents).toHaveLength(6)
    expect(body.tree.some((n) => n.kind === 'dir' && n.name === 'specs')).toBe(true)
  })

  test('GET /api/documents/* で多階層パス ID の詳細を返す', async () => {
    const res = await app.fetch(new Request('http://localhost/api/documents/specs/auth/lockout'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      document: { id: string; blocks: { id: string }[]; incoming: { docId: string; kind: string }[] }
    }
    expect(body.document.id).toBe('specs/auth/lockout')
    expect(body.document.blocks.map((b) => b.id)).toEqual(['auth.lockout'])
    expect(body.document.incoming.some((r) => r.docId === 'designs/auth' && r.kind === 'satisfies')).toBe(true)
  })

  test('存在しない・不正なパスは 404 / 400', async () => {
    expect((await app.fetch(new Request('http://localhost/api/documents/no/such/doc'))).status).toBe(404)
    expect((await app.fetch(new Request('http://localhost/api/documents?type=bogus'))).status).toBe(400)
  })

  test('GET /api/graph と /api/terms', async () => {
    const graphRes = await app.fetch(new Request('http://localhost/api/graph?layers=trace'))
    expect(graphRes.status).toBe(200)
    const graph = (await graphRes.json()) as { granularity: string; nodes: unknown[]; edges: { kind: string }[] }
    expect(graph.granularity).toBe('docs')
    expect(graph.nodes).toHaveLength(6)
    expect(graph.edges.every((e) => e.kind !== 'mentions')).toBe(true)

    const blocksGraphRes = await app.fetch(new Request('http://localhost/api/graph?layers=all&granularity=blocks'))
    expect(blocksGraphRes.status).toBe(200)
    const blocksGraph = (await blocksGraphRes.json()) as {
      granularity: string
      nodes: { kind: string }[]
      edges: { kind: string }[]
    }
    expect(blocksGraph.granularity).toBe('blocks')
    expect(blocksGraph.nodes.some((n) => n.kind === 'block')).toBe(true)
    expect(blocksGraph.edges.some((e) => e.kind === 'contains')).toBe(true)

    const termsRes = await app.fetch(new Request('http://localhost/api/terms'))
    expect(termsRes.status).toBe(200)
    const terms = (await termsRes.json()) as { terms: { id: string; aliases: string[] }[] }
    expect(terms.terms).toHaveLength(1)
    expect(terms.terms[0]?.id).toBe('Artifact')
  })

  test('DocsStore.reload でファイル追加が即座に API へ反映される', async () => {
    await writeDoc('guides/added.mdx', { title: 'Added Guide' })
    await store.reload()

    const res = await app.fetch(new Request('http://localhost/api/documents/guides/added'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { document: { title: string } }
    expect(body.document.title).toBe('Added Guide')
  })

  test('POST /api/export/pdf は html を検証する', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/export/pdf', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    )
    expect(res.status).toBe(400)
  })

  test('ブロックの承認・一括承認・確認メモ・Diff・承認取り消し API が動作する', async () => {
    // 承認 (確認メモ付き)
    const approveRes = await app.fetch(
      new Request('http://localhost/api/blocks/auth.lockout/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: 'reviewer', note: '境界条件を確認済み' }),
      }),
    )
    expect(approveRes.status).toBe(200)
    const approved = (await approveRes.json()) as {
      block: { review: string; approvedBy: string; approvedNote?: string }
    }
    expect(approved.block.review).toBe('approved')
    expect(approved.block.approvedBy).toBe('reviewer')
    expect(approved.block.approvedNote).toBe('境界条件を確認済み')

    // 一括承認 API (最終確認 URL 向け)
    const batchRes = await app.fetch(
      new Request('http://localhost/api/blocks/approve-batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: ['dec.bun', 'Artifact'], author: 'reviewer', note: 'クイズ合意' }),
      }),
    )
    expect(batchRes.status).toBe(200)
    const batchBody = (await batchRes.json()) as { approvedIds: string[]; count: number }
    expect(batchBody.count).toBe(2)
    expect(batchBody.approvedIds).toEqual(['dec.bun', 'Artifact'])

    // 本文変更後の Diff API
    await writeDoc(
      'specs/auth/lockout.mdx',
      { title: 'Lockout Spec', description: 'ロック仕様', derives: ['goals/core'] },
      '<Spec id="auth.lockout" stability="stable">3回失敗でロック</Spec>\n',
    )
    await store.reload()
    const diffRes = await app.fetch(new Request('http://localhost/api/blocks/auth.lockout/diff'))
    expect(diffRes.status).toBe(200)
    const diffBody = (await diffRes.json()) as { changed: boolean; lines: { type: string; text: string }[] }
    expect(diffBody.changed).toBe(true)
    expect(diffBody.lines.some((l) => l.type === 'add' && l.text.includes('3回失敗'))).toBe(true)

    // GET /api/blocks に Markdown 描画用メタデータと確認メモが含まれる
    const blocksRes = await app.fetch(new Request('http://localhost/api/blocks'))
    expect(blocksRes.status).toBe(200)
    const blocksJson = (await blocksRes.json()) as {
      blocks: Array<{ id: string; docFormat: string; docDir: string; approvedNote?: string }>
    }
    const lockoutSummary = blocksJson.blocks.find((b) => b.id === 'auth.lockout')
    expect(lockoutSummary?.docFormat).toBe('mdx')
    expect(lockoutSummary?.docDir).toBe('specs/auth')
    const bunSummary = blocksJson.blocks.find((b) => b.id === 'dec.bun')
    expect(bunSummary?.approvedNote).toBe('クイズ合意')

    // 承認取り消し API (DELETE /api/blocks/:id/approve) で unreviewed に戻る
    const unapproveRes = await app.fetch(
      new Request('http://localhost/api/blocks/auth.lockout/approve', { method: 'DELETE' }),
    )
    expect(unapproveRes.status).toBe(200)
    const unapproved = (await unapproveRes.json()) as {
      block: { review: string; stability: string; approvedNote?: string }
    }
    expect(unapproved.block.review).toBe('unreviewed')
    expect(unapproved.block.stability).toBe('stable')
    expect(unapproved.block.approvedNote).toBeUndefined()
  })

  test('Hono RPC (hc<ApiRoutes>) と Zod バリデーションが型安全に動作する', async () => {
    const client = hc<ApiRoutes>('http://localhost', {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init)),
    })

    const overviewRes = await client.api.overview.$get()
    expect(overviewRes.status).toBe(200)
    const overview = await overviewRes.json()
    expect(overview.documentCount).toBe(6)
    expect(overview.goals.map((g) => g.id)).toEqual(['goals/core'])

    const docRes = await client.api.documents[':id{.+}'].$get({ param: { id: 'specs/auth/lockout' } })
    expect(docRes.status).toBe(200)
    if (docRes.status === 200) {
      const docBody = await docRes.json()
      expect(docBody.document.id).toBe('specs/auth/lockout')
    }

    // Zod バリデーションエラーは JSON { error } で 400 を返す
    const invalidSource = await app.fetch(new Request('http://localhost/api/source?file=src/a.ts'))
    expect(invalidSource.status).toBe(400)
    const sourceErr = (await invalidSource.json()) as { error?: string }
    expect(sourceErr.error).toContain('symbol')

    const malformedJson = await app.fetch(
      new Request('http://localhost/api/blocks/approve-batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{invalid-json',
      }),
    )
    expect(malformedJson.status).toBe(400)
    const jsonErr = (await malformedJson.json()) as { error?: string }
    expect(typeof jsonErr.error).toBe('string')
  })
})

function mcpRequest(body: unknown): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  })
}

describe('MCP endpoint', () => {
  test('tools/list が全 14 ツールを返す', async () => {
    const res = await app.fetch(mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result?: { tools: { name: string }[] } }
    expect(body.result?.tools.map((t) => t.name).toSorted()).toEqual([
      'add_block',
      'get_document',
      'get_project_map',
      'get_relations',
      'get_spec_context',
      'list_documents',
      'query_specs',
      'rename_block_id',
      'retrieve_context',
      'scaffold_document',
      'search_documents',
      'update_block',
      'upsert_term',
      'validate_docs',
    ])
  })

  test('get_project_map は Goal・Decision Outcome・Terms をまとめて返す', async () => {
    const res = await app.fetch(
      mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_project_map', arguments: {} } }),
    )
    const body = (await res.json()) as {
      result?: {
        structuredContent?: { goals: { id: string }[]; decisionOutcomes: { id: string }[]; terms: { id: string }[] }
      }
    }
    const content = body.result?.structuredContent
    expect(content?.goals.map((g) => g.id)).toEqual(['goals/core'])
    expect(content?.decisionOutcomes.map((o) => o.id)).toEqual(['dec.bun'])
    expect(content?.terms.map((t) => t.id)).toEqual(['Artifact'])
  })

  test('query_specs と get_spec_context が動作する', async () => {
    const qRes = await app.fetch(
      mcpRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'query_specs', arguments: { kind: 'spec', stability: 'stable' } },
      }),
    )
    const qBody = (await qRes.json()) as { result?: { structuredContent?: { blocks: { id: string }[] } } }
    expect(qBody.result?.structuredContent?.blocks.map((b) => b.id)).toEqual(['auth.lockout'])

    const cRes = await app.fetch(
      mcpRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_spec_context', arguments: { id: 'auth.lockout' } },
      }),
    )
    const cBody = (await cRes.json()) as {
      result?: { structuredContent?: { upstreamGoals: { id: string }[]; relatedDocuments: { id: string }[] } }
    }
    expect(cBody.result?.structuredContent?.upstreamGoals.map((g) => g.id)).toEqual(['goals/core'])
    expect(cBody.result?.structuredContent?.relatedDocuments.some((d) => d.id === 'designs/auth')).toBe(true)
  })

  test('validate_docs は orphan-spec 等の問題を返す', async () => {
    const res = await app.fetch(
      mcpRequest({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'validate_docs', arguments: {} } }),
    )
    const body = (await res.json()) as {
      result?: { structuredContent?: { ok: boolean; docIssues: { code: string; blockId?: string }[] } }
    }
    expect(body.result?.structuredContent?.ok).toBe(false)
    expect(
      body.result?.structuredContent?.docIssues.some((i) => i.code === 'orphan-spec' && i.blockId === 'orphan.item'),
    ).toBe(true)
  })
})
