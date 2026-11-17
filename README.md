# Documi

ソフトウェア開発における仕様書・設計書・意思決定・検証記録を構造的に管理するドキュメント管理ツール。
文書間の関係を管理し、要件から設計・実装・検証までを追跡できることを目指す。

単なる Markdown ビューアではなく、Artifact と呼ばれる文書単位と、その間の Relations を管理する。
ファイルシステム上の Markdown / MDX + YAML Frontmatter を Single Source of Truth とし、
Web UI と MCP Server の両方から同じ Document Core 経由で参照できる。

## ドキュメント形式

`docs/` ディレクトリ以下に、8 種類の Artifact Type ごとのディレクトリを持つ。

| Type | Directory | 役割 |
|---|---|---|
| `goal` | `goals/` | プロダクトが目指す状態 |
| `requirement` | `requirements/` | 満たすべき要求 |
| `architecture` | `architecture/` | システム全体の構造・境界 |
| `design` | `designs/` | Requirement を実現する設計 |
| `decision` | `decisions/` | 選択と判断理由 |
| `contract` | `contracts/` | API・Protocol・Data Format 等の契約 |
| `verification` | `verification/` | 適合性の検証方法 |
| `guide` | `guides/` | 利用・開発・運用手順 |

各 Artifact は `NNNNN-kebab-case-slug.md`（または `.mdx`）というファイル名で、
5 桁の ID と YAML Frontmatter を持つ。識別子は `type:id` の形式（例: `requirement:00001`）。
ID はファイル名から導出され、Slug の変更では変わらない。Type が異なれば同じ ID を使える。

```yaml
---
type: design
title: Plugin登録の設計
description: Pluginの登録と識別方法を定義する
status: draft
relations:
  requirement:
    - '00001'
---
```

- 必須フィールド: `type`, `title`, `description`, `status`
- `status`: `draft` / `accepted` / `deprecated`（実装・検証の状態とは独立）
- 任意フィールド: `tags`, `sources`, `subtype`, `relations`, `perspective`
- `relations`: 他 Artifact への外向き参照。逆参照は読み込み時に自動算出される
- `docs/glossary.md` は Artifact Type を持たない特別な用語集
- Design は少なくとも 1 つの Requirement、Verification は Requirement / Design /
  Architecture / Contract のいずれかを参照する必要がある（違反は issues として報告）

## セットアップと起動

```bash
bun install
bun run dev      # 開発: Vite (5173) + Hono (3000) を同時起動
bun run build    # フロントエンドを dist/ にビルド
bun run start    # ビルド済みアプリを port 3000 で起動
bun run test     # テスト実行
```

開発時は http://localhost:5173 にアクセスする（`/api` と `/mcp` は 3000 番へプロキシ）。
本番起動時は http://localhost:3000 が React アプリと API / MCP を同一オリジンで配信する。

サーバーはデフォルトで `127.0.0.1` にのみバインドする。外部公開する場合は `HOST=0.0.0.0` を明示すること。

### ドキュメントディレクトリの変更

```bash
bun run start -- --docs /path/to/docs
# または環境変数
DOCUMI_DOCS_DIR=/path/to/docs bun run start
```

## Web UI

3 カラム構成: 左に全 Artifact Type を束ねた Explorer（折り畳み式）、中央にタブ付き
Document Viewer、右に Outline / Relations パネル。

- Explorer: 8 Type + Glossary を単一ツリーで表示。文書クリックでタブを開く
- タブ: 複数文書の切り替え・クローズ・sessionStorage による復元
- Outline: 本文見出しから生成、クリックでスクロール
- Relations: 外向き参照 (References) と逆参照 (Referenced by) を相互に辿れる
- テーマ: light / dark / system を切替可能。Artifact Type ごとにアクセントカラーを持つ
- レスポンシブ: モバイルでは Explorer はドロワー表示

## リッチ表現 (Markdown / MDX)

通常の Markdown + GFM に加え、制限付き MDX をサポートする。
**任意の JavaScript は実行されない**（import/export・JSX 式・イベントハンドラは拒否）。
許可された構文以外はエラーとして明示表示される。

