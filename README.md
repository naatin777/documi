# Documi

人間が読んでコードまで理解でき、AI エージェントが同じ挙動を再現できる **Living Specification プラットフォーム**。

ファイルシステム上の Markdown / MDX + YAML Frontmatter を Single Source of Truth とし、
Web UI・REST API・MCP Server・CLI のすべてが同じ Document Core (`src/core`) を共有する。

## 主な特徴

- **連番廃止 & 自由な階層構造**: `docs/` 配下を再帰走査し、拡張子なし POSIX 相対パスをドキュメント ID とする（任意 `date` メタデータ対応・ADR 降順ソート）
- **4 層・9 種類の Artifact Type**: `goal` / `decision` / `domain` / `spec` / `contract` / `architecture` / `design` / `verification` / `guide`（ディレクトリ名・ファイル名から自動推論）
- **Goal を根にした Rooted DAG**: `normative` な `<Spec>` が `derives` 経由で `goal` に繋がっていない場合は `orphan-spec` として検知
- **MDX セマンティックタグ（任意 JS 実行禁止）**: `<Spec>`, `<Constraint>`, `<Outcome>`, `<Note>`, `<TermDef>`, `<Term>`, `<SourceRef>` + `<Callout>`, `<Tabs>`, `<Steps>`, Mermaid, KaTeX, Shiki
- **読む・レビューする中心の UI**: 1 本の開閉式サイドバー（`⌘B`・上流→下流の `Flow` / `Files` 切替）、専用 **Review Inbox (`/review`)**、右ペイン **Context Inspector (`Outline` / `Links`) ＋ Side-by-Side プレビュー（並べて読む・`Shift+クリック`）**
- **人間レビュー & Git Diff (`docs/.documi/reviews.json`)**: MDX 本文と物理分離された承認サイドカー。本文変更で自動 `stale` ＋承認時点コミットとの行 Diff 表示、上流変更で **Suspect Links** 検知、Web UI からワンクリック承認・Stability 切替・AI 向けフィードバック投稿
- **Living Glossary**: 登録済み `<TermDef>` 用語・別名を本文中で自動リンクし、ホバー時に定義＋AST 抽出した実コード型定義をポップオーバー表示
- **コード・テスト・PR からの `realization` 自動算出**: `@implements` / `@verifies` / `test("[spec.id] ...")` / `<SourceRef>` / JUnit XML / `gh` PR 連携から `unimplemented` / `in-progress` / `implemented` / `verified` / `drifted` を自動判定
- **Sigma.js (WebGL) ライブ力学ネットワークグラフ & Traceability Matrix (`/graph`)**: Obsidian Graph View ライクなフルビューポート・角丸長方形ノード・弾性ドラッグ・Forces スライダー・枠ハイライト・**ノードクリックで右側に本文を即時プレビュー**
- **Hono RPC + Zod 型安全 API**: サブルータ分割 + `zValidator` + `hc<ApiRoutes>` によりサーバーとクライアント間の型ドリフトをコンパイル時に防止
- **全文検索 (`Cmd+K`)** & MCP 8 ツール（HTTP `/mcp` および stdio `documi mcp`）
- **複数ドキュメントまとめ HTML / PDF Export (`/bundle` + `documi export`)**: 全文書・ディレクトリ配下・Goal 関連一式・任意複数選択を、表紙・自動目次・ページ内アンカー・全タブ展開付きで 1 冊に書き出し（`Bun.WebView` Chrome backend 使用・追加 npm 依存なし）

## セットアップとコマンド

```bash
bun install
bun run dev           # 開発: Vite (5173) + Hono (3000, docs 自動監視・SSE ホットリロード)
bun run build         # フロントエンドを dist/ にビルド
bun run start         # ビルド済みアプリを port 3000 で起動
bun run test          # テスト実行
bun run documi:check  # ドキュメント・DAG・AST シンボル・テスト結果を一括検証
bun run documi:export -- --scope all --format pdf --out spec.pdf
```

### CLI サブコマンド (`documi` / `bun src/cli.ts`)

```bash
bun src/cli.ts init --docs ./docs                          # 新規プロジェクト向け docs/ 雛形生成
bun src/cli.ts serve --docs ./docs --project . --port 3000 # Web UI + REST API + HTTP MCP 起動
bun src/cli.ts mcp --docs ./docs --project .               # stdio MCP サーバー起動 (AI エディタ連携)
bun src/cli.ts check --strict --no-review-edit             # 厳格チェック & reviews.json 改ざん検知
bun src/cli.ts approve core.document-model                 # ブロック承認
bun src/cli.ts export --scope all --format pdf --out spec.pdf
```

> ソース参照（`<SourceRef file="src/..." />` / `<TermDef symbols="src/...#Sym">`）はすべて `projectRoot`（既定: `docs/` の親ディレクトリ、`--project` または `DOCUMI_PROJECT_ROOT` で変更可）からの相対パスで解決されます。

## MCP Server (`/mcp`)

Streamable HTTP 方式で AI エージェント向けの 8 ツールを提供する。

| Tool | 説明 |
|---|---|
| `get_project_map` | Goal・Architecture・Decision `<Outcome>`・Domain 用語集・Review & Realization サマリを一括取得 |
| `list_documents` | ドキュメント一覧 (`type` 絞り込み可) |
| `get_document` | パス ID から本文・ブロック・関係・問題を取得 |
| `get_relations` | ドキュメント ID またはブロック ID の外向き/逆参照を取得 |
| `query_specs` | セマンティックブロックを `kind` / `intent` / `stability` / `review` / `realization` / `suspect` / `hasFeedback` / キーワードで検索 |
| `get_spec_context` | 指定 Spec の上流 Goal・未解決フィードバック・関連文書・Decision Outcome・用語・SourceRef を一括集約 |
| `search_documents` | ドキュメントとセマンティックブロックを横断全文検索 |
| `validate_docs` | `orphan-spec`・参照切れ・循環・重複 ID・MDX 未対応構文・AST `<SourceRef>` / `<TermDef>` シンボル切れを一括検証 |
