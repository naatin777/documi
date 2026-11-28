export type ReviewCardFinish = 'provisional' | 'committed'
type ReviewCardFillability = 'yes' | 'no'
export type ReviewCardActionInput =
  | { type: 'choose'; optionId: string }
  | { type: 'finish'; finish: ReviewCardFinish }
  | { type: 'typeWriteIn'; text: string }
  | { type: 'toggleIncomprehensible' }
  | { type: 'toggleObjection' }

interface ReviewCardOption {
  id: string
  label: string
  consequence: string
  loses: string
  negative?: boolean
}

export interface ReviewCard {
  id: string
  fillable: ReviewCardFillability
  title: string
  whyNow: string
  defaultPath: string
  example: string
  options: ReviewCardOption[]
}

interface ReviewCardLocalState {
  selectedOptionId?: string
  finish?: ReviewCardFinish
  writeIn?: string
  incomprehensible?: boolean
  objected?: boolean
}

export type ReviewCardStateMap = Record<string, ReviewCardLocalState>

// @implements ui.review-card-actions
export function applyReviewCardAction(
  states: ReviewCardStateMap,
  cardId: string,
  action: ReviewCardActionInput,
): ReviewCardStateMap {
  const current = states[cardId] ?? {}
  const next: ReviewCardLocalState = { ...current }

  if (action.type === 'choose') {
    if (action.optionId !== next.selectedOptionId) {
      next.finish = undefined
    }
    next.selectedOptionId = action.optionId
    next.incomprehensible = undefined
  } else if (action.type === 'finish') {
    if (next.selectedOptionId && !next.incomprehensible) {
      next.finish = action.finish
    }
  } else if (action.type === 'typeWriteIn') {
    next.writeIn = action.text
  } else if (action.type === 'toggleIncomprehensible') {
    next.incomprehensible = !next.incomprehensible
    if (next.incomprehensible) {
      next.finish = undefined
      next.selectedOptionId = undefined
    }
  } else if (action.type === 'toggleObjection') {
    next.objected = !next.objected
  }

  return { ...states, [cardId]: next }
}

