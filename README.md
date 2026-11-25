# Documi

人間が読んでコードまで理解でき、AI エージェントが同じ挙動を再現できる **Living Specification プラットフォーム**。

ファイルシステム上の Markdown / MDX + YAML Frontmatter を Single Source of Truth とし、
Web UI・REST API・MCP Server・CLI のすべてが同じ Document Core (`src/core`) を共有する。

## 人間と AI の標準フロー

Documi は **AI が CLI / MCP で仕様・設計・コード・テストを同期し、人間が Web UI（閲覧・Diff・フィードバック・承認）と AI チャット（修正依頼・対話クイズ）で判断する** 役割分担を前提にしています。

1. **AI に依頼する（AI チャット）**: 機能追加や仕様変更を伝えると、AI が `docs/`・コード・テストを同期更新し、`documi check --no-review-edit` まで検証します。
2. **変更分を確認する（Web UI `/review`）**: `documi serve` で開いたブラウザは SSE で自動更新され、**`変更あり` タブ**（作業ツリー／ブランチ差分のブロックのみ）や **`要再確認` タブ**（承認時点からの自動展開 Diff・上流変更の軽量な `suspect` 参考通知）、`/review?ids=...` リンクから変更点をすぐ確認できます。
3. **ズレを直す・理解を確認する（Web UI → AI チャット）**:
   - 直したい箇所はブロックのフィードバック欄に書き溜め、**「未解決コメントを AI へ渡す」** ボタンで 1 クリックコピーして AI チャットへ渡します。
   - 重要な仕様はカードを選択して **「AI クイズでレビュー」** をコピーし、`documi-review` スキルで 2〜3 件ずつエッジケースの認識合わせを行えます。
4. **承認・取消する（人間専用）**: 納得したブロックだけ Web UI の「承認」ボタンまたは `documi approve <id...>` で承認します（見直し時は「承認を取り消す」 / `documi unapprove <id...>`）。AI が `docs/.documi/reviews.json` を書き換えることは `documi check --no-review-edit` で防ぎます。

## 主な特徴

- **連番廃止 & 自由な階層構造**: `docs/` 配下を再帰走査し、拡張子なし POSIX 相対パスをドキュメント ID とする（任意 `date` メタデータ対応・ADR 降順ソート）
- **4 層・9 種類の Artifact Type**: `goal` / `decision` / `domain` / `spec` / `contract` / `architecture` / `design` / `verification` / `guide`（ディレクトリ名・ファイル名から自動推論）
- **Goal を根にした Rooted DAG**: `normative` な `<Spec>` が `derives` 経由で `goal` に繋がっていない場合は `orphan-spec` として検知
- **MDX セマンティックタグ（任意 JS 実行禁止）**: `<Spec>`, `<Constraint>`, `<Outcome>`, `<Note>`, `<TermDef>`, `<Term>`, `<SourceRef>` + `<Callout>`, `<Tabs>`, `<Steps>`, Mermaid, KaTeX, Shiki
- **読む・レビューする中心の UI**: 1 本の開閉式サイドバー（`⌘B`・上流→下流の `Flow` / `Files` 切替）、専用 **Review Inbox (`/review`)**（Git 変更分フィルタ・`?ids=` URL 絞り込み・自動展開 Diff・AI プロンプトコピー）、右ペイン **Context Inspector (`Outline` / `Links` / `History`) ＋ Side-by-Side プレビュー (`Shift+クリック`)**、読み取り専用 **Code Explorer (`/code`)**
- **人間レビュー & Git Diff (`docs/.documi/reviews.json`)**: MDX 本文と物理分離された承認サイドカー。本文変更で自動 `stale` ＋承認時点コミットとの行 Diff 表示、上流変更で軽量な参考通知 `suspect` を自動付与、Web UI / CLI から承認・承認取り消し・Stability 切替・AI 向けフィードバック投稿
- **Living Glossary**: 登録済み `<TermDef>` 用語・別名を本文中で自動リンクし、ホバー時に定義＋AST 抽出した実コード型定義をポップオーバー表示
- **コード・テスト・PR からの `realization` 自動算出 & 健全性ヒント**: `@implements` / `@verifies` / `test("[spec.id] ...")` / `<SourceRef mode="exports">` / JUnit XML / `gh` PR 連携から `unimplemented` 〜 `verified` / `drifted` と Design・Verification カバレッジを自動算出
- **Sigma.js (WebGL) ライブ力学ネットワークグラフ (`/graph`)**: フルビューポート・角丸長方形ノード・弾性ドラッグ・Figma 風トラックパッドパン／ピンチズーム・Forces スライダー・**ノードクリックで右側に本文を即時プレビュー**
- **AI デュアルチャネル連携**: **CLI + Agent Skills**（`documi` / `documi-bootstrap` / `documi-review` を `documi init` で配布）と **MCP Server 14 ツール**（HTTP `/mcp` および stdio `documi mcp`）の両方を同一 Document Core で提供
- **ローカル Hybrid RAG & 全文検索 (`Cmd+K`)**: ゼロ依存 BM25＋用語集同義語展開＋明示グラフ展開に加え、任意のローカル ONNX / Ollama / OpenAI 互換 Embedding による RRF ハイブリッド検索 (`documi retrieve` / `documi index`)
- **まとめ Export (HTML / PDF) & 静的サイト書き出し**: `/bundle` + `documi export` で 1 冊の HTML/PDF 出力、`documi build-site` で任意の静的ホスティングへ配置できる読み取り専用静的サイトを生成

