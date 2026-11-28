#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs as parseNodeArgs } from 'node:util'
import { runDocsCheck } from './core/checker'
import { RAG_PROVIDERS, REVIEW_GATES, resolveProjectPaths } from './core/config'
import type { RagConfig, RagProvider, ReviewGate } from './core/config'
import {
  addBlockToDoc,
  renameBlockIdAcrossProject,
  scaffoldDocument,
  updateBlockInDocs,
  upsertTermInDocs,
} from './core/editor'
import { createEmbeddingProvider } from './core/embeddings'
import { retrieveContextHybrid, searchIndexHybrid } from './core/hybrid-retrieval'
import { initDocumiProject } from './core/init'
import type { InitLanguage } from './core/init'
import { loadDocuments } from './core/loader'
import {
  buildProjectMap,
  buildValidationPayload,
  collectSourceRefExports,
  getDocumentDetail,
  getImpactAnalysis,
  getNodeRelations,
  getSpecContext,
  listDocuments,
  querySpecs,
  searchDocuments,
} from './core/query'
import { retrieveContext } from './core/retrieval'
import { approveBlock, unapproveBlock } from './core/reviews'
import {
  ARTIFACT_TYPES,
  BLOCK_KINDS,
  DOC_SCOPES,
  TEST_LEVELS,
  isArtifactType,
  isDocScope,
  isNoteIntent,
  isReviewStatus,
  isSpecIntent,
  isStability,
  isTestLevel,
  REALIZATION_STATUSES,
  REVIEW_STATUSES,
  SPEC_INTENTS,
  STABILITIES,
} from './core/types'
import type {
  ArtifactType,
  BlockKind,
  DocScope,
  NoteIntent,
  RealizationStatus,
  ReviewStatus,
  SpecIntent,
  Stability,
  TestLevel,
} from './core/types'
import { syncVectorIndex } from './core/vector-store'
import { startMcpStdio } from './server/mcp'
import { DocsStore } from './server/store'

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
  readStdin: () => Promise<string>
}

const DEFAULT_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  readStdin: () => Bun.stdin.text(),
}

function usage(io: CliIo): void {
  io.out(USAGE_TEXT)
}

/** `documi <command> --help` 用に、そのコマンドの使い方と関連オプションだけを表示する。未知コマンドなら false */
function commandUsage(io: CliIo, command: string): boolean {
  const lines = USAGE_TEXT.split('\n')
  const usageLines = lines.filter((l) => l.startsWith(`  documi ${command} `))
  if (usageLines.length === 0) return false
  const annotated = new RegExp(`\\([^)]*\\b${command}\\b`)
  const globalOption = /^ {2}(--project|--docs|--json|-h,)/
  const optionLines = lines.filter((l) => /^ {2}(--|-h)/.test(l) && (globalOption.test(l) || annotated.test(l)))
  io.out(`Usage:\n${usageLines.join('\n')}\n\nOptions:\n${optionLines.join('\n')}`)
  return true
}

const USAGE_TEXT = `Documi CLI

Usage:
  documi init [options]                          Scaffold docs/ templates and Agent Skills for new or existing projects
  documi serve [options]                         Start Web UI, REST API, and MCP (HTTP) server
  documi mcp [options]                           Start MCP server over stdio (for AI editor integration)
  documi check [options]                         Validate documents, graph, AST symbols, and test results
  documi approve <block-id...> [opts]            Approve specified semantic blocks (updates reviews.json)
  documi unapprove <block-id...> [opts]          Revoke approval for specified semantic blocks (back to unreviewed)
  documi export [options]                        Export multiple documents as a single PDF or HTML bundle
  documi build-site [options]                    Build a read-only static site for any static hosting provider

  [Read & Search Commands for AI & Humans (all support --json)]
  documi map [options]                           Get Goals, Architecture, Outcomes, Glossary, and summary stats
  documi list [--type <type>] [options]          List documents
  documi show <doc-id> [options]                 Show document body, blocks, relations, and issues
  documi relations <id> [options]                Show outgoing and incoming references for a document or block
  documi impact <id> [options]                   Recursively list downstream docs, blocks, and code/tests affected by changing an ID
  documi search <query...> [options]             Search docs/blocks (BM25 + glossary / --semantic; --context for budgeted graph expansion)
  documi index [options]                         Build or incrementally sync the local Embedding cache (bun:sqlite)
  documi query [filters] [options]               Filter semantic blocks across multiple dimensions
  documi context <id> [options]                  Aggregate upstream Goals, related docs, Outcomes, Terms, and SourceRefs for a Spec

  documi card create [options]                   Create a review card from JSON (--body - for stdin)
  documi card list [options]                     List review cards in the operational store
  documi card get <card-id> [options]            Show one review card with its answer state
  documi card answer <card-id> [options]         Record an answer (--option <id> --finish provisional|committed [--write-in <text>])
  documi card distill <card-id> [options]        Distill a committed card into docs/decisions/ as a decision record

  [Precision Edit Commands for AI & Humans (all support --json)]
  documi block add <doc-id> [options]            Append a semantic block to a document
  documi block update <block-id> [options]       Safely update only the line range of an existing semantic block
  documi block rename <old-id> <new-id> [opts]   Rename a block ID across docs/, source code, and tests
  documi term upsert <term-id> [options]         Add or update a glossary term (<TermDef>)
  documi scaffold <rel-path> --title <t> [opts]  Create a new .mdx document with compliant frontmatter

Options:
  --project <dir>         Project root (default: cwd or DOCUMI_PROJECT_ROOT / parent of --docs)
  --docs <dir>            Docs directory (default: config docs, <project>/docs, or DOCUMI_DOCS_DIR)
  --mount <id>            Target docs mount ID in multi-docs projects (check / list / query / search / scaffold)
  --en / --ja             Language for generated Agent Skills and starter docs (default: en / --lang <en|ja>)
  --skills-dir <dir>      Agent Skills output directory (init, default: <project>/.agents/skills)
  --skills-only           Generate Agent Skills only without creating docs/ (init)
  --no-skills             Skip Agent Skills generation (init)
  --force-skills          Overwrite existing Documi SKILL.md files with the latest version (init)
  --port <number>         Listening port (serve, default: 3000 or PORT)
  --host <addr>           Bind address (serve, default: 127.0.0.1 or HOST)
  --test-report <xml>     Path to JUnit XML test report (check / map / query / context)
  --review-gate <level>   Graduated review gate: none|stable|all (check, default: config reviewGate or none)
  --strict                Treat all unreviewed, stale, and drifted blocks as errors (check)
  --no-review-edit        Fail if docs/guard/reviews.json has uncommitted Git changes (check)
  --prs                   Fetch and link PRs via gh CLI (check)
  --author <name>         Reviewer name (approve)
  --note <text>           Optional approval note (approve)
  --type <type>           Artifact type (list / search / scaffold)
  --limit <n>             Maximum result count (search default: 20, or 8 with --context)
  --depth <n>             Maximum downstream traversal depth (impact, default: 4)
  --context               Return budgeted graph-expanded context in search (Goals, Outcomes, Terms, SourceRefs)
  --budget <chars>        Character budget for search --context output (search, default: 6000)
  --no-graph              Disable graph neighborhood expansion in search --context (search)
  --semantic              Enable local Embedding + RRF hybrid search in search (--no-semantic to disable)
  --provider <name>       Embedding provider: ollama|openai|gemini (index / search, default: ollama)
  --model <id>            Embedding model ID (Ollama default: embeddinggemma / OpenAI default: text-embedding-3-small)
  --endpoint <url>        Ollama / OpenAI-compatible endpoint URL
  --api-key-env <var>     Environment variable name holding the OpenAI-compatible API key (default: OPENAI_API_KEY)
  --kind <kind>           Block kind: spec|constraint|decision|test|note|term (query / block add)
  --intent <intent>       Intent: normative|idea|rejected|informative (query / block)
  --stability <level>     Stability: stable|evolving|volatile (query / block)
  --summary <text>        One-line conclusion summary for <Decision> (block)
  --level <level>         Test level for <Test>: unit|integration|e2e|contract|manual (block)
  --review <status>       Review status: unreviewed|approved|stale (query)
  --realization <status>  Realization status: unimplemented|in-progress|implemented|verified|drifted (query)
  --suspect               Only include suspect blocks (query, --no-suspect to exclude)
  --q <text>              Keyword filter for ID or body (query)
  --id <block-id>         New block ID (block add)
  --body <text>           Block/document body (use "-" to read from stdin)
  --body-file <file>      File path to read block/document body from
  --definition <text>     Term definition body (term upsert, use "-" for stdin)
  --after-heading <text>  Heading text after which to insert (block add)
  --derives <a,b>         Comma-separated derives references
  --supersedes <a,b>      Comma-separated supersedes references
  --satisfies <a,b>       Comma-separated satisfies references (scaffold)
  --verifies <a,b>        Comma-separated verifies references (scaffold)
  --tags <a,b>            Comma-separated tags (scaffold)
  --description <text>    Short description (scaffold)
  --date <YYYY-MM-DD>     Decision date (scaffold)
  --scope <scope>         Export scope (export), Document scope "system" (scaffold), or Constraint scope (block)
  --aliases <a,b>         Comma-separated term aliases (block / term)
  --anti-terms <a,b>      Comma-separated forbidden/confused anti-terms (block / term)
  --domain-context <ctx>  Optional Bounded Context name for a term (block / term)
  --symbols <a,b>         Comma-separated code symbols (block / term)
  --doc <doc-id>          Target glossary document ID (term upsert, default: domain/glossary)
  --dry-run               Preview planned changes without writing files (block rename)
  --format <fmt>          Output format: text|github (check, default: text) or pdf|html (export, default: pdf)
  --ids <a,b,c>           Comma-separated document IDs to export (export)
  --title <text>          Cover title (export) or document/block title (scaffold / block)
  --out <file>            Output file or directory (export default: documi-bundle.pdf|html / build-site default: ./dist-site)
  --base <path>           Asset base path for static site (build-site, default: ./)
  --no-code               Exclude Code Explorer and source snippets (build-site)
  --revisions <n>         Max historical commits bundled per document (build-site, default: 5)
  --json                  Output results as JSON
  --full                  Include full body and detail arrays in map / query / context JSON output
  -h, --help              Show this help`

