import { execFileSync } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import { BLOCK_ID_PATTERN } from './types'
import type {
  CodeAnchor,
  DocsIndex,
  IndexIssue,
  PullRequestLink,
  RealizationStatus,
  RealizationSummary,
  TestCaseResult,
} from './types'
import { resolveSourceLines, resolveSourceSymbol, SourceError } from './source'

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.documi',
  '.next',
  '.turbo',
  'target',
  'build',
])
const CODE_EXTS = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'go',
  'rs',
  'py',
  'java',
  'kt',
  'kts',
  'swift',
  'rb',
  'php',
  'c',
  'h',
  'cpp',
  'cc',
  'hpp',
  'cs',
  'ex',
  'exs',
])
const MAX_SCAN_FILE_BYTES = 512 * 1024

export interface RawPullRequest {
  number: number
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  url: string
  body?: string
}

export interface TraceEnrichOptions {
  projectRoot: string
  /** JUnit XML テストレポートのパス (省略時は docs/.documi/test-results.xml 等を自動探索) */
  testReportPath?: string
  /** テスト注入用の PR 一覧 (指定時は gh CLI を呼ばない) */
  pullRequests?: RawPullRequest[]
  /** true のとき gh CLI から PR 一覧を取得する (失敗時は空配列) */
  fetchPrs?: boolean
  /** 壊れた SourceRef により drifted とみなすブロック ID 集合 */
  brokenSpecIds?: ReadonlySet<string>
}

/**
 * プロジェクト内のソース・テストファイルを走査し、
 * `@implements <id>` / `@verifies <id>` / `test("[<id>] ...")` アンカーを抽出する。
 */
export async function scanCodeAnchors(projectRoot: string, index: DocsIndex): Promise<CodeAnchor[]> {
  const root = path.resolve(projectRoot)
  const docsRel = path.relative(root, index.rootDir).split(path.sep).join('/')
  const anchors: CodeAnchor[] = []

  // 1. ドキュメント内の <SourceRef satisfies="..." verifies="..." /> を合流
  for (const doc of index.documents) {
    for (const ref of doc.sourceRefs) {
      for (const specId of ref.satisfies) {
        anchors.push({
          kind: 'implements',
          specId,
          file: ref.file,
          line: ref.startLine,
          fromDoc: true,
        })
      }
      for (const specId of ref.verifies) {
        anchors.push({
          kind: 'verifies',
          specId,
          file: ref.file,
          line: ref.startLine,
          fromDoc: true,
        })
      }
    }
  }

  // 2. プロジェクトのソース・テストファイルを走査
  const files = await collectCodeFiles(root, '', docsRel)
  for (const relFile of files) {
    const abs = path.join(root, relFile)
    let text: string
    try {
      const st = await stat(abs)
      if (st.size > MAX_SCAN_FILE_BYTES) continue
      text = await readFile(abs, 'utf-8')
    } catch {
      continue
    }
    extractAnchorsFromSource(relFile, text, anchors)
  }

  return anchors
}

async function collectCodeFiles(root: string, relDir: string, docsRel: string): Promise<string[]> {
  const absDir = relDir ? path.join(root, relDir) : root
  let entries: Dirent[]
  try {
    entries = await readdir(absDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
    const childRel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (docsRel && !docsRel.startsWith('..') && childRel === docsRel) continue
    if (entry.isDirectory()) {
      out.push(...(await collectCodeFiles(root, childRel, docsRel)))
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toLowerCase()
      if (CODE_EXTS.has(ext)) out.push(childRel)
    }
  }
  return out
}

const COMMENT_TAG_RE = /@(implements|verifies)\s+([a-zA-Z0-9._,\s-]+)/g
const TEST_CALL_RE = /^\s*(?:test|it)(?:\.only|\.skip)?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])+)\1/
const BRACKET_ID_RE = /\[([a-zA-Z][a-zA-Z0-9._-]*)\]/g

