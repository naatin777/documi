---
type: verification
title: Document Core の検証方針
description: Artifact 読み込み・Relations・MCP・Web UI の検証方法を定義する
status: accepted
tags: [testing]
relations:
  requirement:
    - '00001'
    - '00002'
  design:
    - '00001'
    - '00002'
  architecture:
    - '00001'
  contract:
    - '00001'
    - '00002'
---

# 検証方針

## Document Core (`bun test`)

一時ディレクトリにフィクスチャを生成して以下を検証する。

- Markdown / MDX の読み込みと frontmatter 解析
- Type 別の ID 解決（同一 ID が異なる Type に存在するケース）
- 不正な frontmatter・ファイル名・ID 重複の検出
- 存在しない Relation・自己参照・重複参照の検出
- 逆参照 (Incoming Relations) の算出
- Design / Verification の構造制約
- MDX の危険な構文が検出されること（実行はされない）

## API / MCP

`app.fetch` を使い HTTP レベルで検証する。

- `/api/documents`, `/api/documents/:type/:id`, `/api/glossary`, `/api/status`
- `/mcp` への JSON-RPC リクエスト（initialize / tools/list / tools/call）

## Web UI

- `bun run build` が成功し、`bun run start` で `dist/` が配信されること
- サンプルドキュメントをブラウザで閲覧し、一覧・詳細・Relations 遷移・用語集・エラー表示を確認する