| 表現 | 書き方 |
|---|---|
| シンタックスハイライト | ` ```ts ` 等のフェンス (Shiki、light/dark・行番号・コピー対応) |
| 図 | ` ```mermaid ` フェンス (Flowchart / Sequence / State 等) |
| 数式 | `$...$` インライン、`$$...$$` ブロック (KaTeX) |
| Callout | `<Callout type="warning" title="注意">...</Callout>` |
| Tabs | `<Tabs><Tabs.Tab label="A">...</Tabs.Tab></Tabs>` |
| Steps | `<Steps><Steps.Step title="...">...</Steps.Step></Steps>` |
| SourceRef | `<SourceRef file="..." symbol="..." />` (後述) |

## SourceRef — ソースコード参照

MDX 内で実際のソースファイルのコードを参照・表示できる。
コードを文書へコピーせず、元ファイルから都度読み込むため常に最新が反映される。

```mdx
<SourceRef file="src/core/loader.ts" lines="35-45" />
<SourceRef file="src/core/source.ts" symbol="resolveSourceSymbol" />
<SourceRef file="core/registry.go" symbol="Registry.Register" />
```

- `file`: プロジェクトルート（docs ディレクトリの親）相対パス
- `lines`: 1 始まりの行範囲 (`"10-40"` または `"10"`)
- `symbol`: AST で解決する定義名。`Class.method` のような修飾名に対応
- `symbol` と `lines` はどちらか一方のみ指定可能

シンボルは `@ast-grep/napi` (tree-sitter) で解析する。関数・クラス・メソッド・
型・インターフェース等の定義を抽出し、同名で一意に解決できない場合は
候補一覧つきで曖昧エラーを返す。

対応言語: TypeScript / TSX / JavaScript / Go / Rust / Python / Java / Kotlin / Swift
（`@ast-grep/lang-*` の動的パーサーを使用）。
それ以外の拡張子では `lines` のみ利用できる。

セキュリティ: プロジェクトルート外へのパストラバーサル・絶対パス・
シンボリックリンク経由の参照は拒否される。バイナリ・巨大ファイルも拒否。
ソースは実行されない。

## MCP Server

`/mcp` で Streamable HTTP 方式の MCP Server を提供する（読み取り専用）。
Web UI・REST API と同じ Document Core を使用する。
ブラウザからのクロスオリジンアクセスは localhost 系 Origin のみ許可される。

| Tool | 説明 |
|---|---|
| `list_documents` | Artifact 一覧（type 絞り込み可） |
| `get_document` | Type + ID で本文とメタデータを取得 |
| `get_relations` | 外向き・逆参照の解決済み関係を取得 |
| `get_glossary` | 用語集を取得 |

## REST API

| Endpoint | 説明 |
|---|---|
| `GET /api/health` | ヘルスチェック |
| `GET /api/status` | ルート・文書数・issues |
| `GET /api/documents` | 文書サマリ一覧（`?type=` で絞り込み） |
| `GET /api/documents/:type/:id` | 文書詳細（本文・relations 込み） |
| `GET /api/glossary` | 用語集 |
| `GET /api/source?file=&symbol=\|lines=` | SourceRef 用ソース取得 |

## 技術スタック

- Runtime / PM: Bun / TypeScript
- Backend: Hono（`/`, `/api/*`, `/mcp` を同一サーバーで提供）
- Frontend: React + Vite
- Markdown: remark (parse/gfm/math/mdx) → 独自 mdast → React レンダラー
- Highlighting: Shiki / Diagrams: Mermaid / Math: KaTeX
- AST: `@ast-grep/napi` + `@ast-grep/lang-*`
- MCP: `@modelcontextprotocol/sdk` (Streamable HTTP)
- Document Core (`src/core`) はフレームワーク非依存

## 今後の拡張（未実装）

文書の編集、実装進捗の自動追跡、SSG・外部公開、全文検索、認証、
SourceRef の名前付き登録 (`ref="..."`)、LSP による意味解析、Relation Graph 可視化など。
