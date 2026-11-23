import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildStaticSite } from '../src/server/site'

describe('Static Site Export (documi build-site)', () => {
  test('[core.static-site] 静的サイト一式（index.html / 404.html / .nojekyll / data/*.json / icons）を生成し --no-code も機能する', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'documi-static-site-'))
    const fakeDist = path.join(work, 'dist')
    const repo = path.join(work, 'repo')
    const docsDir = path.join(repo, 'docs')
    const srcDir = path.join(repo, 'src')
    const outFull = path.join(work, 'site-full')
    const outNoCode = path.join(work, 'site-nocode')

    try {
      await mkdir(path.join(fakeDist, 'assets'), { recursive: true })
      await writeFile(
        path.join(fakeDist, 'index.html'),
        '<!doctype html><html><head><script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div></body></html>',
      )
      await writeFile(path.join(fakeDist, 'assets', 'app.js'), 'console.log("ok")')
      await writeFile(path.join(fakeDist, 'assets', 'app.css'), 'body{}')

      await mkdir(path.join(docsDir, 'goals'), { recursive: true })
      await mkdir(path.join(docsDir, 'specs'), { recursive: true })
      await mkdir(srcDir, { recursive: true })

      await writeFile(
        path.join(srcDir, 'auth.ts'),
        '// @implements auth.login\nexport function login() { return true }\n',
      )
      await writeFile(
        path.join(docsDir, 'goals', 'core.mdx'),
        '---\ntype: goal\ntitle: Core Goal\n---\n\n# Core Goal\n',
      )
      await writeFile(
        path.join(docsDir, 'specs', 'auth.mdx'),
        [
          '---',
          'type: spec',
          'title: Auth Spec',
          'derives:',
          '  - goals/core',
          '---',
          '',
          '# Auth Spec',
          '',
          '<Spec id="auth.login" stability="stable" derives="goals/core">',
          '  Users can log in.',
          '</Spec>',
          '',
          '<SourceRef file="src/auth.ts" symbol="login" satisfies="auth.login" />',
          '',
        ].join('\n'),
      )

      const full = await buildStaticSite({
        docsDir,
        projectRoot: repo,
        outDir: outFull,
        clientDist: fakeDist,
        includeCode: true,
      })

      expect(full.documentCount).toBe(2)
      expect(full.codeFileCount).toBeGreaterThanOrEqual(1)
      expect(full.sourceSnippetCount).toBe(1)
      expect(full.iconCount).toBeGreaterThan(0)

      expect(existsSync(path.join(outFull, '.nojekyll'))).toBe(true)
      expect(existsSync(path.join(outFull, '404.html'))).toBe(true)
      expect(existsSync(path.join(outFull, 'data', 'overview.json'))).toBe(true)
      expect(existsSync(path.join(outFull, 'data', 'tree.json'))).toBe(true)
      expect(existsSync(path.join(outFull, 'data', 'search-index.json'))).toBe(true)
      expect(existsSync(path.join(outFull, 'data', 'documents', 'specs', 'auth.json'))).toBe(true)
      expect(existsSync(path.join(outFull, 'data', 'history', 'specs', 'auth.json'))).toBe(true)
      expect(existsSync(path.join(outFull, 'data', 'code', 'files', 'src', 'auth.ts.json'))).toBe(true)
      expect(existsSync(path.join(outFull, 'data', 'icons', 'manifest.json'))).toBe(true)

      const indexHtml = await readFile(path.join(outFull, 'index.html'), 'utf-8')
      expect(indexHtml).toContain('window.__DOCUMI_STATIC__=')
      expect(indexHtml).toContain('src="./assets/app.js"')
      expect(indexHtml).toContain('href="./assets/app.css"')

      const searchData = JSON.parse(await readFile(path.join(outFull, 'data', 'search-index.json'), 'utf-8')) as {
        entries: { id: string }[]
      }
      expect(searchData.entries.some((e) => e.id === 'auth.login')).toBe(true)

      // --no-code モードではソースコードファイルとスニペットを含めない
      const noCode = await buildStaticSite({
        docsDir,
        projectRoot: repo,
        outDir: outNoCode,
        clientDist: fakeDist,
        basePath: '/documi/',
        includeCode: false,
      })

      expect(noCode.codeFileCount).toBe(0)
      expect(noCode.sourceSnippetCount).toBe(0)
      expect(existsSync(path.join(outNoCode, 'data', 'code', 'files', 'src', 'auth.ts.json'))).toBe(false)

      const noCodeHtml = await readFile(path.join(outNoCode, 'index.html'), 'utf-8')
      expect(noCodeHtml).toContain('src="/documi/assets/app.js"')
      expect(noCodeHtml).toContain('"includeCode":false')
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })
})
