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

<Decision id="dec.initial-architecture" summary="初期アーキテクチャ方針の結論を 1〜2 行で簡潔に記述する" stability="evolving">
  決定した結論を 2〜3 行で簡潔に記述します。独立 \`decision\` ファイル内の \`<Decision>\` は AI への常時コンテキストとして優先投入されます。
</Decision>

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

<Test id="test.example.behavior" verifies="example.behavior" level="unit">
  - **Given**: 正常な入力が与えられている
  - **When**: 対象操作を実行する
  - **Then**: 期待される結果が返る
</Test>
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

<Decision id="dec.initial-architecture" summary="Summarize the initial architecture decision in 1–2 concise lines" stability="evolving">
  Summarize the decision in 2–3 concise sentences. Top-level Decision blocks are surfaced upfront in project maps.
</Decision>

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

<Test id="test.example.behavior" verifies="example.behavior" level="unit">
  - **Given**: Valid input is provided
  - **When**: The target action is executed
  - **Then**: The expected observable result is returned
</Test>
`,
  }
}

function buildSkillTemplates(relDocsDir: string, lang: InitLanguage): Record<string, string> {
  if (lang === 'ja') {
    return {
      'documi/SKILL.md': `---
name: documi
description: Documi CLI を使って Living Specification（${relDocsDir}/ の仕様・契約・設計・ADR・用語集）を検索・精密編集・検証する日常運用スキル。機能実装・仕様変更・バグ修正・API/スキーマ変更・コードとテストの同期・チャット合意の記録を行うときは必ず使用する。新機能の上流設計・技術選定には先に documi-design、既存コードへの初回導入には documi-bootstrap、人間との認識合わせクイズには documi-review、仕様の再現性監査には documi-audit を使う。
---

# Documi Living Specification 運用ワークフロー（CLI）

> ワークフロー位置: \`documi-design\`（上流設計）→ **\`documi\`（日常運用・実装）** → \`documi-audit\`（再現性監査）→ \`documi-review\`（人間承認）

このリポジトリは \`${relDocsDir}/\` 配下の Living Specification を **Documi** で管理しています。
ファイルを 1 件ずつ丸ごと読む代わりに、\`documi\` CLI の既定コンパクト出力を使って段階的に文脈を取得・精密編集してください（構造化データが必要なときだけ \`--json\`、全文展開が必要なときだけ \`--full\`）。

## Hard Gates（絶対に破らない）

- **Spec-First**: 仕様・振る舞い・契約を変えるときは、コードやテストより先に \`${relDocsDir}/\` を更新し、\`documi check --no-review-edit\` を通す。
- **変更前に \`documi impact <id>\`**: 既存仕様を変える前に必ず影響範囲（下流文書・ブロック・コード・テスト）を洗い出す。
- **\`${relDocsDir}/guard/reviews.json\` 編集禁止**: 承認記録は人間専用。AI は絶対に編集せず \`documi approve\` / \`unapprove\` も実行しない。
- **MDX 安全性**: MDX 内で実行可能な JS（ESM \`import\`/\`export\`・JSX 式 \`{...}\`・未許可コンポーネント）を書かない。
- **一時ファイル禁止**: \`${relDocsDir}/\` 内に \`tasks.md\` 等を作らない（進捗は \`realization\` で自動算出）。
- **チェスタートンの柵**: 理由不明な防御コード・ワークアラウンドを勝手に消さない（削除前に \`git log -S\` / \`git blame\` と \`documi search --context\` で経緯を確認。詳細は \`documi-design\`）。

## 1. 段階的コンテキスト取得（実装前に読む）

1. **Spec ID が未確定のタスク**: \`documi search "<自然文のタスクや質問>" --context\` — BM25＋用語集同義語展開＋グラフ展開で関連 Spec・上流 Goal・\`<Decision>\`・用語・\`<SourceRef>\` を 1 発取得する。
2. **全体像の把握**: \`documi map\` — Goal・\`systemDesigns\`・\`systemConstraints\`・現行独立 \`<Decision>\`・ドメイン用語（\`antiTerms\` 含む）・Review / Realization 状況を一括取得する。
3. **条件絞り込み**: \`documi query [--kind spec] [--review ...] [--realization ...] [--q <語>]\` または \`documi search "<query>"\`。
4. **特定 Spec の深掘り・影響確認**: \`documi context <spec-id>\` で対象 Spec と周辺文脈を取得し、変更前は必ず \`documi impact <id>\` を実行する。

## 2. 矛盾防止・合意の即時永続化・執筆ルール

- **1 事実 1 箇所（SSOT）**: 同じ仕様表や列挙を重複コピーせず、正規の置き場所（\`spec\`＝振る舞い／\`contract\`＝外部 I/F・スキーマ／\`design\`＝モジュール責務）を 1 箇所に決め、他文書からはリンクや \`<Term>\` で参照する。
- **古い決定は \`supersedes\` で廃止**: 方針転換時は新 ADR に \`supersedes: [decisions/<old-adr>]\` を付け、横に v2 ファイルを乱立させない。
- **チャット合意の即時永続化**: ユーザーと合意した方針・却下案は \`<Decision>\`、振る舞いは \`<Spec>\`、保証シナリオは \`<Test verifies="..." level="...">\`、禁止事項は \`<Constraint>\`、軽い仮置きは \`intent="idea"\`（判断基準は \`documi-design\`）へ**その場で即記録する**。
- **視覚ファースト執筆（SHOULD）**: 結論ファースト・1 段落 3 行以内・箇条書き先頭太字・フローは Mermaid・条件分岐は表・長い補足は \`<Details>\` に畳む。

## 3. CLI による精密編集（差分最小化）

MDX 全体を手書きで書き換えず AST 位置ベースの CLI を優先する。複数行 Markdown やバッククォートを含む本文は \`--body -\` ＋シングルクォートヒアドキュメント（または \`--body-file\`）を使う：

\`\`\`bash
documi block update <block-id> --stability evolving --body - <<'EOF'
**When** 条件が発生したとき、
**the** システム **shall** 期待される振る舞いを行う。
EOF
\`\`\`

- \`documi block update <block-id> --body - [--stability ...] [--derives a,b]\` — 既存ブロックの該当行範囲のみ更新
- \`documi block add <doc-id> --kind spec --id <new-id> --derives <goal> --body - [--after-heading "<見出し>"]\` — ブロックを 1 件追記
- \`documi term upsert <term-id> --definition "..." [--aliases a,b] [--symbols src/foo.ts#Foo]\` — \`<TermDef>\` を追加・更新
- \`documi scaffold <rel-path.mdx> --title "..." [--type spec] [--derives a,b] [--body -]\` — 新規文書を作成（既存上書き拒否）
- \`documi block rename <old-id> <new-id> --dry-run\` — 全 \`${relDocsDir}/\` とコード・テストの ID 参照を一括リネーム（先に \`--dry-run\` 必須）

## 4. コード・テストと仕様の同期

- 実装には \`// @implements <spec.id>\`（または \`<SourceRef file="src/..." satisfies="<spec.id>" />\`）、テストには \`test('[<spec.id>] ...', ...)\`（または \`// @verifies <spec.id>\`）を付与する。
- \`<SourceRef file="...">\` と \`<TermDef symbols="...">\` はプロジェクトルートからの POSIX 相対パスで記述する。
- **再現性 4 チェック**: 別 AI が \`${relDocsDir}/\` だけで同じ挙動を再現できるか確認する — ① 境界条件・エラー拒否、② 優先順位・フォールバック、③ 入出力・永続スキーマの \`contract\` 同期、④ 公開シンボルは \`<SourceRef mode="exports" />\` / \`symbol="..."\` で AST 接続（非公開ヘルパーや \`if\`/\`for\` 擬似コードは書かない）。
- **Capability 単位分割**: \`spec\` は 1 Capability = 1 ファイル。無関係な機能が並び始めたら件数に関係なく \`documi scaffold\` で分割する（10 件超は \`bloated-spec-doc\` で検知）。
- **新規 \`<Spec>\` 追加時**: 同じ \`spec\` / \`contract\` 内に \`<Test id="..." verifies="<spec.id>" level="...">\` の Given / When / Then を同居させ、必要に応じ \`design\` / \`<Decision>\` も更新する。

## Gotchas（よくある失敗と言い訳封じ）

| やりがちな言い訳・失敗 | 正しい対処 |
| :--- | :--- |
| 「小さな変更だから先にコードだけ直そう」 | **NG**。先に \`${relDocsDir}/\` を更新してから実装する（\`docs-sync-missing\` の原因） |
| 「チャットで合意したし覚えている」 | **NG**。別セッションでは消える。その場で \`${relDocsDir}/\` に永続化する |
| 「用語を分かりやすく日本語や別名で書こう」 | **NG**。1 概念＝1 正準表記。登録済み用語はバッククォートで囲わず正準 ID で書く |
| 「\`goal\` に制約や実装タグも書いておこう」 | **NG**。\`goal\` は Problem Space のみ。技術制約は \`design (scope: system)\` へ分離する |

## 5. 検証と完了時の報告フォーマット

1. \`documi check --no-review-edit\` を実行し、エラー 0 件・健全性ヒントを確認する。
2. 完了時は以下の形式で簡潔に報告する：
   - **更新した Spec / 文書**: ID と 1 行要約
   - **検証結果**: \`documi check --no-review-edit\` とテスト結果
   - **人間確認が必要な点**: 未確定の \`intent="idea"\` やレビュー対象（あれば \`http://localhost:3000/review?filter=changed\` を案内）
`,
      'documi-design/SKILL.md': `---
name: documi-design
description: 新機能設計・仕様策定・方針相談・技術選定・アーキテクチャ変更・ADR 作成を求められたら、コードを 1 行も書く前に必ず使用する上流設計スキル。車輪の再発明・古いライブラリ/GitHub Actions 記法・狭い 2 択の ADR・人間の暗黙の前提漏れを防ぐ。既存仕様が確定している軽微な修正・バグ修正・単なるコード同期には使わない（documi を使う）。
---

# Documi 上流設計・調査・仕様確定スキル (\`documi-design\`)

> ワークフロー位置: **\`documi-design\`（上流設計）** → \`documi\`（日常運用・実装）→ \`documi-audit\`（再現性監査）→ \`documi-review\`（人間承認）

AI がコードを書く前にやりがちな 4 大事故（**車輪の再発明・古い API/Actions 記法・狭い 2 択の ADR・暗黙の前提を勝手な仮定で埋める**）を構造的に防ぎ、人間と合意した仕様・設計・ADR を確定させる手順です。

## Hard Gates（絶対に破らない）

- **調査前に実装しない**: 既存資産の棚卸し（\`documi map\` / \`documi search --context\`）と実バージョン確認が終わるまでコードを 1 行も書かない。
- **重い曖昧さは勝手に決めない**: データ構造・外部 API/CLI 契約・権限/セキュリティ・アーキテクチャ境界・Non-Goals に曖昧さがあれば、実装前に必ず選択式で人間に確認する。
- **学習データの古い記憶で書かない**: ライブラリ API や GitHub Actions は必ず \`node_modules/*.d.ts\` または公式ドキュメント Web 検索で裏を取る。
- **チェスタートンの柵**: 一見ムダに見える既存ガードやワークアラウンドを理由不明のまま削らない（\`git log -S\` / \`git blame\` と \`documi search --context\` で経緯確認必須）。

## 1. 既存資産と制約の棚卸し（車輪の再発明を防ぐ）

1. \`documi map\` — Goal・\`goalConstraints\`・\`systemDesigns\`・\`systemConstraints\`・\`domainInvariants\`・\`decisions\`・\`terms\`（\`antiTerms\` 含む）を把握する。
2. \`documi search "<今回のテーマ>" --context\` — 関連仕様・既存設計・\`<SourceRef>\` を一括取得する。
3. 対象領域の \`<SourceRef mode="exports">\` や既存ユーティリティを確認し、既にある関数・型・UI コンポーネント・エラー型を再発明しない。

## 2. 最新バージョンと一次情報の確認（古い記法を防ぐ）

1. **実バージョンの確認**: \`package.json\`・lockfile・\`.github/workflows/*.yml\`・Dockerfile 等の実バージョンを確認する。
2. **ライブラリ API の裏取り**: 推測で書かず \`node_modules/\` の \`.d.ts\` 型定義または公式ドキュメント Web 検索で現行 API を確認する。
3. **GitHub Actions / 外部ツールの裏取り**: 古いメジャーバージョンを惰性で書かず、最新推奨を確認してから記述する。

## 3. 外部パターンのリサーチ（視野の狭い ADR を防ぐ）

1. Web 検索で先行事例・業界標準・定番ライブラリを調査し、頭の中の狭い 2 択で結論を急がない。
2. 最低 2〜3 案を比較したうえで、\`<Decision id="dec.xxx" summary="...">\` に \`<Context>\`・\`<Chosen>\`・\`<Rejected option="...">\`・\`<Tradeoff>\` を残す。
3. プロジェクト全体に関わる重い判断は独立 \`${relDocsDir}/decisions/YYYY-MM-DD-<slug>.mdx\`、機能固有の局所判断や地雷回避は該当 \`design\` / \`spec\` 内のインライン \`<Decision>\`（マイクロ ADR）に書く。

## 4. 暗黙の前提チェックと「質問 vs 仮実装」の切り分け

以下の 7 軸で抜け漏れを点検し、**抜けていて影響が大きい項目だけ**を短い選択式で人間に確認する：

- **権限・セキュリティ**（非ローカル／未認証／ルート外パスの拒否）
- **空・異常・境界値**（0 件・上限・不正入力・タイムアウト）
- **同時実行・冪等性**（連続実行・並列実行・途中失敗からの再実行）
- **データ寿命・削除・互換性**（永続先・削除時挙動・既存データ影響）
- **既存機能・他マウント影響**（\`documi impact <id>\` で下流確認）
- **語彙の一貫性**（\`<TermDef>\`・\`antiTerms\`・1 概念＝1 正準表記）
- **Non-Goals**（今回あえてやらない範囲）

### 後戻りコスト基準の切り分け
- **重い曖昧さ（後戻りコスト高）**: データ構造・外部契約・セキュリティ・境界・Non-Goals → **実装前に必ず人間と合意する**。
- **軽い曖昧さ（後戻りコスト低）**: デフォルト値・UI 細部・文言・補助オプション → **合理的な仮案で仮実装してよい**。ただし確定仕様に混ぜず \`<Note intent="idea" title="仮置き: ...">\` または \`<Spec intent="idea">\` に明示し、PR のレビュー観点にも記載する。
- **バグ修正・地雷回避の 3 点セット**: ① コード直前に 1 行の Why-not コメント、② Red → Green 再現テスト、③ 構造的地雷なら該当 \`design\`/\`spec\` 内インライン \`<Decision>\` ＋ \`<Test>\`。

## 5. 入出力の具体例 ＋ \`<SourceRef>\` で仕様確定

実装前に以下の 3 点セットを \`${relDocsDir}/\` に揃える：
1. **振る舞い (\`<Spec>\`)**: EARS 構文で観測可能な振る舞いと異常系を記述する。
2. **具体入出力 (\`<Test verifies="..." level="...">\`)**: 正常系・境界値・エラー系を Given / When / Then で同居させる。
3. **実コード境界 (\`<SourceRef>\`)**: 公開型・関数シグネチャは \`<SourceRef file="..." symbol="..." />\` または \`mode="exports"\` で AST 接続する。

## Gotchas（よくある失敗と言い訳封じ）

| やりがちな言い訳・失敗 | 正しい対処 |
| :--- | :--- |
| 「簡単な機能だから調査や比較は飛ばしてすぐ実装しよう」 | **NG**。既存ユーティリティの見落としや狭い 2 択 ADR の温床になる |
| 「どうせ後で直せるし、仕様の細かい前提は全部質問しよう」 | **NG**。後戻りコストの低い細部は \`intent="idea"\` で仮置きしてテンポを保つ |
| 「\`goal\` に新しい技術制約や実装方針もまとめて書こう」 | **NG**。\`goal\` は Problem Space のみ。技術制約は \`design (scope: system)\` へ置く |

## 6. 完了時の報告フォーマット

設計確定時は以下を簡潔に提示して合意を取る：
- **採用案と比較した代替案**: 2〜3 案のトレードオフ表（1〜3 行）
- **更新・新規作成する \`${relDocsDir}/\`**: Spec / Contract / Design / ADR の一覧
- **人間確認が必要な重い決定 / \`intent="idea"\` 仮置き**: 選択式質問または仮置き一覧
`,
      'documi-bootstrap/SKILL.md': `---
name: documi-bootstrap
description: すでにソースコードやテストが存在するリポジトリ（Brownfield）に Documi の Living Specification を初回導入・段階的に立ち上げるときに必ず使用するスキル。既存コードから Goal・System Design・用語集・コア仕様を棚卸しするときに使う。すでに ${relDocsDir}/ が運用中の通常変更には使わない（documi を使う）。
---

# Documi 既存コードベース（Brownfield）導入ワークフロー（CLI）

> ワークフロー位置: **\`documi-bootstrap\`（初回導入）** → \`documi\`（日常運用）→ \`documi-audit\`（肉付け）→ \`documi-review\`（人間承認）

既存リポジトリへ Documi を導入するとき、実態と乖離したテンプレの山を作らずに薄く正確な骨格から立ち上げる手順です。

## Hard Gates（絶対に破らない）

- **推測で仕様を創作しない**: 必ず実コードと既存テストを照合し、観測可能な振る舞いだけを記述する。
- **最初から全機能を仕様化しない**: コア仕様は最重要の 3〜5 件から始め、細かなヘルパーを仕様化しない。
- **\`${relDocsDir}/guard/reviews.json\` 編集禁止**: 生成した仕様はすべて \`unreviewed\` のまま残し、人間承認に委ねる。
- **既存 \`docs/\` を壊さない**: ユーザー向けドキュメント（Docusaurus / VitePress 等）で \`docs/\` が占有されている場合は \`.documi.json\`（例: \`{ "docs": "documi" }\`）で別ディレクトリに分離する。

## 1. 既存リポジトリの棚卸し

1. ディレクトリ構成・ビルド設定（\`package.json\`, \`Cargo.toml\`, \`go.mod\`, \`pyproject.toml\` 等）・エントリポイント・既存 \`README.md\` を確認する。
2. \`docs/\` が既存ドキュメントで占有されているか確認し、衝突するなら \`.documi.json\` でマウント先を分ける。
3. 最重要な 3〜5 個の中核機能、主要ドメイン型・データ構造、既存テストスイートを特定する。

## 2. トップダウンの骨格を先に作る（薄く始める）

手書きで長大なファイルを作らず、\`documi\` CLI（\`scaffold\` / \`block add\` / \`term upsert\`）で最小骨格を作る：

1. **Root Goal（\`goals/\`）**: プロダクトの目的・対象ユーザー・明示的な Non-Goals をまとめた Problem Space の Goal 文書を 1 件作成する（実装詳細や技術制約は入れない）。
2. **System Overview（\`designs/system-overview.mdx\`, \`scope: system\`）**: モジュール境界・データフロー・システム全体の技術制約（\`<Constraint id="sys....">\`）を 1 件にまとめ、実在する \`<SourceRef file="src/..." mode="exports" />\` を紐づける。
3. **主要な既存意思決定（\`decisions/\`）**: すでにコードベースに根付いている重要な技術選定を 1〜3 件だけ記録し、各結論を 2〜3 行の \`<Decision id="dec....">\` にまとめる。

## 3. 実コードからボトムアップでコア仕様を抽出する

1. **ドメイン用語集（\`domain/glossary.mdx\`）**: 中核概念 5〜10 個を \`documi term upsert\` で登録し、実在する型・クラス・関数を \`--symbols src/...#Symbol\` で紐づける。
2. **コア仕様（\`specs/\`）**: 重要な 3〜5 機能に絞り、観測可能な振る舞いを EARS 記法の \`<Spec id="domain.capability" stability="evolving" derives="goals/...">\` で記述する。実装に \`// @implements <spec.id>\`（または \`<SourceRef ... satisfies="<spec.id>" />\`）を付与し、既存テストがあれば紐づける。
3. **コントラクト（\`contracts/\`）**: 公開 HTTP/RPC API・CLI・イベントスキーマ等があれば \`satisfies\` 付きで簡潔にまとめる。

## Gotchas（よくある失敗と言い訳封じ）

| やりがちな言い訳・失敗 | 正しい対処 |
| :--- | :--- |
| 「網羅的に全ファイルを一気に Spec 化しよう」 | **NG**。薄いカタログの山になる。まず 3〜5 件のコア能力に絞る |
| 「\`README.md\` の宣伝文をそのまま \`goals/\` にコピペしよう」 | **NG**。\`goal\` は課題・対象ユーザー・Non-Goals の Problem Space に絞る |
| 「初期導入だし \`reviews.json\` も承認済みにしておこう」 | **NG**。必ず \`unreviewed\` のまま残して人間に確認・承認してもらう |

## 4. 検証と完了時の報告フォーマット

1. \`documi check --no-review-edit\` を実行し、\`<SourceRef>\` パス切れ・\`orphan-spec\`・MDX 構文エラーを 0 件にする。
2. 完了時は以下の形式で人間へ引き継ぐ：
   - **作成した骨格**: Goal / System Design / Decisions / Glossary / Core Specs の一覧と Spec ID
   - **確認・意思決定が必要な曖昧点**: コードから判断できなかった仕様・Non-Goals
   - **次のステップ**: \`documi serve\` で確認、または \`documi-review\` で認識合わせ開始
`,
      'documi-review/SKILL.md': `---
name: documi-review
description: 未承認・stale・suspect な仕様を 2〜3 件ずつ取り上げ、具体シナリオやエッジケースの選択式クイズで人間と AI の認識ズレを炙り出し、合意後に人間専用の最終確認 URL・承認コマンドを引き継ぐ対話レビュースキル。「仕様レビューしよう」「承認を進めたい」「認識合わせしたい」「未承認 / stale / suspect を確認して」と求められたときに必ず使用する。コードとの機械的なギャップ監査には使わない（documi-audit を使う）。
---

# Documi 対話型仕様レビュー・認識合わせクイズ（CLI）

> ワークフロー位置: \`documi-design\` → \`documi\` → \`documi-audit\` → **\`documi-review\`（人間との認識合わせ・承認引き継ぎ）**

「読んだつもりのハンコ承認」と「AI 側の勝手な解釈・勘違い」を同時に防ぐ対話レビュー手順です。
**1 ラウンド 2〜3 ブロック**に絞り、具体的なエッジケースの選択式クイズで認識を合わせてから、人間が自分の手で承認できるように引き継ぎます。

## Hard Gates（絶対に破らない）

- **承認記録は絶対に触らない**: \`${relDocsDir}/guard/reviews.json\` を編集せず、\`documi approve\` / \`documi unapprove\` も実行しない。
- **1 ラウンド 2〜3 件厳守**: 大量の仕様を一度に並べて人間の認知を溢れさせない。
- **全文貼り付け禁止**: 仕様全文を貼って「これで合っていますか？」と聞くだけのハンコ確認をしない。
- **フル URL で引き継ぐ**: チャット上で 1 クリック起動できるよう \`http://localhost:3000/review?ids=...&note=...\` のフル URL で提示する。

## 1. レビュー対象を 2〜3 件選ぶ

1. ユーザーから特定ドキュメントや Spec ID の指定があればそれを対象にする。
2. 指定が無ければ以下の優先順で \`documi query\` を実行し、未処理の **2〜3 件だけ** を選ぶ：
   - \`documi query --review stale\`（承認後に変更されたブロック）
   - \`documi query --suspect\`（上流変更が波及したブロック）
   - \`documi query --review unreviewed --kind spec\`（未承認の正式仕様）
3. 各ブロックに \`documi context <spec-id>\` を実行し、上流 Goal・\`<Decision>\`・関連制約・\`<SourceRef>\`（実コード）を把握する。

## 2. 具体シナリオ・エッジケースのクイズを出題する

選んだ **2〜3 件に対して各 1〜2 問（計 3〜5 問）** を選択式（A/B/C/D）メインで出題する。選択式質問 UI ツール（例: \`ask_question\`）がある場合は積極的に使う。

- **良い出題の切り口（認識ズレが出やすい箇所）**:
  - **障害・フォールバック**: 外部依存や入力が欠けたとき、エラー終了かフォールバックか？
  - **境界・セキュリティ拒否**: ルート外パスや不正フラグを渡されたときどう拒否するか？
  - **優先順位・競合解決**: 設定 vs CLI 引数、あるいはファイル衝突でどちらが勝つか？
  - **副作用・不変条件**: 書き込み範囲はどこまでか、MDX 本文とサイドカーの責務分離は？
- **禁止する出題**: 仕様文面の単語穴埋め、誰でも分かるトリビア、全文丸貼り確認。
- 各質問には「（どれも違う／仕様をこう変えたい）」と答えやすい余地を残す。

## 3. 回答の照合とズレの即時修正

1. **認識一致**: 1 行で簡潔に確認し、テンポを止めない。
2. **人間側の読み飛ばし・記憶違い**: 現行仕様の挙動と理由を 1〜2 行で補足し、意図通りか確認する。
3. **仕様や AI 側の勘違い**: \`documi block update <block-id> --body - <<'EOF'\` で仕様を精密修正し（必要ならコード・テストも更新）、\`documi check --no-review-edit\` でエラー 0 件を確認する。

## Gotchas（よくある失敗と言い訳封じ）

| やりがちな言い訳・失敗 | 正しい対処 |
| :--- | :--- |
| 「効率よく終わらせるために 10 件まとめて確認しよう」 | **NG**。ハンコ承認になる。必ず 2〜3 件ずつ刻む |
| 「合意できたからついでに \`documi approve\` も実行しておこう」 | **NG**。承認実行は人間専用。URL とコマンドを提示するだけ |
| 「パスだけ \`/review?ids=...\` と書けば分かるだろう」 | **NG**。チャット上でクリックできない。\`http://localhost:3000/review?...\` で出す |

## 4. 完了時の引き継ぎフォーマット（人間専用）

認識が 100% 一致したブロックだけを選び、以下の形式で引き継ぐ：

- **認識一致ブロック**: ID ごとに 1 行で確認済みの合意内容
- **Web UI 最終確認 URL**: \`http://localhost:3000/review?ids=<aligned-id-1>,<aligned-id-2>&note=<URLエンコード済み確認メモ>\`
- **CLI コマンド**:
\`\`\`bash
documi approve <aligned-id-1> <aligned-id-2> --note "<確認した内容の要約>"
\`\`\`
- **継続確認**: 「次の 2〜3 件も続けますか？」と尋ねる
`,
      'documi-audit/SKILL.md': `---
name: documi-audit
description: 既存のソースコード・テストと Documi の仕様・契約・設計・ADR を突き合わせ、「別 AI に ${relDocsDir}/ だけ渡してもほぼ同じ挙動を再現できる解像度」に不足している境界条件・優先順位・スキーマ・外部契約・ADR 漏れ・層の漏れを監査して肉付けするスキル。「仕様とコードがずれていないか確認して」「${relDocsDir} の薄い要約を補強して」「矛盾や穴を監査して」と求められたとき、または大きな仕様変更の実装前に必ず使用する。新機能の上流設計（documi-design）や人間向けの対話クイズ承認（documi-review）には使わない。
---

# Documi 再現性監査・ドキュメント肉付けワークフロー（CLI）

> ワークフロー位置: \`documi-design\`（上流設計）→ \`documi\`（日常運用・実装）→ **\`documi-audit\`（再現性監査）** → \`documi-review\`（人間承認）

\`${relDocsDir}/\` が「機能名のカタログ要約（1 機能 3 行）」に留まっていると、別の AI に \`${relDocsDir}/\` だけ渡しても同じ挙動を再現できず、AI コードレビューも発散します。
実コード・テストと \`${relDocsDir}/\` を **1 領域ずつ** 突き合わせ、擬似コード化を避けながら「再現可能レベル」まで引き上げます。

## Hard Gates（絶対に破らない）

- **1 回 1 領域に絞る**: リポジトリ全体を 1 度に書き換えない。1 領域（または変更 Spec とその \`documi impact\` 先）に絞る。
- **擬似コード禁止**: 関数内部の \`if\`/\`for\` 手順・非公開ヘルパー名・リファクタで変わる実装細部は書かない。
- **\`${relDocsDir}/guard/reviews.json\` 編集禁止**: 承認記録は絶対に触らない。

## 1. 監査スコープの選定と矛盾チェック

1. \`documi map\` および \`documi query --kind spec\` で対象領域の文書・Spec ID・健全性ヒントを確認する。
2. **実装前の意味的矛盾チェック**: 対象 Spec に \`documi impact <id>\` を実行し、影響先の \`spec\` / \`contract\` / \`design\` / \`decision\` 同士を突き合わせて **① 記述の重複・食い違い、② \`supersedes\` 漏れの古い ADR、③ 未定義の境界条件** を先に潰す。
3. 対象文書を \`documi show <doc-id>\` / \`documi context <spec-id>\` で読み、\`<SourceRef>\`・\`@implements\`・テストの実コードから**実際に守られている振る舞い**を抽出する。

## 2. 再現性ギャップの 6 観点チェック（AI 差し戻しテスト）

「**別 AI に \`${relDocsDir}/\` だけ渡してゼロから再実装させたとき、どこが違っていたら仕様違反で差し戻すか？**」の基準で 6 観点を点検する：

1. **境界条件・異常系・セキュリティ拒否**: 不正入力・空入力・上限値・パストラバーサル・未存在 ID・禁止構文の拒否方法と終了コード／ステータス。
2. **優先順位・フォールバック・競合解決**: 設定 vs 環境変数 vs CLI、拡張子衝突、外部依存障害時のフォールバック順。
3. **永続ファイル＆設定スキーマ契約 (\`contract\`)**: JSON / YAML / DB / 出力ファイルの実パス・フィールド・型・既定値・厳格検証。
4. **外部 I/F の入出力契約 (\`contract\`)**: REST API・MCP・CLI の引数・主要レスポンス構造・エラーコード・副作用範囲。
5. **公開境界の AST 紐づけと未記録 ADR 漏れ**: 主要モジュールの export を \`<SourceRef file="src/..." mode="exports" />\` で接続し、後戻りコストが高い判断や Non-Goals を ADR / Goal に記録する。
6. **層の漏れ・用語リンク健全性**: \`goal\`（Problem Space）に実装詳細（タグ名・関数名・ファイルパス・技術制約）や宣伝文が混入していないか、技術制約は全体設計（\`design\` / \`scope: system\`）へ分離されているか、登録済み用語がバッククォート囲みで自動リンク無効になっていないか。

## 3. 書きすぎ防止ガード（リファクタリングテスト）

- **書く（SHOULD）**: 決定表（条件 × 結果）、優先順位リスト、状態遷移図（Mermaid）、入出力フィールド表、エラー規約表、\`<Details>\`、\`<Columns>\`、\`<Timeline>\`、\`<SourceRef mode="exports" />\`。
- **長文ダイエット**: 前置きや重複を削り、3 行超の散文は表・Mermaid・\`<Details>\` へ変換する。
- **1 Capability = 1 ファイル**: \`spec\` は能力単位で凝集させ、無関係な機能を相乗りさせない（10 件超は肥大化ヒント対象）。

## Gotchas（よくある失敗と言い訳封じ）

| やりがちな言い訳・失敗 | 正しい対処 |
| :--- | :--- |
| 「再現性を上げるために関数の処理手順を全部書こう」 | **NG**。外部から観測できる契約・決定表・境界条件だけ書き、内部手順は書かない |
| 「ついでに他領域の docs も全部直しておこう」 | **NG**。レビュー不能になる。1 回 1 領域に絞る |
| 「コードと docs が食い違っているから勝手にコードの方を正にしよう」 | **NG**。意図的な仕様かバグか判断がつかない食い違いは人間に確認する |

## 4. 精密更新・検証と完了時の報告フォーマット

1. \`documi block update\` / \`documi scaffold\` 等で不足を補強する。
2. \`documi check --no-review-edit\` でエラー 0 件・\`<SourceRef>\` 切れ 0 件を確認する。
3. 完了時は以下の形式で報告する：
   - **監査対象**: 領域・対象文書 / Spec ID
   - **埋めたギャップ（6 観点別）**: 何をどこに補強したか（箇条書き 3〜6 行）
   - **人間の判断が必要な食い違い**: コードと仕様で意図確認が必要な点（あれば）
   - **確認導線**: \`http://localhost:3000/review?filter=changed\`
`,
    }
  }

  return {
    'documi/SKILL.md': `---
name: documi
description: Read, search, surgically edit, and verify Living Specifications in ${relDocsDir}/ via the documi CLI. Make sure to use this skill whenever implementing features, changing behavior/API/schemas, fixing bugs, syncing code/tests with specs, or recording chat agreements. For upstream feature design or ADRs, use documi-design first; for brownfield onboarding, use documi-bootstrap; for interactive human alignment quizzes, use documi-review; for reproducibility audits, use documi-audit.
---

# Documi Living Specification Workflow (CLI)

> Workflow position: \`documi-design\` (design) -> **\`documi\` (daily ops & implementation)** -> \`documi-audit\` (reproducibility audit) -> \`documi-review\` (human approval)

This repository manages its Living Specifications in \`${relDocsDir}/\` using **Documi**.
Use the \`documi\` CLI default compact text output instead of reading raw files one by one; add \`--json\` only when structured fields are needed and \`--full\` only when full bodies or trace arrays are required.

## Hard Gates (Never Violate)

- **Spec-First**: Update \`${relDocsDir}/\` before editing code or tests, and verify with \`documi check --no-review-edit\`.
- **Run \`documi impact <id>\` before changing any spec**: List all affected downstream docs, blocks, code anchors, and tests first.
- **Never edit \`${relDocsDir}/guard/reviews.json\`**: Approvals belong strictly to humans; never run \`documi approve\` or \`documi unapprove\`.
- **MDX safety**: Never write executable JS inside MDX (no ESM \`import\`/\`export\`, no JSX \`{...}\`, no unapproved components).
- **No temporary checklists**: Never create \`tasks.md\` inside \`${relDocsDir}/\` (progress is computed automatically from code, tests, and PRs).
- **Chesterton's Fence**: Never delete defensive guards or workarounds without understanding why they exist (check \`git log -S\` / \`git blame\` and \`documi search --context\`; see \`documi-design\`).

## 1. Progressive Disclosure (Read Before Coding)

1. **Unknown Spec ID / natural-language task**: \`documi search "<task or question>" --context\` — fetches related specs, upstream Goals, \`<Decision>\` conclusions, Terms, and \`<SourceRef>\`s in one shot within a character budget.
2. **Project overview**: \`documi map\` — loads Goals, \`systemDesigns\`, \`systemConstraints\`, active top-level \`<Decision>\` blocks, Domain Terms (including \`antiTerms\`), and Review / Realization status.
3. **Filtering**: \`documi query [--kind spec] [--review ...] [--realization ...] [--q <text>]\` or \`documi search "<query>"\`.
4. **Target Spec deep dive & blast radius**: Run \`documi context <spec-id>\` for full surrounding context and \`documi impact <id>\` before modifying any spec.

## 2. Contradiction Prevention, Decision Capture & Writing Rules

- **Single Source of Truth**: Keep each fact in one canonical place (\`spec\` = behavior & boundaries, \`contract\` = external I/F & schemas, \`design\` = module responsibilities); link rather than duplicating tables.
- **Retire old decisions with \`supersedes\`**: Add \`supersedes: [decisions/<old-adr>]\` to the new ADR instead of creating parallel v2 files.
- **Persist chat agreements immediately**: Record agreed choices/rejected options in \`<Decision>\`, behavior in \`<Spec>\`, verification scenarios in \`<Test verifies="..." level="...">\`, invariants in \`<Constraint>\`, and tentative choices in \`intent="idea"\` (criteria in \`documi-design\`) immediately.
- **Visual-first writing (SHOULD)**: Inverted pyramid, <= 3 lines per paragraph, **bold leading 2–4 words** of bullets, Mermaid for flows, tables for rules/errors, and \`<Details>\` for long notes.

## 3. Surgical Editing via CLI (Keep Diffs Minimal)

Prefer AST-aware CLI commands over rewriting whole MDX files. For multiline Markdown or bodies containing backticks, pass \`--body -\` with a single-quoted heredoc (or \`--body-file\`):

\`\`\`bash
documi block update <block-id> --stability evolving --body - <<'EOF'
**When** the trigger condition occurs,
**the** system **shall** produce the expected observable behavior.
EOF
\`\`\`

- \`documi block update <block-id> --body - [--stability ...] [--derives a,b]\` — update an existing block in place
- \`documi block add <doc-id> --kind spec --id <new-id> --derives <goal> --body - [--after-heading "<heading>"]\` — append a new block
- \`documi term upsert <term-id> --definition "..." [--aliases a,b] [--symbols src/foo.ts#Foo]\` — add or update a \`<TermDef>\`
- \`documi scaffold <rel-path.mdx> --title "..." [--type spec] [--derives a,b] [--body -]\` — create a new typed document (refuses overwrite)
- \`documi block rename <old-id> <new-id> --dry-run\` — rename a block ID across \`${relDocsDir}/\` and code/tests (always preview with \`--dry-run\` first)

## 4. Sync Code, Tests & Update Triggers

- Link implementation code with \`// @implements <spec.id>\` (or \`<SourceRef file="src/..." satisfies="<spec.id>" />\`) and tests with \`test('[<spec.id>] ...', ...)\` (or \`// @verifies <spec.id>\`).
- Always write \`<SourceRef file="...">\` and \`<TermDef symbols="...">\` as POSIX paths relative to the project root.
- **Reproducibility 4-check**: Confirm another AI could reproduce the behavior from \`${relDocsDir}/\` alone — (1) boundaries & error rejections, (2) precedence & fallbacks, (3) persistent/external schemas in \`contract\`, (4) public symbols linked via \`<SourceRef mode="exports" />\` or \`symbol="..."\` (never private helper pseudocode).
- **1 Capability = 1 \`spec\` file**: Split via \`documi scaffold\` whenever unrelated features start stacking (> 10 blocks triggers \`bloated-spec-doc\`).
- **New \`<Spec>\`**: Colocate declarative Given / When / Then \`<Test id="..." verifies="<spec.id>" level="...">\` in the same \`spec\`/\`contract\`, and update \`design\`/\`<Decision>\` as needed.

## Gotchas (Common Traps & Anti-Rationalization)

| Common Rationalization / Trap | Correct Action |
| :--- | :--- |
| "It's a small fix—I'll edit code first and update docs later." | **NO.** Update \`${relDocsDir}/\` first (avoids \`docs-sync-missing\`). |
| "We agreed in chat, so I'll remember it." | **NO.** Chat context dies next session. Persist into \`${relDocsDir}/\` immediately. |
| "I'll use a friendlier synonym instead of the glossary term." | **NO.** 1 concept = 1 canonical term ID; don't wrap registered terms in backticks. |
| "I'll put technical constraints directly in \`goal\`." | **NO.** \`goal\` is Problem Space only; put system-wide technical constraints in \`design (scope: system)\`. |

## 5. Verify & Output Format

1. Run \`documi check --no-review-edit\` and confirm 0 errors and clean health hints.
2. Report concisely using:
   - **Updated Specs / Docs**: IDs + 1-line summary
   - **Verification**: \`documi check --no-review-edit\` and test results
   - **Needs Human Review**: Any \`intent="idea"\` placeholders or changed blocks (\`http://localhost:3000/review?filter=changed\`)
`,
    'documi-design/SKILL.md': `---
name: documi-design
description: Upstream design, research, and specification alignment workflow before writing any code. Make sure to use this skill whenever designing new features, comparing technical options, making architectural changes, or authoring ADRs to prevent reinventing utilities, outdated API/Actions syntax, narrow 2-option ADRs, and unverified assumptions. Do not use for small bug fixes or routine syncing of already-settled specs (use documi instead).
---

# Documi Upstream Design, Research & Spec Alignment (\`documi-design\`)

> Workflow position: **\`documi-design\` (design)** -> \`documi\` (daily ops & implementation) -> \`documi-audit\` (reproducibility audit) -> \`documi-review\` (human approval)

Prevents the 4 classic pre-coding failure modes (**reinventing existing utilities, outdated API/Actions syntax, narrow 2-option ADRs, and silently guessing implicit human assumptions**) before a single line of code is written.

## Hard Gates (Never Violate)

- **No code before discovery**: Complete existing-asset inventory (\`documi map\` / \`documi search --context\`) and real version checks before writing any code.
- **Never silently guess high-cost ambiguities**: Always confirm data structures, external API/CLI contracts, permissions/security, architecture boundaries, and Non-Goals with the human first.
- **Verify against primary sources**: Never rely on stale training memory for library APIs or GitHub Actions—check \`node_modules/*.d.ts\` or official docs via web search.
- **Chesterton's Fence**: Never remove existing guards or workarounds without verifying their history via \`git log -S\` / \`git blame\` and \`documi search --context\`.

## 1. Inventory Existing Assets & Constraints

1. Run \`documi map\` to inspect Goals, \`goalConstraints\`, \`systemDesigns\`, \`systemConstraints\`, \`domainInvariants\`, \`decisions\`, and \`terms\` (\`antiTerms\`).
2. Run \`documi search "<topic>" --context\` to load related specs, designs, and \`<SourceRef>\`s.
3. Inspect \`<SourceRef mode="exports">\` and existing utilities so you never reinvent existing functions, types, UI components, or error classes.

## 2. Verify Real Versions & Primary Sources

1. Check actual versions in \`package.json\`, lockfiles, \`.github/workflows/*.yml\`, Dockerfiles, etc.
2. Verify current library APIs against \`node_modules/*.d.ts\` or official web docs.
3. Verify current GitHub Actions / external tool versions before authoring workflow files.

## 3. Research External Patterns Before Authoring ADRs

1. Search industry standards, prior art, and established libraries instead of rushing a narrow 2-option decision.
2. Compare 2–3 options and capture \`<Context>\`, \`<Chosen>\`, \`<Rejected option="...">\`, and \`<Tradeoff>\` inside \`<Decision id="dec.xxx" summary="...">\`.
3. Put project-wide choices in \`${relDocsDir}/decisions/YYYY-MM-DD-<slug>.mdx\` and local trade-offs / gotcha rationales as inline \`<Decision>\` micro-ADRs inside \`design\` or \`spec\`.

## 4. Implicit Assumptions & Question vs. Prototype Split

Audit these 7 axes and ask the human concise multiple-choice questions **only for high-impact gaps**:
- **Permissions & security** (non-local / unauthenticated / out-of-root rejections)
- **Empty, error & boundary values** (0 items, limits, invalid input, timeouts)
- **Concurrency & idempotency** (repeated/parallel runs, partial-failure recovery)
- **Data lifecycle & compatibility** (storage path, deletion behavior, migration impact)
- **Downstream blast radius** (\`documi impact <id>\`)
- **Terminology hygiene** (\`<TermDef>\`, \`antiTerms\`, 1 concept = 1 canonical ID)
- **Non-Goals** (what is explicitly out of scope)

### Reversibility-Cost Rule
- **High reversibility cost** (schemas, external contracts, security, boundaries, Non-Goals): **Align with the human before implementing.**
- **Low reversibility cost** (defaults, minor UI placement, copy, helper options): **Prototype with a reasonable choice**, but explicitly mark it as \`<Note intent="idea" title="Placeholder: ...">\` or \`<Spec intent="idea">\` so it surfaces in Overview and PR review.
- **Bug-fix / gotcha 3-piece set**: (1) 1-line why-not comment above code, (2) Red -> Green regression test, (3) inline \`<Decision>\` + \`<Test>\` for structural traps.

## 5. Lock Specs With Concrete I/O & \`<SourceRef>\`

Before coding, prepare:
1. **Behavior (\`<Spec>\`)**: EARS syntax covering observable behavior and rejections.
2. **Concrete I/O (\`<Test verifies="..." level="...">\`)**: Declarative Given / When / Then for normal, boundary, and error cases.
3. **Code boundary (\`<SourceRef>\`)**: Link public types/signatures via \`symbol="..."\` or \`mode="exports"\`.

## Gotchas (Common Traps & Anti-Rationalization)

| Common Rationalization / Trap | Correct Action |
| :--- | :--- |
| "It's a straightforward feature—skip research and jump into code." | **NO.** Leads to reinvented helpers and narrow 2-option ADRs. |
| "Let me ask the human 15 questions about minor defaults." | **NO.** Prototype low-cost details with \`intent="idea"\` to keep momentum. |
| "I'll add technical constraints into \`goal\`." | **NO.** Keep \`goal\` in the Problem Space; put system constraints in \`design (scope: system)\`. |

## 6. Output Format

When presenting a design for alignment:
- **Chosen Option vs. Alternatives**: 2–3 row trade-off table
- **Planned \`${relDocsDir}/\` Updates**: Spec / Contract / Design / ADR list
- **High-Cost Questions / \`intent="idea"\` Placeholders**: Concise multiple-choice questions or placeholder list
`,
    'documi-bootstrap/SKILL.md': `---
name: documi-bootstrap
description: Bootstrap Documi Living Specifications for an existing (brownfield) codebase via the documi CLI. Make sure to use this skill when adopting Documi for the first time in a repository that already has source code and tests, to inventory architecture, domain terms, and core specs incrementally. Do not use for routine updates in repos that already maintain ${relDocsDir}/ (use documi instead).
---

# Documi Brownfield Bootstrap Workflow (CLI)

> Workflow position: **\`documi-bootstrap\` (initial onboarding)** -> \`documi\` (daily ops) -> \`documi-audit\` (enrichment) -> \`documi-review\` (human approval)

Use this workflow to stand up accurate, lightweight Living Specifications from an existing codebase without flooding the repo with boilerplate.

## Hard Gates (Never Violate)

- **Never fabricate behavior**: Verify every spec against actual source code and tests.
- **Start thin (3–5 core capabilities)**: Do not try to spec every helper or file in one pass.
- **Never edit \`${relDocsDir}/guard/reviews.json\`**: Leave all bootstrapped specs \`unreviewed\` for human approval.
- **Do not collide with existing \`docs/\`**: If \`docs/\` is already occupied (e.g., Docusaurus/VitePress), configure \`.documi.json\` (e.g., \`{ "docs": "documi" }\`) first.

## 1. Inspect the Existing Repository

1. Map layout, build manifests (\`package.json\`, \`Cargo.toml\`, \`go.mod\`, \`pyproject.toml\`), entry points, and existing \`README.md\`.
2. Check if \`docs/\` is occupied; if so, configure \`.documi.json\`.
3. Identify the 3–5 most critical capabilities, core domain types, and existing test suites.

## 2. Establish Top-Down Anchors First (Thin Skeleton)

Use \`documi\` CLI (\`scaffold\`, \`block add\`, \`term upsert\`) instead of hand-writing large files:
1. **Root Goal (\`goals/\`)**: 1 concise Problem Space Goal covering purpose, target users, and explicit Non-Goals (no implementation details or technical constraints).
2. **System Overview (\`designs/system-overview.mdx\`, \`scope: system\`)**: 1 system-scope design covering modules, boundaries, data flow, and system-wide technical constraints (\`<Constraint id="sys....">\`) with real \`<SourceRef file="src/..." mode="exports" />\` links.
3. **Existing Key Decisions (\`decisions/\`)**: 1–3 consequential decisions already baked into the codebase, each with a 2–3 line \`<Decision id="dec....">\`.

## 3. Extract Bottom-Up Core Specs From Real Code

1. **Domain Glossary (\`domain/glossary.mdx\`)**: Register 5–10 core concepts via \`documi term upsert\` with \`--symbols src/...#Symbol\`.
2. **Core Specifications (\`specs/\`)**: Write 3–5 EARS \`<Spec id="domain.capability" stability="evolving" derives="goals/...">\` blocks for observable contracts, link with \`// @implements <spec.id>\` (or \`<SourceRef ... satisfies="..." />\`), and connect existing tests.
3. **Contracts (\`contracts/\`)**: Summarize public HTTP/RPC APIs, CLI commands, or event schemas with \`satisfies\`.

## Gotchas (Common Traps & Anti-Rationalization)

| Common Rationalization / Trap | Correct Action |
| :--- | :--- |
| "Let's spec every module in the repo right now." | **NO.** Produces shallow catalog bloat. Start with 3–5 core capabilities. |
| "Copy marketing pitch from \`README.md\` into \`goals/\`." | **NO.** Keep \`goal\` strictly in the Problem Space (problem, users, Non-Goals). |
| "Mark initial specs approved in \`reviews.json\`." | **NO.** Keep all initial specs \`unreviewed\` for human ownership. |

## 4. Validate & Output Format

1. Run \`documi check --no-review-edit\` and fix all broken \`<SourceRef>\` paths, orphan specs, or MDX errors.
2. Hand off using:
   - **Created Skeleton**: Goal / System Design / Decisions / Glossary / Core Spec IDs
   - **Ambiguities Needing Human Decision**: Unclear behaviors or Non-Goals found in code
   - **Next Step**: Inspect in \`documi serve\` or run \`documi-review\`
`,
    'documi-review/SKILL.md': `---
name: documi-review
description: Run an interactive specification review and alignment quiz for unreviewed, stale, or suspect Documi blocks (2–3 blocks per round) using concrete edge-case scenarios, then hand off human-only confirmation URLs and approval commands. Make sure to use this skill whenever the user asks to review specs, align on behavior, approve blocks, or check unreviewed/stale/suspect items. Do not use for mechanical code-vs-docs gap audits (use documi-audit instead).
---

# Documi Interactive Review & Alignment Quiz (CLI)

> Workflow position: \`documi-design\` -> \`documi\` -> \`documi-audit\` -> **\`documi-review\` (human alignment & approval handoff)**

Prevents both **rubber-stamp approvals** and **AI misunderstandings** by running fast rounds of **2–3 blocks** with concrete scenario quizzes before handing off human-only approval.

## Hard Gates (Never Violate)

- **NEVER edit \`${relDocsDir}/guard/reviews.json\`** and **NEVER run \`documi approve\` or \`documi unapprove\`**. Approval belongs strictly to the human.
- **Strictly 2–3 blocks per round**: Never dump dozens of specs at once.
- **No full-text paste checks**: Never paste entire spec prose and ask "Does this look OK?"
- **Always include full origin in URLs**: Output \`http://localhost:3000/review?ids=...&note=...\` so it is clickable in chat.

## 1. Pick a Focused Batch (2–3 Blocks Only)

1. If the user specifies docs or Spec IDs, use those.
2. Otherwise run \`documi query\` in priority order and select **only 2–3 blocks**:
   - \`documi query --review stale\` (modified after approval)
   - \`documi query --suspect\` (upstream changed)
   - \`documi query --review unreviewed --kind spec\` (unreviewed normative specs)
3. Run \`documi context <spec-id>\` on each block to inspect upstream Goals, \`<Decision>\`, constraints, and linked \`<SourceRef>\` code.

## 2. Ask Concrete Edge-Case & Scenario Questions

Ask **1–2 multiple-choice questions per block (3–5 questions total per round)**. Prefer interactive multiple-choice UI tools (e.g., \`ask_question\`) when available.

- **High-signal angles**: failure & fallback, security & boundary rejection, precedence & conflict resolution, side effects & invariants.
- **Avoid**: fill-in-the-blank prose trivia or full-text paste confirmations.
- Always leave room for *"None of these — the spec should actually do X"*.

## 3. Reconcile Answers & Fix Mismatches Immediately

1. **Aligned**: Confirm in 1 concise line and keep momentum.
2. **Human missed a detail**: Explain the current spec in 1–2 lines and verify intent.
3. **Spec or AI mismatch**: Update in place via \`documi block update <block-id> --body - <<'EOF'\` (and code/tests if requested), then verify with \`documi check --no-review-edit\`.

## Gotchas (Common Traps & Anti-Rationalization)

| Common Rationalization / Trap | Correct Action |
| :--- | :--- |
| "Let's batch 10 blocks to go faster." | **NO.** Causes rubber-stamping. Keep strictly to 2–3 blocks per round. |
| "We aligned, so I'll run \`documi approve\` for them." | **NO.** Only humans run approval commands. |
| "Just print \`/review?ids=...\` without localhost." | **NO.** Not clickable in chat; always print \`http://localhost:3000/review?...\`. |

## 4. Human-Only Handoff Format

For blocks confirmed 100% aligned:
- **Aligned Blocks**: 1-line summary of verified behavior per ID
- **Web UI Final Confirmation URL**: \`http://localhost:3000/review?ids=<aligned-id-1>,<aligned-id-2>&note=<url-encoded-summary>\`
- **CLI Command**:
\`\`\`bash
documi approve <aligned-id-1> <aligned-id-2> --note "<short summary of what was verified>"
\`\`\`
- **Next Round**: Ask whether to continue with the next 2–3 blocks.
`,
    'documi-audit/SKILL.md': `---
name: documi-audit
description: Audit source code and tests against Documi specs, contracts, designs, and ADRs to close reproducibility gaps (boundaries, precedence/fallbacks, persistent schemas, external I/F contracts, unrecorded ADRs, layer leakage) without writing pseudocode. Make sure to use this skill whenever asked to check spec-vs-code drift, enrich thin docs, or verify semantic consistency across docs before implementing large spec changes. Do not use for upstream feature design (use documi-design) or human approval quizzes (use documi-review).
---

# Documi Reproducibility Audit & Spec Enrichment Workflow (CLI)

> Workflow position: \`documi-design\` (design) -> \`documi\` (daily ops & implementation) -> **\`documi-audit\` (reproducibility audit)** -> \`documi-review\` (human approval)

Compares real code & tests against \`${relDocsDir}/\` **one domain at a time** so another AI could reproduce the exact same behavior from \`${relDocsDir}/\` alone—without turning docs into pseudocode.

## Hard Gates (Never Violate)

- **Scope to 1 domain per pass**: Never rewrite the entire repository in one pass.
- **No pseudocode**: Never write function-internal \`if\`/\`for\` steps, private helper names, or refactor-sensitive internals.
- **Never edit \`${relDocsDir}/guard/reviews.json\`**.

## 1. Scope the Audit & Check Contradictions

1. Run \`documi map\` and \`documi query --kind spec\` to inspect target docs, Spec IDs, and health hints.
2. **Pre-implementation semantic contradiction check**: Run \`documi impact <id>\` on modified specs and cross-check connected \`spec\`, \`contract\`, \`design\`, and \`decision\` docs for (a) duplicated/conflicting rules, (b) outdated ADRs missing \`supersedes\`, and (c) undefined edge cases.
3. Read target docs via \`documi show <doc-id>\` / \`documi context <spec-id>\`, and extract **actual enforced behavior** from linked \`<SourceRef>\`, \`@implements\`, and tests.

## 2. Six-Point Reproducibility Gap Check (AI Rejection Test)

Ask: *"If another AI re-implemented this domain from \`${relDocsDir}/\` alone, what discrepancy would make me reject the PR?"*

1. **Boundaries, Errors & Security Rejections**: invalid/empty inputs, limits, path traversal, unknown IDs, forbidden writes, exact error/status codes.
2. **Precedence, Fallbacks & Conflict Resolution**: CLI vs. env vs. config order, collisions, offline/missing-cache fallbacks.
3. **Persistent File & Config Schemas (\`contract\`)**: exact paths, fields, types, defaults, strict validation.
4. **External I/F Contracts (\`contract\`)**: REST API, MCP, CLI args, response shapes, side-effect boundaries, idempotency.
5. **Public AST Anchors & Unrecorded ADRs**: link public exports via \`<SourceRef file="src/..." mode="exports" />\`; capture hard-to-reverse decisions and Non-Goals in \`decisions/\` or \`goals/\`.
6. **Layer Leakage & Glossary Link Hygiene**: keep \`goal\` in the Problem Space (move technical constraints to \`design\` with \`scope: system\`) and avoid wrapping glossary terms in backticks that suppress autolinking.

## 3. Anti-Pseudocode Guardrail (Refactoring Test)

- **Write declaratively (SHOULD)**: decision tables, precedence lists, Mermaid diagrams, I/O & error tables, \`<Details>\`, \`<Columns>\`, \`<Timeline>\`, \`<SourceRef mode="exports" />\`.
- **Prose diet**: Trim filler and convert > 3-line prose blocks into tables, Mermaid, or \`<Details>\`.
- **1 Capability = 1 \`spec\` file**: Keep specs cohesive by capability (> 10 blocks triggers the safety-net hint).

## Gotchas (Common Traps & Anti-Rationalization)

| Common Rationalization / Trap | Correct Action |
| :--- | :--- |
| "Include step-by-step function logic for maximum precision." | **NO.** Document observable contracts, boundaries, and decision tables only. |
| "Fix other unrelated domains while I'm here." | **NO.** Makes review unmanageable; strictly 1 domain per pass. |
| "Code and spec disagree—silently make code the source of truth." | **NO.** If unsure whether it's intended behavior or a bug, ask the human. |

## 4. Update, Verify & Output Format

1. Enrich docs via \`documi block update\` / \`documi scaffold\` (or direct MDX edits for large tables).
2. Run \`documi check --no-review-edit\` and confirm 0 errors and 0 broken \`<SourceRef>\` anchors.
3. Report concisely using:
   - **Audited Scope**: Domain, docs, and Spec IDs
   - **Closed Gaps (by 6 points)**: 3–6 bullet summary of what was added where
   - **Discrepancies Needing Human Decision**: Any code-vs-spec conflicts needing intent check
   - **Review Link**: \`http://localhost:3000/review?filter=changed\`
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
