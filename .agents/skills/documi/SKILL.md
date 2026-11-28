---
name: documi
description: Documi CLI を使って Living Specification（docs/ の仕様・契約・設計・ADR・用語集）を検索・精密編集・検証する日常運用スキル。機能実装・仕様変更・バグ修正・API/スキーマ変更・コードとテストの同期・チャット合意の記録を行うときは必ず使用する。新機能の上流設計・技術選定には先に documi-design、既存コードへの初回導入には documi-bootstrap、人間との認識合わせクイズには documi-review、仕様の再現性監査には documi-audit、PR 作成には documi-pr を使う。
---

# Documi Living Specification 運用ワークフロー（CLI）

> ワークフロー位置: `documi-design`（上流設計）→ **`documi`（日常運用・実装）** → `documi-audit`（再現性監査）→ `documi-pr`（PR 作成）→ `documi-review`（人間承認）

このリポジトリは `docs/` 配下の Living Specification を **Documi** で管理しています。
ファイルを 1 件ずつ丸ごと読む代わりに、`documi` CLI の既定コンパクト出力を使って段階的に文脈を取得・精密編集してください（構造化データが必要なときだけ `--json`、全文展開が必要なときだけ `--full`）。

## Hard Gates（絶対に破らない）

- **Spec-First**: 仕様・振る舞い・契約を変えるときは、コードやテストより先に `docs/` を更新し、`documi check --no-review-edit` を通す。
- **変更前に `documi impact <id>`**: 既存仕様を変える前に必ず影響範囲（下流文書・ブロック・コード・テスト）を洗い出す。
- **`docs/guard/reviews.json` 編集禁止**: 承認記録は人間専用。AI は絶対に編集せず `documi approve` / `unapprove` も実行しない。
- **MDX 安全性**: MDX 内で実行可能な JS（ESM `import`/`export`・JSX 式 `{...}`・未許可コンポーネント）を書かない。
- **一時ファイル禁止**: `docs/` 内に `tasks.md` 等を作らない（進捗は `realization` で自動算出）。
- **チェスタートンの柵**: 理由不明な防御コード・ワークアラウンドを勝手に消さない（削除前に `git log -S` / `git blame` と `documi search --context` で経緯を確認。詳細は `documi-design`）。

## 1. 段階的コンテキスト取得（実装前に読む）

1. **Spec ID が未確定のタスク**: `documi search "<自然文のタスクや質問>" --context` — BM25＋用語集同義語展開＋グラフ展開で関連 Spec・上流 Goal・`<Decision>`・用語・`<SourceRef>` を 1 発取得する。
2. **全体像の把握**: `documi map` — Goal・`systemDesigns`・`systemConstraints`・現行独立 `<Decision>`・ドメイン用語（`antiTerms` 含む）・Review / Realization 状況を一括取得する。
3. **条件絞り込み**: `documi query [--kind spec] [--review ...] [--realization ...] [--q <語>]` または `documi search "<query>"`。
4. **特定 Spec の深掘り・影響確認**: `documi context <spec-id>` で対象 Spec と周辺文脈を取得し、変更前は必ず `documi impact <id>` を実行する。

## 2. 矛盾防止・合意の即時永続化・執筆ルール

- **1 事実 1 箇所（SSOT）**: 同じ仕様表や列挙を重複コピーせず、正規の置き場所（`spec`＝振る舞い／`contract`＝外部 I/F・スキーマ／`design`＝モジュール責務）を 1 箇所に決め、他文書からはリンクや `<Term>` で参照する。
- **古い決定は `supersedes` で廃止**: 方針転換時は新 ADR に `supersedes: [decisions/<old-adr>]` を付け、横に v2 ファイルを乱立させない。
- **チャット合意の即時永続化**: ユーザーと合意した方針・却下案は `<Decision>`、振る舞いは `<Spec>`、保証シナリオは `<Test verifies="..." level="...">`、禁止事項は `<Constraint>`、軽い仮置きは `intent="idea"`（判断基準は `documi-design`）へ**その場で即記録する**。
- **視覚ファースト執筆（SHOULD）**: 結論ファースト・1 段落 3 行以内・箇条書き先頭太字・フローは Mermaid・条件分岐は表・長い補足は `<Details>` に畳む（詳細は `docs/guides/authoring-guide.mdx`）。

