/**
 * MDX 本文の安全性チェック。
 * 実行系の構文 (ESM / JSX 式 / 未許可コンポーネント) を検出して問題として報告する。
 * 許可されたコンポーネント (Callout / Tabs / Steps / SourceRef) は問題にしない。
 * コードブロック・インラインコード内の記述は対象外とする。
 */
const ALLOWED_COMPONENTS = ['Callout', 'Tabs', 'Tabs.Tab', 'Tab', 'Steps', 'Steps.Step', 'Step', 'SourceRef']

export function analyzeMdxBody(body: string): string[] {
  const issues: string[] = []
  const stripped = stripMath(stripCode(body))

  if (/^\s*import\s/m.test(stripped) || /^\s*export\s/m.test(stripped)) {
    issues.push('ESM の import / export 文は未対応です')
  }
  if (/\{[^{}\n]+\}/.test(stripped)) {
    issues.push('JSX 式 { ... } は未対応です')
  }

  const tags = stripped.matchAll(/<\/?([A-Za-z][A-Za-z0-9.:-]*)/g)
  const unsupported = new Set<string>()
  for (const m of tags) {
    const name = m[1]!
    if (!ALLOWED_COMPONENTS.includes(name)) unsupported.add(name)
  }
  if (unsupported.size > 0) {
    issues.push(`未対応のコンポーネントです: ${[...unsupported].map((n) => `<${n}>`).join(', ')}`)
  }
  return issues
}

function stripCode(body: string): string {
  return body
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/`[^`\n]*`/g, '')
}

/** KaTeX の { } を JSX 式と誤認しないよう数式を除去する */
function stripMath(body: string): string {
  return body.replace(/\$\$[\s\S]*?\$\$/g, '').replace(/\$[^$\n]+\$/g, '')
}