/** 単一ファイル内のコメントタグと test("[id] ...") からアンカーを抽出する */
export function extractAnchorsFromSource(relFile: string, source: string, out: CodeAnchor[]): void {
  const lines = source.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!
    const lineNum = i + 1

    // コメント内の @implements / @verifies (文字列リテラル内のフィクスチャ文字列を除外)
    const commentStart = findCommentPart(lineText)
    if (commentStart !== null) {
      COMMENT_TAG_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = COMMENT_TAG_RE.exec(commentStart)) !== null) {
        const kind = m[1] as 'implements' | 'verifies'
        const rawIds = m[2]!
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
        for (const id of rawIds) {
          if (BLOCK_ID_PATTERN.test(id)) {
            out.push({ kind, specId: id, file: relFile, line: lineNum })
          }
        }
      }
    }

    // 行頭の test('[spec.id] ...') / it("[spec.id] ...")
    const tm = TEST_CALL_RE.exec(lineText)
    if (tm) {
      const testName = tm[2]!
      BRACKET_ID_RE.lastIndex = 0
      let bm: RegExpExecArray | null
      while ((bm = BRACKET_ID_RE.exec(testName)) !== null) {
        const specId = bm[1]!
        if (specId.includes('.')) {
          out.push({ kind: 'verifies', specId, file: relFile, line: lineNum, testName })
        }
      }
    }
  }
}

/** 文字列リテラル外に出現するコメント部分だけを抽出する */
function findCommentPart(line: string): string | null {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
    return trimmed
  }
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote) {
      if (ch === '\\') {
        i++
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '/' && line[i + 1] === '/') {
      return line.slice(i)
    }
  }
  return null
}

const junitXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
})

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function collectTestcases(node: unknown, out: Record<string, unknown>[]): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectTestcases(item, out)
    return
  }
  const obj = node as Record<string, unknown>
  if ('testcase' in obj) {
    for (const tc of toArray(obj.testcase)) {
      if (tc && typeof tc === 'object') out.push(tc as Record<string, unknown>)
    }
  }
  for (const [key, val] of Object.entries(obj)) {
    if (key === 'testcase' || key.startsWith('@_') || key === '#text') continue
    collectTestcases(val, out)
  }
}

function extractFailureMessage(node: unknown): string | undefined {
  const first = toArray(node)[0]
  if (typeof first === 'string') return first.trim().slice(0, 200) || undefined
  if (first && typeof first === 'object') {
    const obj = first as Record<string, unknown>
    const attrMsg = typeof obj['@_message'] === 'string' ? obj['@_message'].trim() : ''
    if (attrMsg) return attrMsg
    const textMsg = typeof obj['#text'] === 'string' ? obj['#text'].trim().slice(0, 200) : ''
    if (textMsg) return textMsg
  }
  return undefined
}

/** JUnit XML テストレポートから `[spec.id]` 付きのテスト結果を抽出する */
export function parseJunitXml(xml: string): TestCaseResult[] {
  let parsed: unknown
  try {
    parsed = junitXmlParser.parse(xml)
  } catch {
    return []
  }

  const testcases: Record<string, unknown>[] = []
  collectTestcases(parsed, testcases)

  const results: TestCaseResult[] = []
  for (const tc of testcases) {
    const name = typeof tc['@_name'] === 'string' ? tc['@_name'] : ''
    if (!name) continue

    const specIds: string[] = []
    BRACKET_ID_RE.lastIndex = 0
    let bm: RegExpExecArray | null
    while ((bm = BRACKET_ID_RE.exec(name)) !== null) {
      if (bm[1]!.includes('.')) specIds.push(bm[1]!)
    }
    if (specIds.length === 0) continue

    let status: TestCaseResult['status'] = 'passed'
    let message: string | undefined
    if ('failure' in tc || 'error' in tc) {
      status = 'failed'
      message = extractFailureMessage(tc.failure ?? tc.error)
    } else if ('skipped' in tc) {
      status = 'skipped'
    }

    const fileAttr = typeof tc['@_file'] === 'string' ? tc['@_file'] : undefined
    const classAttr = typeof tc['@_classname'] === 'string' ? tc['@_classname'] : undefined
    const file = fileAttr || classAttr || undefined
    for (const specId of specIds) {
      results.push({ specId, name, file, status, message })
    }
  }
  return results
}