const CLI_OPTIONS = {
  docs: { type: 'string' },
  project: { type: 'string' },
  mount: { type: 'string' },
  ja: { type: 'boolean' },
  en: { type: 'boolean' },
  lang: { type: 'string' },
  'skills-dir': { type: 'string' },
  'skills-only': { type: 'boolean' },
  'no-skills': { type: 'boolean' },
  'force-skills': { type: 'boolean' },
  port: { type: 'string' },
  host: { type: 'string' },
  'test-report': { type: 'string' },
  author: { type: 'string' },
  note: { type: 'string' },
  option: { type: 'string' },
  finish: { type: 'string' },
  'write-in': { type: 'string' },
  format: { type: 'string' },
  scope: { type: 'string' },
  ids: { type: 'string' },
  title: { type: 'string' },
  out: { type: 'string' },
  base: { type: 'string' },
  'no-code': { type: 'boolean' },
  revisions: { type: 'string' },
  strict: { type: 'boolean' },
  'review-gate': { type: 'string' },
  'no-review-edit': { type: 'boolean' },
  prs: { type: 'boolean' },
  type: { type: 'string' },
  limit: { type: 'string' },
  depth: { type: 'string' },
  context: { type: 'boolean' },
  budget: { type: 'string' },
  'no-graph': { type: 'boolean' },
  semantic: { type: 'boolean' },
  'no-semantic': { type: 'boolean' },
  provider: { type: 'string' },
  model: { type: 'string' },
  endpoint: { type: 'string' },
  'api-key-env': { type: 'string' },
  kind: { type: 'string' },
  intent: { type: 'string' },
  stability: { type: 'string' },
  summary: { type: 'string' },
  level: { type: 'string' },
  review: { type: 'string' },
  realization: { type: 'string' },
  suspect: { type: 'boolean' },
  'no-suspect': { type: 'boolean' },
  q: { type: 'string' },
  id: { type: 'string' },
  body: { type: 'string' },
  'body-file': { type: 'string' },
  definition: { type: 'string' },
  'after-heading': { type: 'string' },
  derives: { type: 'string' },
  supersedes: { type: 'string' },
  satisfies: { type: 'string' },
  verifies: { type: 'string' },
  tags: { type: 'string' },
  description: { type: 'string' },
  date: { type: 'string' },
  aliases: { type: 'string' },
  'anti-terms': { type: 'string' },
  'domain-context': { type: 'string' },
  symbols: { type: 'string' },
  doc: { type: 'string' },
  'dry-run': { type: 'boolean' },
  full: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

type CliFlags = Partial<Record<keyof typeof CLI_OPTIONS, string | boolean>>

interface ParsedArgs {
  command?: string
  positionals: string[]
  flags: CliFlags
}

class CliArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliArgError'
  }
}

const GLOBAL_ALLOWED_FLAGS = new Set<string>(['docs', 'project', 'help'])

const COMMAND_ALLOWED_FLAGS: Record<string, ReadonlySet<string>> = {
  card: new Set(['json', 'body', 'body-file', 'option', 'finish', 'write-in']),
  init: new Set(['ja', 'en', 'lang', 'skills-dir', 'skills-only', 'no-skills', 'force-skills', 'json']),
  serve: new Set(['port', 'host', 'test-report']),
  mcp: new Set(['test-report']),
  check: new Set(['mount', 'test-report', 'strict', 'review-gate', 'no-review-edit', 'prs', 'format', 'json']),
  approve: new Set(['author', 'note']),
  unapprove: new Set([]),
  export: new Set(['format', 'scope', 'ids', 'title', 'out', 'test-report']),
  'build-site': new Set(['out', 'base', 'no-code', 'revisions', 'test-report']),
  map: new Set(['test-report', 'full', 'json']),
  list: new Set(['type', 'mount', 'json']),
  show: new Set(['test-report', 'json']),
  relations: new Set(['json']),
  impact: new Set(['depth', 'test-report', 'json']),
  search: new Set([
    'type',
    'mount',
    'limit',
    'context',
    'budget',
    'no-graph',
    'semantic',
    'no-semantic',
    'provider',
    'model',
    'endpoint',
    'api-key-env',
    'test-report',
    'json',
  ]),
  index: new Set(['provider', 'model', 'endpoint', 'api-key-env', 'json']),
  query: new Set([
    'kind',
    'intent',
    'stability',
    'review',
    'realization',
    'suspect',
    'no-suspect',
    'mount',
    'q',
    'test-report',
    'full',
    'json',
  ]),
  context: new Set(['test-report', 'full', 'json']),
  block: new Set([
    'kind',
    'id',
    'body',
    'body-file',
    'after-heading',
    'title',
    'summary',
    'date',
    'level',
    'verifies',
    'stability',
    'intent',
    'derives',
    'supersedes',
    'scope',
    'aliases',
    'anti-terms',
    'domain-context',
    'symbols',
    'dry-run',
    'json',
  ]),
  term: new Set([
    'definition',
    'body',
    'body-file',
    'aliases',
    'anti-terms',
    'domain-context',
    'symbols',
    'doc',
    'json',
  ]),
  scaffold: new Set([
    'mount',
    'title',
    'type',
    'scope',
    'description',
    'date',
    'tags',
    'derives',
    'satisfies',
    'verifies',
    'body',
    'body-file',
    'json',
  ]),
}

function validateCommandFlags(command: string, flags: CliFlags): void {
  const allowed = COMMAND_ALLOWED_FLAGS[command]
  if (!allowed) return
  for (const key of Object.keys(flags)) {
    if (GLOBAL_ALLOWED_FLAGS.has(key) || allowed.has(key)) continue
    throw new CliArgError(`Option --${key} is not supported by "documi ${command}" (see documi ${command} --help)`)
  }
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const { values, positionals } = parseNodeArgs({
    args: argv,
    options: CLI_OPTIONS,
    allowPositionals: true,
    strict: false,
  })
  // strict: false は未知フラグを黙って受け入れるため、typo (例: --stict) で CI ゲートが素通りしないよう明示的に拒否する
  for (const key of Object.keys(values)) {
    if (!(key in CLI_OPTIONS)) {
      throw new CliArgError(`Unknown option: ${key.length === 1 ? '-' : '--'}${key} (see documi --help)`)
    }
  }
  return {
    command: positionals[0],
    positionals: positionals.slice(1),
    flags: values,
  }
}

function resolveCliPaths(flags: CliFlags) {
  const res = resolveProjectPaths({
    docs: typeof flags.docs === 'string' ? flags.docs : undefined,
    project: typeof flags.project === 'string' ? flags.project : undefined,
    testReport: typeof flags['test-report'] === 'string' ? flags['test-report'] : undefined,
  })
  if (res.isErr()) throw new CliArgError(res.error.message)
  return res.value
}

function getStringFlag(flags: CliFlags, key: keyof CliFlags): string | undefined {
  const value = flags[key]
  return typeof value === 'string' ? value : undefined
}

function parseCsvFlag(flags: CliFlags, key: keyof CliFlags): string[] | undefined {
  const raw = getStringFlag(flags, key)
  if (raw === undefined) return undefined
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return items
}

