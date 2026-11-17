---
type: contract
title: REST API コントラクト
description: React フロントエンドが利用する /api/* エンドポイントの仕様
status: accepted
tags: [api]
---

# REST API コントラクト

React SPA が利用する読み取り専用 API。すべて `GET` で、JSON を返す。

## GET /api/documents

Artifact のサマリ一覧。

- Query: `type` (任意) — Artifact Type で絞り込み
- Response: `{ documents: DocumentSummary[] }`

```json
{
  "documents": [
    {
      "ref": "requirement:00001",
      "type": "requirement",
      "id": "00001",
      "title": "...",
      "description": "...",
      "status": "accepted",
      "path": "requirements/00001-....md",
      "format": "markdown",
      "issueCount": 0
    }
  ]
}
```

## GET /api/documents/:type/:id

単一ドキュメントの詳細。`type` は 8 種類のいずれか、`id` は 5 桁数字。
見つからない場合は `404`、形式不正は `400`。

Response の `document` は Document Core の `Document` モデル全体
（body・declaredRelations・解決済み relations / incomingRelations・issues を含む）。

## GET /api/glossary

用語集。`docs/glossary.md` が存在しない場合は `404`。

## GET /api/status

`{ rootDir, documentCount, issues }` を返す。`issues` は読み込み時に検出されたファイル単位の問題。
