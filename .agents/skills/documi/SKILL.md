---
name: documi
description: Documi CLI を使って Living Specification（仕様・設計・ADR・用語集）を検索・精密編集・検証する運用スキル。機能実装・仕様変更・API/アーキテクチャ変更・コードとテストの同期前に使用します。
---

# Documi Living Specification 運用ワークフロー（CLI）

このリポジトリは `docs/` 配下の Living Specification を **Documi** で管理しています。
ファイルを 1 件ずつ丸ごと読む代わりに、`documi` CLI を使って必要な文脈だけを段階的に取得・精密編集してください。
コンテキストを節約するため、**読み取りは既定のコンパクトなテキスト出力を優先**し、構造化データが必要なときだけ `--json`（さらに全文・詳細配列が必要なときだけ `--full`）を付けてください（全オプションは `documi --help` で確認できます）。

## 1. 段階的コンテキスト取得（実装前に読む）

1. **Spec ID がまだ分からないタスク**: `documi search "<自然文のタスクや質問>" --context` — BM25＋用語集同義語展開＋グラフ展開で関連 Spec・上流 Goal・Decision `<Outcome>`・用語・`<SourceRef>` を文字数予算内で 1 発取得する。
2. **全体像の把握**: `documi map` — Goal・Architecture・Decision `<Outcome>`・ドメイン用語・Review / Realization 全体像を一括取得する（機械処理時は `documi map --json`）。
3. **条件絞り込み・横断検索**: `documi query [--kind spec] [--review ...] [--realization ...] [--q <語>]` または `documi search "<query>"`。
4. **特定 Spec の深掘り・変更影響の確認**: `documi context <spec-id>` で対象 Spec 本文・上流 Goal・関連文書・用語・`<SourceRef>` を取得する。**仕様変更の前には必ず `documi impact <id>` を実行し、影響を受ける全下流文書・ブロック・コード・テストを洗い出す**（全文や直接参照だけ見たい場合は `documi show <doc-id>` / `documi relations <id>`）。

## 2. Spec-First・矛盾防止・合意の即時永続化（実装前に docs/ を固める）

- **Spec-First**: 仕様・振る舞い・契約を変えるときは、**コードやテストを触る前にまず `docs/` を更新し、`documi check` で整合を確認する**。
- **1 事実 1 箇所（Single Source of Truth）**: 同じ仕様表や列挙を Spec・Contract・Design に重複コピーせず、正規の置き場所（`spec`＝振る舞い／`contract`＝外部 I/F・スキーマ／`design`＝モジュール責務）を 1 箇所に決め、他文書からはリンクや `<Term>` で参照する。
- **古い決定は `supersedes` で廃止**: 方針転換や旧 ADR の撤回時は、新しい ADR に `supersedes: [decisions/<old-adr>]` を付け、古い決定を現行一覧から分離する（横に v2 仕様ファイルを乱立させない）。
- **チャット合意の即時永続化**: チャット履歴にしか残っていない合意は別セッションでは失われる。ユーザーと合意した方針・却下案は `<Outcome>`、振る舞いは `<Spec>`、禁止事項は `<Constraint>`、未確定の仮案・保留は `<Note intent="idea">` に**その場で即記録する**。
- **読みやすさ・視覚ファースト執筆（長文ダラダラ禁止）**: 人間はドキュメントを斜め読みするため、散文の壁を作らず以下を徹底する：
  - **結論ファースト＆3 行ルール**: 冒頭に 1〜2 文の要約を置き、1 段落は 3 行以内・箇条書きの先頭 2〜4 語を **太字** にする。
  - **図表・コンポーネント優先**: 処理フロー・状態遷移は **Mermaid 図**、条件分岐・エラー規約は **表**、長い補足や JSON 例は **`<Details title="...">`** に畳み、並列比較は **`<Columns><Column>`**、時系列は **`<Timeline><Timeline.Item>`** を使う。

## 3. CLI による精密編集（差分を最小限に保つ）

仕様を更新するときは、MDX ファイル全体を書き換える代わりに AST 位置ベースの CLI コマンドを優先してください。**複数行の Markdown やバッククォートを含む本文はクォート崩れを防ぐため `--body -` ＋ヒアドキュメント**（または `--body-file <file>`）を使ってください：