function isBlockKind(value: unknown): value is BlockKind {
  return typeof value === 'string' && (BLOCK_KINDS as readonly string[]).includes(value)
}

function isRealizationStatus(value: unknown): value is RealizationStatus {
  return typeof value === 'string' && (REALIZATION_STATUSES as readonly string[]).includes(value)
}

function parseOptionalArtifactType(flags: CliFlags): ArtifactType | undefined {
  const raw = getStringFlag(flags, 'type')
  if (raw === undefined) return undefined
  if (!isArtifactType(raw)) {
    throw new CliArgError(`Invalid --type: "${raw}" (allowed: ${ARTIFACT_TYPES.join(', ')})`)
  }
  return raw
}

function parseOptionalDocScope(flags: CliFlags): DocScope | undefined {
  const raw = getStringFlag(flags, 'scope')
  if (raw === undefined) return undefined
  if (!isDocScope(raw)) {
    throw new CliArgError(`Invalid --scope: "${raw}" (allowed: ${DOC_SCOPES.join(', ')})`)
  }
  return raw
}

function parseOptionalTestLevel(flags: CliFlags): TestLevel | undefined {
  const raw = getStringFlag(flags, 'level')
  if (raw === undefined) return undefined
  if (!isTestLevel(raw)) {
    throw new CliArgError(`Invalid --level: "${raw}" (allowed: ${TEST_LEVELS.join(', ')})`)
  }
  return raw
}

function parseOptionalBlockKind(flags: CliFlags): BlockKind | undefined {
  const raw = getStringFlag(flags, 'kind')
  if (raw === undefined) return undefined
  if (!isBlockKind(raw)) {
    throw new CliArgError(`Invalid --kind: "${raw}" (allowed: ${BLOCK_KINDS.join(', ')})`)
  }
  return raw
}

function parseOptionalStability(flags: CliFlags): Stability | undefined {
  const raw = getStringFlag(flags, 'stability')
  if (raw === undefined) return undefined
  if (!isStability(raw)) {
    throw new CliArgError(`Invalid --stability: "${raw}" (allowed: ${STABILITIES.join(', ')})`)
  }
  return raw
}

function parseOptionalSpecIntent(flags: CliFlags): SpecIntent | undefined {
  const raw = getStringFlag(flags, 'intent')
  if (raw === undefined) return undefined
  if (!isSpecIntent(raw)) {
    throw new CliArgError(`Invalid --intent: "${raw}" (allowed: ${SPEC_INTENTS.join(', ')})`)
  }
  return raw
}

function parseOptionalBlockIntent(flags: CliFlags): SpecIntent | NoteIntent | undefined {
  const raw = getStringFlag(flags, 'intent')
  if (raw === undefined) return undefined
  if (!isSpecIntent(raw) && !isNoteIntent(raw)) {
    throw new CliArgError(`Invalid --intent: "${raw}" (allowed: normative, idea, rejected, informative)`)
  }
  return raw
}

function parseOptionalReviewStatus(flags: CliFlags): ReviewStatus | undefined {
  const raw = getStringFlag(flags, 'review')
  if (raw === undefined) return undefined
  if (!isReviewStatus(raw)) {
    throw new CliArgError(`Invalid --review: "${raw}" (allowed: ${REVIEW_STATUSES.join(', ')})`)
  }
  return raw
}

function parseOptionalRealizationStatus(flags: CliFlags): RealizationStatus | undefined {
  const raw = getStringFlag(flags, 'realization')
  if (raw === undefined) return undefined
  if (!isRealizationStatus(raw)) {
    throw new CliArgError(`Invalid --realization: "${raw}" (allowed: ${REALIZATION_STATUSES.join(', ')})`)
  }
  return raw
}

function resolveInitLanguage(flags: CliFlags): InitLanguage {
  const hasJa = flags.ja === true
  const hasEn = flags.en === true
  const langFlag = getStringFlag(flags, 'lang')?.trim().toLowerCase()

  if (hasJa && hasEn) {
    throw new CliArgError('--ja and --en cannot be used together')
  }
  if (langFlag !== undefined && langFlag !== 'en' && langFlag !== 'ja') {
    throw new CliArgError(`Invalid --lang: "${langFlag}" (allowed: en, ja)`)
  }
  if (hasJa && langFlag === 'en') {
    throw new CliArgError('--ja and --lang en cannot be used together')
  }
  if (hasEn && langFlag === 'ja') {
    throw new CliArgError('--en and --lang ja cannot be used together')
  }

  if (hasJa || langFlag === 'ja') return 'ja'
  return 'en'
}

async function resolveBodyContent(
  flags: CliFlags,
  io: CliIo,
  options: { allowDefinition?: boolean; required?: boolean } = {},
): Promise<string | undefined> {
  const bodyFile = getStringFlag(flags, 'body-file')
  const bodyFlag = getStringFlag(flags, 'body')
  const defFlag = options.allowDefinition ? getStringFlag(flags, 'definition') : undefined
  const inline = defFlag ?? bodyFlag

  if (bodyFile !== undefined && inline !== undefined) {
    throw new CliArgError('--body / --definition and --body-file cannot be used together')
  }
  if (bodyFile !== undefined) {
    return readFile(path.resolve(bodyFile), 'utf-8')
  }
  if (inline === '-') {
    return io.readStdin()
  }
  if (inline !== undefined) {
    return inline
  }
  if (options.required) {
    const label = options.allowDefinition ? '--definition or --body / --body-file' : '--body or --body-file'
    throw new CliArgError(`Please specify ${label}`)
  }
  return undefined
}

function printJson(io: CliIo, data: unknown): void {
  io.out(JSON.stringify(data, null, 2))
}

async function cmdInit(flags: CliFlags, io: CliIo): Promise<number> {
  const { docsDir, projectRoot } = resolveCliPaths(flags)
  const lang = resolveInitLanguage(flags)
  const skillsDir = typeof flags['skills-dir'] === 'string' ? path.resolve(flags['skills-dir']) : undefined
  const result = await initDocumiProject({
    docsDir,
    projectRoot,
    lang,
    skillsDir,
    skillsOnly: flags['skills-only'] === true,
    noSkills: flags['no-skills'] === true,
    forceSkills: flags['force-skills'] === true,
  })

  if (flags.json === true) {
    printJson(io, result)
    return 0
  }

  if (flags['skills-only'] !== true) {
    io.out(`Documi Init (docs, lang=${result.lang}): ${result.docsDir}`)
    for (const rel of result.createdDocs) io.out(`  + created ${rel}`)
    for (const rel of result.skippedDocs) io.out(`  - skipped ${rel} (already exists)`)
  }
  if (flags['no-skills'] !== true) {
    io.out(`Documi Init (Agent Skills, lang=${result.lang}): ${result.skillsDir}`)
    for (const rel of result.createdSkills) io.out(`  + created ${rel}`)
    for (const rel of result.updatedSkills) io.out(`  ~ updated ${rel}`)
    for (const rel of result.skippedSkills) io.out(`  - skipped ${rel} (already exists)`)
  }
  io.out('\nRecommended .gitignore entry:')
  io.out('  .documi/')
  io.out('\nAI Integration (either option works standalone):')
  io.out('  1. CLI + Agent Skills (no MCP config needed):')
  io.out(
    '     Skills in .agents/skills/ are loaded automatically and use documi map / search / query / context / block',
  )
  io.out('  2. MCP Server (no skills needed; built-in instructions):')
  io.out(
    JSON.stringify(
      {
        mcpServers: {
          documi: {
            command: 'documi',
            args: ['mcp', '--project', projectRoot],
          },
        },
      },
      null,
      2,
    ),
  )
  io.out('\nNext steps:')
  io.out('  documi check')
  io.out('  documi map')
  io.out('  documi mcp')
  return 0
}

async function cmdMcp(flags: CliFlags): Promise<number> {
  const { docsDir, docsMounts, projectRoot, testReportPath, testReportPaths, config } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, { mounts: docsMounts, projectRoot, testReportPath, testReportPaths })
  const stopWatch = store.watch()

  process.on('SIGINT', () => {
    stopWatch()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    stopWatch()
    process.exit(0)
  })

  await startMcpStdio(store, projectRoot, config.rag)
  // stdio 接続が閉じるまで待機
  await new Promise(() => {})
  return 0
}

function parseOptionalReviewGate(flags: CliFlags): ReviewGate | undefined {
  const raw = getStringFlag(flags, 'review-gate')
  if (raw === undefined) return undefined
  if (!(REVIEW_GATES as readonly string[]).includes(raw)) {
    throw new CliArgError(`Invalid --review-gate: "${raw}" (allowed: ${REVIEW_GATES.join(', ')})`)
  }
  return raw as ReviewGate
}

