import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface InitProjectOptions {
  docsDir: string
  projectRoot: string
  /** スキル出力先ディレクトリ（既定: <projectRoot>/.agents/skills） */
  skillsDir?: string
  /** docs/ の雛形生成をスキップし Agent Skills のみ生成する */
  skillsOnly?: boolean
  /** Agent Skills の生成をスキップする */
  noSkills?: boolean
  /** 既存の SKILL.md を最新版テンプレートで上書き更新する */
  forceSkills?: boolean
  /** ADR テンプレートに埋め込む日付（テスト決定論用） */
  today?: string
}

export interface InitProjectResult {
  docsDir: string
  projectRoot: string
  skillsDir: string
  createdDocs: string[]
  skippedDocs: string[]
  createdSkills: string[]
  updatedSkills: string[]
  skippedSkills: string[]
}

function buildDocTemplates(today: string): Record<string, string> {
  return {
    'goals/project-goal.mdx': `---
type: goal
title: プロジェクト目標
description: このプロジェクトが解決したい課題と達成したい状態
tags: [goal]
---

# プロジェクト目標

ここに「なぜこのシステムを作るのか」「誰の何を解決するのか」を記述します。
すべての \`normative\` な \`<Spec>\` は \`derives\` でこの Goal に接続します。
`,
    'domain/glossary.mdx': `---
type: domain
title: ドメイン用語集
description: 人間と AI が共有するユビキタス言語とコードシンボルの対応表
tags: [domain, glossary]
---

# ドメイン用語集

<TermDef id="ExampleTerm" aliases="サンプル用語">
  プロジェクト内で繰り返し使う主要概念を定義します。\`symbols="src/example.ts#Example"\` を付けるとホバー時に実コードも表示されます。
</TermDef>
`,
    'decisions/first-decision.mdx': `---
type: decision
title: 初期アーキテクチャ方針
description: 主要な技術選定とトレードオフの記録
date: ${today}
tags: [adr]
---

# 初期アーキテクチャ方針

<Outcome id="dec.initial-architecture" stability="evolving">
  決定した結論を 2〜3 行で簡潔に記述します。AI への常時コンテキストとして優先投入されます。
</Outcome>

## 背景・比較検討

ここに選択肢の比較やトレードオフの詳細を残します。
`,
    'specs/example.mdx': `---
type: spec
title: サンプル機能仕様
description: 最初の仕様テンプレート
tags: [spec]
derives:
  - goals/project-goal
---

# サンプル機能仕様

<Spec id="example.behavior" stability="evolving" derives="goals/project-goal">
  **When** ユーザーが対象操作を行ったとき、
  **the** システム **shall** 期待される結果を返す。
</Spec>
`,
  }
}

