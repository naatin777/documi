import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import Markdown from '../src/web/components/Markdown'
import { extractHeadings } from '../src/web/headings'
import { highlightCode, normalizeLang } from '../src/web/highlight'

function render(body: string, format: 'markdown' | 'mdx' = 'mdx') {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Markdown body={body} format={format} />
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

  test('内部リンクを SPA リンクへ変換する', () => {
    const html = render('[req](requirement:00001)', 'markdown')
    expect(html).toContain('href="/pages/requirement/00001"')
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
  test('Callout を描画する', () => {
    const html = render('<Callout type="warning" title="注意">本文</Callout>')
    expect(html).toContain('callout-warning')
    expect(html).toContain('注意')
    expect(html).toContain('本文')
  })

  test('Tabs / Steps を描画する', () => {
    const tabs = render('<Tabs>\n<Tabs.Tab label="A">内容A</Tabs.Tab>\n<Tabs.Tab label="B">内容B</Tabs.Tab>\n</Tabs>')
    expect(tabs).toContain('mdx-tabs')
    expect(tabs).toContain('内容A')

    const steps = render('<Steps>\n<Steps.Step title="一">説明</Steps.Step>\n</Steps>')
    expect(steps).toContain('mdx-steps')
    expect(steps).toContain('一')
  })

  test('SourceRef を描画する (props 不正時はエラー表示)', () => {
    const ok = render('<SourceRef file="src/a.ts" lines="1-3" />')
    expect(ok).toContain('source-ref')
    const bad = render('<SourceRef symbol="x" />')
    expect(bad).toContain('source-ref-error')
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
