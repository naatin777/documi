---
type: contract
title: MCP ツールコントラクト
description: /mcp で公開する MCP ツールの入出力仕様
status: draft
tags: [api, mcp]
relations:
  requirement:
    - '00001'
  contract:
    - '00001'
  design:
    - '00001'
---

# MCP ツールコントラクト

`/mcp` は Streamable HTTP 方式の MCP Server。公式 TypeScript SDK を使用し、読み取り専用の 4 ツールを提供する。

## list_documents

Artifact の一覧を取得する。

- Input: `{ type?: ArtifactType }`
- Output: `{ documents: [{ ref, type, id, title, description, status, path }], count }`

## get_document

Type と ID からドキュメントを取得する。

- Input: `{ type: ArtifactType, id: "NNNNN" }`
- Output: メタデータ + `body`（Markdown/MDX ソース）+ `path` + relations + issues
- 存在しない場合は `isError: true`

## get_relations

指定 Artifact の参照関係を取得する。

- Input: `{ type: ArtifactType, id: "NNNNN" }`
- Output: `{ ref, outgoing: RelationTarget[], incoming: RelationTarget[] }`

## get_glossary

用語集を取得する。

- Input: `{}`
- Output: `{ title, description, path, body }`

## 備考

レスポンスは `enableJsonResponse` により JSON 形式で返す。
将来の全文検索ツール追加を見据え、`list_documents` の `type` 絞り込みのみを初期スコープとする。
