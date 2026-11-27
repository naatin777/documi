# Documi

[English](./README.md) | **日本語**

人間が読んでコードまで理解でき、AI エージェントが同じ挙動を再現できる **Living Specification プラットフォーム**。

ファイルシステム上の Markdown / MDX + YAML Frontmatter を Single Source of Truth とし、
Web UI・REST API・MCP Server・CLI のすべてが同じフレームワーク非依存の Document Core (`src/core/`) を共有します。

---

## 5 分クイックスタート（小さく始める）

最初から 9 種類の Artifact Type を全部使う必要はありません。まずは **3 類型（`goal` / `spec` / `decision`）＋ `<SourceRef>` ＋ `documi check`** だけで始められます。

### 1. ソースから準備する（未リリース期間）

```bash
git clone https://github.com/naatin777/documi.git
cd documi
bun install
bun run build
```

### 2. プロジェクトを初期化する

```bash
bun src/cli.ts init --project /path/to/your-repo --ja
# 英語テンプレート・スキルを使う場合は --ja を省略（既定: en）
```

最小構成の `docs/` 雛形と、標準 Agent Skills 4 種（`.agents/skills/`）を生成します。既存の `AGENTS.md` は上書きしません。

### 3. `<Spec>` を 1 件書いてコードと紐づける

```mdx
---
type: spec
title: アカウントロックアウト
derives: [goals/security]
---

<Spec id="auth.lockout" stability="stable">
  **When** ログインに 5 回連続で失敗したとき、**the** Auth Service **shall** 対象アカウントを 15 分間ロックする。
</Spec>

<SourceRef file="src/auth.ts" symbol="lockAccount" satisfies="auth.lockout" />
```

コード・テスト側:

```ts
// @implements auth.lockout
export function lockAccount() { /* ... */ }

test('[auth.lockout] 5回失敗でロックされる', () => { /* ... */ })
```

### 4. 検証して Web UI を開く

```bash
bun src/cli.ts check --project /path/to/your-repo
bun src/cli.ts serve --project /path/to/your-repo
```

---

## 人間と AI の標準フロー

1. **AI に依頼する（AI チャット）**: 機能追加や仕様変更を伝えると、AI が `docs/`・コード・テストを同期更新し、`documi check --no-review-edit` まで検証します。
2. **変更分を確認する（Web UI `/review`）**: `documi serve` で開いたブラウザは SSE で自動更新され、**`変更あり` タブ**（Git 差分）や **`要再確認` タブ**（承認時点からの自動展開 Diff・上流変更の軽量通知 `suspect`）から変更点をすぐ確認できます。
3. **ズレを直す・理解を確認する（Web UI → AI チャット）**: 各ブロックの **「AI へ伝える」** や **「AI クイズでレビュー」**（`documi-review` スキル）で認識合わせを行います。
4. **最終確認 URL から承認する（人間専用）**: `/review?ids=...&note=...` を開いて確認メモ付きで一括承認します（`documi approve` / `unapprove` も利用可）。

## 主な特徴

- **連番廃止 & 自由な階層構造**: `docs/` 配下を再帰走査し、拡張子なし POSIX 相対パスをドキュメント ID とする
- **4 層・9 種類の Artifact Type（段階導入可）**: `goal` / `decision` / `domain` / `spec` / `contract` / `architecture` / `design` / `verification` / `guide`
- **Goal を根にした Rooted DAG**: `normative` な `<Spec>` が `goal` に繋がっていない場合は `orphan-spec` として検知
- **安全な静的 MDX（任意 JS 実行禁止）**: `<Spec>`, `<Constraint>`, `<Outcome>`, `<Note>`, `<TermDef>`, `<Term>`, `<SourceRef>` + Mermaid, KaTeX, Shiki
- **自動 `realization` 算出 & AST 検証**: `@implements` / `@verifies` / `test("[spec.id]")` / `<SourceRef mode="exports">` / JUnit XML / `gh` PR から実装状態を自動算出
- **AI デュアルチャネル連携**: **CLI + Agent Skills 4 種** と **MCP Server 15 ツール**（stdio / HTTP）を同一コアで提供
- **ゼロ依存検索 + 任意ローカル Hybrid RAG**: 日本語（`Intl.Segmenter`）・英語・コード識別子 BM25＋用語集展開＋グラフ展開に加え、任意の Ollama / OpenAI 互換 HTTP Embedding + `bun:sqlite` キャッシュに対応
- **静的サイト書き出し & まとめ Export**: `documi build-site` でプロバイダ非依存の読み取り専用静的サイトを生成、`documi export` で 1 冊の HTML / PDF を出力

## Documi 自体の開発コマンド

**Bun >= 1.4.0** が必要です。

```bash
bun install
bun run dev           # 開発: Vite (5173) + Hono (3000)
bun run build         # フロントエンドを dist/ にビルド
bun run test          # テスト実行
bun run check         # 型チェック
bun run lint          # oxlint --type-aware --deny-warnings
bun run format:check  # oxfmt --check
bun run knip          # 未使用ファイル・エクスポート検証
bun run documi:check  # 自社 docs/ の Living Specification 検証
```

リリースは Git タグ（`v*.*.*`）の push をトリガーに `.github/workflows/release.yml` で実行する方針です。

## ライセンス

[MIT](./LICENSE)
