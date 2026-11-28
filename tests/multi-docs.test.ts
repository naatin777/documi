import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../src/cli'
import { runDocsCheck } from '../src/core/checker'
import { resolveProjectPaths } from '../src/core/config'
import { loadDocuments } from '../src/core/loader'
import { approveBlock } from '../src/core/reviews'

const tempDirs: string[] = []

async function makeMonorepo(files: Record<string, string | Uint8Array>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'documi-monorepo-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content)
  }
  return root
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('Multi-docs Monorepo Mounts & --mount (core.project-config)', () => {
  test('[core.project-config] 複数 docs マウント・クロスリンク・マウント別 reviews.json・複数 testReport・--mount が統合動作する', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const root = await makeMonorepo({
      '.documi.json': JSON.stringify(
        {
          docs: [
            { id: 'root', path: 'docs', label: 'Root' },
            { id: 'web', path: 'apps/web/docs', label: 'Web App' },
            { id: 'api', path: 'packages/api/docs', label: 'API' },
          ],
          testReport: ['apps/web/junit.xml', 'packages/api/junit.xml'],
        },
        null,
        2,
      ),
      'docs/goals/product.mdx': `---\ntype: goal\ntitle: Product Goal\n---\n\n# Product Goal\n`,
      'apps/web/docs/specs/auth.mdx': `---\ntitle: Web Auth Spec\n---\n\n# Web Auth Spec\n\n<Spec id="web.login" stability="evolving" derives="goals/product">\n  **When** a user signs in, **the** web app **shall** call the API.\n</Spec>\n\nSee [API Contract](doc:api/contracts/rest) and [Relative Contract](../../../../packages/api/docs/contracts/rest.mdx).\n\n![Flow](./flow.png)\n`,
      'apps/web/docs/specs/flow.png': pngBytes,
      'packages/api/docs/contracts/rest.mdx': `---\ntype: contract\ntitle: API REST Contract\n---\n\n# API REST Contract\n\n<Spec id="api.token" stability="stable" derives="goals/product">\n  **When** credentials are valid, **the** API **shall** issue a token.\n</Spec>\n`,
      'apps/web/junit.xml': `<testsuite name="web"><testcase name="[web.login] signs in" /></testsuite>`,
      'packages/api/junit.xml': `<testsuite name="api"><testcase name="[api.token] issues token" /></testsuite>`,
    })

    const resolvedRes = resolveProjectPaths({ project: root })
    expect(resolvedRes.isOk()).toBe(true)
    if (resolvedRes.isErr()) return
    const resolved = resolvedRes.value
    expect(resolved.docsMounts).toHaveLength(3)
    expect(resolved.docsMounts.map((m) => m.id)).toEqual(['root', 'web', 'api'])
    expect(resolved.testReportPaths).toHaveLength(2)

    const index = await loadDocuments(resolved.docsDir, { mounts: resolved.docsMounts })
    expect(index.documents.map((d) => d.id).toSorted()).toEqual([
      'api/contracts/rest',
      'goals/product',
      'web/specs/auth',
    ])

    // 名前付きマウント配下でも mountRelPath から Artifact Type が推論される
    const webDoc = index.byId.get('web/specs/auth')
    expect(webDoc?.type).toBe('spec')
    expect(webDoc?.mountId).toBe('web')
    expect(webDoc?.issues).toHaveLength(0)

    // doc:<docId> とクロス相対パスの両方が api/contracts/rest への mentions エッジおよび Web UI 用 resolvedLinks として解決される
    expect(webDoc?.outgoing.some((e) => e.docId === 'api/contracts/rest' && e.kind === 'mentions')).toBe(true)
    expect(webDoc?.resolvedLinks?.['../../../../packages/api/docs/contracts/rest.mdx']).toBe('api/contracts/rest')
    expect(webDoc?.resolvedLinks?.['doc:api/contracts/rest']).toBe('api/contracts/rest')

    // 承認は各ブロックの所属マウント配下の guard/reviews.json へ保存される
    const approveWeb = await approveBlock(resolved.docsDir, index, 'web.login', { author: 'alice', cacheRoot: root })
    expect(approveWeb.isOk()).toBe(true)
    const approveApi = await approveBlock(resolved.docsDir, index, 'api.token', { author: 'bob', cacheRoot: root })
    expect(approveApi.isOk()).toBe(true)

    const webReviewsPath = path.join(root, 'apps/web/docs/guard/reviews.json')
    const apiReviewsPath = path.join(root, 'packages/api/docs/guard/reviews.json')
    expect(existsSync(webReviewsPath)).toBe(true)
    expect(existsSync(apiReviewsPath)).toBe(true)
    const webReviews = JSON.parse(await readFile(webReviewsPath, 'utf-8')) as { blocks: Record<string, unknown> }
    const apiReviews = JSON.parse(await readFile(apiReviewsPath, 'utf-8')) as { blocks: Record<string, unknown> }
    expect(webReviews.blocks['web.login']).toBeDefined()
    expect(webReviews.blocks['api.token']).toBeUndefined()
    expect(apiReviews.blocks['api.token']).toBeDefined()

    // 再読み込み時に全マウントの reviews.json がマージされ、複数 JUnit XML で両方 verified になる
    const checkAll = await runDocsCheck({
      docsDir: resolved.docsDir,
      mounts: resolved.docsMounts,
      projectRoot: root,
      testReportPaths: resolved.testReportPaths,
    })
    expect(checkAll.ok).toBe(true)
    expect(checkAll.reviewCounts.approved).toBe(2)
    expect(checkAll.realizationCounts.verified).toBe(2)

    // --mount web は全体グラフをロードした上で web だけ絞り込み、root の goals/product 参照も壊れない
    const checkWeb = await runDocsCheck({
      docsDir: resolved.docsDir,
      mounts: resolved.docsMounts,
      mount: 'web',
      projectRoot: root,
      testReportPaths: resolved.testReportPaths,
    })
    expect(checkWeb.ok).toBe(true)
    expect(checkWeb.documentCount).toBe(1)
    expect(checkWeb.blockCount).toBe(1)
    expect(checkWeb.realizationCounts.verified).toBe(1)

    // 存在しない --mount は unknown-mount エラー
    const checkInvalid = await runDocsCheck({
      docsDir: resolved.docsDir,
      mounts: resolved.docsMounts,
      mount: 'nonexistent',
      projectRoot: root,
    })
    expect(checkInvalid.ok).toBe(false)
    expect(checkInvalid.errors.some((e) => e.code === 'unknown-mount')).toBe(true)

    // CLI: list / query / scaffold の --mount 対応
    const listOut: string[] = []
    const listCode = await runCli(['list', '--project', root, '--mount', 'web', '--json'], {
      out: (s) => listOut.push(s),
      err: () => {},
      readStdin: async () => '',
    })
    expect(listCode).toBe(0)
    const listJson = JSON.parse(listOut.join('\n')) as { count: number; documents: Array<{ id: string }> }
    expect(listJson.count).toBe(1)
    expect(listJson.documents[0]?.id).toBe('web/specs/auth')

    const scaffoldOut: string[] = []
    const scaffoldCode = await runCli(
      ['scaffold', 'designs/auth.mdx', '--project', root, '--mount', 'web', '--title', 'Web Auth Design', '--json'],
      {
        out: (s) => scaffoldOut.push(s),
        err: () => {},
        readStdin: async () => '',
      },
    )
    expect(scaffoldCode).toBe(0)
    expect(existsSync(path.join(root, 'apps/web/docs/designs/auth.mdx'))).toBe(true)
  })

  test('[core.project-config] 重複した docs マウント ID は ConfigValidationError で拒否する', async () => {
    const root = await makeMonorepo({
      '.documi.json': JSON.stringify({
        docs: [
          { id: 'web', path: 'apps/web/docs' },
          { id: 'web', path: 'apps/admin/docs' },
        ],
      }),
    })
    const res = resolveProjectPaths({ project: root })
    expect(res.isErr()).toBe(true)
    if (res.isErr()) {
      expect(res.error.message).toContain('Duplicate docs mount id')
    }
  })

  test('[core.ai-cli] documi check --format github のアノテーション出力とコマンド別フラグ検証が動作する', async () => {
    const root = await makeMonorepo({
      'docs/specs/orphan.mdx': `---\ntype: spec\ntitle: Orphan\n---\n\n# Orphan\n\n<Spec id="app.orphan">Orphan spec</Spec>\n`,
    })

    // --format github で ::error file=docs/specs/orphan.mdx,title=orphan-spec::... を出力
    const out: string[] = []
    const code = await runCli(['check', '--project', root, '--format', 'github'], {
      out: (s) => out.push(s),
      err: () => {},
      readStdin: async () => '',
    })
    expect(code).toBe(1)
    expect(out.join('\n')).toContain('::error file=docs/specs/orphan.mdx,title=orphan-spec::')

    // コマンド非対応フラグ（list --strict）を明確に拒否
    const flagErrs: string[] = []
    const badCode = await runCli(['list', '--project', root, '--strict'], {
      out: () => {},
      err: (s) => flagErrs.push(s),
      readStdin: async () => '',
    })
    expect(badCode).toBe(1)
    expect(flagErrs.join('\n')).toContain('Option --strict is not supported by "documi list"')
  })
})
