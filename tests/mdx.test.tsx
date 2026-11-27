import { beforeEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import type { TermEntry } from '../src/web/api'
import Markdown from '../src/web/components/Markdown'
import { extractHeadings } from '../src/web/headings'
import { highlightCode, normalizeLang } from '../src/web/highlight'
import { setAppLocale } from '../src/web/i18n'
import { LiveProvider } from '../src/web/live'

beforeEach(() => {
  setAppLocale('ja')
})

const SAMPLE_TERMS: TermEntry[] = [
  {
    id: 'Artifact',
    docId: 'domain/glossary',
    docTitle: '用語集',
    aliases: ['成果物'],
    antiTerms: [],
    symbols: ['src/core/types.ts#Document'],
    usedIn: [],
    rawBody: '管理対象の文書単位',
  },
]

function render(body: string, format: 'markdown' | 'mdx' = 'mdx', currentDir = 'specs') {
  return renderToStaticMarkup(
    <MemoryRouter>
      <LiveProvider>
        <Markdown body={body} format={format} currentDir={currentDir} terms={SAMPLE_TERMS} />
      </LiveProvider>
    </MemoryRouter>,
  )
}

describe('Markdown レンダリング', () => {
  test('通常の Markdown (GFM) を描画する', () => {
    const html = render('# Title\n\n**bold** and `code`\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n', 'markdown')
    expect(html).toContain('<h1')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<table>')
  })

  test('相対パスの内部リンクを SPA リンクへ変換する', () => {
    const html = render('[goal](../goals/core.mdx)', 'markdown', 'specs/auth')
    expect(html).toContain('href="/docs/specs/goals/core"')
    const html2 = render('[goal](../../goals/core.mdx)', 'markdown', 'specs/auth')
    expect(html2).toContain('href="/docs/goals/core"')
  })

  test('危険なスキームのリンクは無効化する', () => {
    const html = render('[x](javascript:alert(1))\n\n[y](data:text/html,x)', 'markdown')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toContain('href="data:')
    expect(html).toContain('md-broken-ref')
  })

  test('Shiki 用コードブロックと Mermaid ブロックを描画する', () => {
    const html = render('```ts\nconst x = 1\n```\n\n```mermaid\nflowchart LR\n  A-->B\n```\n')
    expect(html).toContain('codeblock')
    expect(html).toContain('mermaid-block')
  })

  test('KaTeX で数式を描画する', () => {
    const inline = render('式 $x^2$ です', 'markdown')
    expect(inline).toContain('katex')
    const block = render('$$\n\\min_x f(x)\n$$', 'markdown')
    expect(block).toContain('katex-display')
  })

  test('同名見出しには Outline と共通の一意 id が振られる', () => {
    const body = '# Same\n\n## Same\n\n### Same\n'
    const html = render(body, 'markdown')
    const ids = [...html.matchAll(/<h\d id="([^"]+)"/g)].map((m) => m[1]!)
    expect(ids).toEqual(['same', 'same-2', 'same-3'])
    expect(new Set(ids).size).toBe(3)
    expect(extractHeadings(body).map((h) => h.id)).toEqual(ids)
  })

  test('setext 見出しと MDX コンポーネント内の見出しも id が一致する', () => {
    const body = 'Same\n====\n\n<Callout>\n\n## Same\n\n</Callout>\n'
    const ids = [...render(body, 'mdx').matchAll(/<h\d id="([^"]+)"/g)].map((m) => m[1]!)
    expect(ids).toEqual(['same', 'same-2'])
    expect(extractHeadings(body, 'mdx').map((h) => h.id)).toEqual(ids)
  })
})

describe('MDX コンポーネント', () => {
  test('Callout / Tabs / Steps を描画する', () => {
    const callout = render('<Callout type="warning" title="注意">本文</Callout>')
    expect(callout).toContain('callout-warning')
    expect(callout).toContain('注意')

    const tabs = render('<Tabs>\n<Tabs.Tab label="A">内容A</Tabs.Tab>\n<Tabs.Tab label="B">内容B</Tabs.Tab>\n</Tabs>')
    expect(tabs).toContain('mdx-tabs')
    expect(tabs).toContain('内容A')

    const steps = render('<Steps>\n<Steps.Step title="一">説明</Steps.Step>\n</Steps>')
    expect(steps).toContain('mdx-steps')
    expect(steps).toContain('一')
  })

  test('セマンティックタグ (Spec / Constraint / Decision / Test / Note / TermDef / Term) を描画する', () => {
    const spec = render('<Spec id="auth.lockout" stability="stable" derives="goals/core">5回失敗でロック</Spec>')
    expect(spec).toContain('sem-spec')
    expect(spec).toContain('id="block-auth.lockout"')
    expect(spec).toContain('stable')
    expect(spec).toContain('goals/core')

    const constraint = render('<Constraint id="core.safe" scope="mdx">JS実行禁止</Constraint>')
    expect(constraint).toContain('sem-constraint')
    expect(constraint).toContain('core.safe')

    const decision = render(
      '<Decision id="dec.bun" summary="Bunを採用"><Context>高速化</Context><Rejected option="Node">起動が遅い</Rejected><Tradeoff>互換性差分</Tradeoff></Decision>',
    )
    expect(decision).toContain('sem-decision')
    expect(decision).toContain('dec.bun')
    expect(decision).toContain('Bunを採用')
    expect(decision).toContain('Rejected: Node')

    const testBlock = render('<Test id="test.bun" verifies="core.runtime" level="unit">Given/When/Then</Test>')
    expect(testBlock).toContain('sem-test')
    expect(testBlock).toContain('unit')
    expect(testBlock).toContain('core.runtime')

    const note = render('<Note intent="idea" title="構想">未確定案</Note>')
    expect(note).toContain('sem-note-idea')
    expect(note).toContain('構想')

    const termDef = render(
      '<TermDef id="Artifact" aliases="成果物" symbols="src/core/types.ts#Document">定義</TermDef>',
    )
    expect(termDef).toContain('sem-term')
    expect(termDef).toContain('成果物')
    expect(termDef).toContain('src/core/types.ts#Document')

    const termRef = render('これは <Term name="Artifact" /> と <Term name="成果物" /> です')
    expect(termRef).toContain('href="/docs/domain/glossary#block-Artifact"')
    expect(termRef).not.toContain('term-missing')

    // Living Glossary 自動リンク: 正準 ID のみ自動でリンクされ、aliases・コード内・見出し内は変換しない
    const autoLinked = render('# Artifact 見出し\n\nArtifact と成果物を管理する。`Artifact` はコード。', 'markdown')
    expect(autoLinked).toMatch(/href="\/docs\/domain\/glossary#block-Artifact"[^>]*>Artifact<\/a>/)
    expect(autoLinked).not.toMatch(/href="\/docs\/domain\/glossary#block-Artifact"[^>]*>成果物<\/a>/)
    expect(autoLinked).toContain('成果物を管理する。')
    expect(autoLinked).toContain('<code>Artifact</code>')
    expect(autoLinked).toContain('<h1 id="artifact-見出し">Artifact 見出し</h1>')

    // 日本語正準 ID でも複合語（漢字・カタカナ連続）の途中は切り刻んでリンク化しない
    const compoundHtml = renderToStaticMarkup(
      <MemoryRouter>
        <LiveProvider>
          <Markdown
            body="関係者とエッジケースは分割せず、関係やエッジを独立語としてリンクする。承認記録は alias なのでリンクしない。"
            format="markdown"
            currentDir="goals"
            terms={[
              {
                id: '関係',
                docId: 'domain/glossary',
                docTitle: 'Glossary',
                aliases: ['承認記録'],
                antiTerms: [],
                symbols: [],
                rawBody: '有向辺',
                usedIn: [],
              },
              {
                id: 'エッジ',
                docId: 'domain/glossary',
                docTitle: 'Glossary',
                aliases: [],
                antiTerms: [],
                symbols: [],
                rawBody: '辺',
                usedIn: [],
              },
            ]}
          />
        </LiveProvider>
      </MemoryRouter>,
    )
    expect(compoundHtml).toContain('関係者とエッジケースは分割せず、')
    expect(compoundHtml).toMatch(/href="\/docs\/domain\/glossary#block-%E9%96%A2%E4%BF%82"[^>]*>関係<\/a>/)
    expect(compoundHtml).toMatch(/href="\/docs\/domain\/glossary#block-%E3%82%A8%E3%83%83%E3%82%B8"[^>]*>エッジ<\/a>/)
    expect(compoundHtml).not.toContain('>承認記録</a>')
  })

  test('SourceRef を描画する (satisfies/verifies バッジ・props 不正時エラー)', () => {
    const ok = render('<SourceRef file="src/a.ts" lines="1-3" satisfies="auth.lockout" />')
    expect(ok).toContain('source-ref')
    expect(ok).toContain('satisfies auth.lockout')
    const bad = render('<SourceRef symbol="x" />')
    expect(bad).toContain('source-ref-error')
  })

  test('[ui.web-viewer] Details / Columns / Timeline の視覚 MDX コンポーネントを描画する', () => {
    const md = `
<Details title="詳細 JSON">
  補足テキストです。
</Details>

<Columns>
  <Column title="Before">旧仕様</Column>
  <Column title="After">新仕様</Column>
</Columns>

<Timeline>
  <Timeline.Item title="Step A" date="2026-11">最初の段階</Timeline.Item>
  <TimelineItem title="Step B">次の段階</TimelineItem>
</Timeline>
`
    const html = render(md)
    expect(html).toContain('mdx-details')
    expect(html).toContain('詳細 JSON')
    expect(html).toContain('mdx-columns')
    expect(html).toContain('Before')
    expect(html).toContain('After')
    expect(html).toContain('mdx-timeline')
    expect(html).toContain('Step A')
    expect(html).toContain('2026-11')
    expect(html).toContain('Step B')
    expect(html).not.toContain('mdx-error')

    const expanded = renderToStaticMarkup(
      <MemoryRouter>
        <LiveProvider>
          <Markdown body={md} format="mdx" currentDir="specs" expandAllTabs />
        </LiveProvider>
      </MemoryRouter>,
    )
    expect(expanded).toContain('<details class="mdx-details" open="">')
  })

  test('未対応コンポーネント・式・ESM をエラー表示し実行しない', () => {
    const html = render('import x from "y"\n\n<Unknown>hi</Unknown>\n\n値は {alert(1)} です\n')
    expect(html).toContain('mdx-error')
    expect(html).toContain('未対応')
    expect(html).not.toContain('<Unknown')
    expect(html).not.toContain('alert(1)</')
  })

  test('属性式・スプレッドを拒否する', () => {
    const html = render('<Callout type={"x"}>a</Callout>\n\n<Callout {...props}>b</Callout>')
    expect((html.match(/mdx-error/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('Shiki', () => {
  test('言語を正規化し HTML を生成する', async () => {
    expect(normalizeLang('ts')).toBe('typescript')
    expect(normalizeLang('text')).toBeNull()
    const html = await highlightCode('const x: number = 1', 'ts')
    expect(html).toContain('shiki')
    expect(html).toContain('--shiki-light')
    expect(html).toContain('--shiki-dark')
  })

  test('未対応言語は null を返す', async () => {
    expect(await highlightCode('x', 'not-a-lang')).toBeNull()
    expect(await highlightCode('x', null)).toBeNull()
  })
})