## セットアップとコマンド

```bash
bun install
bun run dev           # 開発: Vite (5173) + Hono (3000, docs 自動監視・SSE ホットリロード)
bun run build         # フロントエンドを dist/ にビルド
bun run start         # ビルド済みアプリを port 3000 で起動
bun run test          # テスト実行
bun run documi:check  # ドキュメント・DAG・AST シンボル・テスト結果を一括検証
bun run documi:export -- --scope all --format pdf --out spec.pdf
bun run documi:build-site -- --out dist-site
```

### CLI サブコマンド (`documi` / `bun src/cli.ts`)

```bash
bun src/cli.ts init --project . --ja                       # docs/ 雛形 + .agents/skills/ (3スキル) 生成
bun src/cli.ts serve --docs ./docs --project . --port 3000 # Web UI + REST API + HTTP MCP 起動
bun src/cli.ts mcp --docs ./docs --project .               # stdio MCP サーバー起動 (AI エディタ連携)
bun src/cli.ts retrieve "承認記録の改ざん防止ルール"        # BM25 (+Embedding) + グラフ展開で関連文脈を 1 発取得
bun src/cli.ts check --strict --no-review-edit             # 厳格チェック & reviews.json 改ざん検知
bun src/cli.ts approve core.document-model                 # ブロック承認 (人間専用)
bun src/cli.ts unapprove core.document-model               # ブロック承認取り消し (人間専用)
bun src/cli.ts export --scope all --format pdf --out spec.pdf
bun src/cli.ts build-site --out dist-site
```

> ソース参照（`<SourceRef file="src/..." />` / `<TermDef symbols="src/...#Sym">`）はすべて `projectRoot`（既定: `docs/` の親ディレクトリ、`--project` または `DOCUMI_PROJECT_ROOT` で変更可）からの POSIX 相対パスで解決されます。

## MCP Server (`/mcp` & `documi mcp`)

Streamable HTTP (`/mcp`) および stdio (`documi mcp`) で AI エージェント向けの 14 ツールを提供します。

| Tool | 説明 |
|---|---|
| `get_project_map` | Goal・Architecture・Decision `<Outcome>`・Domain 用語集・Review / Realization・健全性サマリを一括取得 |
| `list_documents` | ドキュメント一覧 (`type` 絞り込み可) |
| `get_document` | パス ID から本文・ブロック・関係・問題を取得 |
| `get_relations` | ドキュメント ID またはブロック ID の外向き/逆参照を取得 |
| `query_specs` | セマンティックブロックを `kind` / `intent` / `stability` / `review` / `realization` / `suspect` / `hasFeedback` / キーワードで検索 |
| `get_spec_context` | 指定 Spec の上流 Goal・未解決フィードバック・関連文書・Decision Outcome・用語・SourceRef を一括集約 |
| `search_documents` | ドキュメントとセマンティックブロックを横断全文検索 |
| `retrieve_context` | 自然文から BM25（＋任意 Embedding RRF）＋グラフ展開で関連文脈を予算内に集約 |
| `validate_docs` | `orphan-spec`・参照切れ・循環・重複 ID・MDX 未対応構文・AST `<SourceRef>` / `<TermDef>` シンボル切れ・健全性ヒントを一括検証 |
| `add_block` / `update_block` / `rename_block_id` | AST 位置ベースでのブロック追記・局所更新・参照一括リネーム |
| `upsert_term` / `scaffold_document` | `<TermDef>` の追加/更新および規約済み新規 `.mdx` の雛形生成 |