export async function loadTestResults(
  projectRoot: string,
  docsDir: string,
  explicitPath?: string,
): Promise<TestCaseResult[]> {
  const candidates = explicitPath
    ? [path.resolve(explicitPath)]
    : [path.join(docsDir, '.documi/test-results.xml'), path.join(projectRoot, '.documi/test-results.xml')]

  for (const file of candidates) {
    try {
      const xml = await readFile(file, 'utf-8')
      return parseJunitXml(xml)
    } catch {
      // 次の候補を試す
    }
  }
  return []
}

/** gh CLI から PR 一覧を安全に取得する (未インストール・オフライン時は空配列) */
export function fetchPullRequestsViaGh(projectRoot: string): RawPullRequest[] {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--state', 'all', '--limit', '50', '--json', 'number,title,state,url,body'],
      { cwd: projectRoot, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const parsed: unknown = JSON.parse(out)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is RawPullRequest =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as RawPullRequest).number === 'number' &&
        typeof (p as RawPullRequest).title === 'string' &&
        typeof (p as RawPullRequest).url === 'string',
    )
  } catch {
    return []
  }
}

/** PR 本文・タイトルから Spec ID ごとの PR リンクを抽出する */
export function extractPrLinksBySpec(
  prs: readonly RawPullRequest[],
  knownBlockIds: ReadonlySet<string>,
): Map<string, PullRequestLink[]> {
  const map = new Map<string, PullRequestLink[]>()
  const push = (specId: string, link: PullRequestLink) => {
    const list = map.get(specId) ?? []
    if (!list.some((existing) => existing.number === link.number)) {
      list.push(link)
      map.set(specId, list)
    }
  }

  const headerRe = /(?:implements|satisfies|verifies)\s*:\s*([^\n]+)/gi

  for (const pr of prs) {
    const text = `${pr.title}\n${pr.body ?? ''}`
    headerRe.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = headerRe.exec(text)) !== null) {
      const relation = m[0].toLowerCase().startsWith('verifies') ? 'verifies' : 'implements'
      const ids = m[1]!
        .split(/[,\s]+/)
        .map((s) => s.replace(/^spec:/i, '').trim())
        .filter(Boolean)
      for (const id of ids) {
        if (knownBlockIds.has(id)) {
          push(id, { number: pr.number, title: pr.title, state: pr.state, url: pr.url, relation })
        }
      }
    }

    BRACKET_ID_RE.lastIndex = 0
    let bm: RegExpExecArray | null
    while ((bm = BRACKET_ID_RE.exec(text)) !== null) {
      const id = bm[1]!
      if (knownBlockIds.has(id)) {
        push(id, { number: pr.number, title: pr.title, state: pr.state, url: pr.url, relation: 'mentions' })
      }
    }
  }

  return map
}

/**
 * 全ドキュメントの <SourceRef> と <TermDef symbols="..."> を AST / 行範囲で実在検証する。
 */
export async function validateSourceLinks(
  projectRoot: string,
  index: DocsIndex,
): Promise<{ issues: IndexIssue[]; brokenSpecIds: Set<string> }> {
  const issues: IndexIssue[] = []
  const brokenSpecIds = new Set<string>()

  for (const doc of index.documents) {
    for (const ref of doc.sourceRefs) {
      try {
        if (ref.symbol) {
          await resolveSourceSymbol(projectRoot, ref.file, ref.symbol)
        } else if (ref.lines) {
          await resolveSourceLines(projectRoot, ref.file, ref.lines)
        }
      } catch (e) {
        const msg = e instanceof SourceError ? e.message : String(e)
        issues.push({
          code: 'broken-source-ref',
          message: `<SourceRef file="${ref.file}" ${ref.symbol ? `symbol="${ref.symbol}"` : `lines="${ref.lines ?? ''}"`} /> (L${ref.startLine}): ${msg}`,
          path: doc.path,
        })
        for (const id of [...ref.satisfies, ...ref.verifies]) {
          brokenSpecIds.add(id)
        }
      }
    }

    for (const block of doc.blocks) {
      if (block.kind !== 'term' || !block.symbols) continue
      for (const sym of block.symbols) {
        const [file, symbol] = sym.split('#')
        if (!file || !symbol) {
          issues.push({
            code: 'broken-term-symbol',
            message: `<TermDef id="${block.id}"> の symbol 形式が不正です ("file#Symbol" 形式が必要): ${sym}`,
            path: doc.path,
            blockId: block.id,
          })
          continue
        }
        try {
          await resolveSourceSymbol(projectRoot, file, symbol)
        } catch (e) {
          const msg = e instanceof SourceError ? e.message : String(e)
          issues.push({
            code: 'broken-term-symbol',
            message: `<TermDef id="${block.id}"> のシンボル ${sym} が解決できません: ${msg}`,
            path: doc.path,
            blockId: block.id,
          })
        }
      }
    }
  }

  return { issues, brokenSpecIds }
}

