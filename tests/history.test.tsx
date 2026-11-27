import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router'
import { getDocumentHistory, getDocumentRevision, parseUnifiedDiffRanges } from '../src/core/git'
import { loadDocuments } from '../src/core/loader'
import type { DocumentHistory } from '../src/core/types'
import { createApp } from '../src/server/app'
import { DocsStore } from '../src/server/store'
import DocViewer from '../src/web/components/DocViewer'
import SidePanel from '../src/web/components/SidePanel'
import { extractHeadings } from '../src/web/headings'
import i18n from '../src/web/i18n'
import { parseMarkdown, renderMarkdown } from '../src/web/mdast'

function runGitIn(cwd: string, args: string[], dateIso?: string): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test Author',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test Author',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    ...(dateIso ? { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso } : {}),
  }
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

describe('Document Git Freshness, Highlight & History', () => {
  test('[core.doc-history] parseUnifiedDiffRanges が frontmatter を除いた本文基準の変更行レンジを正しく抽出する', () => {
    const diff = [
      'diff --git a/docs/specs/sample.mdx b/docs/specs/sample.mdx',
      '--- a/docs/specs/sample.mdx',
      '+++ b/docs/specs/sample.mdx',
      '@@ -2,1 +2,1 @@',
      '-title: Old',
      '+title: New',
      '@@ -8,0 +9,3 @@',
      '+added 1',
      '+added 2',
      '+added 3',
      '@@ -14,2 +17,2 @@',
      '-old a',
      '-old b',
      '+new a',
      '+new b',
    ].join('\n')

    // frontmatter が 5 行ある場合 (bodyStartLine = 6 -> offset = 5)
    const ranges = parseUnifiedDiffRanges(diff, 5)
    expect(ranges).toEqual([
      { startLine: 4, endLine: 6, kind: 'added' },
      { startLine: 12, endLine: 13, kind: 'modified' },
    ])
  })

  test('[core.doc-history] Git リポジトリで鮮度・コミット履歴・最新変更レンジ・過去版本文を取得でき、不正 SHA を拒否する', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'documi-git-history-'))
    const docsDir = path.join(root, 'docs')
    try {
      await mkdir(path.join(docsDir, 'goals'), { recursive: true })
      await mkdir(path.join(docsDir, 'specs'), { recursive: true })

      runGitIn(root, ['init'])

      const goalPath = path.join(docsDir, 'goals', 'core.mdx')
      const specPath = path.join(docsDir, 'specs', 'auth.mdx')

      await writeFile(goalPath, '---\ntype: goal\ntitle: Core Goal\n---\n\n# Core Goal\n\nRoot goal.\n')
      await writeFile(
        specPath,
        [
          '---',
          'type: spec',
          'title: Auth Spec v1',
          '---',
          '',
          '# Auth Spec',
          '',
          '## Login',
          '',
          'Initial paragraph.',
          '',
        ].join('\n'),
      )

      runGitIn(root, ['add', '.'])
      runGitIn(root, ['commit', '-m', 'docs: add initial specs'], '2026-10-01T10:00:00+09:00')
      const firstSha = runGitIn(root, ['rev-parse', 'HEAD'])

      // 2 回目のコミットで新しいセクションを追加
      await writeFile(
        specPath,
        [
          '---',
          'type: spec',
          'title: Auth Spec v2',
          '---',
          '',
          '# Auth Spec',
          '',
          '## Login',
          '',
          'Initial paragraph.',
          '',
          '## Lockout',
          '',
          'Lock account after 5 failures.',
          '',
        ].join('\n'),
      )
      runGitIn(root, ['add', '.'])
      runGitIn(root, ['commit', '-m', 'docs: add lockout section'], '2026-10-10T15:30:00+09:00')
      const secondSha = runGitIn(root, ['rev-parse', 'HEAD'])

      // コミット直後: highlightBasis は last-commit
      const indexAfterCommit = await loadDocuments(docsDir)
      const specDoc = indexAfterCommit.byId.get('specs/auth')
      expect(specDoc).toBeDefined()
      expect(specDoc?.freshness?.createdAt).toBe('2026-10-01T10:00:00+09:00')
      expect(specDoc?.freshness?.updatedAt).toBe('2026-10-10T15:30:00+09:00')
      expect(specDoc?.freshness?.commitCount).toBe(2)
      expect(specDoc?.freshness?.lastCommitSha).toBe(secondSha.slice(0, 7))
      expect(specDoc?.freshness?.workingStatus).toBeUndefined()

      const historyCommitted = await getDocumentHistory(docsDir, specDoc!)
      expect(historyCommitted.gitAvailable).toBe(true)
      expect(historyCommitted.highlightBasis).toBe('last-commit')
      if (historyCommitted.highlightBasis === 'last-commit') {
        expect(historyCommitted.highlightCommit.sha).toBe(secondSha)
      }
      expect(historyCommitted.commits).toHaveLength(2)
      expect(historyCommitted.changedRanges.length).toBeGreaterThan(0)

      // 過去コミット (firstSha) の本文を参照できる
      const pastRev = getDocumentRevision(docsDir, specDoc!, firstSha).unwrap()
      expect(pastRev.title).toBe('Auth Spec v1')
      expect(pastRev.body).toContain('Initial paragraph.')
      expect(pastRev.body).not.toContain('Lockout')
      expect(pastRev.commit.sha).toBe(firstSha)

      // 不正な SHA は InvalidCommitShaError で拒否
      const badRev = getDocumentRevision(docsDir, specDoc!, 'not-a-sha!')
      expect(badRev.isErr()).toBe(true)
      if (badRev.isErr()) expect(badRev.error._tag).toBe('InvalidCommitShaError')

      // ローカル未コミット変更 + 新規未追跡ファイルを追加
      await writeFile(
        specPath,
        [
          '---',
          'type: spec',
          'title: Auth Spec v2',
          '---',
          '',
          '# Auth Spec',
          '',
          '## Login',
          '',
          'Updated login copy by AI.',
          '',
          '## Lockout',
          '',
          'Lock account after 5 failures.',
          '',
        ].join('\n'),
      )
      await writeFile(
        path.join(docsDir, 'specs', 'draft.mdx'),
        '---\ntype: spec\ntitle: Draft Spec\n---\n\n# Draft\n\nBrand new doc.\n',
      )

      const store = await DocsStore.open(docsDir, { enrichTrace: false })
      const app = createApp(store)

      const overviewRes = await app.request('/api/overview')
      expect(overviewRes.status).toBe(200)
      const overview = (await overviewRes.json()) as {
        recentDocuments: { id: string; freshness?: { workingStatus?: string } }[]
        uncommittedCount: number
      }
      expect(overview.uncommittedCount).toBe(2)
      expect(overview.recentDocuments.length).toBeGreaterThanOrEqual(2)

      const histRes = await app.request('/api/history?id=specs/auth')
      expect(histRes.status).toBe(200)
      const histBody = (await histRes.json()) as DocumentHistory
      expect(histBody.highlightBasis).toBe('working')
      expect(histBody.freshness.workingStatus).toBe('modified')
      expect(histBody.changedRanges.length).toBeGreaterThan(0)

      const draftHistRes = await app.request('/api/history?id=specs/draft')
      expect(draftHistRes.status).toBe(200)
      const draftHist = (await draftHistRes.json()) as DocumentHistory
      expect(draftHist.highlightBasis).toBe('working')
      expect(draftHist.freshness.workingStatus).toBe('untracked')

      const revRes = await app.request(`/api/history/revision?id=specs/auth&commit=${firstSha}`)
      expect(revRes.status).toBe(200)
      const revBody = (await revRes.json()) as { title: string; body: string }
      expect(revBody.title).toBe('Auth Spec v1')
      expect(revBody.body).toContain('Initial paragraph.')

      const badShaRes = await app.request('/api/history/revision?id=specs/auth&commit=invalid-sha')
      expect(badShaRes.status).toBe(400)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('[core.doc-history] 非 Git ディレクトリではファイル時刻へフォールバックし、過去版 API は 404 を返す', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'documi-nogit-history-'))
    const docsDir = path.join(root, 'docs')
    try {
      await mkdir(path.join(docsDir, 'guides'), { recursive: true })
      await writeFile(path.join(docsDir, 'guides', 'intro.mdx'), '---\ntype: guide\ntitle: Intro\n---\n\n# Intro\n')

      const store = await DocsStore.open(docsDir, { enrichTrace: false })
      const doc = store.getIndex().byId.get('guides/intro')
      expect(doc?.freshness?.createdAt).toBeTruthy()
      expect(doc?.freshness?.updatedAt).toBeTruthy()

      const app = createApp(store)
      const histRes = await app.request('/api/history?id=guides/intro')
      expect(histRes.status).toBe(200)
      const hist = (await histRes.json()) as DocumentHistory
      expect(hist.gitAvailable).toBe(false)
      expect(hist.commits).toEqual([])
      expect(hist.highlightBasis).toBe('none')

      const revRes = await app.request('/api/history/revision?id=guides/intro&commit=1234567')
      expect(revRes.status).toBe(404)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('[ui.doc-history] 最新変更ハイライト・見出しセクション範囲・DocViewer 鮮度と SidePanel 履歴タブが正しく描画される', () => {
    const body = ['# Title', '', '## Intro', '', 'Unchanged text.', '', '## Recent', '', 'Newly added by AI.'].join(
      '\n',
    )
    const changedRanges = [{ startLine: 7, endLine: 9, kind: 'added' as const }]

    const tree = parseMarkdown(body, 'mdx')
    const mdHtml = renderToStaticMarkup(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>{renderMarkdown(tree, { changedRanges })}</I18nextProvider>
      </MemoryRouter>,
    )
    expect(mdHtml).toContain('md-changed-block')
    expect(mdHtml).toContain('data-change-kind="added"')
    expect(mdHtml).toContain('Newly added by AI.')

    const headings = extractHeadings(body, 'mdx')
    expect(headings).toHaveLength(3)
    expect(headings[1]?.line).toBe(3)
    expect(headings[1]?.sectionEndLine).toBe(6)
    expect(headings[2]?.line).toBe(7)
    expect(headings[2]?.sectionEndLine).toBe(Number.MAX_SAFE_INTEGER)

    const sampleHistory: DocumentHistory = {
      docId: 'specs/demo',
      path: 'specs/demo.mdx',
      gitAvailable: true,
      freshness: {
        createdAt: '2026-10-01T10:00:00Z',
        updatedAt: '2026-11-23T09:00:00Z',
        workingStatus: 'modified',
        lastCommitSha: 'abcdef1',
        lastCommitSubject: 'docs: update demo',
        commitCount: 2,
      },
      highlightBasis: 'working',
      changedRanges,
      commits: [
        {
          sha: 'abcdef1234567890abcdef1234567890abcdef12',
          shortSha: 'abcdef1',
          date: '2026-11-20T10:00:00Z',
          author: 'Alice',
          subject: 'docs: update demo',
          status: 'M',
        },
      ],
    }

    const sampleDoc = {
      id: 'specs/demo',
      mountId: 'root',
      mountRelPath: 'specs/demo.mdx',
      type: 'spec' as const,
      typeInferred: false,
      title: 'Demo Spec',
      description: 'Demo description',
      tags: ['demo'],
      format: 'mdx' as const,
      path: 'specs/demo.mdx',
      dir: 'specs',
      body,
      blocks: [],
      sourceRefs: [],
      declaredEdges: {},
      outgoing: [],
      incoming: [],
      freshness: sampleHistory.freshness,
      issues: [],
    }

    const viewerHtml = renderToStaticMarkup(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <DocViewer
            doc={sampleDoc}
            onMutate={() => {}}
            history={sampleHistory}
            highlightChanges={true}
            onToggleHighlight={() => {}}
            onOpenHistory={() => {}}
          />
        </I18nextProvider>
      </MemoryRouter>,
    )
    expect(viewerHtml).toContain('2026-10-01')
    expect(viewerHtml).toContain('md-changed-block')

    const panelHtml = renderToStaticMarkup(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <SidePanel
            doc={sampleDoc}
            headings={headings}
            history={sampleHistory}
            highlightChanges={true}
            activeTab="history"
            onPeek={() => {}}
            onPeekRevision={() => {}}
            onCollapse={() => {}}
          />
        </I18nextProvider>
      </MemoryRouter>,
    )
    expect(panelHtml).toContain('abcdef1')
    expect(panelHtml).toContain('docs: update demo')
    expect(panelHtml).toContain('Alice')
  })
})