function escapeGithubAnnotationData(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

function escapeGithubAnnotationProp(value: string): string {
  return escapeGithubAnnotationData(value).replaceAll(':', '%3A').replaceAll(',', '%2C')
}

function toProjectRelAnnotationPath(
  projectRoot: string,
  report: Awaited<ReturnType<typeof runDocsCheck>>,
  rawPath?: string,
): string | undefined {
  if (!rawPath) return undefined
  const doc = report.index.documents.find((d) => d.path === rawPath)
  if (doc) {
    const mount = report.index.mounts.find((m) => m.id === doc.mountId)
    if (mount) {
      const rel = path
        .relative(projectRoot, path.join(mount.dir, doc.mountRelPath || doc.path))
        .split(path.sep)
        .join('/')
      if (rel && !rel.startsWith('..')) return rel
    }
  }
  const slashIdx = rawPath.indexOf('/')
  if (slashIdx > 0) {
    const prefix = rawPath.slice(0, slashIdx)
    const mount = report.index.mounts.find((m) => m.prefixed && m.id === prefix)
    if (mount) {
      const rel = path
        .relative(projectRoot, path.join(mount.dir, rawPath.slice(slashIdx + 1)))
        .split(path.sep)
        .join('/')
      if (rel && !rel.startsWith('..')) return rel
    }
  }
  const primaryRel = path.relative(projectRoot, path.join(report.docsDir, rawPath)).split(path.sep).join('/')
  return rawPath.includes('/') && !primaryRel.startsWith('..')
    ? rawPath
    : primaryRel.startsWith('..')
      ? rawPath
      : primaryRel
}

async function cmdCheck(flags: CliFlags, io: CliIo): Promise<number> {
  const { docsDir, docsMounts, projectRoot, testReportPath, testReportPaths, config } = resolveCliPaths(flags)
  const reviewGate = parseOptionalReviewGate(flags) ?? config.reviewGate
  const mount = getStringFlag(flags, 'mount')
  const format = getStringFlag(flags, 'format') ?? 'text'
  if (format !== 'text' && format !== 'github') {
    throw new CliArgError(`Invalid --format for check: "${format}" (allowed: text, github)`)
  }

  const report = await runDocsCheck({
    docsDir,
    mounts: docsMounts,
    mount,
    projectRoot,
    testReportPath,
    testReportPaths,
    strict: flags.strict === true,
    reviewGate,
    noReviewEdit: flags['no-review-edit'] === true,
    fetchPrs: flags.prs === true,
  })

  if (flags.json === true) {
    printJson(io, {
      ok: report.ok,
      docsDir: report.docsDir,
      ...(report.mount ? { mount: report.mount } : {}),
      documentCount: report.documentCount,
      blockCount: report.blockCount,
      reviewCounts: report.reviewCounts,
      realizationCounts: report.realizationCounts,
      signalEvaluations: report.signalEvaluations,
      health: report.health,
      errors: report.errors,
      warnings: report.warnings,
    })
    return report.ok ? 0 : 1
  }

  if (format === 'github') {
    for (const err of report.errors) {
      const file = toProjectRelAnnotationPath(projectRoot, report, err.path)
      const props = [
        file ? `file=${escapeGithubAnnotationProp(file)}` : '',
        `title=${escapeGithubAnnotationProp(err.code)}`,
      ]
        .filter(Boolean)
        .join(',')
      io.out(`::error ${props}::${escapeGithubAnnotationData(err.message)}`)
    }
    for (const warn of report.warnings) {
      const file = toProjectRelAnnotationPath(projectRoot, report, warn.path)
      const props = [
        file ? `file=${escapeGithubAnnotationProp(file)}` : '',
        `title=${escapeGithubAnnotationProp(warn.code)}`,
      ]
        .filter(Boolean)
        .join(',')
      io.out(`::warning ${props}::${escapeGithubAnnotationData(warn.message)}`)
    }
    return report.ok ? 0 : 1
  }

  io.out(`Documi Check: ${report.docsDir}${report.mount ? ` (mount=${report.mount})` : ''}`)
  io.out(`  documents:   ${report.documentCount} (${report.blockCount} blocks)`)
  io.out(
    `  reviews:     approved=${report.reviewCounts.approved} unreviewed=${report.reviewCounts.unreviewed} stale=${report.reviewCounts.stale} suspect=${report.reviewCounts.suspect}`,
  )
  io.out(
    `  realization: verified=${report.realizationCounts.verified} implemented=${report.realizationCounts.implemented} in-progress=${report.realizationCounts['in-progress']} unimplemented=${report.realizationCounts.unimplemented} drifted=${report.realizationCounts.drifted}`,
  )
  io.out(
    `  coverage:    design=${report.health.designCoveredSpecs}/${report.health.totalNormativeSpecs} test=${report.health.testCoveredSpecs}/${report.health.totalNormativeSpecs}`,
  )

  if (report.signalEvaluations.length > 0) {
    const achieved = report.signalEvaluations.filter((x) => x.status === 'achieved').length
    const notAchieved = report.signalEvaluations.filter((x) => x.status === 'not-achieved').length
    const unevaluated = report.signalEvaluations.filter((x) => x.status === 'unevaluated').length
    io.out(`\nSignals (achieved=${achieved} not-achieved=${notAchieved} unevaluated=${unevaluated}):`)
    for (const sig of report.signalEvaluations) {
      if (sig.status === 'unevaluated') {
        io.out(`  - [unevaluated] ${sig.id} (method=${sig.method})`)
      } else {
        const mark = sig.status === 'achieved' ? '✓' : '✗'
        io.out(`  ${mark} [${sig.status}] ${sig.id}: ${sig.metric} ${sig.op} ${sig.expected} (actual=${sig.actual})`)
      }
    }
  }

  if (report.health.hints.length > 0) {
    io.out(`\nHealth Hints (${report.health.hints.length}, advisory):`)
    for (const h of report.health.hints) {
      io.out(`  ℹ [${h.code}] ${h.message}`)
    }
  }

  if (report.warnings.length > 0) {
    io.out(`\nWarnings (${report.warnings.length}):`)
    for (const w of report.warnings) {
      io.out(`  ⚠ [${w.code}] ${w.path ? `${w.path}: ` : ''}${w.message}`)
    }
  }

  if (report.errors.length > 0) {
    io.out(`\nErrors (${report.errors.length}):`)
    for (const e of report.errors) {
      io.out(`  ✗ [${e.code}] ${e.path ? `${e.path}: ` : ''}${e.message}`)
    }
  }

  io.out(report.ok ? '\n✓ Check passed' : `\n✗ Check failed (${report.errors.length} errors)`)
  return report.ok ? 0 : 1
}

async function cmdApprove(ids: string[], flags: CliFlags, io: CliIo): Promise<number> {
  if (ids.length === 0) {
    io.err('Specify at least one block ID to approve (e.g. documi approve auth.lockout)')
    return 1
  }
  const { docsDir, docsMounts, projectRoot } = resolveCliPaths(flags)
  const author = typeof flags.author === 'string' ? flags.author : undefined
  const note = typeof flags.note === 'string' ? flags.note : undefined
  const index = await loadDocuments(docsDir, { mounts: docsMounts })

  let failed = 0
  for (const id of ids) {
    const res = await approveBlock(docsDir, index, id, { author, note, cacheRoot: projectRoot })
    if (res.isErr()) {
      io.err(`✗ ${id}: ${res.error.message}`)
      failed++
      continue
    }
    const rec = res.value
    const bySuffix = rec.approvedBy ? ` by ${rec.approvedBy}` : ''
    io.out(`✓ Approved ${id} (${rec.hash.slice(0, 19)}…${bySuffix})`)
  }
  return failed > 0 ? 1 : 0
}

async function cmdUnapprove(ids: string[], flags: CliFlags, io: CliIo): Promise<number> {
  if (ids.length === 0) {
    io.err('Specify at least one block ID to unapprove (e.g. documi unapprove auth.lockout)')
    return 1
  }
  const { docsDir, docsMounts, projectRoot } = resolveCliPaths(flags)
  const index = await loadDocuments(docsDir, { mounts: docsMounts })

  let failed = 0
  for (const id of ids) {
    const res = await unapproveBlock(docsDir, index, id, { cacheRoot: projectRoot })
    if (res.isErr()) {
      io.err(`✗ ${id}: ${res.error.message}`)
      failed++
      continue
    }
    io.out(res.value.removed ? `✓ Unapproved ${id}` : `- ${id} is not approved (no changes)`)
  }
  return failed > 0 ? 1 : 0
}

// ---------- AI & 人間向け 読み取り・検索コマンド ----------
// @implements core.ai-cli

async function cmdMap(flags: CliFlags, io: CliIo): Promise<number> {
  const { docsDir, docsMounts, projectRoot, testReportPath, testReportPaths } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, { mounts: docsMounts, projectRoot, testReportPath, testReportPaths })
  const map = buildProjectMap(store.getIndex(), { full: flags.full === true })

  if (flags.json === true) {
    printJson(io, map)
    return 0
  }

  io.out(`Documi Project Map (${map.documentCount} docs, ${map.blockCount} blocks, ${map.issueCount} issues)`)
  io.out(
    `  reviews:     approved=${map.reviewSummary.approved} unreviewed=${map.reviewSummary.unreviewed} stale=${map.reviewSummary.stale} suspect=${map.reviewSummary.suspect}`,
  )
  io.out(
    `  realization: verified=${map.realizationSummary.verified} implemented=${map.realizationSummary.implemented} in-progress=${map.realizationSummary['in-progress']} unimplemented=${map.realizationSummary.unimplemented} drifted=${map.realizationSummary.drifted}`,
  )
  io.out(
    `  coverage:    design=${map.health.designCoveredSpecs}/${map.health.totalNormativeSpecs} test=${map.health.testCoveredSpecs}/${map.health.totalNormativeSpecs}${map.health.hints.length > 0 ? ` (${map.health.hints.length} health hints)` : ''}`,
  )

  if (map.goals.length > 0) {
    io.out(`\nGoals (${map.goals.length}):`)
    for (const g of map.goals) io.out(`  - ${g.id}: ${g.title}`)
  }
  if (map.goalConstraints.length > 0) {
    io.out(`\nGoal Constraints (${map.goalConstraints.length}):`)
    for (const c of map.goalConstraints) {
      const firstLine = c.body.trim().split('\n')[0] ?? ''
      io.out(`  - ${c.id} (${c.docId}): ${firstLine}`)
    }
  }
  if (map.systemDesigns.length > 0) {
    io.out(`\nSystem Designs (${map.systemDesigns.length}):`)
    for (const a of map.systemDesigns) io.out(`  - ${a.id}: ${a.title}`)
  }
  if (map.systemConstraints.length > 0) {
    io.out(`\nSystem Constraints (${map.systemConstraints.length}):`)
    for (const c of map.systemConstraints) {
      const firstLine = c.body.trim().split('\n')[0] ?? ''
      io.out(`  - ${c.id} (${c.docId}): ${firstLine}`)
    }
  }
  if (map.decisions.length > 0) {
    const supersededNote =
      map.supersededDecisions.length > 0 ? `, ${map.supersededDecisions.length} superseded hidden` : ''
    io.out(`\nDecisions (${map.decisions.length} active${supersededNote}):`)
    for (const o of map.decisions) {
      const firstLine = o.body.trim().split('\n')[0] ?? ''
      io.out(`  - ${o.id} (${o.docId}${o.date ? `, ${o.date}` : ''}): ${firstLine}`)
    }
  }
  if (map.domainModels.length > 0) {
    io.out(`\nDomain Models (${map.domainModels.length}):`)
    for (const d of map.domainModels) io.out(`  - ${d.id}: ${d.title}`)
  }
  if (map.domainInvariants.length > 0) {
    io.out(`\nDomain Invariants (${map.domainInvariants.length}):`)
    for (const inv of map.domainInvariants) {
      const firstLine = inv.body.trim().split('\n')[0] ?? ''
      io.out(`  - ${inv.id} (${inv.docId}): ${firstLine}`)
    }
  }
  if (map.terms.length > 0) {
    io.out(`\nDomain Terms (${map.terms.length}):`)
    for (const t of map.terms) {
      const aliases = t.aliases.length > 0 ? ` [${t.aliases.join(', ')}]` : ''
      const ctx = t.context ? ` @${t.context}` : ''
      const avoid = t.antiTerms.length > 0 ? ` (avoid: ${t.antiTerms.join(', ')})` : ''
      io.out(`  - ${t.id}${ctx}${aliases}${avoid}`)
    }
  }
  return 0
}

