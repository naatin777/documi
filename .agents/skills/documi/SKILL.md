---
name: documi
description: Documi CLI を使って Living Specification（仕様・設計・ADR・用語集）を検索・精密編集・検証する運用スキル。機能実装・仕様変更・API/アーキテクチャ変更・コードとテストの同期前に使用します。
---

# Documi Living Specification 運用ワークフロー（CLI）

このリポジトリは `docs/` 配下の Living Specification を **Documi** で管理しています。
ファイルを 1 件ずつ丸ごと読む代わりに、`documi` CLI を使って必要な文脈だけを段階的に取得・精密編集してください。
コンテキストを節約するため、**読み取りは既定のコンパクトなテキスト出力を優先**し、構造化データが必要なときだけ `--json`（さらに全文・詳細配列が必要なときだけ `--full`）を付けてください（全オプションは `documi --help` で確認できます）。

## 1. 段階的コンテキスト取得（実装前に読む）

1. **Spec ID がまだ分からないタスク**: `documi retrieve "<自然文のタスクや質問>"` — BM25＋用語集同義語展開＋グラフ展開で関連 Spec・上流 Goal・Decision `<Outcome>`・用語・`<SourceRef>` を文字数予算内で 1 発取得する。
2. **全体像の把握**: `documi map` — Goal・Architecture・Decision `<Outcome>`・ドメイン用語・Review / Realization 全体像を一括取得する（機械処理時は `documi map --json`）。
3. **条件絞り込み・横断検索**: `documi query [--kind spec] [--review ...] [--realization ...] [--has-feedback] [--q <語>]` または `documi search "<query>"`。
4. **特定 Spec の深掘り**: `documi context <spec-id>` — 対象 Spec 本文・上流 Goal・未解決フィードバック・関連文書・用語・`<SourceRef>` を取得する（全文や参照関係が必要なら `documi show <doc-id>` / `documi relations <id>`）。

## 2. CLI による精密編集（差分を最小限に保つ）

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

## 3. コード・テストと仕様の同期

- 実装コードには `// @implements <spec.id>`（または設計書に `<SourceRef file="src/..." satisfies="<spec.id>" />`）を付与する。
- 検証テストには `test('[<spec.id>] ...', ...)`（または `// @verifies <spec.id>`）を含め、設定されていれば JUnit XML を出力する。
- `<SourceRef file="...">` と `<TermDef symbols="...">` は必ずプロジェクトルートからの POSIX 相対パスで記述する。
- 振る舞い・API・アーキテクチャを変更したら、対応する仕様・コントラクト・設計・ADR も同じ変更で更新する。

## 4. 守るべき不変ルール

- **`docs/.documi/reviews.json` を直接編集しない。** 承認とフィードバックは人間専用（`documi check --no-review-edit` で検証）。
- **MDX 内で実行可能な JavaScript を書かない**（ESM `import`/`export`・JSX 式 `{...}`・未許可コンポーネントは禁止）。
- **`docs/` 内に一時的な `tasks.md` 等を作らない。** 進捗（`realization`）はコード・テスト・PR から自動算出される。

## 5. 完了前の検証と引き継ぎ

1. `documi check --no-review-edit` を実行し、エラー 0 件（Rooted DAG・MDX 安全性・AST シンボル参照）を確認する。
2. 追加・変更した Spec ID を簡潔にまとめ、人間レビュアーが Web UI（`documi serve`）で確認・承認できるようにする。
