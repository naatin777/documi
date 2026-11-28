# Review Cards セッション引き継ぎ（2026-11-28）

ブランチ: `prototype/decision-cards`（worktree: documi-decision-cards）
前セッション要約: `~/.local/share/devin/cli/summaries/history_671a99dc4d0a4c76.md`

## 完了しているもの（全部コミット済み）

### カード UI（/cards ページ）
- Q部: 太字タイトル + 詳細1段落（whyNow+defaultPath+example を連結表示。ラベル・ボーダー・斜体なし）
- 選択肢: AIの×3 + 「やらない」negative×1（個別文言・得失必須・テストで機械保証）+ 書き込み選択肢
- 書き込み選択肢: label要素で行クリック→inputフォーカス、フォーカス=選択、丸は飾り、空テキストでは確定不可
- 仮置きボタンは fillable=yes のカードにのみ表示（無効表示すらしない）
- 状態表示: チップ全廃（ガタつき防止）。確定=緑・仮置き=水色のボタン押下状態、異議/理解不能=ボタン押下+カード赤縁
- 用語hover: TermInline で状態用語（Provisional/Committed/Incomprehensible/CardObjection）にpopover。ヘッダ集計チップのみ。ボタンには未適用

### 状態機械の意味論（実装済み・テスト済み）
- 破損(意味がわからない)は回答と選択を取り消す。writeInテキストは残る
- 破損中は回答不可（core/APIでも拒否）。選択肢を選ぶと破損が自動解除（選択=理解の証拠）
- 納得いかないは進行を妨げない独立フラグ。確定と併用可（disagree and commit）
- 確定+理解不能は両立しない（実装で排除済み）

### UI 蒸留導線
- 確定済みカードにだけ「記録に残す」を表示（4つの判断ボタンとは分離）
- 押下で POST /api/cards/:id/distill を呼び、成功したカードは一覧と集計から消える
- 失敗時はカードを残して再試行可能。日本語/英語コピーあり
- 一時プロジェクト + ポート3999の実ブラウザで、選択→確定→記録に残す→一覧消去→Decision生成まで確認済み

### 配管
- `.documi/cards/` ファイルストア（gitignore済み・操作状態）
- CLI: `documi card create/list/get/answer/distill`
- API: GET /api/cards、POST /:id/answer、POST /:id/flag、POST /:id/distill（src/server/routes/cards.ts）
- Web: useReviewCards hook（src/web/hooks.ts）でライブ取得、Hono RPC型付きクライアント
- 蒸留: `distillCard` — 確定カードを docs/decisions/ に Decision レコード化、distilledAt を刻印、API一覧から除外。再蒸留と異なる既存レコードの上書きは拒否し、生成内容と一致する既存レコードがある中断状態では distilledAt を補完する
- 8件のfixtureカードは src/web/reviewCards.ts が種元。.documi/cards/ にseed済み（回答・フラグ保持で再seed可）
- capture-frequency / design-maybe は蒸留済み（docs/decisions/2026-11-28-capture-frequency.mdx, docs/decisions/2026-11-28-design-maybe.mdx）で残り6件表示

## 重要な設計決定（変えるなら理由が要る）
- 仮置きの見直しは義務にしない。見えていれば正直。見直しトリガーは「上に大きく建てる時」「問題発生時」のみ
- カード文章は会話文脈・造語なしで単体で読める平易な言葉（spec要求済み。「visible な maybe」事件由来）
- 「やらない」は人間の無アクション（openのまま）とは別物。選ぶと普通に閉じる negative decision
- カードは操作状態であって記録ではない。確定→docs蒸留→カード消滅が健全なライフサイクル

## 未実装（次の配管作業、優先度順の一例）
1. 配達 — カードにどう気づくか（同期interrupt vs 非同期queue）
2. 反映の可視化 — 回答が作業に効いた ack
3. AIがカードを書き出す側（MCP elicitation。SDKはelicit対応確認済み）
4. 仮置きの足元可視化（依存する仮置きの一覧）

## 既知の未解決・メモ
- 蒸留レコード生成はコミット済み文言では動くが、write-in 等に引用符・`<`・`>`・改行が入った場合の MDX/YAML エスケープは未検証。利用者入力を受ける本格運用前に要硬化
- answer/flag API 呼び出し全体の直列化は未完了。確定→蒸留だけは直列化済みだが、flagとanswerが絡む高速連打ではサーバー側状態が楽観UIとずれうる
- ボタンの「仮置き」「確定」ラベルに用語popoverを付けたいがボタン内リンクは不可。要別手段
- 再選択してfinishし直さないままだとリロード時に古い回答が復活（意味論的には正しいと判断済み）
- サーバーはポート3000/5173でユーザーが起動中。カードは初回ロード時のみfetch（リロードで更新）
- 言語: ユーザーとの会話は日本語。口調はカジュアル寄りの丁寧。検索は積極的に使う流派

## 検証コマンド
`bun run verify`（format:check → lint → check → test → documi:check）
oxlintはArray#sort禁止（toSorted）、UIでの生useEffect禁止（src/web/hooks.tsへ隔離）
