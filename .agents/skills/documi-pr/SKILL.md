---
name: documi-pr
description: Documi 運用リポジトリで Pull Request を作成・更新する手順。PR テンプレート厳守・Before/After 視覚化（表・Mermaid・出力抜粋）・レビュー順 Walkthrough・Spec ID 自動抽出・PR 前検証ゲートを徹底するときに使用します。
---

# Documi PR 作成・更新スキル

AI エージェントが作成する Pull Request を、人間が最短時間で正確に理解・判断できる「Context Pump」として仕上げるための運用手順です。

## 1. PR 作成前の必須ゲート

PR を作成・更新する前に、以下をすべて通過させること。

1. **テスト・静的検査・ビルド・Documi 検証**（すべてエラー・警告 0 件）
   ```bash
   mkdir -p .documi && bun test --reporter=junit --reporter-outfile=.documi/test-results.xml
   bun run check
   bun run lint
   bun run format:check
   bun run knip
   bun run build
   bun run documi:check --no-review-edit
   ```
2. **承認ガード非編集確認**: `docs/guard/reviews.json` に AI による変更が含まれていないこと。
3. **プライバシー確認**: `git diff` にローカルユーザー名・ホーム絶対パス・個人情報が含まれていないこと。
4. **会話合意の蒸留（Context Drift 防止）**: 「今この会話の中では覚えている」錯覚で次のセッションへ消えるのを防ぐため、PR 作成前にこの会話で合意した **今後も破ってほしくない原則・判断・地雷** を振り返り、コードや `spec` だけでなく `docs/`（`goal` / `domain` / `decision` / `guide`）へ昇格漏れがないか確認する（一時メモや途中経過は書かない）。
5. **真っ白な別コンテキストでの PR 前クロスチェック**: 書いた本人の思い込みによる見落としを防ぐため、履歴を持たない別サブエージェント（`research` 等）に `git diff main...HEAD` を渡し、以下 3 点を必ず点検してから PR を作成・更新する：
   - 変更した仕様・オプション・挙動と `contracts/`・`designs/`・`decisions/`・`src/core/init.ts`・`.agents/skills/` の間にズレや旧表現の残存がないか
   - `goal` への実装詳細混入など層の逆流がないか
   - セキュリティ境界（パス脱出・Origin 検証・権限）に抜けがないか

## 2. テンプレート厳守とタイトル規約

- **必ず `.github/pull_request_template.md` を読んで準拠する**。テンプレートの見出し構造を無視しない。
- **空セクションや未該当のコメント行は削除**し、ノイズを残さない。
- **PR タイトル規約**:
  - 会話内の段取りラベル（`Phase 1`, `Wave 2`, `Step 3`, `P0` 等）や空虚なバズワードを書かない。
  - 「何をどう変えたか」の具体的な事実だけを端的に書く（例: `feat: domain に antiTerms と不変条件の map 投入を追加`）。

## 3. 本文の書き方ルール（認知負荷の最小化）

### 3.1 概要・背景（結論ファースト）
- 1〜2 文で「課題 → 解決」だけを書く。コミット履歴の書き写しやファイル名羅列は禁止。

### 3.2 Before / After（視覚化ファースト）
変更の性質に合わせて最も伝わる表現を 1〜2 個選ぶ（長文の箇条書きだけで済ませない）：
- **挙動・API・仕様の変更**: 3〜5 行の **Before / After 比較表**
- **構造・データフロー・状態遷移の変更**: 簡潔な **Mermaid 図**（`flowchart` / `sequenceDiagram` / `stateDiagram-v2`）
- **CLI の変更**: 実際の実行出力サンプル（3〜6 行）
- **Web UI の変更**: Before / After スクリーンショット

### 3.3 変更のポイント（レビュー順 Walkthrough）
- 複数ファイルにまたがる PR では、レビュアーがどこから読むべきかを **3〜5 項目・先頭太字**（`**コア変更（要確認）**: ...`）で案内する。
- 1 項目は 1〜2 行以内。細かいファイル一覧や補足は `<details><summary>...</summary>...</details>` に折りたたむ。
- 1〜2 ファイルの小さな修正では本セクションを省略して簡潔に保つ。

### 3.4 レビュー観点・判断・見送ったこと（Automation Bias 対策）
- 破壊的変更、採用したトレードオフ（捨てた別案）、エッジケース、今回あえて見送った範囲（Out of Scope）を明記し、人間の判断が必要なポイントへ視線を誘導する。

### 3.5 仕様トレース & 検証証拠
- `git diff` に含まれる `@implements <spec.id>` / `<Spec id="...">` / `test('[<spec.id>] ...')` から該当 ID を抽出し、`Implements: <spec.id>` / `Verifies: <spec.id>` を記載する（`documi check --prs` と自動連動）。
- 関連する `docs/` ファイルや ADR パスを記載する。
- 実行したテスト件数・静的検査・手動確認（バグ修正時は Red → Green の再現結果）を 1〜3 行で記載する。
