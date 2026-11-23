import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type InitLanguage = 'en' | 'ja'

export interface InitProjectOptions {
  docsDir: string
  projectRoot: string
  /** スキル・雛形の出力言語（既定: en） */
  lang?: InitLanguage
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
  lang: InitLanguage
  createdDocs: string[]
  skippedDocs: string[]
  createdSkills: string[]
  updatedSkills: string[]
  skippedSkills: string[]
}

function buildDocTemplates(today: string, lang: InitLanguage): Record<string, string> {
  if (lang === 'ja') {
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

  return {
    'goals/project-goal.mdx': `---
type: goal
title: Project Goal
description: The problem this project solves and the outcomes it aims to achieve
tags: [goal]
---

# Project Goal

Describe why this system exists, who it serves, and what is explicitly out of scope.
Every \`normative\` \`<Spec>\` connects back to this Goal via \`derives\`.
`,
    'domain/glossary.mdx': `---
type: domain
title: Domain Glossary
description: Ubiquitous language shared by humans and AI agents with code symbol links
tags: [domain, glossary]
---

# Domain Glossary

<TermDef id="ExampleTerm" aliases="Example Concept">
  Define key domain concepts used across specifications and code. Add \`symbols="src/example.ts#Example"\` to verify and preview the real symbol.
</TermDef>
`,
    'decisions/first-decision.mdx': `---
type: decision
title: Initial Architecture Direction
description: Record of key technical choices and trade-offs
date: ${today}
tags: [adr]
---

# Initial Architecture Direction

<Outcome id="dec.initial-architecture" stability="evolving">
  Summarize the decision in 2–3 concise sentences. Outcome blocks are surfaced upfront in project maps.
</Outcome>

## Context & Trade-offs

Document the options considered and the rationale behind the chosen approach.
`,
    'specs/example.mdx': `---
type: spec
title: Example Feature Specification
description: Starter Living Specification template
tags: [spec]
derives:
  - goals/project-goal
---

# Example Feature Specification

<Spec id="example.behavior" stability="evolving" derives="goals/project-goal">
  **When** a user performs the target action,
  **the** system **shall** return the expected observable result.
</Spec>
`,
  }
}

function buildSkillTemplates(relDocsDir: string, lang: InitLanguage): Record<string, string> {
  if (lang === 'ja') {
    return {
      'documi/SKILL.md': `---
name: documi
description: Documi CLI を使って Living Specification（仕様・設計・ADR・用語集）を検索・精密編集・検証する運用スキル。機能実装・仕様変更・API/アーキテクチャ変更・コードとテストの同期前に使用します。
---

# Documi Living Specification 運用ワークフロー（CLI）

このリポジトリは \`${relDocsDir}/\` 配下の Living Specification を **Documi** で管理しています。
ファイルを 1 件ずつ丸ごと読む代わりに、\`documi\` CLI を使って必要な文脈だけを段階的に取得・精密編集してください。
コンテキストを節約するため、**読み取りは既定のコンパクトなテキスト出力を優先**し、構造化データが必要なときだけ \`--json\`（さらに全文・詳細配列が必要なときだけ \`--full\`）を付けてください（全オプションは \`documi --help\` で確認できます）。

## 1. 段階的コンテキスト取得（実装前に読む）

1. **Spec ID がまだ分からないタスク**: \`documi retrieve "<自然文のタスクや質問>"\` — BM25＋用語集同義語展開＋グラフ展開で関連 Spec・上流 Goal・Decision \`<Outcome>\`・用語・\`<SourceRef>\` を文字数予算内で 1 発取得する。
2. **全体像の把握**: \`documi map\` — Goal・Architecture・Decision \`<Outcome>\`・ドメイン用語・Review / Realization 全体像を一括取得する（機械処理時は \`documi map --json\`）。
3. **条件絞り込み・横断検索**: \`documi query [--kind spec] [--review ...] [--realization ...] [--has-feedback] [--q <語>]\` または \`documi search "<query>"\`。
4. **特定 Spec の深掘り**: \`documi context <spec-id>\` — 対象 Spec 本文・上流 Goal・未解決フィードバック・関連文書・用語・\`<SourceRef>\` を取得する（全文や参照関係が必要なら \`documi show <doc-id>\` / \`documi relations <id>\`）。

## 2. CLI による精密編集（差分を最小限に保つ）

仕様を更新するときは、MDX ファイル全体を書き換える代わりに AST 位置ベースの CLI コマンドを優先してください。**複数行の Markdown やバッククォートを含む本文はクォート崩れを防ぐため \`--body -\` ＋ヒアドキュメント**（または \`--body-file <file>\`）を使ってください：

\`\`\`bash
documi block update <block-id> --stability evolving --body - <<'EOF'
**When** 条件が発生したとき、
**the** システム **shall** 期待される振る舞いを行う。
EOF
\`\`\`

- \`documi block update <block-id> --body - [--stability ...] [--derives a,b]\` — 既存ブロックの該当行範囲のみを安全に更新する。
- \`documi block add <doc-id> --kind spec --id <new-id> --derives <goal> --body - [--after-heading "<見出し>"]\` — セマンティックブロックを 1 件追記する。
- \`documi term upsert <term-id> --definition "..." [--aliases a,b] [--symbols src/foo.ts#Foo]\` — 用語集に \`<TermDef>\` を追加・更新する。
- \`documi scaffold <rel-path.mdx> --title "..." [--type spec] [--derives a,b] [--body -]\` — 規約通りの frontmatter を持つ新規文書を作成する（既存ファイルの上書きは拒否）。
- \`documi block rename <old-id> <new-id> --dry-run\` — 全 \`${relDocsDir}/\` とコード・テストの ID 参照を一括リネームする（必ず先に \`--dry-run\` で対象を確認）。

## 3. コード・テストと仕様の同期

- 実装コードには \`// @implements <spec.id>\`（または設計書に \`<SourceRef file="src/..." satisfies="<spec.id>" />\`）を付与する。
- 検証テストには \`test('[<spec.id>] ...', ...)\`（または \`// @verifies <spec.id>\`）を含め、設定されていれば JUnit XML を出力する。
- \`<SourceRef file="...">\` と \`<TermDef symbols="...">\` は必ずプロジェクトルートからの POSIX 相対パスで記述する。
- 振る舞い・API・アーキテクチャを変更したら、対応する仕様・コントラクト・設計・ADR も同じ変更で更新する。

## 4. 守るべき不変ルール

- **\`${relDocsDir}/.documi/reviews.json\` を直接編集しない。** 承認とフィードバックは人間専用（\`documi check --no-review-edit\` で検証）。
- **MDX 内で実行可能な JavaScript を書かない**（ESM \`import\`/\`export\`・JSX 式 \`{...}\`・未許可コンポーネントは禁止）。
- **\`${relDocsDir}/\` 内に一時的な \`tasks.md\` 等を作らない。** 進捗（\`realization\`）はコード・テスト・PR から自動算出される。

## 5. 完了前の検証と引き継ぎ

1. \`documi check --no-review-edit\` を実行し、エラー 0 件（Rooted DAG・MDX 安全性・AST シンボル参照）を確認する。
2. 追加・変更した Spec ID を簡潔にまとめ、人間レビュアーが Web UI（\`documi serve\`）で確認・承認できるようにする。
`,
      'documi-bootstrap/SKILL.md': `---
name: documi-bootstrap
description: 既存コードベース（Brownfield）に Documi の Living Specification を段階的に導入するスキル。既存のソースコードやテストからアーキテクチャ・ドメイン用語・コア仕様を棚卸しするときに使用します。
---

# Documi 既存コードベース（Brownfield）導入ワークフロー（CLI）

すでにソースコードやテストが存在するリポジトリに **Documi** を導入するとき、実態と乖離したテンプレの山を作らずに段階的に Living Specification を立ち上げるための手順です。

## 1. 既存リポジトリの棚卸し

1. ディレクトリ構成・ビルド設定（\`package.json\`, \`Cargo.toml\`, \`go.mod\`, \`pyproject.toml\` 等）・エントリポイント・既存 \`README.md\` やドキュメントを確認する。
2. すでに \`docs/\` がユーザー向けドキュメント（Docusaurus / VitePress 等）で占有されているか確認する。
   - 占有されている場合はプロジェクトルートに \`.documi.json\`（例: \`{ "docs": "documi" }\`）を作成し、既存ドキュメントと衝突させない。
3. 最も重要な 3〜5 個の中核機能、主要なドメイン型・データ構造、既存テストスイートを特定する。

## 2. トップダウンの骨格を先に作る（薄く始める）

手書きで長大なファイルを作らず、\`documi\` CLI（\`scaffold\` / \`block add\` / \`term upsert\`）を使って最小骨格を作る：

1. **Root Goal（\`goals/\`）**: プロダクトの目的・対象ユーザー・明示的な Non-Goals をまとめた Goal 文書を 1 件作成し、譲れない制約を \`<Constraint id="...">\` として記述する。
2. **System Overview（\`architecture/\`）**: モジュール境界とデータフローを俯瞰する設計概要を 1 件作成し、実在する \`<SourceRef file="src/..." />\` を紐づける。
3. **主要な既存意思決定（\`decisions/\`）**: すでにコードベースに根付いている重要な技術選定を 1〜3 件だけ記録し、各結論を 2〜3 行の \`<Outcome id="dec....">\` にまとめる。

## 3. 実コードからボトムアップでコア仕様を抽出する

1. **ドメイン用語集（\`domain/glossary.mdx\`）**: 中核概念 5〜10 個を \`documi term upsert\` で登録し、実在する型・クラス・関数を \`--symbols src/...#Symbol\` で紐づける。
2. **コア仕様（\`specs/\`）**: 重要な機能から 3〜5 件に絞って始める（すべての細かなヘルパーを仕様化しない）：
   - 既存システムの*観測可能な振る舞い*を EARS 記法の \`<Spec id="domain.capability" stability="evolving" derives="goals/...">\` として記述する。
   - 推測で仕様を創作せず、必ず実装とテストを照合する。
   - 実装側に \`// @implements <spec.id>\`（または \`<SourceRef ... satisfies="<spec.id>" />\`）を付与し、対応する既存テストがあれば紐づける。
3. **コントラクト（\`contracts/\`）**: HTTP/RPC API・CLI・イベントスキーマ等を公開している場合、\`satisfies\` 付きで簡潔にまとめる。

## 4. 検証して人間へ引き継ぐ

1. \`documi check\` を実行し、\`<SourceRef>\` パス切れ・\`derives\` 漏れ（\`orphan-spec\`）・MDX 構文エラーをすべて解消する。
2. **\`${relDocsDir}/.documi/reviews.json\` は絶対に編集しない。** 生成した仕様はすべて \`unreviewed\` のまま残し、人間オーナーが \`documi serve\` 上で確認・修正・承認できるようにする。
3. 作成したドキュメント・Spec ID 一覧と、既存コードから判断がつかなかった曖昧点（人間の意思決定が必要な点）を簡潔に報告する。
`,
    }
  }

  return {
    'documi/SKILL.md': `---
name: documi
description: Read, search, surgically edit, and verify Living Specifications managed by Documi via the documi CLI. Use before implementing features, changing behavior/API/architecture, reviewing specs, or syncing code and tests with specifications.
---

# Documi Living Specification Workflow (CLI)

This repository manages its Living Specifications in \`${relDocsDir}/\` using **Documi**.
Use the \`documi\` CLI instead of reading raw spec files one by one so context stays minimal and structured.
Prefer the **default compact text output** for reading to minimize token usage; add \`--json\` only when structured fields are needed (and \`--full\` only when complete Goal/Architecture bodies or full trace arrays are required). Run \`documi --help\` for the full flag list.

## 1. Progressive Disclosure (Read Before Coding)

1. **Unknown Spec ID / natural-language task**: Run \`documi retrieve "<task or question>"\` — combines BM25, glossary alias expansion, and graph traversal (upstream Goals, Decision \`<Outcome>\`s, related docs, Terms, \`<SourceRef>\`s) within a character budget in one shot.
2. **Project overview**: Run \`documi map\` to load Goals, Architecture summaries, Decision \`<Outcome>\` blocks, Domain Terms, and Review / Realization status (use \`documi map --json\` for structured output).
3. **Filtering & search**: Run \`documi query [--kind spec] [--review ...] [--realization ...] [--has-feedback] [--q <text>]\` or \`documi search "<query>"\`.
4. **Target Spec deep dive**: Run \`documi context <spec-id>\` for its spec body, upstream Goals, unresolved feedback, related Design/Contract docs, Terms, and \`<SourceRef>\` anchors (use \`documi show <doc-id>\` or \`documi relations <id>\` only when full prose or graph edges are needed).

## 2. Surgical Editing via CLI (Keep Diffs Minimal)

When updating specifications, prefer Documi's AST-aware CLI commands over rewriting whole MDX files. **For multiline Markdown or bodies containing backticks, pass \`--body -\` with a single-quoted heredoc** (or \`--body-file <file>\`) to avoid shell quoting issues:

\`\`\`bash
documi block update <block-id> --stability evolving --body - <<'EOF'
**When** the trigger condition occurs,
**the** system **shall** produce the expected observable behavior.
EOF
\`\`\`

- \`documi block update <block-id> --body - [--stability ...] [--derives a,b]\` — replace the body or attributes of an existing semantic block in place.
- \`documi block add <doc-id> --kind spec --id <new-id> --derives <goal> --body - [--after-heading "<heading>"]\` — append a new semantic block to an existing document.
- \`documi term upsert <term-id> --definition "..." [--aliases a,b] [--symbols src/foo.ts#Foo]\` — add or update a \`<TermDef>\` in the glossary.
- \`documi scaffold <rel-path.mdx> --title "..." [--type spec] [--derives a,b] [--body -]\` — create a new typed document with valid frontmatter (refuses to overwrite existing files).
- \`documi block rename <old-id> <new-id> --dry-run\` — safely rename a block ID and all cross-references across \`${relDocsDir}/\` and code/tests (always preview with \`--dry-run\` first).

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

1. Run \`documi check --no-review-edit\` and confirm 0 errors (Rooted DAG, MDX safety, AST symbol references).
2. Summarize any new or modified Spec IDs so the human reviewer can inspect and approve them in the Documi Web UI (\`documi serve\`).
`,
    'documi-bootstrap/SKILL.md': `---
name: documi-bootstrap
description: Bootstrap Documi Living Specifications for an existing (brownfield) codebase using the documi CLI. Use when adopting Documi in a repository that already has source code and tests, to inventory architecture, domain terms, and core specifications incrementally.
---

# Documi Brownfield Bootstrap Workflow (CLI)

Use this skill when introducing Documi into an **existing codebase** so that initial Living Specifications reflect reality without overwhelming the repository with boilerplate.

## 1. Inspect the Existing Repository

1. Map the repository layout: top-level directories, runtime/build manifests (\`package.json\`, \`Cargo.toml\`, \`go.mod\`, \`pyproject.toml\`, etc.), entry points, and existing \`README.md\` or docs.
2. Check whether \`docs/\` is already occupied by user-facing documentation (e.g., Docusaurus/VitePress).
   - If \`docs/\` is occupied, create \`.documi.json\` at the project root (for example \`{ "docs": "documi" }\`) so Documi does not collide with existing docs.
3. Identify the 3–5 most critical user-facing or domain capabilities, key domain data structures/types, and existing test suites.

## 2. Establish Top-Down Anchors First (Thin Skeleton)

Use \`documi\` CLI commands (\`documi scaffold\`, \`documi block add\`, \`documi term upsert\`) rather than hand-crafting large files:

1. **Root Goal (\`goals/\`)**: Create 1 concise Root Goal describing the product purpose, target users, and explicit Non-Goals. Capture hard architectural invariants as \`<Constraint id="...">\`.
2. **System Overview (\`architecture/\`)**: Create 1 high-level architecture document describing modules, boundaries, and data flow with real \`<SourceRef file="src/..." />\` links.
3. **Existing Key Decisions (\`decisions/\`)**: Record only the 1–3 most consequential architectural decisions already baked into the codebase, each with a 2–3 line \`<Outcome id="dec....">\`.

## 3. Extract Bottom-Up Living Specs From Real Code

1. **Domain Glossary (\`domain/glossary.mdx\`)**: Register the 5–10 core domain concepts via \`documi term upsert\` with \`--symbols src/...#Symbol\` pointing to real types/classes/functions in the codebase.
2. **Core Specifications (\`specs/\`)**: For each critical capability (start small: 3–5 specs, not every helper function):
   - Write EARS-style \`<Spec id="domain.capability" stability="evolving" derives="goals/...">\` blocks describing the *observable contract* of the existing system.
   - Do not fabricate undocumented behavior; verify against the actual implementation and tests.
   - Add \`// @implements <spec.id>\` (or \`<SourceRef ... satisfies="<spec.id>" />\`) and link existing tests where appropriate.
3. **Contracts (\`contracts/\`)**: If the project exposes HTTP/RPC APIs, CLI commands, or event schemas, summarize them in a contract document linked via \`satisfies\`.

## 4. Validate & Hand Off to Humans

1. Run \`documi check\` and fix all broken \`<SourceRef>\` paths, missing \`derives\` (orphan specs), or invalid MDX syntax.
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
  const lang: InitLanguage = options.lang ?? 'en'
  const today = options.today ?? new Date().toISOString().slice(0, 10)
  const relDocs = path.relative(projectRoot, docsDir).split(path.sep).join('/') || 'docs'

  const createdDocs: string[] = []
  const skippedDocs: string[] = []
  const createdSkills: string[] = []
  const updatedSkills: string[] = []
  const skippedSkills: string[] = []

  if (!options.skillsOnly) {
    for (const [rel, content] of Object.entries(buildDocTemplates(today, lang))) {
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
    for (const [rel, content] of Object.entries(buildSkillTemplates(relDocs, lang))) {
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
    lang,
    createdDocs,
    skippedDocs,
    createdSkills,
    updatedSkills,
    skippedSkills,
  }
}
