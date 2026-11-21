# AGENTS.md — Documi 開発ガイドライン

このリポジトリは Living Specification プラットフォーム **Documi** の本体であり、`docs/` 配下で自分自身の仕様・設計・ADR を管理しています（Dogfooding）。

## 1. 作業開始前に読むもの

実装・修正を始める前に、以下のいずれかでプロジェクトの文脈を確認してください。

- **MCP 経由（推奨）**: `documi mcp`（stdio）または `http://localhost:3000/mcp` に接続し、以下を呼ぶ
  1. `get_project_map` — Goal・Architecture・Decision `<Outcome>`・用語集・Review / Realization 全体像
  2. `get_spec_context` — 対象 Spec ID に紐づく上流 Goal・未解決フィードバック・関連 Design / Contract・用語・`<SourceRef>`
- **ファイル直接参照**: `docs/goals/living-specification.mdx`, `docs/architecture/system-overview.mdx`, `docs/decisions/*.mdx`（`<Outcome>` ブロック）, 対象の `docs/specs/*.mdx`

## 2. 守るべき不変ルール

1. **`docs/.documi/reviews.json` を直接編集しない**
   - `reviews.json` は人間の承認・フィードバック専用のサイドカーファイルです。
   - AI エージェントは MDX 本文・ソース・テストを編集し、承認記録には触れません（`documi check --no-review-edit` で検証されます）。
2. **`src/core/` はフレームワーク非依存に保つ**
   - `src/core/` から `react`, `hono`, `sigma` 等を import しないでください。Web UI・REST API・MCP・CLI が同じ Document Core を共有します。
3. **MDX で任意の JavaScript を実行しない**
   - 許可された静的コンポーネントのみを mdast AST 経由で描画し、式 (`{...}`) や ESM (`import` / `export`) を評価しません。
4. **`tasks.md` のような一時的なタスク管理ファイルを `docs/` に作らない**
   - 仕様の進捗（`realization`）はコード・テスト・JUnit XML・PR から自動算出します。
5. **ソース参照パスの基準は `projectRoot`**
   - `<SourceRef file="src/..." />` と `<TermDef symbols="src/...#Symbol">` は常に **`projectRoot`（既定: `docs/` の親ディレクトリ、`--project` / `DOCUMI_PROJECT_ROOT` で上書き可）からの POSIX 相対パス** で記述してください。
6. **未リリース期間中は後方互換レイヤ（v2/v3 分岐・非推奨エイリアス）を溜めない**
   - 破壊的変更でも現行実装・仕様を直接書き換えてシンプルに保ってください。

## 3. 実装と仕様の同期ルール

- 仕様 (`<Spec id="...">`) を実装したら、コードに `// @implements <spec.id>`（または設計書に `<SourceRef ... satisfies="<spec.id>" />`）を付与してください。
- 仕様を検証するテストには `test('[<spec.id>] ...', ...)` 形式で Spec ID を含めてください。
- 振る舞いや API / CLI / アーキテクチャを変更したら、対応する `docs/`（`specs/`, `contracts/`, `designs/`, `decisions/`）も同時に更新してください。

## 4. 完了前の検証コマンド

変更後はすべてエラー・警告 0 件で通ることを確認してください。

```bash
bun test --reporter=junit --reporter-outfile=docs/.documi/test-results.xml
bun run check
bun run lint
bun run format:check
bun run knip
bun run build
bun run documi:check
```
