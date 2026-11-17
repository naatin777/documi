---
type: architecture
title: システム全体構成
description: Document Core・Honoサーバー・Reactフロントエンド・MCPの責務と境界を定義する
status: accepted
tags: [architecture]
---

# システム構成

Documi は単一の TypeScript プロジェクトとして、以下の 3 層で構成する。

```text
┌─────────────────────────────────────────────┐
│  React SPA (Vite build → dist/)             │
│  / , /pages/:type/:id , /glossary           │
└──────────────┬──────────────────────────────┘
               │ /api/*
┌──────────────▼──────────────────────────────┐
│  Hono Server (Bun.serve, port 3000)         │
│  ├─ /api/*    React 向け REST API           │
│  └─ /mcp      MCP Server (Streamable HTTP)  │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│  Document Core (src/core)                   │
│  FS走査 / Frontmatter解析 / Relations解決   │
│  React・Hono・MCP に非依存                  │
└──────────────┬──────────────────────────────┘
               │
        docs/ (Markdown / MDX + YAML)
```

## 責務の境界

- **Document Core**: ファイルシステム上の文書を共通データモデルへ変換する。フレームワークに依存しない。
- **Hono Server**: Web UI の静的配信、`/api/*`、`/mcp` を同一プロセスで提供する。
- **React SPA**: 文書の閲覧 UI。描画とナビゲーションのみを担当し、文書ロジックを持たない。
- **MCP Server**: Document Core をツールとして公開する。読み取り専用。

Web UI と MCP は同じ Document Core を共有し、返す情報の整合性を保証する。
