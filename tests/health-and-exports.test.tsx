import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../src/cli'
import { runDocsCheck } from '../src/core/checker'
import { computeDocumentHealth } from '../src/core/health'
import { loadDocuments } from '../src/core/loader'
import { buildProjectMap, buildValidationPayload, collectSourceRefExports } from '../src/core/query'
import { extractExportedSymbols, extractExportedSymbolsFromSource } from '../src/core/source'
import { createApp } from '../src/server/app'
import { DocsStore } from '../src/server/store'

const tempDirs: string[] = []

async function makeTempProject(files: Record<string, string>): Promise<{ projectRoot: string; docsDir: string }> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'documi-health-exports-'))
  tempDirs.push(projectRoot)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(projectRoot, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf-8')
  }
  return { projectRoot, docsDir: path.join(projectRoot, 'docs') }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('Document Health & Coverage (core.doc-health)', () => {
  test('[core.doc-health] Design / Verification カバレッジ・Spec 肥大化・Architecture 鮮度差を Advisory ヒントとして算出する', async () => {
    const specBlocks = Array.from({ length: 11 }, (_, i) => {
      const id = `app.spec${i + 1}`
      return `<Spec id="${id}" stability="evolving" derives="goals/root">\n  **When** action ${i + 1} occurs, **the** system **shall** respond.\n</Spec>`
    }).join('\n\n')

    const { projectRoot, docsDir } = await makeTempProject({
      'docs/goals/root.mdx': `---\ntype: goal\ntitle: Root Goal\n---\n\n# Root Goal\n`,
      'docs/architecture/overview.mdx': `---\ntype: architecture\ntitle: System Overview\n---\n\n# System Overview\n`,
      'docs/specs/bloated.mdx': `---\ntype: spec\ntitle: Bloated Specs\n---\n\n# Bloated Specs\n\n${specBlocks}\n`,
      'docs/designs/partial.mdx': `---\ntype: design\ntitle: Partial Design\nsatisfies:\n  - app.spec1\n---\n\n# Partial Design\n`,
      'docs/verification/partial.mdx': `---\ntype: verification\ntitle: Partial Verification\nverifies:\n  - app.spec1\n  - app.spec2\n---\n\n# Partial Verification\n`,
    })

    const index = await loadDocuments(docsDir)

    // Architecture が古く、Spec/Design が 5 件以上新しく更新された状態を模倣
    const archDoc = index.byId.get('architecture/overview')
    expect(archDoc).toBeDefined()
    if (archDoc) {
      archDoc.freshness = { updatedAt: '2026-01-01T00:00:00.000Z' }
    }
    const specDoc = index.byId.get('specs/bloated')
    if (specDoc) specDoc.freshness = { updatedAt: '2026-02-01T00:00:00.000Z' }
    const designDoc = index.byId.get('designs/partial')
    if (designDoc) designDoc.freshness = { updatedAt: '2026-02-01T00:00:00.000Z' }

    const health = computeDocumentHealth(index)
    expect(health.totalNormativeSpecs).toBe(11)
    expect(health.designCoveredSpecs).toBe(1)
    expect(health.verificationCoveredSpecs).toBe(2)
    expect(health.uncoveredByDesign).toHaveLength(10)
    expect(health.uncoveredByVerification).toHaveLength(9)
    expect(health.bloatedSpecDocs).toHaveLength(1)
    expect(health.bloatedSpecDocs[0]?.specCount).toBe(11)
    expect(health.hints.some((h) => h.code === 'missing-design')).toBe(true)
    expect(health.hints.some((h) => h.code === 'missing-verification')).toBe(true)
    expect(health.hints.some((h) => h.code === 'bloated-spec-doc')).toBe(true)

    // Advisory ヒントがあっても runDocsCheck.ok は true（CI を壊さない）
    const report = await runDocsCheck({ docsDir, projectRoot })
    expect(report.ok).toBe(true)
    expect(report.health.totalNormativeSpecs).toBe(11)
    expect(report.health.designCoveredSpecs).toBe(1)

    // buildProjectMap / buildValidationPayload / REST API / CLI にも反映される
    const map = buildProjectMap(index)
    expect(map.health.designCoveredSpecs).toBe(1)
    const validation = await buildValidationPayload(index, projectRoot)
    expect(validation.ok).toBe(true)
    expect(validation.health.bloatedSpecDocs).toHaveLength(1)

    const store = await DocsStore.open(docsDir, { projectRoot })
    const app = createApp(store, { projectRoot })
    const overviewRes = await app.request('/api/overview')
    expect(overviewRes.status).toBe(200)
    const overviewJson = (await overviewRes.json()) as { health: { designCoveredSpecs: number; hints: unknown[] } }
    expect(overviewJson.health.designCoveredSpecs).toBe(1)
    expect(overviewJson.health.hints.length).toBeGreaterThan(0)

    const lines: string[] = []
    const exitCode = await runCli(['check', '--project', projectRoot], {
      out: (s) => lines.push(s),
      err: () => {},
      readStdin: async () => '',
    })
    expect(exitCode).toBe(0)
    const output = lines.join('\n')
    expect(output).toContain('coverage:    design=1/11 verification=2/11')
    expect(output).toContain('Health Hints')
  })

  test('[core.doc-health] architecture 最終更新以降に 5 件以上の spec / design が更新されると stale-architecture ヒントを出す', async () => {
    const files: Record<string, string> = {
      'docs/goals/root.mdx': `---\ntype: goal\ntitle: Root\n---\n\n# Root\n`,
      'docs/architecture/overview.mdx': `---\ntype: architecture\ntitle: Overview\n---\n\n# Overview\n`,
    }
    for (let i = 1; i <= 5; i++) {
      files[`docs/specs/s${i}.mdx`] =
        `---\ntype: spec\ntitle: Spec ${i}\n---\n\n# Spec ${i}\n\n<Spec id="mod.s${i}" derives="goals/root">Rule ${i}</Spec>\n`
    }
    const { docsDir } = await makeTempProject(files)
    const index = await loadDocuments(docsDir)

    const arch = index.byId.get('architecture/overview')
    if (arch) arch.freshness = { updatedAt: '2026-01-01T00:00:00.000Z' }
    for (let i = 1; i <= 5; i++) {
      const s = index.byId.get(`specs/s${i}`)
      if (s) s.freshness = { updatedAt: '2026-02-10T00:00:00.000Z' }
    }

    const health = computeDocumentHealth(index)
    expect(health.staleArchitectureDocs).toHaveLength(1)
    expect(health.staleArchitectureDocs[0]?.newerDocsCount).toBe(5)
    expect(health.hints.some((h) => h.code === 'stale-architecture')).toBe(true)
  })
})

