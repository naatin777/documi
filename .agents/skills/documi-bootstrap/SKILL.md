---
name: documi-bootstrap
description: 既存コードベース（Brownfield）に Documi の Living Specification を段階的に導入するスキル。既存のソースコードやテストからアーキテクチャ・ドメイン用語・コア仕様を棚卸しするときに使用します。
---

# Documi 既存コードベース（Brownfield）導入ワークフロー（CLI）

すでにソースコードやテストが存在するリポジトリに **Documi** を導入するとき、実態と乖離したテンプレの山を作らずに段階的に Living Specification を立ち上げるための手順です。

## 1. 既存リポジトリの棚卸し

1. ディレクトリ構成・ビルド設定（`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml` 等）・エントリポイント・既存 `README.md` やドキュメントを確認する。
2. すでに `docs/` がユーザー向けドキュメント（Docusaurus / VitePress 等）で占有されているか確認する。
   - 占有されている場合はプロジェクトルートに `.documi.json`（例: `{ "docs": "documi" }`）を作成し、既存ドキュメントと衝突させない。
3. 最も重要な 3〜5 個の中核機能、主要なドメイン型・データ構造、既存テストスイートを特定する。

## 2. トップダウンの骨格を先に作る（薄く始める）

手書きで長大なファイルを作らず、`documi` CLI（`scaffold` / `block add` / `term upsert`）を使って最小骨格を作る：

1. **Root Goal（`goals/`）**: プロダクトの目的・対象ユーザー・明示的な Non-Goals をまとめた Goal 文書を 1 件作成し、譲れない制約を `<Constraint id="...">` として記述する。
2. **System Overview（`architecture/`）**: モジュール境界とデータフローを俯瞰する設計概要を 1 件作成し、実在する `<SourceRef file="src/..." />` を紐づける。
3. **主要な既存意思決定（`decisions/`）**: すでにコードベースに根付いている重要な技術選定を 1〜3 件だけ記録し、各結論を 2〜3 行の `<Outcome id="dec....">` にまとめる。

## 3. 実コードからボトムアップでコア仕様を抽出する

1. **ドメイン用語集（`domain/glossary.mdx`）**: 中核概念 5〜10 個を `documi term upsert` で登録し、実在する型・クラス・関数を `--symbols src/...#Symbol` で紐づける。
2. **コア仕様（`specs/`）**: 重要な機能から 3〜5 件に絞って始める（すべての細かなヘルパーを仕様化しない）：
   - 既存システムの*観測可能な振る舞い*を EARS 記法の `<Spec id="domain.capability" stability="evolving" derives="goals/...">` として記述する。
   - 推測で仕様を創作せず、必ず実装とテストを照合する。
   - 実装側に `// @implements <spec.id>`（または `<SourceRef ... satisfies="<spec.id>" />`）を付与し、対応する既存テストがあれば紐づける。
3. **コントラクト（`contracts/`）**: HTTP/RPC API・CLI・イベントスキーマ等を公開している場合、`satisfies` 付きで簡潔にまとめる。

## 4. 検証して人間へ引き継ぐ

1. `documi check` を実行し、`<SourceRef>` パス切れ・`derives` 漏れ（`orphan-spec`）・MDX 構文エラーをすべて解消する。
2. **`docs/.documi/reviews.json` は絶対に編集しない。** 生成した仕様はすべて `unreviewed` のまま残し、人間オーナーが `documi serve` 上で確認・修正・承認できるようにする。
3. 作成したドキュメント・Spec ID 一覧と、既存コードから判断がつかなかった曖昧点（人間の意思決定が必要な点）を簡潔に報告する。
