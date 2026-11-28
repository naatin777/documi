import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import ReviewCardsLayout, { ReviewCardItem } from '../src/web/components/ReviewCardsLayout'
import { setAppLocale } from '../src/web/i18n'
import { applyReviewCardAction, REVIEW_CARDS } from '../src/web/reviewCards'

function renderCardForDistillTest(state: { selectedOptionId?: string; finish?: 'provisional' | 'committed' }) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ReviewCardItem
        card={REVIEW_CARDS[0]!}
        state={state}
        onChoose={() => {}}
        onFinish={() => {}}
        onTypeWriteIn={() => {}}
        onToggleIncomprehensible={() => {}}
        onToggleObjection={() => {}}
        onDistill={() => {}}
      />
    </MemoryRouter>,
  )
}

describe('Review Cards prototype', () => {
  test('[ui.review-cards-prototype] 固定データ 5〜8 件が判断に必要な要素を持ち、/cards 相当の画面に描画される', () => {
    setAppLocale('ja')

    expect(REVIEW_CARDS.length).toBeGreaterThanOrEqual(5)
    expect(REVIEW_CARDS.length).toBeLessThanOrEqual(8)

    for (const card of REVIEW_CARDS) {
      expect(card.whyNow.length).toBeGreaterThan(0)
      expect(card.defaultPath.length).toBeGreaterThan(0)
      expect(card.example.length).toBeGreaterThan(0)
      expect(card.options.length).toBeGreaterThanOrEqual(2)
      expect(card.options.every((option) => option.consequence.length > 0)).toBe(true)
      expect(card.options.every((option) => option.loses.length > 0)).toBe(true)
      const negatives = card.options.filter((option) => option.negative === true)
      expect(negatives.length).toBe(1)
      const negative = negatives[0]!
      expect(negative.consequence.length).toBeGreaterThan(0)
      expect(negative.loses.length).toBeGreaterThan(0)
      expect(['yes', 'no']).toContain(card.fillable)
    }

    const shell = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/cards']}>
        <ReviewCardsLayout />
      </MemoryRouter>,
    )
    expect(shell).toContain('読み込み中')

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ReviewCardItem
          card={REVIEW_CARDS[0]!}
          state={{}}
          onChoose={() => {}}
          onFinish={() => {}}
          onTypeWriteIn={() => {}}
          onToggleIncomprehensible={() => {}}
          onToggleObjection={() => {}}
          onDistill={() => {}}
        />
      </MemoryRouter>,
    )

    expect(html).toContain('最初に作る対象をどれにするか')
    expect(html).toContain('仮置きできないので')
    expect(html).toContain('たとえば')
    expect(html).toContain('メリット')
    expect(html).toContain('デメリット')
    expect(html).toContain('意味がわからない')
    expect(html).toContain('納得いかない')
    expect(html).toContain('他のやり方がある')
    expect(html).not.toContain('AI 推奨')
    expect(html).not.toContain('並び順の根拠')
    expect(html).not.toContain('不確かなこと')
  })

  test('[ui.review-card-actions] 選択は入力にとどまり、ボタンでのみ仮置き/確定に遷移する', () => {
    // 選択だけでは開いたまま（finish なし）
    let states = applyReviewCardAction({}, 'card.capture-frequency', {
      type: 'choose',
      optionId: 'capture-selective-interrupt',
    })
    expect(states['card.capture-frequency']?.selectedOptionId).toBe('capture-selective-interrupt')
    expect(states['card.capture-frequency']?.finish).toBeUndefined()

    // 未選択での finish は無効
    states = applyReviewCardAction({}, 'card.capture-frequency', { type: 'finish', finish: 'committed' })
    expect(states['card.capture-frequency']?.finish).toBeUndefined()
    expect(states['card.capture-frequency']?.selectedOptionId).toBeUndefined()

    // 仮置きできるカードでは仮置きに遷移できる
    states = applyReviewCardAction({}, 'card.capture-frequency', {
      type: 'choose',
      optionId: 'capture-selective-interrupt',
    })
    states = applyReviewCardAction(states, 'card.capture-frequency', { type: 'finish', finish: 'provisional' })
    expect(states['card.capture-frequency']?.finish).toBe('provisional')

    // 確定にも遷移できる
    states = applyReviewCardAction(states, 'card.capture-frequency', { type: 'finish', finish: 'committed' })
    expect(states['card.capture-frequency']?.finish).toBe('committed')

    // 確定後に「意味がわからない」を押すと仕上げが解除され破損に戻る
    states = applyReviewCardAction(states, 'card.capture-frequency', { type: 'toggleIncomprehensible' })
    expect(states['card.capture-frequency']?.finish).toBeUndefined()
    expect(states['card.capture-frequency']?.selectedOptionId).toBeUndefined()
    expect(states['card.capture-frequency']?.incomprehensible).toBe(true)

    // 破損中は finish できない
    states = applyReviewCardAction(states, 'card.capture-frequency', { type: 'finish', finish: 'committed' })
    expect(states['card.capture-frequency']?.finish).toBeUndefined()

    // 選択肢を選ぶと破損は解除される（選択できる=理解できた証拠）
    states = applyReviewCardAction(states, 'card.capture-frequency', {
      type: 'choose',
      optionId: 'capture-selective-interrupt',
    })
    expect(states['card.capture-frequency']?.incomprehensible).toBeUndefined()
    expect(states['card.capture-frequency']?.selectedOptionId).toBe('capture-selective-interrupt')

    // 別の選択肢を選ぶと仕上げ状態は開いた状態に戻る
    states = applyReviewCardAction(states, 'card.first-build-target', {
      type: 'choose',
      optionId: 'implementation-permission',
    })
    expect(states['card.first-build-target']?.finish).toBeUndefined()
    expect(states['card.first-build-target']?.selectedOptionId).toBe('implementation-permission')
  })

  test('[ui.review-card-actions] 意味がわからないは破損状態にし、納得いかないは進行を妨げない', () => {
    // トグルで破損を解除し、選び直せば finish できる
    let states = applyReviewCardAction({}, 'card.capture-frequency', { type: 'toggleIncomprehensible' })
    expect(states['card.capture-frequency']?.incomprehensible).toBe(true)
    states = applyReviewCardAction(states, 'card.capture-frequency', { type: 'toggleIncomprehensible' })
    expect(states['card.capture-frequency']?.incomprehensible).toBe(false)
    states = applyReviewCardAction(states, 'card.capture-frequency', {
      type: 'choose',
      optionId: 'capture-selective-interrupt',
    })
    states = applyReviewCardAction(states, 'card.capture-frequency', { type: 'finish', finish: 'committed' })
    expect(states['card.capture-frequency']?.finish).toBe('committed')

    // 異議は進行を妨げない
    states = applyReviewCardAction(states, 'card.capture-frequency', { type: 'toggleObjection' })
    expect(states['card.capture-frequency']?.objected).toBe(true)
    states = applyReviewCardAction(states, 'card.capture-frequency', { type: 'finish', finish: 'provisional' })
    expect(states['card.capture-frequency']?.finish).toBe('provisional')
  })

  test('[ui.review-card-distill] 記録に残す操作は確定済みカードにだけ表示される', () => {
    setAppLocale('ja')
    const committed = renderCardForDistillTest({ selectedOptionId: 'design-decisions', finish: 'committed' })
    expect(committed).toContain('記録に残す')

    const provisional = renderCardForDistillTest({ selectedOptionId: 'design-decisions', finish: 'provisional' })
    expect(provisional).not.toContain('記録に残す')

    const open = renderCardForDistillTest({ selectedOptionId: 'design-decisions' })
    expect(open).not.toContain('記録に残す')
  })
})