async function cmdList(flags: CliFlags, io: CliIo): Promise<number> {
  const type = parseOptionalArtifactType(flags)
  const mount = getStringFlag(flags, 'mount')
  const { docsDir, docsMounts } = resolveCliPaths(flags)
  const index = await loadDocuments(docsDir, { mounts: docsMounts })
  const res = listDocuments(index, type, mount)

  if (flags.json === true) {
    printJson(io, res)
    return 0
  }

  io.out(`Documents (${res.count}):`)
  for (const d of res.documents) {
    const datePart = d.date ? ` [${d.date}]` : ''
    io.out(`  [${d.type}] ${d.id}${datePart} — ${d.title}`)
  }
  return 0
}

async function cmdShow(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  const id = positionals[0]
  if (!id) throw new CliArgError('Document ID is required (e.g. documi show specs/document-model)')
  const { docsDir, docsMounts, projectRoot, testReportPath, testReportPaths } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, { mounts: docsMounts, projectRoot, testReportPath, testReportPaths })
  const detail = getDocumentDetail(store.getIndex(), id)
  if (!detail) {
    io.err(`✗ Document not found: ${id}`)
    return 1
  }

  if (flags.json === true) {
    printJson(io, detail)
    return 0
  }

  io.out(`[${detail.type}] ${detail.id} — ${detail.title}`)
  io.out(`path: ${detail.path}`)
  if (detail.blocks.length > 0) {
    io.out(`blocks (${detail.blocks.length}):`)
    for (const b of detail.blocks) {
      const real = b.realization ? ` realization=${b.realization.status}` : ''
      io.out(`  - ${b.id} (${b.kind}, L${b.startLine}-L${b.endLine}, review=${b.review}${real})`)
    }
  }
  io.out('')
  io.out(detail.body)
  return 0
}

async function cmdRelations(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  const id = positionals[0]
  if (!id) throw new CliArgError('Document ID or block ID is required (e.g. documi relations core.document-model)')
  const { docsDir, docsMounts } = resolveCliPaths(flags)
  const index = await loadDocuments(docsDir, { mounts: docsMounts })
  const rel = getNodeRelations(index, id)
  if (!rel) {
    io.err(`✗ Document or block not found: ${id}`)
    return 1
  }

  if (flags.json === true) {
    printJson(io, rel)
    return 0
  }

  io.out(`Relations for ${rel.id} (${rel.kind})`)
  if (rel.kind === 'doc') {
    io.out(`  outgoing (${rel.outgoing.length}):`)
    for (const e of rel.outgoing) io.out(`    --${e.kind}--> ${e.ref} (${e.title})`)
    io.out(`  incoming (${rel.incoming.length}):`)
    for (const e of rel.incoming) io.out(`    <--${e.kind}-- ${e.ref} (${e.title})`)
  } else {
    io.out(`  outgoing (${rel.outgoing.length}):`)
    for (const e of rel.outgoing) io.out(`    --${e.kind}--> ${e.to}`)
    io.out(`  incoming (${rel.incoming.length}):`)
    for (const e of rel.incoming) io.out(`    <--${e.kind}-- ${e.from}`)
  }
  return 0
}

async function cmdImpact(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  const id = positionals[0]
  if (!id) throw new CliArgError('Document ID or block ID is required (e.g. documi impact core.document-model)')
  const depthRaw = getStringFlag(flags, 'depth')
  let maxDepth: number | undefined
  if (depthRaw !== undefined) {
    const parsed = Number(depthRaw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) {
      throw new CliArgError(`--depth must be an integer between 1 and 12: "${depthRaw}"`)
    }
    maxDepth = parsed
  }

  const { docsDir, docsMounts, projectRoot, testReportPath, testReportPaths } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, { mounts: docsMounts, projectRoot, testReportPath, testReportPaths })
  const impact = getImpactAnalysis(store.getIndex(), id, { maxDepth })
  if (!impact) {
    io.err(`✗ Document or block not found: ${id}`)
    return 1
  }

  if (flags.json === true) {
    printJson(io, impact)
    return 0
  }

  io.out(`Impact Analysis for ${impact.target.id} (${impact.target.kind}, maxDepth=${impact.maxDepth})`)
  io.out(`  affected documents: ${impact.affectedDocuments.length}`)
  for (const d of impact.affectedDocuments) {
    io.out(`    [depth=${d.depth}] [${d.type}] ${d.id} (${d.path}) via ${d.via.join(', ')} — ${d.title}`)
  }
  if (impact.affectedBlocks.length > 0) {
    io.out(`  affected blocks: ${impact.affectedBlocks.length}`)
    for (const b of impact.affectedBlocks) {
      io.out(`    [depth=${b.depth}] ${b.id} (${b.kind}, ${b.docId}, review=${b.review}) via ${b.via.join(', ')}`)
    }
  }
  if (impact.sourceRefs.length > 0) {
    io.out(`  linked SourceRefs: ${impact.sourceRefs.length}`)
    for (const r of impact.sourceRefs) {
      io.out(`    - ${r.file} (from ${r.docId})`)
    }
  }
  if (impact.codeAnchors.length > 0) {
    io.out(`  linked code/test anchors: ${impact.codeAnchors.length}`)
    for (const a of impact.codeAnchors) {
      io.out(`    - [${a.kind}] ${a.file}:${a.line} (${a.specId})${a.testName ? ` — ${a.testName}` : ''}`)
    }
  }
  return 0
}

