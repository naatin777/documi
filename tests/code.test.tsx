import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { stringify } from 'yaml'
import { buildCodeTree, readCodeFile } from '../src/core/code'
import { loadDocuments } from '../src/core/loader'
import { SourceError } from '../src/core/source'
import { enrichWithRealization } from '../src/core/trace'
import { createApp } from '../src/server/app'
import { DocsStore } from '../src/server/store'
import CodeExplorerLayout from '../src/web/components/CodeExplorerLayout'
import { setAppLocale } from '../src/web/i18n'
import { LiveProvider } from '../src/web/live'

let projectDir: string
let docsDir: string

beforeEach(async () => {
  setAppLocale('ja')
  projectDir = await mkdtemp(path.join(tmpdir(), 'documi-code-explorer-'))
  docsDir = path.join(projectDir, 'docs')

  const writeDoc = async (rel: string, fm: Record<string, unknown>, body: string) => {
    const file = path.join(docsDir, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `---\n${stringify(fm)}---\n\n${body}`)
  }

  const writeSrc = async (rel: string, content: string | Uint8Array) => {
    const file = path.join(projectDir, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }

  await writeDoc('goals/core.mdx', { title: 'コア目標' }, '# コア目標\n')
  await writeDoc(
    'domain/glossary.mdx',
    { title: '用語集' },
    '<TermDef id="AuthService" symbols="src/auth.ts#AuthService">認証サービス</TermDef>\n',
  )
  await writeDoc(
    'specs/auth.mdx',
    { title: '認証仕様', derives: ['goals/core'] },
    '<Spec id="auth.login" stability="stable">ログインを検証する。</Spec>\n',
  )
  await writeDoc(
    'designs/auth.mdx',
    { title: '認証設計', satisfies: ['auth.login'] },
    '<SourceRef file="src/auth.ts" symbol="AuthService" satisfies="auth.login" />\n',
  )

  await writeSrc(
    'src/auth.ts',
    [
      '// @implements auth.login',
      'export class AuthService {',
      '  login(user: string): boolean {',
      '    return user.length > 0',
      '  }',
      '}',
      '',
    ].join('\n'),
  )
  await writeSrc('src/util.ts', 'export const add = (a: number, b: number) => a + b\n')
  await writeSrc('tests/auth.test.ts', "test('[auth.login] ok', () => {})\n")
  await writeSrc('src/bin.dat', new Uint8Array([0x00, 0x01, 0x02, 0x03]))
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

describe('Read-only Code Explorer', () => {
  test('[ui.code-explorer] buildCodeTree がソースツリーと仕様紐づけ率を算出し docs/ やバイナリを除外する', async () => {
    const index = await loadDocuments(docsDir)
    await enrichWithRealization(index, { projectRoot: projectDir })

    const result = await buildCodeTree(projectDir, index)
    const paths = result.files.map((f) => f.path)
    expect(paths).toContain('src/auth.ts')
    expect(paths).toContain('src/util.ts')
    expect(paths).toContain('tests/auth.test.ts')
    expect(paths.some((p) => p.startsWith('docs/'))).toBe(false)
    expect(paths).not.toContain('src/bin.dat')

    const authFile = result.files.find((f) => f.path === 'src/auth.ts')!
    expect(authFile.covered).toBe(true)
    expect(authFile.specCount).toBe(1)
    expect(authFile.docRefCount).toBe(1)
    expect(authFile.termCount).toBe(1)

    const utilFile = result.files.find((f) => f.path === 'src/util.ts')!
    expect(utilFile.covered).toBe(false)
    expect(result.coveredFiles).toBe(2) // src/auth.ts + tests/auth.test.ts
    expect(result.totalFiles).toBe(3)
  })

  test('[ui.code-explorer] readCodeFile が全文と Spec・文書・用語の逆リンクを返し境界違反を拒否する', async () => {
    const index = await loadDocuments(docsDir)
    await enrichWithRealization(index, { projectRoot: projectDir })

    const file = await readCodeFile(projectDir, index, 'src/auth.ts')
    expect(file.path).toBe('src/auth.ts')
    expect(file.language).toBe('typescript')
    expect(file.totalLines).toBe(6)
    expect(file.code).toContain('export class AuthService')
    expect(file.specLinks.some((s) => s.specId === 'auth.login' && s.kind === 'implements' && s.line === 1)).toBe(true)
    expect(file.docRefs.some((d) => d.docId === 'designs/auth' && d.symbol === 'AuthService')).toBe(true)
    expect(file.termLinks.some((t) => t.termId === 'AuthService' && t.symbol === 'AuthService')).toBe(true)

    // パストラバーサルは 403
    await expect(readCodeFile(projectDir, index, '../secret.ts')).rejects.toMatchObject({ status: 403 })
    await expect(readCodeFile(projectDir, index, '/etc/passwd')).rejects.toMatchObject({ status: 403 })

    // 未存在は 404
    await expect(readCodeFile(projectDir, index, 'src/missing.ts')).rejects.toMatchObject({ status: 404 })

    // バイナリは 400
    await expect(readCodeFile(projectDir, index, 'src/bin.dat')).rejects.toMatchObject({ status: 400 })

    // ルート外シンボリックリンクは 403
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'documi-outside-'))
    try {
      const outsideFile = path.join(outsideDir, 'leak.ts')
      await writeFile(outsideFile, 'export const secret = 1\n')
      await symlink(outsideFile, path.join(projectDir, 'src/leak.ts'))
      await expect(readCodeFile(projectDir, index, 'src/leak.ts')).rejects.toBeInstanceOf(SourceError)
      await expect(readCodeFile(projectDir, index, 'src/leak.ts')).rejects.toMatchObject({ status: 403 })
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })

  test('[ui.code-explorer] GET /api/code/tree と GET /api/code/file および CodeExplorerLayout が動作する', async () => {
    const store = await DocsStore.open(docsDir, { projectRoot: projectDir })
    const app = createApp(store, { projectRoot: projectDir })

    const treeRes = await app.fetch(new Request('http://localhost/api/code/tree'))
    expect(treeRes.status).toBe(200)
    const treeJson = (await treeRes.json()) as { totalFiles: number; coveredFiles: number }
    expect(treeJson.totalFiles).toBe(3)
    expect(treeJson.coveredFiles).toBe(2)

    const fileRes = await app.fetch(new Request('http://localhost/api/code/file?path=src/auth.ts'))
    expect(fileRes.status).toBe(200)
    const fileJson = (await fileRes.json()) as { path: string; specLinks: { specId: string }[] }
    expect(fileJson.path).toBe('src/auth.ts')
    expect(fileJson.specLinks.some((s) => s.specId === 'auth.login')).toBe(true)

    const badTraversal = await app.fetch(new Request('http://localhost/api/code/file?path=../outside.ts'))
    expect(badTraversal.status).toBe(403)

    const missing = await app.fetch(new Request('http://localhost/api/code/file?path=src/nope.ts'))
    expect(missing.status).toBe(404)

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/code']}>
        <LiveProvider>
          <CodeExplorerLayout />
        </LiveProvider>
      </MemoryRouter>,
    )
    expect(html).toContain('仕様紐づけ率')
    expect(html).toContain('コード閲覧')
  })
})