/**
 * ソース/テストアンカー・JUnit テスト結果・PR 情報を統合し、
 * DocsIndex の各ブロックに `realization` を自動算出・付与する。
 */
export async function enrichWithRealization(
  index: DocsIndex,
  options: TraceEnrichOptions,
): Promise<{ anchors: CodeAnchor[]; unknownAnchors: CodeAnchor[] }> {
  const anchors = await scanCodeAnchors(options.projectRoot, index)
  const testResults = await loadTestResults(options.projectRoot, index.rootDir, options.testReportPath)
  const prs = options.pullRequests ?? (options.fetchPrs ? fetchPullRequestsViaGh(options.projectRoot) : [])
  const knownIds = new Set(index.blocksById.keys())
  const prsBySpec = extractPrLinksBySpec(prs, knownIds)

  const implsBySpec = new Map<string, CodeAnchor[]>()
  const verifsBySpec = new Map<string, CodeAnchor[]>()
  const unknownAnchors: CodeAnchor[] = []

  for (const anchor of anchors) {
    if (!knownIds.has(anchor.specId)) {
      if (!anchor.fromDoc) unknownAnchors.push(anchor)
      continue
    }
    const targetMap = anchor.kind === 'implements' ? implsBySpec : verifsBySpec
    const list = targetMap.get(anchor.specId) ?? []
    list.push(anchor)
    targetMap.set(anchor.specId, list)
  }

  const resultsBySpec = new Map<string, TestCaseResult[]>()
  for (const r of testResults) {
    const list = resultsBySpec.get(r.specId) ?? []
    list.push(r)
    resultsBySpec.set(r.specId, list)
  }

  for (const block of index.blocksById.values()) {
    const implementations = implsBySpec.get(block.id) ?? []
    const verifications = verifsBySpec.get(block.id) ?? []
    const tests = resultsBySpec.get(block.id) ?? []
    const pullRequests = prsBySpec.get(block.id) ?? []

    const isNormativeSpec = block.kind === 'spec' && block.intent === 'normative'
    const hasAnyLink =
      implementations.length > 0 || verifications.length > 0 || tests.length > 0 || pullRequests.length > 0
    if (!isNormativeSpec && !hasAnyLink) continue

    const reasons: string[] = []
    const hasFailedTest = tests.some((t) => t.status === 'failed')
    const hasPassedTest = tests.some((t) => t.status === 'passed')
    const hasOpenPr = pullRequests.some((p) => p.state === 'OPEN')
    const hasCodeOrTest = implementations.length > 0 || verifications.length > 0
    const hasBrokenRef = options.brokenSpecIds?.has(block.id) ?? false

    let status: RealizationStatus
    if (hasFailedTest) {
      status = 'drifted'
      reasons.push('紐づくテストが失敗しています')
    } else if (hasBrokenRef) {
      status = 'drifted'
      reasons.push('紐づく <SourceRef> のシンボルまたは行範囲が壊れています')
    } else if (hasCodeOrTest && block.review === 'stale') {
      status = 'drifted'
      reasons.push('仕様が承認後に変更されており、実装との再確認が必要です')
    } else if (hasCodeOrTest && block.suspect) {
      status = 'drifted'
      reasons.push(`上流の変更により Suspect 状態です (${block.suspectSources.join(', ')})`)
    } else if (hasPassedTest && !hasFailedTest) {
      status = 'verified'
    } else if (hasOpenPr) {
      status = 'in-progress'
    } else if (hasCodeOrTest) {
      status = 'implemented'
    } else {
      status = 'unimplemented'
    }

    const summary: RealizationSummary = {
      status,
      implementations,
      verifications,
      testResults: tests,
      pullRequests,
      reasons,
    }
    block.realization = summary
  }

  return { anchors, unknownAnchors }
}
