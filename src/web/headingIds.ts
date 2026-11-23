export interface Heading {
  level: number
  text: string
  id: string
  /** 本文（frontmatter 除外後）基準の見出し開始行 (1-indexed) */
  line?: number
  /** この見出しが支配するセクションの終了行（次の同レベル以上の見出し直前行） */
  sectionEndLine?: number
}

/** GitHub 風のスラッグ化。レンダラ側と Outline 側で同じ関数を使う。 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/** 同名見出しに連番を付与して id を一意にする。呼び出し側は同じ順序で呼ぶこと。 */
export function uniqueHeadingId(text: string, seen: Set<string>): string {
  const base = slugify(text) || 'section'
  let id = base
  let suffix = 2
  while (seen.has(id)) id = `${base}-${suffix++}`
  seen.add(id)
  return id
}
