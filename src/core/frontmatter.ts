import { parse } from 'yaml'

export class FrontmatterError extends Error {}

export interface SplitFrontmatter {
  hasFrontmatter: boolean
  /** YAML としてパース前の frontmatter 文字列 */
  data: string
  body: string
  /** 正規化済みソース文字列内での body 先頭オフセット */
  bodyOffset: number
  /** ファイル先頭を 1 としたときの body 先頭行番号 */
  bodyStartLine: number
}

/**
 * 先頭の `---` フェンスで囲まれた YAML frontmatter を分離する。
 * 先頭に `---` がない場合は frontmatter なしとして本文全体を返す。
 * 開始フェンスがあるのに閉じフェンスがない場合は FrontmatterError を投げる。
 */
export function splitFrontmatter(source: string): SplitFrontmatter {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n') && normalized !== '---') {
    return { hasFrontmatter: false, data: '', body: normalized, bodyOffset: 0, bodyStartLine: 1 }
  }
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)
  if (!match || match[1] === undefined) {
    throw new FrontmatterError('YAML frontmatter の閉じフェンス (---) が見つかりません')
  }
  const prefix = match[0]
  const bodyStartLine = prefix.split('\n').length
  return {
    hasFrontmatter: true,
    data: match[1],
    body: normalized.slice(prefix.length),
    bodyOffset: prefix.length,
    bodyStartLine,
  }
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
