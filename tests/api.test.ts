import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stringify } from 'yaml'
import { Hono } from 'hono'
import { loadDocuments } from '../src/core/loader'
import { createApp } from '../src/server/app'
import type { DocsIndex } from '../src/core/types'

let root: string
let index: DocsIndex
let app: Hono

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'documi-api-test-'))
  const write = async (rel: string, fm: Record<string, unknown>, body = '# Body\n') => {
    const file = path.join(root, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `---\n${stringify(fm)}---\n\n${body}`)
  }
  await write('glossary.mdx', { title: '用語集', description: 'desc' }, '# Glossary body\n')
  await write(
    'requirements/00001-req.md',
    { type: 'requirement', title: 'Req One', description: 'first', status: 'accepted' },
    '# Req body\n\nSome **markdown** content.\n',
  )
  await write('requirements/00002-req2.md', {
    type: 'requirement',
    title: 'Req Two',
    description: 'second',
    status: 'draft',
  })
  await write(
    'designs/00001-design.md',
    {
      type: 'design',
      title: 'Design One',
      description: 'd',
      status: 'accepted',
      relations: { requirement: ['00001', '00002'] },
    },
    '# Design body\n',
  )
  // 壊れた文書 (必須フィールド欠落)
  await write('goals/00001-broken.md', { type: 'goal', description: 'no title' })

  index = await loadDocuments(root)
  app = createApp(index)
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

  test('GET /api/documents はサマリ一覧を返す', async () => {
    const res = await app.fetch(new Request('http://localhost/api/documents'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { documents: { ref: string; title: string; issueCount: number }[] }
    expect(body.documents.map((d) => d.ref)).toEqual(['requirement:00001', 'requirement:00002', 'design:00001'])
    expect(body.documents[0]).not.toHaveProperty('body')
  })

  test('GET /api/documents?type= で絞り込める', async () => {
    const res = await app.fetch(new Request('http://localhost/api/documents?type=requirement'))
    const body = (await res.json()) as { documents: { type: string }[] }
    expect(body.documents).toHaveLength(2)
    expect(body.documents.every((d) => d.type === 'requirement')).toBe(true)
  })

  test('GET /api/documents/:type/:id で詳細を返す', async () => {
    const res = await app.fetch(new Request('http://localhost/api/documents/requirement/00001'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      document: { body: string; relations: unknown[]; incomingRelations: { ref: string }[] }
    }
    expect(body.document.body).toContain('markdown')
    expect(body.document.incomingRelations.map((r) => r.ref)).toEqual(['design:00001'])
  })

  test('存在しない・不正なドキュメントは 404 / 400', async () => {
    expect((await app.fetch(new Request('http://localhost/api/documents/requirement/99999'))).status).toBe(404)
    expect((await app.fetch(new Request('http://localhost/api/documents/bogus/00001'))).status).toBe(400)
    expect((await app.fetch(new Request('http://localhost/api/documents/requirement/abc'))).status).toBe(400)
    expect((await app.fetch(new Request('http://localhost/api/documents?type=bogus'))).status).toBe(400)
  })

  test('GET /api/glossary', async () => {
    const res = await app.fetch(new Request('http://localhost/api/glossary'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { glossary: { title: string; body: string } }
    expect(body.glossary.title).toBe('用語集')
    expect(body.glossary.body).toContain('Glossary body')
  })

  test('GET /api/status は問題一覧を返す', async () => {
    const res = await app.fetch(new Request('http://localhost/api/status'))
    const body = (await res.json()) as { documentCount: number; issues: { path?: string; code: string }[] }
    expect(body.documentCount).toBe(3)
    expect(body.issues.some((i) => i.path?.includes('00001-broken'))).toBe(true)
  })
})

describe('MCP endpoint', () => {
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

  test('initialize が成功する', async () => {
    const res = await app.fetch(
      mcpRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.1' },
        },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result?: { serverInfo?: { name: string } } }
    expect(body.result?.serverInfo?.name).toBe('documi')
  })

  test('tools/list が4つのツールを返す', async () => {
    const res = await app.fetch(mcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result?: { tools: { name: string }[] } }
    expect(body.result?.tools.map((t) => t.name).sort()).toEqual([
      'get_document',
      'get_glossary',
      'get_relations',
      'list_documents',
    ])
  })

  test('tools/call list_documents', async () => {
    const res = await app.fetch(
      mcpRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_documents', arguments: { type: 'requirement' } },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result?: { structuredContent?: { documents: { ref: string }[]; count: number } }
    }
    const content = body.result?.structuredContent
    expect(content?.count).toBe(2)
    expect(content?.documents.map((d) => d.ref)).toEqual(['requirement:00001', 'requirement:00002'])
  })

  test('tools/call get_document は本文と relations を返す', async () => {
    const res = await app.fetch(
      mcpRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_document', arguments: { type: 'design', id: '00001' } },
      }),
    )
    const body = (await res.json()) as {
      result?: { structuredContent?: { body: string; incomingRelations: unknown[]; relations: { ref: string }[] } }
    }
    const doc = body.result?.structuredContent
    expect(doc?.body).toContain('Design body')
    expect(doc?.relations.map((r) => r.ref).sort()).toEqual(['requirement:00001', 'requirement:00002'])
  })

  test('tools/call get_relations は outgoing/incoming を返す', async () => {
    const res = await app.fetch(
      mcpRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'get_relations', arguments: { type: 'requirement', id: '00001' } },
      }),
    )
    const body = (await res.json()) as {
      result?: { structuredContent?: { outgoing: unknown[]; incoming: { ref: string }[] } }
    }
    const rel = body.result?.structuredContent
    expect(rel?.outgoing).toHaveLength(0)
    expect(rel?.incoming.map((r) => r.ref)).toEqual(['design:00001'])
  })

  test('tools/call get_glossary', async () => {
    const res = await app.fetch(
      mcpRequest({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_glossary', arguments: {} } }),
    )
    const body = (await res.json()) as { result?: { structuredContent?: { title: string; body: string } } }
    expect(body.result?.structuredContent?.title).toBe('用語集')
    expect(body.result?.structuredContent?.body).toContain('Glossary body')
  })

  test('存在しないドキュメントは isError を返す', async () => {
    const res = await app.fetch(
      mcpRequest({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'get_document', arguments: { type: 'goal', id: '99999' } },
      }),
    )
    const body = (await res.json()) as { result?: { isError?: boolean } }
    expect(body.result?.isError).toBe(true)
  })
})
