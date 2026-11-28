import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { StoredCard } from '../../core/cards'
import { rpc } from '../api'
import { useReviewCards } from '../hooks'
import { useTermsQuery } from '../queries'
import { applyReviewCardAction, type ReviewCard, type ReviewCardFinish, type ReviewCardStateMap } from '../reviewCards'
import { TermInline } from './TermPopover'

function finishClass(finish: ReviewCardFinish) {
  switch (finish) {
    case 'committed':
      return 'border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
    case 'provisional':
      return 'border-cyan-500/35 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300'
  }
}

const feedbackButtonClass =
  'inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-line bg-surface px-3 py-1.5 text-[12.5px] font-bold text-fg-muted hover:border-fg-muted hover:text-fg aria-pressed:border-rose-500 aria-pressed:bg-rose-500/10 aria-pressed:text-rose-700 dark:aria-pressed:text-rose-300'
const finishButtonClass =
  'inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md border border-line bg-surface px-4 py-1.5 text-[13px] font-bold text-fg hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-fg'

function chip(label: ReactNode, className: string) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold ${className}`}>
      {label}
    </span>
  )
}

/** 用語集の語にホバー説明を付けた状態チップ。用語が未取得・未定義なら通常チップにフォールバックする。 */
function TermChip({
  termId,
  label,
  suffix,
  className,
}: {
  termId: string
  label: string
  suffix?: ReactNode
  className: string
}) {
  const termsQuery = useTermsQuery()
  const term = termsQuery.data?.terms.find((entry) => entry.id === termId)
  const content = term ? <TermInline term={term}>{label}</TermInline> : label
  return chip(
    <>
      {content}
      {suffix}
    </>,
    className,
  )
}

// @implements ui.review-cards-prototype
export default function ReviewCardsLayout() {
  const { t } = useTranslation()
  const { cards } = useReviewCards()

  if (cards === null) {
    return (
      <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface max-desktop:flex-none max-desktop:overflow-visible">
        <div className="mx-auto flex max-w-[880px] flex-col gap-4 p-5">
          <p className="text-[13px] text-fg-muted">{t('cards.loading')}</p>
        </div>
      </main>
    )
  }

  return <ReviewCardsView cards={cards} />
}

function ReviewCardsView({ cards }: { cards: StoredCard[] }) {
  const { t } = useTranslation()
  const [states, setStates] = useState<ReviewCardStateMap>(() => {
    const seeded: ReviewCardStateMap = {}
    for (const card of cards) {
      seeded[card.id] = {
        selectedOptionId: card.answer?.selectedOptionId,
        finish: card.answer?.finish,
        writeIn: card.answer?.writeIn,
        incomprehensible: card.incomprehensible,
        objected: card.objected,
      }
    }
    return seeded
  })
  const answerWrites = useRef(new Map<string, Promise<void>>())
  const [distilledIds, setDistilledIds] = useState<string[]>([])
  const [distillingIds, setDistillingIds] = useState<string[]>([])
  const [distillErrors, setDistillErrors] = useState<Record<string, string>>({})

  const distill = async (cardId: string) => {
    if (distillingIds.includes(cardId) || distilledIds.includes(cardId)) return
    setDistillingIds((prev) => [...prev, cardId])
    setDistillErrors((prev) => {
      const next = { ...prev }
      delete next[cardId]
      return next
    })
    try {
      await answerWrites.current.get(cardId)
      const res = await rpc.api.cards[':id'].distill.$post({ param: { id: cardId } })
      if (!res.ok) throw new Error('distill failed')
      setDistilledIds((prev) => [...prev, cardId])
    } catch {
      setDistillErrors((prev) => ({ ...prev, [cardId]: t('cards.distillError') }))
    } finally {
      setDistillingIds((prev) => prev.filter((id) => id !== cardId))
    }
  }

  const queueAnswerWrite = (
    cardId: string,
    json: { selectedOptionId: string; writeIn?: string; finish: ReviewCardFinish },
  ) => {
    const previous = answerWrites.current.get(cardId) ?? Promise.resolve()
    const next = (async () => {
      await previous
      const res = await rpc.api.cards[':id'].answer.$post({ param: { id: cardId }, json })
      if (!res.ok) throw new Error('answer failed')
    })().catch(() => {})
    answerWrites.current.set(cardId, next)
    void next.finally(() => {
      if (answerWrites.current.get(cardId) === next) answerWrites.current.delete(cardId)
    })
  }

  const act = (cardId: string, action: Parameters<typeof applyReviewCardAction>[2]) => {
    const current = states[cardId] ?? {}
    if (action.type === 'choose' && current.incomprehensible === true) {
      void rpc.api.cards[':id'].flag.$post({ param: { id: cardId }, json: { incomprehensible: false } }).catch(() => {})
    }
    if (action.type === 'finish' && current.selectedOptionId) {
      queueAnswerWrite(cardId, {
        selectedOptionId: current.selectedOptionId,
        writeIn: current.selectedOptionId === 'other' ? current.writeIn : undefined,
        finish: action.finish,
      })
    } else if (action.type === 'toggleIncomprehensible') {
      void rpc.api.cards[':id'].flag
        .$post({ param: { id: cardId }, json: { incomprehensible: current.incomprehensible !== true } })
        .catch(() => {})
    } else if (action.type === 'toggleObjection') {
      void rpc.api.cards[':id'].flag
        .$post({ param: { id: cardId }, json: { objected: current.objected !== true } })
        .catch(() => {})
    }
    setStates((prev) => applyReviewCardAction(prev, cardId, action))
  }

  const visibleCards = cards.filter((card) => !distilledIds.includes(card.id))

  const finishCounts = useMemo(() => {
    const counts = { committed: 0, provisional: 0, incomprehensible: 0 }
    for (const [cardId, state] of Object.entries(states)) {
      if (distilledIds.includes(cardId)) continue
      if (state.finish === 'committed') counts.committed += 1
      if (state.finish === 'provisional') counts.provisional += 1
      if (state.incomprehensible) counts.incomprehensible += 1
    }
    return counts
  }, [states, distilledIds])

  return (
    <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface max-desktop:flex-none max-desktop:overflow-visible">
      <div className="mx-auto flex max-w-[880px] flex-col gap-4 p-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-[11px] font-bold tracking-[0.08em] text-accent uppercase">{t('cards.eyebrow')}</div>
            <h1 className="m-0 mt-1 text-[22px] leading-tight font-bold">{t('cards.title')}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {finishCounts.committed > 0 && (
              <TermChip
                termId="Committed"
                label={t('cards.stateCommitted')}
                suffix={` ${finishCounts.committed}`}
                className={finishClass('committed') ?? ''}
              />
            )}
            {finishCounts.provisional > 0 && (
              <TermChip
                termId="Provisional"
                label={t('cards.stateProvisional')}
                suffix={` ${finishCounts.provisional}`}
                className={finishClass('provisional') ?? ''}
              />
            )}
            {finishCounts.incomprehensible > 0 && (
              <TermChip
                termId="Incomprehensible"
                label={t('cards.stateIncomprehensible')}
                suffix={` ${finishCounts.incomprehensible}`}
                className="border-rose-500/40 bg-rose-500/12 text-rose-700 dark:text-rose-300"
              />
            )}
            <span className="rounded-full border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 text-[11px] font-bold text-amber-700 dark:text-amber-300">
              {t('cards.prototypeNotice')}
            </span>
          </div>
        </header>

        {visibleCards.length === 0 && <p className="text-[13px] leading-relaxed text-fg-muted">{t('cards.empty')}</p>}
        {visibleCards.map((card) => (
          <ReviewCardItem
            key={card.id}
            card={card}
            state={states[card.id] ?? {}}
            onChoose={(optionId) => act(card.id, { type: 'choose', optionId })}
            onFinish={(finish) => act(card.id, { type: 'finish', finish })}
            onTypeWriteIn={(text) => act(card.id, { type: 'typeWriteIn', text })}
            onToggleIncomprehensible={() => act(card.id, { type: 'toggleIncomprehensible' })}
            onToggleObjection={() => act(card.id, { type: 'toggleObjection' })}
            onDistill={() => void distill(card.id)}
            distilling={distillingIds.includes(card.id)}
            distillError={distillErrors[card.id]}
          />
        ))}
      </div>
    </main>
  )
}

// @implements ui.review-cards-prototype
export function ReviewCardItem({
  card,
  state,
  onChoose,
  onFinish,
  onTypeWriteIn,
  onToggleIncomprehensible,
  onToggleObjection,
  onDistill,
  distilling = false,
  distillError,
}: {
  card: ReviewCard
  state: {
    selectedOptionId?: string
    finish?: ReviewCardFinish
    writeIn?: string
    incomprehensible?: boolean
    objected?: boolean
  }
  onChoose: (optionId: string) => void
  onFinish: (finish: ReviewCardFinish) => void
  onTypeWriteIn: (text: string) => void
  onToggleIncomprehensible: () => void
  onToggleObjection: () => void
  onDistill: () => void
  distilling?: boolean
  distillError?: string
}) {
  const { t } = useTranslation()
  const broken = state.incomprehensible === true
  const otherText = state.writeIn ?? ''
  const otherChosen = state.selectedOptionId === 'other'
  const otherEmpty = otherChosen && otherText.trim().length === 0
  const canFinish = Boolean(state.selectedOptionId) && !broken && !otherEmpty
  const canProvisional = canFinish && card.fillable === 'yes'

  return (
    <article
      className={`rounded-xl border p-4 ${broken ? 'border-rose-500/50 bg-sidebar opacity-75' : 'border-line bg-sidebar'}`}
    >
      <h2 className="m-0 text-[17px] leading-snug font-bold">{card.title}</h2>
      <p className="mt-1.5 mb-0 text-[13px] leading-relaxed text-fg-muted">
        {card.whyNow}
        {card.defaultPath}
        {card.example}
      </p>

      <div className="mt-3 flex flex-col gap-2">
        {card.options.map((option) => {
          const chosen = state.selectedOptionId === option.id
          const settled = state.finish !== undefined
          const faded = settled && !chosen
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onChoose(option.id)}
              aria-pressed={chosen}
              aria-label={option.label}
              className={`cursor-pointer rounded-lg border p-3 text-left transition-all disabled:cursor-not-allowed ${
                chosen ? 'border-accent bg-accent-soft shadow-sm' : 'border-line bg-surface hover:border-fg-muted'
              } ${faded ? 'opacity-45' : ''}`}
            >
              <div className="flex items-start gap-2 text-[13.5px] font-bold text-fg">
                <span
                  aria-hidden
                  className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none ${
                    chosen ? 'border-accent bg-accent text-white' : 'border-line text-transparent'
                  }`}
                >
                  ✓
                </span>
                <span>{option.label}</span>
              </div>
              <div className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
                <strong className="text-emerald-700 dark:text-emerald-300">{t('cards.merit')}:</strong>{' '}
                {option.consequence}
              </div>
              <div className="mt-0.5 text-[12.5px] leading-relaxed text-fg-muted">
                <strong className="text-rose-700 dark:text-rose-300">{t('cards.demerit')}:</strong> {option.loses}
              </div>
            </button>
          )
        })}
        <label
          htmlFor={`${card.id}-other-input`}
          aria-label={t('cards.otherApproach')}
          className={`block cursor-text rounded-lg border p-3 transition-all ${
            otherChosen ? 'border-accent bg-accent-soft shadow-sm' : 'border-line bg-surface'
          } ${state.finish !== undefined && !otherChosen ? 'opacity-45' : ''}`}
        >
          <div className="flex items-start gap-2 text-[13.5px] font-bold text-fg">
            <span
              aria-hidden
              className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none ${
                otherChosen ? 'border-accent bg-accent text-white' : 'border-line text-transparent'
              }`}
            >
              ✓
            </span>
            <span>{t('cards.otherApproach')}</span>
          </div>
          <input
            id={`${card.id}-other-input`}
            value={otherText}
            onChange={(event) => onTypeWriteIn(event.target.value)}
            onFocus={() => onChoose('other')}
            placeholder={t('cards.otherApproachPlaceholder')}
            className="mt-1.5 ml-6 w-[calc(100%-1.5rem)] border-none bg-transparent p-0 text-[12.5px] text-fg outline-none placeholder:text-fg-muted/50"
          />
        </label>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={feedbackButtonClass}
            aria-pressed={broken}
            onClick={onToggleIncomprehensible}
          >
            {t('cards.actions.incomprehensible')}
          </button>
          <button
            type="button"
            className={feedbackButtonClass}
            aria-pressed={state.objected === true}
            onClick={onToggleObjection}
          >
            {t('cards.actions.objection')}
          </button>
        </div>
        <div className="flex gap-2">
          {card.fillable === 'yes' && (
            <button
              type="button"
              className={`${finishButtonClass} ${state.finish === 'provisional' ? 'border-cyan-500 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300' : ''}`}
              disabled={!canProvisional}
              aria-pressed={state.finish === 'provisional'}
              onClick={() => onFinish('provisional')}
            >
              {t('cards.actions.provisional')}
            </button>
          )}
          <button
            type="button"
            className={`${finishButtonClass} ${state.finish === 'committed' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : ''}`}
            disabled={!canFinish}
            aria-pressed={state.finish === 'committed'}
            onClick={() => onFinish('committed')}
          >
            {t('cards.actions.committed')}
          </button>
        </div>
      </div>

      {state.finish === 'committed' && (
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2 border-t border-line/70 pt-2">
          {distillError && <p className="m-0 mr-auto text-[12px] text-rose-700 dark:text-rose-300">{distillError}</p>}
          <button type="button" className={finishButtonClass} disabled={distilling} onClick={onDistill}>
            {distilling ? t('cards.actions.distilling') : t('cards.actions.distill')}
          </button>
        </div>
      )}
    </article>
  )
}