function resolveCliRagConfig(flags: CliFlags, baseConfig?: RagConfig): RagConfig {
  const rawProvider = getStringFlag(flags, 'provider')
  let provider: RagProvider | undefined = baseConfig?.provider
  if (rawProvider !== undefined) {
    if (!(RAG_PROVIDERS as readonly string[]).includes(rawProvider)) {
      throw new CliArgError(`Invalid --provider: "${rawProvider}" (allowed: ${RAG_PROVIDERS.join(', ')})`)
    }
    provider = rawProvider as RagProvider
  }

  return {
    ...baseConfig,
    ...(provider ? { provider } : {}),
    ...(getStringFlag(flags, 'model') ? { model: getStringFlag(flags, 'model') } : {}),
    ...(getStringFlag(flags, 'endpoint') ? { endpoint: getStringFlag(flags, 'endpoint') } : {}),
    ...(getStringFlag(flags, 'api-key-env') ? { apiKeyEnv: getStringFlag(flags, 'api-key-env') } : {}),
  }
}

function shouldUseSemantic(flags: CliFlags, ragConfig?: RagConfig): boolean {
  if (flags.semantic === true && flags['no-semantic'] === true) {
    throw new CliArgError('--semantic and --no-semantic cannot be used together')
  }
  if (flags.semantic === true) return true
  if (flags['no-semantic'] === true) return false
  return ragConfig?.enabled === true
}

async function cmdIndex(flags: CliFlags, io: CliIo): Promise<number> {
  const { docsDir, docsMounts, projectRoot, config } = resolveCliPaths(flags)
  const ragConfig = resolveCliRagConfig(flags, config.rag)
  const provider = createEmbeddingProvider(ragConfig)
  const index = await loadDocuments(docsDir, { mounts: docsMounts })
  const syncRes = await syncVectorIndex(docsDir, index, provider, {
    cachePath: ragConfig.cachePath,
    projectRoot,
  })
  if (syncRes.isErr()) {
    io.err(`✗ ${syncRes.error.message}`)
    return 1
  }
  const res = syncRes.value

  if (flags.json === true) {
    printJson(io, res)
    return 0
  }

  io.out(`✓ Vector index synced (${res.modelId})`)
  io.out(`  db:     ${res.dbPath}`)
  io.out(`  chunks: total=${res.totalChunks} embedded=${res.embedded} cached=${res.cached} removed=${res.removed}`)
  return 0
}

async function cmdSearch(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  if (flags.context === true) {
    return await cmdSearchContext(positionals, flags, io)
  }
  const query = positionals.join(' ').trim()
  if (!query) throw new CliArgError('Search query is required (e.g. documi search "Rooted DAG")')
  const type = parseOptionalArtifactType(flags)
  const limitRaw = getStringFlag(flags, 'limit')
  let limit: number | undefined
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new CliArgError(`--limit must be an integer between 1 and 100: "${limitRaw}"`)
    }
    limit = parsed
  }

  const mount = getStringFlag(flags, 'mount')
  const { docsDir, docsMounts, projectRoot, config } = resolveCliPaths(flags)
  const index = await loadDocuments(docsDir, { mounts: docsMounts })
  const useSemantic = shouldUseSemantic(flags, config.rag)

  if (useSemantic) {
    const ragConfig = resolveCliRagConfig(flags, config.rag)
    const hybrid = await searchIndexHybrid(docsDir, index, query, {
      type,
      mount,
      limit: limit ?? 20,
      ragConfig,
      projectRoot,
    })
    const payload = {
      query,
      mode: hybrid.mode,
      ...(hybrid.modelId ? { modelId: hybrid.modelId } : {}),
      ...(hybrid.fallbackReason ? { fallbackReason: hybrid.fallbackReason } : {}),
      results: hybrid.hits,
      count: hybrid.hits.length,
    }
    if (flags.json === true) {
      printJson(io, payload)
      return 0
    }
    io.out(
      `Search "${query}" [${hybrid.mode}${hybrid.modelId ? ` / ${hybrid.modelId}` : ''}] (${hybrid.hits.length} hits):`,
    )
    if (hybrid.fallbackReason) io.out(`  ⚠ fallback to BM25: ${hybrid.fallbackReason}`)
    for (const hit of hybrid.hits) {
      const blockPart = hit.kind === 'block' ? ` #${hit.id}` : ''
      io.out(`  [${hit.type}] ${hit.docId}${blockPart} (score=${hit.score}) — ${hit.title}`)
      if (hit.snippet) io.out(`    ${hit.snippet}`)
    }
    return 0
  }

  const res = searchDocuments(index, query, { type, mount, limit })

  if (flags.json === true) {
    printJson(io, res)
    return 0
  }

  io.out(`Search "${res.query}" (${res.count} hits):`)
  for (const hit of res.results) {
    const blockPart = hit.kind === 'block' ? ` #${hit.id}` : ''
    io.out(`  [${hit.type}] ${hit.docId}${blockPart} (score=${hit.score}) — ${hit.title}`)
    if (hit.snippet) io.out(`    ${hit.snippet}`)
  }
  return 0
}

async function cmdSearchContext(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  const query = positionals.join(' ').trim()
  if (!query) {
    throw new CliArgError(
      'Search query or task description is required (e.g. documi search "static site export spec" --context)',
    )
  }
  const type = parseOptionalArtifactType(flags)
  const limitRaw = getStringFlag(flags, 'limit')
  let limit: number | undefined
  if (limitRaw !== undefined) {
    const parsed = Number(limitRaw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 30) {
      throw new CliArgError(`--limit must be an integer between 1 and 30: "${limitRaw}"`)
    }
    limit = parsed
  }
  const budgetRaw = getStringFlag(flags, 'budget')
  let budget: number | undefined
  if (budgetRaw !== undefined) {
    const parsed = Number(budgetRaw)
    if (!Number.isInteger(parsed) || parsed < 500 || parsed > 40000) {
      throw new CliArgError(`--budget must be an integer between 500 and 40000: "${budgetRaw}"`)
    }
    budget = parsed
  }

  const mount = getStringFlag(flags, 'mount')
  const { docsDir, docsMounts, projectRoot, testReportPath, testReportPaths, config } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, { mounts: docsMounts, projectRoot, testReportPath, testReportPaths })
  const useSemantic = shouldUseSemantic(flags, config.rag)
  const res = useSemantic
    ? await retrieveContextHybrid(docsDir, store.getIndex(), query, {
        type,
        mount,
        limit,
        budget,
        includeGraph: flags['no-graph'] !== true,
        ragConfig: resolveCliRagConfig(flags, config.rag),
        projectRoot,
      })
    : retrieveContext(store.getIndex(), query, {
        type,
        mount,
        limit,
        budget,
        includeGraph: flags['no-graph'] !== true,
      })

  if (flags.json === true) {
    printJson(io, res)
    return 0
  }

  const modelSuffix = res.modelId ? ` / ${res.modelId}` : ''
  io.out(
    `Retrieve "${res.query}" [${res.mode}${modelSuffix}] (${res.hits.length} hits, budget ${res.budgetUsed}/${res.budgetLimit})`,
  )
  if (res.fallbackReason) {
    io.out(`  ⚠ fallback to BM25: ${res.fallbackReason}`)
  }
  if (res.expandedTerms.length > 0) {
    io.out(`  glossary expanded: ${res.expandedTerms.join(', ')}`)
  }
  if (res.hits.length > 0) {
    io.out(`\nPrimary Hits (${res.hits.length}):`)
    for (const h of res.hits) {
      const loc = h.startLine ? `${h.docPath}:${h.startLine}-${h.endLine}` : h.docPath
      const status = h.realizationStatus ? ` ${h.realizationStatus}` : ''
      io.out(
        `  [${h.kind === 'block' ? (h.blockKind ?? 'block') : h.type}] ${h.id} (${loc}, score=${h.score}${status})`,
      )
      if (h.excerpt) io.out(`    ${h.excerpt}`)
    }
  }
  if (res.upstreamGoals.length > 0) {
    io.out(`\nUpstream Goals (${res.upstreamGoals.length}):`)
    for (const g of res.upstreamGoals) io.out(`  - ${g.id}: ${g.title} — ${g.description}`)
  }
  if (res.decisions.length > 0) {
    io.out(`\nDecisions (${res.decisions.length}):`)
    for (const o of res.decisions) {
      io.out(`  - ${o.id} (${o.docId}${o.date ? `, ${o.date}` : ''}): ${o.body}`)
    }
  }
  if (res.relatedDocuments.length > 0) {
    io.out(`\nRelated Docs (${res.relatedDocuments.length}):`)
    for (const d of res.relatedDocuments) io.out(`  - [${d.type}] ${d.id} (${d.relation}): ${d.title}`)
  }
  if (res.relevantTerms.length > 0) {
    io.out(`\nTerms (${res.relevantTerms.length}):`)
    for (const t of res.relevantTerms) {
      const alias = t.aliases.length > 0 ? ` [${t.aliases.join(', ')}]` : ''
      io.out(`  - ${t.id}${alias}: ${t.definition}`)
    }
  }
  if (res.sourceRefs.length > 0) {
    io.out(`\nSource Refs (${res.sourceRefs.length}):`)
    for (const r of res.sourceRefs) {
      const loc = r.symbol ? `#${r.symbol}` : r.lines ? `:${r.lines}` : ''
      io.out(`  - ${r.file}${loc} (via ${r.fromDocId})`)
    }
  }
  return 0
}