describe('AST Exported Symbols & <SourceRef mode="exports"> (core.ast-exports)', () => {
  test('[core.ast-exports] TypeScript / Go / Python / Rust から公開シンボルだけを AST 抽出し非公開ヘルパーを除外する', async () => {
    const tsSource = `
interface InternalOnly { a: string }
function privateHelper(x: number): number { return x + 1 }

export interface WidgetConfig {
  id: string
}

export type WidgetMode = 'a' | 'b'

export class WidgetEngine {
  run(): void {}
}

export async function createWidget(cfg: WidgetConfig): Promise<WidgetEngine> {
  return new WidgetEngine()
}

export const DEFAULT_TIMEOUT = 5000
export const makeId = (n: number): string => String(n)
`
    const tsRes = await extractExportedSymbolsFromSource('src/widget.ts', 'ts', tsSource)
    expect(tsRes.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'interface:WidgetConfig',
      'type:WidgetMode',
      'class:WidgetEngine',
      'function:createWidget',
      'constant:DEFAULT_TIMEOUT',
      'function:makeId',
    ])
    expect(tsRes.symbols.find((s) => s.name === 'createWidget')?.signature).toContain(
      'export async function createWidget',
    )

    const goSource = `package svc
type internalCfg struct{}
type PublicService struct{}
func helper() {}
func StartServer(addr string) error { return nil }
`
    const goRes = await extractExportedSymbolsFromSource('svc/server.go', 'go', goSource)
    expect(goRes.symbols.map((s) => s.name)).toEqual(['PublicService', 'StartServer'])

    const pySource = `
def _private_fn():
    pass

class PublicClient:
    def method(self):
        pass

def run_pipeline(x: int) -> int:
    return x
`
    const pyRes = await extractExportedSymbolsFromSource('pkg/client.py', 'py', pySource)
    expect(pyRes.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual(['class:PublicClient', 'function:run_pipeline'])

    const rsSource = `
struct PrivateState {}
pub struct PublicEngine {}
fn private_fn() {}
pub fn run_engine() {}
`
    const rsRes = await extractExportedSymbolsFromSource('src/lib.rs', 'rs', rsSource)
    expect(rsRes.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual(['struct:PublicEngine', 'function:run_engine'])
  })

  test('[core.ast-exports] <SourceRef mode="exports"> の検証・REST API・Code Explorer・CLI context が連動する', async () => {
    const { projectRoot, docsDir } = await makeTempProject({
      'src/service.ts': [
        'export interface ServiceInput { name: string }',
        'export class GreetingService { greet(i: ServiceInput) { return i.name } }',
        'function hiddenHelper() { return 1 }',
        'export function buildGreeting(input: ServiceInput): string { return input.name + hiddenHelper() }',
      ].join('\n'),
      'docs/goals/root.mdx': `---\ntype: goal\ntitle: Root\n---\n\n# Root\n`,
      'docs/specs/service.mdx': `---\ntype: spec\ntitle: Service Spec\n---\n\n# Service Spec\n\n<Spec id="svc.greet" derives="goals/root">Service greets caller.</Spec>\n`,
      'src/helper.ts': 'export function unrelatedHelper(): number { return 1 }\n',
      'docs/designs/service.mdx': `---\ntype: design\ntitle: Service Design\nsatisfies:\n  - svc.greet\n---\n\n# Service Design\n\n<SourceRef file="src/service.ts" mode="exports" satisfies="svc.greet" />\n\n<SourceRef file="src/helper.ts" symbol="unrelatedHelper" />\n`,
      'docs/verification/service.mdx': `---\ntype: verification\ntitle: Service Verification\nverifies:\n  - svc.greet\n---\n\n# Service Verification\n`,
    })

    // 1. AST 抽出 API と check 検証
    const direct = (await extractExportedSymbols(projectRoot, 'src/service.ts')).unwrap()
    expect(direct.symbols.map((s) => s.name)).toEqual(['ServiceInput', 'GreetingService', 'buildGreeting'])

    const report = await runDocsCheck({ docsDir, projectRoot })
    expect(report.ok).toBe(true)
    expect(report.health.designCoveredSpecs).toBe(1)
    expect(report.health.verificationCoveredSpecs).toBe(1)

    // 2. REST API (/api/source/exports & /api/code/file)
    const store = await DocsStore.open(docsDir, { projectRoot })
    const app = createApp(store, { projectRoot })

    const exportsRes = await app.request('/api/source/exports?file=src/service.ts')
    expect(exportsRes.status).toBe(200)
    const exportsJson = (await exportsRes.json()) as { symbols: Array<{ name: string; kind: string }> }
    expect(exportsJson.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'interface:ServiceInput',
      'class:GreetingService',
      'function:buildGreeting',
    ])

    const codeFileRes = await app.request('/api/code/file?path=src/service.ts')
    expect(codeFileRes.status).toBe(200)
    const codeFileJson = (await codeFileRes.json()) as { exportedSymbols: Array<{ name: string }> }
    expect(codeFileJson.exportedSymbols.map((s) => s.name)).toEqual([
      'ServiceInput',
      'GreetingService',
      'buildGreeting',
    ])

    // 3. collectSourceRefExports & CLI context
    const collected = await collectSourceRefExports(projectRoot, [
      { file: 'src/service.ts', mode: 'exports', satisfies: ['svc.greet'], verifies: [], startLine: 1 },
    ])
    expect(collected).toHaveLength(1)
    expect(collected[0]?.symbols.map((s) => s.name)).toEqual(['ServiceInput', 'GreetingService', 'buildGreeting'])

    const cliOut: string[] = []
    const code = await runCli(['context', 'svc.greet', '--project', projectRoot], {
      out: (s) => cliOut.push(s),
      err: () => {},
      readStdin: async () => '',
    })
    expect(code).toBe(0)
    const ctxText = cliOut.join('\n')
    expect(ctxText).toContain('exported symbols')
    expect(ctxText).toContain('GreetingService')
    expect(ctxText).toContain('buildGreeting')
    // 既定では mode="exports" 以外の参照ファイルの公開シンボルは展開しない（コンテキスト節約）
    expect(ctxText).not.toContain('function unrelatedHelper')

    const fullOut: string[] = []
    await runCli(['context', 'svc.greet', '--full', '--project', projectRoot], {
      out: (s) => fullOut.push(s),
      err: () => {},
      readStdin: async () => '',
    })
    expect(fullOut.join('\n')).toContain('function unrelatedHelper')

    // 4. 壊れた mode="exports" パスは documi check で broken-source-ref エラーになる
    await writeFile(
      path.join(docsDir, 'designs/service.mdx'),
      `---\ntype: design\ntitle: Service Design\nsatisfies:\n  - svc.greet\n---\n\n# Service Design\n\n<SourceRef file="src/missing.ts" mode="exports" satisfies="svc.greet" />\n`,
      'utf-8',
    )
    const brokenReport = await runDocsCheck({ docsDir, projectRoot })
    expect(brokenReport.ok).toBe(false)
    expect(brokenReport.errors.some((e) => e.code === 'broken-source-ref')).toBe(true)
  })
})
