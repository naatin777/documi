---
type: requirement
title: MarkdownとMDXを安全に表示する
description: ドキュメント本文をMarkdown/MDXとしてレンダリングし、MDXの実行系構文は実行せず警告として扱うこと
status: accepted
tags: [core, security]
---

# 要件

Artifact の本文は Markdown または MDX で記述する。

## Markdown

- 見出し・表・コードブロック・リスト・リンク・画像を適切に表示する
- GitHub Flavored Markdown（表、取り消し線、タスクリスト等）に対応する

## MDX

- MDX は表示の拡張を目的とするが、任意の JavaScript 式や import/export の無制限な実行は許可しない
- 未対応の構文は黙って実行せず、文書に紐づく警告として表示する
- 通常の Markdown 構文は MDX 文書内でも完全に扱えることを優先する