async function cmdQuery(flags: CliFlags, io: CliIo): Promise<number> {
  if (flags.suspect === true && flags['no-suspect'] === true) {
    throw new CliArgError('--suspect and --no-suspect cannot be used together')
  }

  const filters = {
    kind: parseOptionalBlockKind(flags),
    intent: parseOptionalSpecIntent(flags),
    stability: parseOptionalStability(flags),
    review: parseOptionalReviewStatus(flags),
    realization: parseOptionalRealizationStatus(flags),
    suspect: flags.suspect === true ? true : flags['no-suspect'] === true ? false : undefined,
    query: getStringFlag(flags, 'q'),
    mount: getStringFlag(flags, 'mount'),
    full: flags.full === true,
  }

  const { docsDir, docsMounts, projectRoot, testReportPath, testReportPaths } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, { mounts: docsMounts, projectRoot, testReportPath, testReportPaths })
  const res = querySpecs(store.getIndex(), filters)

  if (flags.json === true) {
    printJson(io, res)
    return 0
  }

  io.out(`Blocks (${res.count}):`)
  for (const b of res.blocks) {
    const status =
      'realizationStatus' in b ? b.realizationStatus : 'realization' in b ? b.realization?.status : undefined
    const real = status ? ` realization=${status}` : ''
    const level = 'level' in b && b.level ? ` level=${b.level}` : ''
    const verifies = 'verifies' in b && b.verifies && b.verifies.length > 0 ? ` verifies=${b.verifies.join(',')}` : ''
    const suspect = b.suspect ? ' suspect' : ''
    io.out(
      `  [${b.kind}] ${b.id} (${b.docPath}:${b.startLine}-${b.endLine}) review=${b.review}${level}${verifies}${real}${suspect}`,
    )
  }
  return 0
}

async function cmdContext(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  const id = positionals[0]
  if (!id) throw new CliArgError('Spec block ID or document ID is required (e.g. documi context core.document-model)')
  const { docsDir, docsMounts, projectRoot, testReportPath, testReportPaths } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, { mounts: docsMounts, projectRoot, testReportPath, testReportPaths })
  const ctx = getSpecContext(store.getIndex(), id, { full: flags.full === true })
  if (!ctx) {
    io.err(`✗ Target not found: ${id}`)
    return 1
  }

  // 既定は mode="exports" を明示した参照のみ展開し、--full 時のみ全参照ファイルの公開シンボルを展開する
  const exportRefs = flags.full === true ? ctx.sourceRefs : ctx.sourceRefs.filter((r) => r.mode === 'exports')
  const exportedSymbols = await collectSourceRefExports(projectRoot, exportRefs)
  const payload = exportedSymbols.length > 0 ? { ...ctx, exportedSymbols } : ctx

  if (flags.json === true) {
    printJson(io, payload)
    return 0
  }

  io.out(`Spec Context: ${id} (${ctx.docPath}${ctx.startLine ? `:${ctx.startLine}-${ctx.endLine}` : ''})`)
  if ('rawBody' in ctx.target && ctx.target.rawBody) {
    io.out(`  body:`)
    for (const line of ctx.target.rawBody.trim().split('\n')) {
      io.out(`    ${line}`)
    }
  }
  if (ctx.upstreamGoals.length > 0) {
    io.out(`  upstream goals: ${ctx.upstreamGoals.map((g) => g.id).join(', ')}`)
  }
  if (ctx.relatedDocuments.length > 0) {
    io.out(`  related docs: ${ctx.relatedDocuments.map((d) => `${d.id} [${d.type}]`).join(', ')}`)
  }
  if (ctx.decisions.length > 0) {
    io.out(`  decisions: ${ctx.decisions.map((o) => o.id).join(', ')}`)
  }
  if (ctx.tests.length > 0) {
    io.out(`  tests (${ctx.tests.length}):`)
    for (const t of ctx.tests) {
      const lv = t.level ? `[${t.level}] ` : ''
      io.out(`    - ${lv}${t.id} (verifies: ${t.verifies.join(', ')}): ${t.body}`)
    }
  }
  if (ctx.relevantTerms.length > 0) {
    io.out(`  terms: ${ctx.relevantTerms.map((t) => t.id).join(', ')}`)
  }
  if (ctx.sourceRefs.length > 0) {
    io.out(`  sourceRefs (${ctx.sourceRefs.length}):`)
    for (const r of ctx.sourceRefs) {
      const suffix = r.mode === 'exports' ? ' [exports]' : r.mode === 'symbol' ? `#${r.symbol}` : `:${r.lines}`
      io.out(`    - ${r.file}${suffix}`)
    }
  }
  if (exportedSymbols.length > 0) {
    io.out(`  exported symbols (${exportedSymbols.length} files):`)
    for (const fileEntry of exportedSymbols) {
      const summary = fileEntry.symbols.map((s) => `${s.kind} ${s.name} (L${s.startLine})`).join(', ')
      io.out(`    - ${fileEntry.file}: ${summary}`)
    }
  }
  return 0
}

// ---------- AI & 人間向け 精密編集コマンド ----------
// @implements core.ai-cli

