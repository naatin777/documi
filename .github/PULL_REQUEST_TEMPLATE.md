## 概要

- 何を変更する PR か（1〜3 行）

## 関連する仕様・ADR（先にこちらから確認）

- Spec / Contract: `docs/specs/...`
- ADR (`decision`): `docs/decisions/...`（構造判断がない場合は「なし」）

## チェックリスト（仕様・ADR → コードの順で確認）

- [ ] 振る舞い・契約・構造の変更に合わせて `docs/` を同期した
- [ ] AI 作業ブランチでは `docs/guard/reviews.json` を改変していない（`documi check --no-review-edit`）
- [ ] `bun test` / `check` / `lint` / `format:check` / `knip` / `build` / `documi:check` がすべて通過した
