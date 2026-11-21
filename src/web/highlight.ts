import type { codeToHtml as CodeToHtmlFn } from 'shiki'

type CodeToHtml = typeof CodeToHtmlFn

let codeToHtmlPromise: Promise<CodeToHtml> | null = null

function getCodeToHtml(): Promise<CodeToHtml> {
  codeToHtmlPromise ??= import('shiki').then((m) => m.codeToHtml)
  return codeToHtmlPromise
}

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  'c#': 'csharp',
  golang: 'go',
  kt: 'kotlin',
  kts: 'kotlin',
}

/** fence の言語名を Shiki の言語名へ正規化する */
export function normalizeLang(lang: string | null | undefined): string | null {
  if (!lang) return null
  const l = lang.trim().toLowerCase()
  if (!l || l === 'text' || l === 'txt' || l === 'plain') return null
  return LANG_ALIASES[l] ?? l
}

/**
 * Shiki でコードを HTML 化する。light/dark 両テーマの CSS 変数を埋め込み、
 * `data-theme` 属性に応じて CSS 側で切り替える。失敗時は null。
 */
export async function highlightCode(code: string, lang: string | null | undefined): Promise<string | null> {
  const normalized = normalizeLang(lang)
  if (!normalized) return null
  try {
    const codeToHtml = await getCodeToHtml()
    return await codeToHtml(code.replace(/\n$/, ''), {
      lang: normalized,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    })
  } catch {
    return null
  }
}