async function cmdBlock(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  const action = positionals[0]
  if (action !== 'add' && action !== 'update' && action !== 'rename') {
    throw new CliArgError('documi block subcommand must be one of: add, update, rename')
  }

  const { docsDir, docsMounts, projectRoot, testReportPath, testReportPaths } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, {
    mounts: docsMounts,
    projectRoot,
    testReportPath,
    testReportPaths,
    enrichTrace: false,
  })

  if (action === 'add') {
    const docId = positionals[1]
    if (!docId)
      throw new CliArgError(
        'Target document ID is required (e.g. documi block add specs/auth --kind spec --id auth.login --body "...")',
      )
    const kind = parseOptionalBlockKind(flags)
    if (!kind) throw new CliArgError(`--kind is required (${BLOCK_KINDS.join(', ')})`)
    const id = getStringFlag(flags, 'id')
    if (!id) throw new CliArgError('--id is required')
    const body = (await resolveBodyContent(flags, io, { required: true }))!

    const addRes = await addBlockToDoc(store.rootDir, store.getIndex(), {
      docId,
      kind,
      id,
      body,
      afterHeading: getStringFlag(flags, 'after-heading'),
      title: getStringFlag(flags, 'title'),
      summary: getStringFlag(flags, 'summary'),
      date: getStringFlag(flags, 'date'),
      level: parseOptionalTestLevel(flags),
      verifies: parseCsvFlag(flags, 'verifies'),
      stability: parseOptionalStability(flags),
      intent: parseOptionalBlockIntent(flags),
      derives: parseCsvFlag(flags, 'derives'),
      supersedes: parseCsvFlag(flags, 'supersedes'),
      scope: getStringFlag(flags, 'scope'),
      aliases: parseCsvFlag(flags, 'aliases'),
      antiTerms: parseCsvFlag(flags, 'anti-terms'),
      context: getStringFlag(flags, 'domain-context'),
      symbols: parseCsvFlag(flags, 'symbols'),
    })
    if (addRes.isErr()) {
      io.err(`✗ ${addRes.error.message}`)
      return 1
    }
    const result = addRes.value
    const nextIndex = await store.reload()
    const validation = await buildValidationPayload(nextIndex, projectRoot)
    const payload = { ...result, validation }

    if (flags.json === true) printJson(io, payload)
    else
      io.out(
        `✓ Added ${result.id} → ${result.path}:${result.startLine}-${result.endLine} (issues: ${validation.totalIssues})`,
      )
    return 0
  }

  if (action === 'update') {
    const id = positionals[1]
    if (!id) throw new CliArgError('Target block ID is required (e.g. documi block update auth.lockout --body "...")')
    const body = (await resolveBodyContent(flags, io, { required: true }))!

    const updateRes = await updateBlockInDocs(store.rootDir, store.getIndex(), {
      id,
      body,
      title: getStringFlag(flags, 'title'),
      summary: getStringFlag(flags, 'summary'),
      date: getStringFlag(flags, 'date'),
      level: parseOptionalTestLevel(flags),
      verifies: parseCsvFlag(flags, 'verifies'),
      stability: parseOptionalStability(flags),
      intent: parseOptionalBlockIntent(flags),
      derives: parseCsvFlag(flags, 'derives'),
      supersedes: parseCsvFlag(flags, 'supersedes'),
      scope: getStringFlag(flags, 'scope'),
      aliases: parseCsvFlag(flags, 'aliases'),
      antiTerms: parseCsvFlag(flags, 'anti-terms'),
      context: getStringFlag(flags, 'domain-context'),
      symbols: parseCsvFlag(flags, 'symbols'),
    })
    if (updateRes.isErr()) {
      io.err(`✗ ${updateRes.error.message}`)
      return 1
    }
    const result = updateRes.value
    const nextIndex = await store.reload()
    const validation = await buildValidationPayload(nextIndex, projectRoot)
    const payload = { ...result, validation }

    if (flags.json === true) printJson(io, payload)
    else
      io.out(
        `✓ Updated ${result.id} → ${result.path}:${result.startLine}-${result.endLine} (issues: ${validation.totalIssues})`,
      )
    return 0
  }

  // rename
  const oldId = positionals[1]
  const newId = positionals[2]
  if (!oldId || !newId) {
    throw new CliArgError('Both old and new block IDs are required (e.g. documi block rename old.id new.id --dry-run)')
  }
  const dryRun = flags['dry-run'] === true
  const renameRes = await renameBlockIdAcrossProject(store.rootDir, projectRoot, store.getIndex(), {
    oldId,
    newId,
    dryRun,
  })
  if (renameRes.isErr()) {
    io.err(`✗ ${renameRes.error.message}`)
    return 1
  }
  const result = renameRes.value
  if (!result.dryRun && result.changes.length > 0) {
    const nextIndex = await store.reload()
    const validation = await buildValidationPayload(nextIndex, projectRoot)
    const payload = { ...result, validation }
    if (flags.json === true) printJson(io, payload)
    else {
      io.out(`✓ Renamed ${oldId} → ${newId} (${result.changes.length} files, issues: ${validation.totalIssues})`)
      for (const c of result.changes) io.out(`  - ${c.path} (${c.occurrences})`)
    }
    return 0
  }

  if (flags.json === true) printJson(io, result)
  else {
    const prefix = result.dryRun ? '[dry-run] ' : ''
    io.out(`${prefix}${oldId} → ${newId} (${result.changes.length} files)`)
    for (const c of result.changes) io.out(`  - ${c.path} (${c.occurrences})`)
  }
  return 0
}

async function cmdTerm(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  const action = positionals[0]
  if (action !== 'upsert') {
    throw new CliArgError(
      'documi term subcommand must be "upsert" (e.g. documi term upsert Artifact --definition "...")',
    )
  }
  const id = positionals[1]
  if (!id) throw new CliArgError('Term ID is required (e.g. documi term upsert Artifact --definition "...")')
  const definition = (await resolveBodyContent(flags, io, { allowDefinition: true, required: true }))!

  const { docsDir, docsMounts, projectRoot, testReportPath, testReportPaths } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, {
    mounts: docsMounts,
    projectRoot,
    testReportPath,
    testReportPaths,
    enrichTrace: false,
  })
  const upsertRes = await upsertTermInDocs(store.rootDir, store.getIndex(), {
    id,
    definition,
    aliases: parseCsvFlag(flags, 'aliases'),
    antiTerms: parseCsvFlag(flags, 'anti-terms'),
    context: getStringFlag(flags, 'domain-context'),
    symbols: parseCsvFlag(flags, 'symbols'),
    docId: getStringFlag(flags, 'doc'),
  })
  if (upsertRes.isErr()) {
    io.err(`✗ ${upsertRes.error.message}`)
    return 1
  }
  const result = upsertRes.value
  const nextIndex = await store.reload()
  const validation = await buildValidationPayload(nextIndex, projectRoot)
  const payload = { ...result, validation }

  if (flags.json === true) printJson(io, payload)
  else
    io.out(
      `✓ Term ${result.action}: ${result.id} → ${result.path}:${result.startLine}-${result.endLine} (issues: ${validation.totalIssues})`,
    )
  return 0
}

async function cmdScaffold(positionals: string[], flags: CliFlags, io: CliIo): Promise<number> {
  const relPath = positionals[0]
  if (!relPath)
    throw new CliArgError('Relative path is required (e.g. documi scaffold specs/auth.mdx --title "Auth Spec")')
  const title = getStringFlag(flags, 'title')
  if (!title) throw new CliArgError('--title is required')
  const body = await resolveBodyContent(flags, io, { required: false })

  const { docsDir, docsMounts, projectRoot, testReportPath, testReportPaths } = resolveCliPaths(flags)
  const store = await DocsStore.open(docsDir, {
    mounts: docsMounts,
    projectRoot,
    testReportPath,
    testReportPaths,
    enrichTrace: false,
  })
  const scaffoldRes = await scaffoldDocument(store.rootDir, store.getIndex(), {
    path: relPath,
    title,
    mount: getStringFlag(flags, 'mount'),
    type: parseOptionalArtifactType(flags),
    scope: parseOptionalDocScope(flags),
    description: getStringFlag(flags, 'description'),
    date: getStringFlag(flags, 'date'),
    tags: parseCsvFlag(flags, 'tags'),
    derives: parseCsvFlag(flags, 'derives'),
    satisfies: parseCsvFlag(flags, 'satisfies'),
    verifies: parseCsvFlag(flags, 'verifies'),
    body,
  })
  if (scaffoldRes.isErr()) {
    io.err(`✗ ${scaffoldRes.error.message}`)
    return 1
  }
  const result = scaffoldRes.value
  const nextIndex = await store.reload()
  const validation = await buildValidationPayload(nextIndex, projectRoot)
  const payload = { ...result, validation }

  if (flags.json === true) printJson(io, payload)
  else io.out(`✓ Scaffolded ${result.docId} → ${result.path} (issues: ${validation.totalIssues})`)
  return 0
}

export async function runCli(argv: string[], io: CliIo = DEFAULT_IO): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parseCliArgs(argv)
  } catch (error) {
    if (error instanceof CliArgError) {
      io.err(`✗ ${error.message}`)
      return 1
    }
    throw error
  }
  const { command, positionals, flags } = parsed
  if (flags.help && command && commandUsage(io, command)) return 0
  if (flags.help || !command) {
    usage(io)
    return command ? 0 : 1
  }

  try {
    validateCommandFlags(command, flags)
    if (command === 'init') return await cmdInit(flags, io)
    if (command === 'mcp') return await cmdMcp(flags)
    if (command === 'check') return await cmdCheck(flags, io)
    if (command === 'approve') return await cmdApprove(positionals, flags, io)
    if (command === 'unapprove') return await cmdUnapprove(positionals, flags, io)
    if (command === 'map') return await cmdMap(flags, io)
    if (command === 'list') return await cmdList(flags, io)
    if (command === 'show') return await cmdShow(positionals, flags, io)
    if (command === 'relations') return await cmdRelations(positionals, flags, io)
    if (command === 'impact') return await cmdImpact(positionals, flags, io)
    if (command === 'search') return await cmdSearch(positionals, flags, io)
    if (command === 'index') return await cmdIndex(flags, io)
    if (command === 'query') return await cmdQuery(flags, io)
    if (command === 'context') return await cmdContext(positionals, flags, io)
    if (command === 'block') return await cmdBlock(positionals, flags, io)
    if (command === 'term') return await cmdTerm(positionals, flags, io)
    if (command === 'scaffold') return await cmdScaffold(positionals, flags, io)

    io.err(`Unknown command: ${command}`)
    usage(io)
    return 1
  } catch (error) {
    if (error instanceof CliArgError) {
      io.err(`✗ ${error.message}`)
      return 1
    }
    throw error
  }
}

if (import.meta.main) {
  void runCli(process.argv.slice(2)).then((code) => process.exit(code))
}
