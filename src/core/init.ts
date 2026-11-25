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
3. **条件絞り込み・横断検索**: \`documi query [--kind spec] [--review ...] [--realization ...] [--q <語>]\` または \`documi search "<query>"\`。
4. **特定 Spec の深掘り**: \`documi context <spec-id>\` — 対象 Spec 本文・上流 Goal・関連文書・用語・\`<SourceRef>\` を取得する（全文や参照関係が必要なら \`documi show <doc-id>\` / \`documi relations <id>\`）。

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

## 3. コード・テストと仕様の同期・更新トリガー

- 実装コードには \`// @implements <spec.id>\`（または設計書に \`<SourceRef file="src/..." satisfies="<spec.id>" />\`）を付与する。
- 検証テストには \`test('[<spec.id>] ...', ...)\`（または \`// @verifies <spec.id>\`）を含め、設定されていれば JUnit XML を出力する。
- \`<SourceRef file="...">\` と \`<TermDef symbols="...">\` は必ずプロジェクトルートからの POSIX 相対パスで記述する。
- **書く／書かないの境界**: 公開シンボル（export された \`class\` / \`interface\` / \`type\` / 公開関数）は手書きコピペせず \`<SourceRef file="src/..." mode="exports" />\` や \`<SourceRef symbol="..." />\` で AST 紐づけして把握できるようにする。一方、非公開ヘルパーや関数内の \`if\`/\`for\` 擬似コードは書かず、外部から観測できる条件・エラー・フォールバックのみを \`spec\` / \`contract\` に書く。
- **更新トリガー（PR 完了前セルフチェック）**:
  - 新サブシステム・主要モジュール追加 → \`architecture\` 更新 ＋ \`design\`（\`satisfies\`・\`<SourceRef>\`）追加・更新
  - 後戻りコストが高い構造・技術判断 → \`decision\`（ADR＋\`<Outcome>\`）を追加
  - 新しい \`<Spec>\` やテストスイート追加 → \`verification\` の \`verifies\` と一覧を更新
  - 1 つの \`spec\` ファイルが 10 件超の \`<Spec>\` を超えた → \`documi scaffold\` で領域別に分割

## 4. 守るべき不変ルール

- **\`${relDocsDir}/guard/reviews.json\` を直接編集しない。** 承認記録は人間専用（\`documi check --no-review-edit\` で検証）。
- **MDX 内で実行可能な JavaScript を書かない**（ESM \`import\`/\`export\`・JSX 式 \`{...}\`・未許可コンポーネントは禁止）。
- **\`${relDocsDir}/\` 内に一時的な \`tasks.md\` 等を作らない。** 進捗（\`realization\`）はコード・テスト・PR から自動算出される。

## 5. 完了前の検証と引き継ぎ

1. \`documi check --no-review-edit\` を実行し、エラー 0 件（Rooted DAG・MDX 安全性・AST シンボル参照）および健全性ヒント（Design / Verification カバレッジ・Spec 肥大化）を確認する。
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
2. **\`${relDocsDir}/guard/reviews.json\` は絶対に編集しない。** 生成した仕様はすべて \`unreviewed\` のまま残し、人間オーナーが \`documi serve\` 上で確認・修正・承認できるようにする。
3. 作成したドキュメント・Spec ID 一覧と、既存コードから判断がつかなかった曖昧点（人間の意思決定が必要な点）を簡潔に報告する。
`,
      'documi-review/SKILL.md': `---
name: documi-review
description: 未承認・stale・suspect な仕様を 2〜3 件ずつ取り上げ、具体シナリオやエッジケースの選択式クイズで人間と AI の認識ズレを炙り出し、合意後に人間専用の承認コマンドを引き継ぐ対話レビュースキル。仕様レビュー・承認前の理解確認に使用します。
---

# Documi 対話型仕様レビュー・認識合わせクイズ（CLI）

「読んだつもりのハンコ承認」と「AI 側の勝手な解釈・勘違い」を同時に防ぐための対話レビュー手順です。
**1 回に 2〜3 件のブロック**に絞り、具体的なエッジケースや挙動の選択式クイズで認識を合わせてから、人間が自分の手で承認できるように引き継ぎます。

## 1. 今回のレビュー対象を 2〜3 件選ぶ

1. ユーザーから特定のドキュメントや Spec ID の指定があればそれを対象にする。
2. 指定が無ければ、以下の優先順で \`documi query\` を実行し、**未処理の 2〜3 件**だけを選ぶ（1 度に大量の仕様を並べない）：
   - \`documi query --review stale\`（承認後に変更されたブロック）
   - \`documi query --suspect\`（上流変更が波及したブロック）
   - \`documi query --review unreviewed --kind spec\`（未承認の正式仕様）
3. 選んだ各ブロックについて \`documi context <spec-id>\` を実行し、上流 Goal・Decision \`<Outcome>\`・関連制約・\`<SourceRef>\`（実コード）を把握する。

## 2. 具体シナリオ・エッジケースのクイズをテンポよく出題する

選んだ **2〜3 件のブロックに対して、各 1〜2 問（1 ラウンド計 3〜5 問）** を選択式（A/B/C/D）メインで出題する。利用しているエージェントに選択式質問 UI ツール（例: \`ask_question\`）がある場合は積極的に使い、人間がクリックだけで回答できるようにする。

- **良い出題の切り口（認識ズレが出やすい箇所を狙う）**:
  - **障害・フォールバック**: 外部依存や入力が欠けたとき、エラー終了するかフォールバックするか？
  - **境界・セキュリティ拒否**: プロジェクトルート外パスや不正フラグを渡されたとき、どう拒否するか？
  - **優先順位・競合解決**: 設定ファイルと CLI 引数、あるいは \`.mdx\` と \`.md\` が衝突したとき、どちらが勝つか？
  - **副作用・不変条件**: 書き込み範囲はどこまでか、MDX 本文とサイドカーの責務はどう分かれているか？
- **禁止する出題**:
  - 仕様文面の単語穴埋めや、読んでいれば誰でも分かるトリビア問題。
  - 仕様の全文を丸ごと貼り付けて「これで合っていますか？」と聞くだけの形式。
- 各質問には「（どれも違う／仕様をこう変えたい）」と答えやすい余地を残し、人間の意図と仕様が食い違っていれば即座に拾えるようにする。

## 3. 回答の照合とズレの即時修正

人間の回答を受け取ったら、各ブロックについて簡潔に照合する：

1. **認識が一致した場合**: 1 行で簡潔に確認し、テンポを止めない。
2. **人間側の読み飛ばし・記憶違いだった場合**: 現行仕様の挙動と理由を 1〜2 行で補足し、「この現行仕様で意図通りか？」を確認する。
3. **仕様や AI 側の勘違いが見つかった場合**:
   - 人間の意図に合わせて \`documi block update <block-id> --body - <<'EOF'\` で仕様を精密修正する（コード・テスト変更も必要なら続けて提案・修正する）。
   - 修正後に \`documi check --no-review-edit\` でエラー 0 件を確認する。

## 4. 人間専用の最終確認 URL・承認コマンドを引き継ぐ（不変ルール）

- **AI は絶対に \`${relDocsDir}/guard/reviews.json\` を編集せず、\`documi approve\` / \`documi unapprove\` も実行しない。** 承認の最終決定と記録は必ず人間が行う。
- 認識が 100% 一致したブロックだけを選び、人間が 1 クリックで最終確認・まとめて承認できる **Web UI 最終確認 URL**（確認した内容の短い要約を \`note\` クエリに載せる）と、CLI コマンドを併せて提示する：

  - Web UI 最終確認 URL: \`/review?ids=<aligned-id-1>,<aligned-id-2>&note=<URLエンコード済み確認メモ>\`
  - CLI コマンド:
\`\`\`bash
documi approve <aligned-id-1> <aligned-id-2> --note "<確認した内容の要約>"
\`\`\`

- 最後に「次の 2〜3 件も続けますか？」と尋ね、ユーザーのペースで段階的に承認を進められるようにする。
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
3. **Filtering & search**: Run \`documi query [--kind spec] [--review ...] [--realization ...] [--q <text>]\` or \`documi search "<query>"\`.
4. **Target Spec deep dive**: Run \`documi context <spec-id>\` for its spec body, upstream Goals, related Design/Contract docs, Terms, and \`<SourceRef>\` anchors (use \`documi show <doc-id>\` or \`documi relations <id>\` only when full prose or graph edges are needed).

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

## 3. Sync Code, Tests & Update Triggers

- Link implementation code to specs with \`// @implements <spec.id>\` (or \`<SourceRef file="src/..." satisfies="<spec.id>" />\`).
- Link verification tests with \`test('[<spec.id>] ...', ...)\` (or \`// @verifies <spec.id>\`) and emit JUnit XML when running tests if configured.
- Always write \`<SourceRef file="...">\` and \`<TermDef symbols="...">\` as POSIX paths relative to the project root.
- **Boundary rule**: Surface public boundary symbols (exported classes, interfaces, types, public functions) via \`<SourceRef file="src/..." mode="exports" />\` or \`<SourceRef symbol="..." />\` rather than hand-copying declarations; never write private helper steps or function-internal \`if\`/\`for\` pseudocode in docs—record only observable behavior, errors, and fallbacks in \`spec\`/\`contract\`.
- **Update triggers (check before finishing)**:
  - New subsystem or core module -> update \`architecture\` and add/update \`design\` (with \`satisfies\` + \`<SourceRef>\`)
  - High-reversibility structural/technical choice -> add a \`decision\` (ADR with \`<Outcome>\`)
  - New \`<Spec>\` or test suite -> update \`verification\` (\`verifies\` list + suite table)
  - A \`spec\` file exceeds ~10 \`<Spec>\` blocks -> split by domain with \`documi scaffold\`

## 4. Invariant Guardrails

- **Never edit \`${relDocsDir}/guard/reviews.json\` directly.** Approvals belong strictly to humans (enforced by \`documi check --no-review-edit\`).
- **Never write executable JS inside MDX** (no ESM \`import\`/\`export\`, no JSX \`{...}\` expressions, no unapproved components).
- **Never create temporary \`tasks.md\` checklists inside \`${relDocsDir}/\`** — progress is computed automatically from code, tests, and PRs.

## 5. Verify Before Finishing

1. Run \`documi check --no-review-edit\` and confirm 0 errors (Rooted DAG, MDX safety, AST symbol references) and inspect any health hints (Design / Verification coverage, bloated spec files).
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
2. **Do not edit \`${relDocsDir}/guard/reviews.json\`.** Leave all bootstrapped specs as \`unreviewed\` so the human owner can read, refine, and approve them in \`documi serve\`.
3. Present a concise summary of created documents, Spec IDs, and any ambiguities discovered in the existing codebase that need a human decision.
`,
    'documi-review/SKILL.md': `---
name: documi-review
description: Run an interactive specification review and alignment quiz for unreviewed, stale, or suspect Documi blocks (2–3 blocks per round) using concrete edge-case scenarios to catch both human rubber-stamping and AI misunderstandings, then hand off human-only approval commands.
---

# Documi Interactive Review & Alignment Quiz (CLI)

Use this workflow to prevent both **rubber-stamp approvals** (approving without really noticing edge cases) and **AI misunderstandings** (spec drift from the human's actual intent).
Work in fast, focused rounds of **2–3 blocks at a time**, verify alignment through concrete scenario questions, fix any spec mismatches immediately, and hand off the exact approval command for the human to run.

## 1. Pick a Focused Batch (2–3 Blocks Only)

1. If the user names specific documents or Spec IDs, review those.
2. Otherwise, run \`documi query\` in priority order and pick **only 2–3 blocks** for this round (never dump dozens of specs at once):
   - \`documi query --review stale\` (modified after approval)
   - \`documi query --suspect\` (upstream changed)
   - \`documi query --review unreviewed --kind spec\` (unreviewed normative specs)
3. Run \`documi context <spec-id>\` on each selected block to inspect its upstream Goal, Decision \`<Outcome>\`, constraints, and linked \`<SourceRef>\` code.

## 2. Ask Concrete Edge-Case & Scenario Questions

For the **2–3 selected blocks**, ask **1–2 multiple-choice questions per block (3–5 questions total per round)** targeting real behavioral boundaries. If your agent supports an interactive multiple-choice question UI tool (e.g., \`ask_question\`), prefer it so the human can simply click their answers.

- **High-signal question angles**:
  - **Failure & fallback**: What happens when a dependency is missing, offline, or throws?
  - **Security & boundary rejection**: What happens on out-of-root paths, invalid flags, or forbidden writes?
  - **Precedence & conflict**: When config vs. CLI flag or two files collide, which wins?
  - **Side effects & invariants**: Which files are written vs. kept immutable (MDX body vs. guard sidecar)?
- **Avoid**:
  - Fill-in-the-blank trivia copied straight from prose.
  - Pasting whole spec paragraphs and asking "Does this look OK?"
- Always leave room for the human to reply *"None of these — the spec should actually do X"*.

## 3. Reconcile Answers & Fix Mismatches Immediately

When the human answers:

1. **Aligned**: Confirm in 1 concise line and keep momentum.
2. **Human missed a detail**: Briefly explain what the current spec says and ask whether they agree with it as written.
3. **Spec or AI misunderstanding**:
   - Update the spec in place via \`documi block update <block-id> --body - <<'EOF'\` (and update code/tests if requested).
   - Run \`documi check --no-review-edit\` to confirm 0 errors.

## 4. Hand Off Human-Only Final Confirmation URL & Approval (Strict Invariant)

- **NEVER edit \`${relDocsDir}/guard/reviews.json\` and NEVER execute \`documi approve\` or \`documi unapprove\` yourself.** Approval belongs strictly to the human.
- For the blocks confirmed as 100% aligned, present a **Web UI final-confirmation URL** (including a short URL-encoded summary in \`note=\` so the human can review and approve all matching blocks in 1 click) along with the equivalent CLI command:

  - Web UI Final Confirmation URL: \`/review?ids=<aligned-id-1>,<aligned-id-2>&note=<url-encoded-summary>\`
  - CLI command:
\`\`\`bash
documi approve <aligned-id-1> <aligned-id-2> --note "<short summary of what was verified>"
\`\`\`

- Ask if the user wants to continue to the next batch of 2–3 blocks.
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
