---
name: documi-bootstrap
description: すでにソースコードやテストが存在するリポジトリ（Brownfield）に Documi の Living Specification を初回導入・段階的に立ち上げるときに必ず使用するスキル。既存コードから Goal・System Design・用語集・コア仕様を棚卸しするときに使う。すでに docs/ が運用中の通常変更には使わない（documi を使う）。
---

# Documi 既存コードベース（Brownfield）導入ワークフロー（CLI）

> ワークフロー位置: **`documi-bootstrap`（初回導入）** → `documi`（日常運用）→ `documi-audit`（肉付け）→ `documi-review`（人間承認）

既存リポジトリへ Documi を導入するとき、実態と乖離したテンプレの山を作らずに薄く正確な骨格から立ち上げる手順です。

## Hard Gates（絶対に破らない）

- **推測で仕様を創作しない**: 必ず実コードと既存テストを照合し、観測可能な振る舞いだけを記述する。
- **最初から全機能を仕様化しない**: コア仕様は最重要の 3〜5 件から始め、細かなヘルパーを仕様化しない。
- **`docs/guard/reviews.json` 編集禁止**: 生成した仕様はすべて `unreviewed` のまま残し、人間承認に委ねる。
- **既存 `docs/` を壊さない**: ユーザー向けドキュメント（Docusaurus / VitePress 等）で `docs/` が占有されている場合は `.documi.json`（例: `{ "docs": "documi" }`）で別ディレクトリに分離する。

## 1. 既存リポジトリの棚卸し

1. ディレクトリ構成・ビルド設定（`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml` 等）・エントリポイント・既存 `README.md` を確認する。
2. `docs/` が既存ドキュメントで占有されているか確認し、衝突するなら `.documi.json` でマウント先を分ける。
3. 最重要な 3〜5 個の中核機能、主要ドメイン型・データ構造、既存テストスイートを特定する。

## 2. トップダウンの骨格を先に作る（薄く始める）

手書きで長大なファイルを作らず、`documi` CLI（`scaffold` / `block add` / `term upsert`）で最小骨格を作る：

1. **Root Goal（`goals/`）**: プロダクトの目的・対象ユーザー・明示的な Non-Goals をまとめた Problem Space の Goal 文書を 1 件作成する（実装詳細や技術制約は入れない）。
2. **System Overview（`designs/system-overview.mdx`, `scope: system`）**: モジュール境界・データフロー・システム全体の技術制約（`<Constraint id="sys....">`）を 1 件にまとめ、実在する `<SourceRef file="src/..." mode="exports" />` を紐づける。
3. **主要な既存意思決定（`decisions/`）**: すでにコードベースに根付いている重要な技術選定を 1〜3 件だけ記録し、各結論を 2〜3 行の `<Decision id="dec....">` にまとめる。

## 3. 実コードからボトムアップでコア仕様を抽出する

1. **ドメイン用語集（`domain/glossary.mdx`）**: 中核概念 5〜10 個を `documi term upsert` で登録し、実在する型・クラス・関数を `--symbols src/...#Symbol` で紐づける。
2. **コア仕様（`specs/`）**: 重要な 3〜5 機能に絞り、観測可能な振る舞いを EARS 記法の `<Spec id="domain.capability" stability="evolving" derives="goals/...">` で記述する。実装に `// @implements <spec.id>`（または `<SourceRef ... satisfies="<spec.id>" />`）を付与し、既存テストがあれば紐づける。
3. **コントラクト（`contracts/`）**: 公開 HTTP/RPC API・CLI・イベントスキーマ等があれば `satisfies` 付きで簡潔にまとめる。

## Gotchas（よくある失敗と言い訳封じ）

| やりがちな言い訳・失敗 | 正しい対処 |
| :--- | :--- |
| 「網羅的に全ファイルを一気に Spec 化しよう」 | **NG**。薄いカタログの山になる。まず 3〜5 件のコア能力に絞る |
| 「`README.md` の宣伝文をそのまま `goals/` にコピペしよう」 | **NG**。`goal` は課題・対象ユーザー・Non-Goals の Problem Space に絞る |
| 「初期導入だし `reviews.json` も承認済みにしておこう」 | **NG**。必ず `unreviewed` のまま残して人間に確認・承認してもらう |

## 4. 検証と完了時の報告フォーマット

1. `documi check --no-review-edit` を実行し、`<SourceRef>` パス切れ・`orphan-spec`・MDX 構文エラーを 0 件にする。
2. 完了時は以下の形式で人間へ引き継ぐ：
   - **作成した骨格**: Goal / System Design / Decisions / Glossary / Core Specs の一覧と Spec ID
   - **確認・意思決定が必要な曖昧点**: コードから判断できなかった仕様・Non-Goals
   - **次のステップ**: `documi serve` で確認、または `documi-review` で認識合わせ開始