// @implements ui.review-cards-prototype
export const REVIEW_CARDS: readonly ReviewCard[] = [
  {
    id: 'card.first-build-target',
    fillable: 'no',
    title: '最初に作る対象をどれにするか',
    whyNow: 'この決定で次に作るものが変わり、無許可実装の防止や仕様管理の全面再設計に進むかどうかがかかっている。',
    defaultPath: 'この問いは仮置きできないので、決まるまでこの方向の作業は進められない。',
    example:
      'たとえば、antigravity に設計方針を相談した内容が翌日にはどこにも残っておらず、同じ説明をやり直す羽目になった。判断カードがあれば、その場で記録に残せた。',
    options: [
      {
        id: 'design-decisions',
        label: '設計・方針の判断カードから作り始める',
        consequence: '今の再設計そのものに使え、実装リスクが小さい',
        loses: '無許可実装の防止は後回しになる',
      },
      {
        id: 'implementation-permission',
        label: '実装開始の許可ゲートを先に作る',
        consequence: 'Signal 事件のような無許可実装に直接効く',
        loses: 'agent 統合や hook が重く、最初の実装が大きくなる',
      },
      {
        id: 'spec-review',
        label: '仕様レビューのカード化から入る',
        consequence: '既存 review 資産を再利用できる',
        loses: 'レビュー債務モデルを引き継ぐ危険がある',
      },
      {
        id: 'do-nothing',
        label: 'この再設計には進まない',
        consequence: '現状のワークフローのまま進め、追加コストはかからない',
        loses: '無許可実装や判断の蒸発は防げず、同種の問題は再発しうる',
        negative: true,
      },
    ],
  },
  {
    id: 'card.capture-frequency',
    fillable: 'yes',
    title: '気づきはこまめにメモし、その場で人間に聞くのは重要なものだけにするか',
    whyNow: '全部聞くと中断が増え、拾わないと蒸発する。この線引きは最初の UX 原則になる。',
    defaultPath: '放っておくと、AI は「メモは全部取り、話しかけるのは大事なものだけ」で仮置きして進める。',
    example:
      'たとえば、実装中に AI が「あれ、この命名おかしくない？」と気づいても、聞くほどでもないと判断するとその気づきは消える。逆に全部聞くと作業が止まる。',
    options: [
      {
        id: 'capture-selective-interrupt',
        label: 'メモは全部取り、話しかけるのは大事なものだけ',
        consequence: '気づきを残しながら作業の流れを保てる',
        loses: '重要度判定を間違えると必要な確認が遅れる',
      },
      {
        id: 'ask-everything',
        label: '全部その場で聞く',
        consequence: '確認漏れは減る',
        loses: '中断が増え、人間が無視するようになる',
      },
      {
        id: 'store-everything',
        label: '全部溜めて後で見る',
        consequence: '作業中は止まらない',
        loses: 'レビュー債務と同じ形で増殖する可能性がある',
      },
      {
        id: 'do-nothing',
        label: 'メモの仕組みは作らない',
        consequence: '今の会話スタイルのままで、導入コストはない',
        loses: 'AI の気づきは消え続け、重要な確認が遅れる',
        negative: true,
      },
    ],
  },
  {
    id: 'card.design-maybe',
    fillable: 'yes',
    title: 'AI が仮に決めた箇所を、仮決定だと分かる形で残すか',
    whyNow: '全部人間に聞くと遅く、黙って埋めるとズレる。中間層があるかどうかで記録モデル全体が変わる。',
    defaultPath: '放っておくと、AI は「仮決定に印を付けて残す」で仮置きして進める。',
    example:
      'たとえば、エラーメッセージの文言や内部命名など、AI が仮に決めた箇所が後から「勝手に決められた」と感じる原因になる。印があれば、確定ではなく仮の決定だと分かる。',
    options: [
      {
        id: 'adopt-maybe',
        label: '仮決定に印を付けて残す',
        consequence: '速さと透明さを両立できる',
        loses: '印の確認漏れがあると、見えるだけで解決しない',
      },
      {
        id: 'ask-all',
        label: '全部その場で人間に聞く',
        consequence: '人間の承認は明確になる',
        loses: '判断要求が増殖し、質問疲れが再発する',
      },
      {
        id: 'implicit-fill',
        label: 'AI が暗に埋める',
        consequence: '短期的には速い',
        loses: '埋めた前提が見えず、ズレとイライラの原因になる',
      },
      {
        id: 'do-nothing',
        label: '印を付ける仕組みは作らない',
        consequence: '記録モデルは単純なまま保てる',
        loses: '暗に埋めるか全部聞くかの二択のままで、ズレか質問疲れのどちらかが起きる',
        negative: true,
      },
    ],
  },
  {
    id: 'card.spec-implementation-coupling',
    fillable: 'yes',
    title: '仕様と実装は承認・マージ単位でセットにするか',
    whyNow:
      '常に完全に同期させると運用が重くなるが、放置すると無自覚なズレが残る。探索速度と一貫性の境界が必要になっている。',
    defaultPath: '放っておくと、AI は「作業中はゆるく、承認時は厳密に」で仮置きして進める。',
    example:
      'たとえば、探索中に API 形状を変えて試したいとする、そのたびに spec を書き直すと探索が止まる。かといって放置すると Signal 事件のように無自覚なズレが残る。',
    options: [
      {
        id: 'eventual-consistency',
        label: '作業中はゆるく、承認時は厳密に',
        consequence: '探索速度と承認時の一貫性を両立できる',
        loses: '承認前の一時的ズレを見せる UX が必要',
      },
      {
        id: 'always-sync',
        label: '常に完全同期',
        consequence: 'ズレが残らない',
        loses: '実装中の小さな変更まで重くなり、仕様管理の負荷が跳ね上がる',
      },
      {
        id: 'loose-sync',
        label: '後で検知する',
        consequence: '実装は速い',
        loses: 'ズレが無自覚に残りやすい',
      },
      {
        id: 'do-nothing',
        label: '同期ルールは決めない',
        consequence: 'ルール運用のコストはかからない',
        loses: 'ズレの扱いが場当たり的になり、無自覚なズレが残りやすい',
        negative: true,
      },
    ],
  },
  {
    id: 'card.source-authority',
    fillable: 'yes',
    title: 'コードへの参照に「この詳細の正典はコード」という意味を持たせるか',
    whyNow: '内部実装を全部仕様化すると二重管理になる。コードと docs の役割を分ける必要がある。',
    defaultPath: '放っておくと、AI は「正典はコードと明示する」で仮置きして進める。',
    example:
      'たとえば、関数の細かい分岐を docs にコピーすると、コードを直すたびに docs も直す羽目になる。「正典はコード」と委譲すれば、docs は意味だけを書けばよい。',
    options: [
      {
        id: 'authority-delegation',
        label: '正典はコードと明示する',
        consequence: 'docs の複写を減らしつつ正典の場所を追える',
        loses: '参照役割の設計と検証が必要になる',
      },
      {
        id: 'plain-link',
        label: '単なるリンクのままにする',
        consequence: '実装は簡単',
        loses: '参考情報と正典の区別がつかない',
      },
      {
        id: 'copy-details',
        label: '詳細を docs に書く',
        consequence: 'docs だけで読める',
        loses: '実装と二重管理になり、更新負債になる',
      },
      {
        id: 'do-nothing',
        label: '参照に意味づけはしない',
        consequence: '追加の設計は不要',
        loses: '参考情報と正典の区別がつかず、詳細の二重管理に流れやすい',
        negative: true,
      },
    ],
  },
  {
    id: 'card.canonical-language',
    fillable: 'yes',
    title: '入力は寛容に受け付け、出力と docs では決まった呼び方だけを使うか',
    whyNow: '関数名・クラス名・概念名が揺れると、人間と AI が同じものを指しているか分からなくなる。',
    defaultPath: '放っておくと、AI は「入力は寛容、出力は正典」で仮置きして進める。',
    example:
      'たとえば、同じ概念が docs では「承認」、コードでは approve、会話では「レビュー通す」と揺れると、AI が別物として扱い、検索も判断もズレる。',
    options: [
      {
        id: 'tolerant-input-canonical-output',
        label: '入力は寛容、出力は決まった呼び方',
        consequence: '自然な会話を保ちつつ、生成物の揺れを減らせる',
        loses: '正規化辞書と生成時チェックが必要',
      },
      {
        id: 'free-language',
        label: '表現は自由にする',
        consequence: '運用は軽い',
        loses: '概念が混ざり、検索・判断・実装がズレる',
      },
      {
        id: 'strict-input',
        label: '入力も決まった呼び方だけにする',
        consequence: '揺れは最も少ない',
        loses: '人間の会話コストが高い',
      },
      {
        id: 'do-nothing',
        label: '語の揺れは放置する',
        consequence: '辞書や生成チェックのコストはかからない',
        loses: '概念の混線が進み、検索・判断・実装がズレ続ける',
        negative: true,
      },
    ],
  },
  {
    id: 'card.prototype-scope',
    fillable: 'yes',
    title: '固定データ・非永続化の Web プロトタイプから始めるか',
    whyNow: 'UX の検証と実用化の問題を分けないと、最初の実装が大きくなりすぎる。',
    defaultPath: '放っておくと、AI は「固定データ Web プロトタイプ」で仮置きして進める。',
    example:
      'この画面自体がその判断の結果。永続化や AI 生成を入れていたら、画面の良し悪しの議論にまだ辿り着いていなかった。',
    options: [
      {
        id: 'fixed-web-prototype',
        label: '固定データ Web プロトタイプ',
        consequence: '画面の判断しやすさを早く検証できる',
        loses: '実用に必要な永続化と AI 生成は分からない',
      },
      {
        id: 'persisted-prototype',
        label: '永続化も入れる',
        consequence: '判断の保存まで検証できる',
        loses: 'データモデル決定が前倒しになり、実装が重くなる',
      },
      {
        id: 'ai-generated-prototype',
        label: 'AI 生成も入れる',
        consequence: '実用の核心に近い',
        loses: 'UX と生成精度の問題が混ざって評価できない',
      },
      {
        id: 'do-nothing',
        label: 'プロトタイプ自体をやめる',
        consequence: '実装コストはゼロ',
        loses: '画面の良し悪しを検証する術がなくなり、設計が空想のまま進む',
        negative: true,
      },
    ],
  },
  {
    id: 'card.implicit-fill-in-implementation',
    fillable: 'yes',
    title: '実装中に AI が仮に決めた箇所を拾って見せるか',
    whyNow: '仮決定はテストを通り diff に紛れる。「通る」ことと「決まっている」ことが区別できず、後から見えなくなる。',
    defaultPath: '放っておくと、AI は「仮決定を拾って記録する」で仮置きして進める。',
    example:
      'たとえば、型を満たすためだけのデフォルト値や、エラーを握りつぶすハンドリングを仮に書くと、テストが通った瞬間に「決まった仕様」の顔をして残る。',
    options: [
      {
        id: 'capture-as-maybe',
        label: '仮決定を拾って記録する',
        consequence: '仮置きの棚卸しと再浮上ができる',
        loses: '何を仮決定と判定するかの精度とノイズの問題がある',
      },
      {
        id: 'human-review-diff',
        label: '人間が diff レビューで拾う',
        consequence: '仕組みは要らない',
        loses: '見逃しが構造的に発生し、レビュー債務と同じ形になる',
      },
      {
        id: 'ban-implicit',
        label: '未決定箇所は実装を止める',
        consequence: '仮決定は発生しない',
        loses: '探索速度が死に、小さな実装も止まる',
      },
      {
        id: 'do-nothing',
        label: '仮決定の記録はしない',
        consequence: '実装の邪魔をしない',
        loses: '勝手に決めた箇所が記録に残らず、後からズレの原因になる',
        negative: true,
      },
    ],
  },
]
