import type { HighlighterCore, LanguageInput } from 'shiki/core'

const LANG_LOADERS: Record<string, () => Promise<LanguageInput>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  mdx: () => import('shiki/langs/mdx.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  prisma: () => import('shiki/langs/prisma.mjs'),
  hcl: () => import('shiki/langs/hcl.mjs'),
}

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
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
  cs: 'csharp',
  golang: 'go',
  kt: 'kotlin',
  kts: 'kotlin',
  docker: 'dockerfile',
  terraform: 'hcl',
  tf: 'hcl',
  svg: 'xml',
}

let highlighterPromise: Promise<HighlighterCore> | null = null
const loadedLangs = new Map<string, Promise<void>>()

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      }),
  )
  return highlighterPromise
}

async function ensureLanguageLoaded(highlighter: HighlighterCore, lang: string): Promise<boolean> {
  const loader = LANG_LOADERS[lang]
  if (!loader) return false
  let pending = loadedLangs.get(lang)
  if (!pending) {
    pending = loader().then((mod) => highlighter.loadLanguage(mod))
    loadedLangs.set(lang, pending)
  }
  await pending
  return true
}

/** fence の言語名を Shiki の言語名へ正規化する */
export function normalizeLang(lang: string | null | undefined): string | null {
  if (!lang) return null
  const l = lang.trim().toLowerCase()
  if (!l || l === 'text' || l === 'txt' || l === 'plain') return null
  return LANG_ALIASES[l] ?? l
}

/**
 * Shiki (fine-grained core + JS regex engine) でコードを HTML 化する。
 * light/dark 両テーマの CSS 変数を埋め込み、`data-theme` 属性に応じて CSS 側で切り替える。
 */
export async function highlightCode(code: string, lang: string | null | undefined): Promise<string | null> {
  const normalized = normalizeLang(lang)
  if (!normalized || !(normalized in LANG_LOADERS)) return null
  try {
    const highlighter = await getHighlighter()
    const ok = await ensureLanguageLoaded(highlighter, normalized)
    if (!ok) return null
    return highlighter.codeToHtml(code.replace(/\n$/, ''), {
      lang: normalized,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    })
  } catch {
    return null
  }
}
