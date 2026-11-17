import { parse } from 'yaml'

export class FrontmatterError extends Error {}

export interface SplitFrontmatter {
  /** YAML としてパース前の frontmatter 文字列 */
  data: string
  body: string
}

/**
 * 先頭の `---` フェンスで囲まれた YAML frontmatter を分離する。
 * frontmatter がない・閉じフェンスがない場合は FrontmatterError を投げる。
 */
export function splitFrontmatter(source: string): SplitFrontmatter {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  const normalized = text.replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)
  if (!match || match[1] === undefined) {
    throw new FrontmatterError('YAML frontmatter が見つかりません (先頭の --- フェンスが必要です)')
  }
  return { data: match[1], body: normalized.slice(match[0].length) }
}

/** YAML 文字列をパースする。失敗時は FrontmatterError を投げる。 */
export function parseYamlFrontmatter(data: string): unknown {
  try {
    return parse(data)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new FrontmatterError(`frontmatter の YAML パースに失敗しました: ${message}`)
  }
}