```bash
documi block update <block-id> --stability evolving --body - <<'EOF'
**When** 条件が発生したとき、
**the** システム **shall** 期待される振る舞いを行う。
EOF
```

- `documi block update <block-id> --body - [--stability ...] [--derives a,b]` — 既存ブロックの該当行範囲のみを安全に更新する。
- `documi block add <doc-id> --kind spec --id <new-id> --derives <goal> --body - [--after-heading "<見出し>"]` — セマンティックブロックを 1 件追記する。
- `documi term upsert <term-id> --definition "..." [--aliases a,b] [--symbols src/foo.ts#Foo]` — 用語集に `<TermDef>` を追加・更新する。
- `documi scaffold <rel-path.mdx> --title "..." [--type spec] [--derives a,b] [--body -]` — 規約通りの frontmatter を持つ新規文書を作成する（既存ファイルの上書きは拒否）。
- `documi block rename <old-id> <new-id> --dry-run` — 全 `docs/` とコード・テストの ID 参照を一括リネームする（必ず先に `--dry-run` で対象を確認）。

## 3. コード・テストと仕様の同期・更新トリガー

- 実装コードには `// @implements <spec.id>`（または設計書に `<SourceRef file="src/..." satisfies="<spec.id>" />`）を付与する。
- 検証テストには `test('[<spec.id>] ...', ...)`（または `// @verifies <spec.id>`）を含め、設定されていれば JUnit XML を出力する。
- `<SourceRef file="...">` と `<TermDef symbols="...">` は必ずプロジェクトルートからの POSIX 相対パスで記述する。
- **書く／書かないの境界（再現性 4 チェック）**: 機能追加・仕様変更を書いたときは「別 AI が `docs/` だけで同じ挙動を再現できるか」を確認する。
  1. **境界条件・エラー拒否**（不正入力・パス脱出・空状態・エラーコード）を明記したか？
  2. **優先順位・フォールバック・競合解決**の順序を明記したか？
  3. **入出力・永続ファイルのスキーマ変更**を `contract` に同期したか？
  4. **公開シンボル**（export された `class`/`interface`/`type`/公開関数）は手書きコピペせず `<SourceRef file="src/..." mode="exports" />` や `<SourceRef symbol="..." />` で AST 紐づけし、非公開ヘルパーや関数内の `if`/`for` 擬似コードは書いていないか？
- **更新トリガー（PR 完了前セルフチェック）**:
  - 新サブシステム・主要モジュール追加 → `architecture` 更新 ＋ `design`（`satisfies`・`<SourceRef>`）追加・更新
  - 後戻りコストが高い構造・技術判断 → `decision`（ADR＋`<Outcome>`）を追加
  - 新しい `<Spec>` やテストスイート追加 → 該当機能領域の `verification` に `verifies`・**宣言的な Given / When / Then 保証シナリオ**・テストスイート一覧を同期する（1 ファイルに 10 件超の `verifies` / `satisfies` を集中させない：`overloaded-hub-doc` で検知）
  - **Capability 単位のファイル分割（相乗り禁止）**: `spec` ファイルは技術レイヤー（`core/`・`ui/`）やスプリント単位ではなく **Capability（システムが提供する 1 つの能力・機能ドメイン）単位で 1 ファイル** にする。タイトルに無関係な機能が `and` や中黒で並び始めたら件数に関係なく `documi scaffold` で別ファイルへ切り出す（10 件超は安全網の `bloated-spec-doc` で検知）

## 4. 守るべき不変ルール

- **`docs/guard/reviews.json` を直接編集しない。** 承認記録は人間専用（`documi check --no-review-edit` で検証）。
- **MDX 内で実行可能な JavaScript を書かない**（ESM `import`/`export`・JSX 式 `{...}`・未許可コンポーネントは禁止）。
- **`docs/` 内に一時的な `tasks.md` 等を作らない。** 進捗（`realization`）はコード・テスト・PR から自動算出される。

## 5. 完了前の検証と引き継ぎ

1. `documi check --no-review-edit` を実行し、エラー 0 件（Rooted DAG・MDX 安全性・AST シンボル参照）および健全性ヒント（Design / Verification カバレッジ・Spec 肥大化・ハブ過密）を確認する。
2. 追加・変更した Spec ID を簡潔にまとめ、人間レビュアーが Web UI（`documi serve`）で確認・承認できるようにする。
