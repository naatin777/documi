---
type: guide
title: 開発ガイド
description: Documi のセットアップ・開発・ビルド・実行方法
status: accepted
tags: [guide]
---

# 開発ガイド

## セットアップ

```bash
bun install
```

## 開発起動

```bash
bun run dev
```

Vite の開発サーバー (port 5173) がフロントエンドを HMR 付きで配信し、
`/api` と `/mcp` は Hono サーバー (port 3000) にプロキシされる。
ブラウザで http://localhost:5173 を開く。

## スクリプト

| コマンド | 内容 |
|---|---|
| `bun run dev` | 開発サーバー + Vite (HMR) |
| `bun run build` | フロントエンドを `dist/` にビルド |
| `bun run start` | ビルド済みアプリを port 3000 で起動 |
| `bun run test` | `bun test` でテスト実行 |

## ドキュメントディレクトリの変更

デフォルトはプロジェクトの `docs/`。別プロジェクトの文書を閲覧する場合:

```bash
bun run start -- --docs /path/to/docs
# または
DOCUMI_DOCS_DIR=/path/to/docs bun run start
```

## ドキュメントの追加

`docs/<type-dir>/NNNNN-kebab-case-slug.md` を作成し、frontmatter に
`type` / `title` / `description` / `status` を記述する。
詳細は [Artifact Model](requirement:00001) を参照。
