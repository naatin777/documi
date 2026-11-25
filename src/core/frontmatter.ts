import { Result } from 'better-result'
import { parse } from 'yaml'
import { FrontmatterParseError, UnclosedFrontmatterError } from './errors'

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
 * 開始フェンスがあるのに閉じフェンスがない場合は UnclosedFrontmatterError を返す。
 */
export function splitFrontmatter(source: string): Result<SplitFrontmatter, UnclosedFrontmatterError> {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n') && normalized !== '---') {
    return Result.ok({ hasFrontmatter: false, data: '', body: normalized, bodyOffset: 0, bodyStartLine: 1 })
  }
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)
  if (!match || match[1] === undefined) {
    return Result.err(new UnclosedFrontmatterError({ message: 'Missing closing YAML frontmatter fence (---)' }))
  }
  const prefix = match[0]
  const bodyStartLine = prefix.split('\n').length
  return Result.ok({
    hasFrontmatter: true,
    data: match[1],
    body: normalized.slice(prefix.length),
    bodyOffset: prefix.length,
    bodyStartLine,
  })
}

/** YAML 文字列をパースする。失敗時は FrontmatterParseError を返す。 */
export function parseYamlFrontmatter(data: string): Result<unknown, FrontmatterParseError> {
  return Result.try({
    try: () => parse(data) as unknown,
    catch: (error) =>
      new FrontmatterParseError({
        message: `Failed to parse YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      }),
  })
}