function buildSkillTemplates(relDocsDir: string): Record<string, string> {
  return {
    'documi/SKILL.md': `---
name: documi
description: Read, update, and verify Living Specifications managed by Documi via MCP and CLI. Use before implementing features, changing behavior/API/architecture, reviewing specs, or syncing code and tests with specifications.
---

# Documi Living Specification Workflow

This repository manages its Living Specifications in \`${relDocsDir}/\` using **Documi**.
Prefer the Documi MCP server (\`documi mcp --project .\`) over reading raw spec files one by one so context stays minimal and structured.

## 1. Progressive Disclosure (Read Before Coding)

1. Call \`get_project_map\` first to load Goals, Architecture summaries, Decision \`<Outcome>\` blocks, Domain Terms, and overall Review / Realization status.
2. Call \`query_specs\` to find relevant \`<Spec>\` blocks by intent, stability, realization status, or tag.
3. Call \`get_spec_context\` for each target Spec ID to retrieve its upstream Goal, unresolved human feedback, related Design/Contract docs, referenced Terms, and \`<SourceRef>\` anchors.
4. Only call \`get_document\` or \`search_documents\` when full surrounding prose is needed.

## 2. Surgical Editing via MCP (Keep Diffs Minimal)

When updating specifications, prefer Documi's AST-aware MCP editing tools over rewriting whole MDX files:

- \`update_block\` — replace the body or attributes of an existing \`<Spec>\` / \`<Constraint>\` / \`<Outcome>\` / \`<Note>\` / \`<TermDef>\`.
- \`add_block\` — append a new semantic block to an existing document.
- \`upsert_term\` — add or update a \`<TermDef>\` (with \`aliases\` and \`symbols="src/...#Symbol"\`) in the glossary.
- \`scaffold_document\` — create a new typed document (\`goal\`, \`decision\`, \`domain\`, \`spec\`, \`contract\`, \`architecture\`, \`design\`, \`verification\`, \`guide\`) with valid frontmatter.
- \`rename_block_id\` — safely rename a block ID and all cross-references (always preview with \`dryRun: true\` first).

## 3. Sync Code & Tests With Specs

- Link implementation code to specs with \`// @implements <spec.id>\` (or \`<SourceRef file="src/..." satisfies="<spec.id>" />\`).
- Link verification tests with \`test('[<spec.id>] ...', ...)\` (or \`// @verifies <spec.id>\`) and emit JUnit XML when running tests if configured.
- Always write \`<SourceRef file="...">\` and \`<TermDef symbols="...">\` as POSIX paths relative to the project root.
- Update the relevant specs, contracts, designs, or decisions in the same change whenever behavior, API, or architecture changes.

## 4. Invariant Guardrails

- **Never edit \`${relDocsDir}/.documi/reviews.json\` directly.** Approvals and feedback belong strictly to humans (enforced by \`documi check --no-review-edit\`).
- **Never write executable JS inside MDX** (no ESM \`import\`/\`export\`, no JSX \`{...}\` expressions, no unapproved components).
- **Never create temporary \`tasks.md\` checklists inside \`${relDocsDir}/\`** — progress is computed automatically from code, tests, and PRs.

## 5. Verify Before Finishing

1. Call MCP \`validate_docs\` (or run \`documi check --no-review-edit\`) and confirm 0 errors (Rooted DAG, MDX safety, AST symbol references).
2. Summarize any new or modified Spec IDs so the human reviewer can inspect and approve them in the Documi Web UI (\`documi serve\`).
`,
    'documi-bootstrap/SKILL.md': `---
name: documi-bootstrap
description: Bootstrap Documi Living Specifications for an existing (brownfield) codebase. Use when adopting Documi in a repository that already has source code and tests, to inventory architecture, domain terms, and core specifications incrementally.
---

# Documi Brownfield Bootstrap Workflow

Use this skill when introducing Documi into an **existing codebase** so that initial Living Specifications reflect reality without overwhelming the repository with boilerplate.

## 1. Inspect the Existing Repository

1. Map the repository layout: top-level directories, runtime/build manifests (\`package.json\`, \`Cargo.toml\`, \`go.mod\`, \`pyproject.toml\`, etc.), entry points, and existing \`README.md\` or docs.
2. Check whether \`docs/\` is already occupied by user-facing documentation (e.g., Docusaurus/VitePress).
   - If \`docs/\` is occupied, create \`.documi.json\` at the project root (for example \`{ "docs": "documi" }\`) so Documi does not collide with existing docs.
3. Identify the 3–5 most critical user-facing or domain capabilities, key domain data structures/types, and existing test suites.

## 2. Establish Top-Down Anchors First (Thin Skeleton)

Use Documi MCP tools (\`scaffold_document\`, \`add_block\`, \`upsert_term\`) rather than hand-crafting large files:

1. **Root Goal (\`goals/\`)**: Create 1 concise Root Goal describing the product purpose, target users, and explicit Non-Goals. Capture hard architectural invariants as \`<Constraint id="...">\`.
2. **System Overview (\`architecture/\`)**: Create 1 high-level architecture document describing modules, boundaries, and data flow with real \`<SourceRef file="src/..." />\` links.
3. **Existing Key Decisions (\`decisions/\`)**: Record only the 1–3 most consequential architectural decisions already baked into the codebase, each with a 2–3 line \`<Outcome id="dec....">\`.

## 3. Extract Bottom-Up Living Specs From Real Code

1. **Domain Glossary (\`domain/glossary.mdx\`)**: Register the 5–10 core domain concepts via \`upsert_term\` with \`symbols="src/...#Symbol"\` pointing to real types/classes/functions in the codebase.
2. **Core Specifications (\`specs/\`)**: For each critical capability (start small: 3–5 specs, not every helper function):
   - Write EARS-style \`<Spec id="domain.capability" stability="evolving" derives="goals/...">\` blocks describing the *observable contract* of the existing system.
   - Do not fabricate undocumented behavior; verify against the actual implementation and tests.
   - Add \`// @implements <spec.id>\` (or \`<SourceRef ... satisfies="<spec.id>" />\`) and link existing tests where appropriate.
3. **Contracts (\`contracts/\`)**: If the project exposes HTTP/RPC APIs, CLI commands, or MCP/event schemas, summarize them in a contract document linked via \`satisfies\`.

## 4. Validate & Hand Off to Humans

1. Run \`validate_docs\` (MCP) or \`documi check\` and fix all broken \`<SourceRef>\` paths, missing \`derives\` (orphan specs), or invalid MDX syntax.
2. **Do not edit \`${relDocsDir}/.documi/reviews.json\`.** Leave all bootstrapped specs as \`unreviewed\` so the human owner can read, refine, and approve them in \`documi serve\`.
3. Present a concise summary of created documents, Spec IDs, and any ambiguities discovered in the existing codebase that need a human decision.
`,
  }
}

// @implements core.agent-skills-init
/**
 * 新規・既存プロジェクト向けに Documi の `docs/` 雛形および標準 Agent Skills (`.agents/skills/`) を生成する。
 * `AGENTS.md` 等の既存エージェント設定ファイルは競合回避のため一切生成・変更しない。
 */
export async function initDocumiProject(options: InitProjectOptions): Promise<InitProjectResult> {
  const docsDir = path.resolve(options.docsDir)
  const projectRoot = path.resolve(options.projectRoot)
  const skillsDir = path.resolve(options.skillsDir ?? path.join(projectRoot, '.agents', 'skills'))
  const today = options.today ?? new Date().toISOString().slice(0, 10)
  const relDocs = path.relative(projectRoot, docsDir).split(path.sep).join('/') || 'docs'

  const createdDocs: string[] = []
  const skippedDocs: string[] = []
  const createdSkills: string[] = []
  const updatedSkills: string[] = []
  const skippedSkills: string[] = []

  if (!options.skillsOnly) {
    for (const [rel, content] of Object.entries(buildDocTemplates(today))) {
      const abs = path.join(docsDir, rel)
      if (existsSync(abs)) {
        skippedDocs.push(rel)
        continue
      }
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf-8')
      createdDocs.push(rel)
    }
  }

  if (!options.noSkills) {
    for (const [rel, content] of Object.entries(buildSkillTemplates(relDocs))) {
      const abs = path.join(skillsDir, rel)
      const exists = existsSync(abs)
      if (exists && !options.forceSkills) {
        skippedSkills.push(rel)
        continue
      }
      await mkdir(path.dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf-8')
      if (exists) updatedSkills.push(rel)
      else createdSkills.push(rel)
    }
  }

  return {
    docsDir,
    projectRoot,
    skillsDir,
    createdDocs,
    skippedDocs,
    createdSkills,
    updatedSkills,
    skippedSkills,
  }
}