## 3. CLI による精密編集（差分最小化）

MDX 全体を手書きで書き換えず AST 位置ベースの CLI を優先する。複数行 Markdown やバッククォートを含む本文は `--body -` ＋シングルクォートヒアドキュメント（または `--body-file`）を使う：

```bash
documi block update <block-id> --stability evolving --body - <<'EOF'
**When** 条件が発生したとき、
**the** システム **shall** 期待される振る舞いを行う。
EOF
```

- `documi block update <block-id> --body - [--stability ...] [--derives a,b]` — 既存ブロックの該当行範囲のみ更新
- `documi block add <doc-id> --kind spec --id <new-id> --derives <goal> --body - [--after-heading "<見出し>"]` — ブロックを 1 件追記
- `documi term upsert <term-id> --definition "..." [--aliases a,b] [--symbols src/foo.ts#Foo]` — `<TermDef>` を追加・更新
- `documi scaffold <rel-path.mdx> --title "..." [--type spec] [--derives a,b] [--body -]` — 新規文書を作成（既存上書き拒否）
- `documi block rename <old-id> <new-id> --dry-run` — 全 `docs/` とコード・テストの ID 参照を一括リネーム（先に `--dry-run` 必須）

## 4. コード・テストと仕様の同期

- 実装には `// @implements <spec.id>`（または `<SourceRef file="src/..." satisfies="<spec.id>" />`）、テストには `test('[<spec.id>] ...', ...)`（または `// @verifies <spec.id>`）を付与する。
- `<SourceRef file="...">` と `<TermDef symbols="...">` はプロジェクトルートからの POSIX 相対パスで記述する。
- **再現性 4 チェック**: 別 AI が `docs/` だけで同じ挙動を再現できるか確認する — ① 境界条件・エラー拒否、② 優先順位・フォールバック、③ 入出力・永続スキーマの `contract` 同期、④ 公開シンボルは `<SourceRef mode="exports" />` / `symbol="..."` で AST 接続（非公開ヘルパーや `if`/`for` 擬似コードは書かない）。
- **Capability 単位分割**: `spec` は 1 Capability = 1 ファイル。無関係な機能が並び始めたら件数に関係なく `documi scaffold` で分割する（10 件超は `bloated-spec-doc` で検知）。
- **新規 `<Spec>` 追加時**: 同じ `spec` / `contract` 内に `<Test id="..." verifies="<spec.id>" level="...">` の Given / When / Then を同居させ、必要に応じ `design` / `<Decision>` も更新する。

## Gotchas（よくある失敗と言い訳封じ）

| やりがちな言い訳・失敗 | 正しい対処 |
| :--- | :--- |
| 「小さな変更だから先にコードだけ直そう」 | **NG**。先に `docs/` を更新してから実装する（`docs-sync-missing` の原因） |
| 「チャットで合意したし覚えている」 | **NG**。別セッションでは消える。その場で `docs/` に永続化する |
| 「用語を分かりやすく日本語や別名で書こう」 | **NG**。1 概念＝1 正準表記。登録済み用語はバッククォートで囲わず正準 ID で書く |
| 「`goal` に制約や実装タグも書いておこう」 | **NG**。`goal` は Problem Space のみ。技術制約は `design (scope: system)` へ分離する |

## 5. 検証と完了時の報告フォーマット

1. `documi check --no-review-edit` を実行し、エラー 0 件・健全性ヒントを確認する。
2. 完了時は以下の形式で簡潔に報告する：
   - **更新した Spec / 文書**: ID と 1 行要約
   - **検証結果**: `documi check --no-review-edit` とテスト結果
   - **人間確認が必要な点**: 未確定の `intent="idea"` やレビュー対象（あれば `http://localhost:3000/review?filter=changed` を案内）
