import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { isNoteIntent, isSpecIntent, isStability } from '../../core/types'
import type { SemanticBlock } from '../../core/types'
import BlockReviewControls from './BlockReviewControls'

interface DocReviewContextValue {
  blocksById: ReadonlyMap<string, SemanticBlock>
  onMutate: () => void
}

const DocReviewContext = createContext<DocReviewContextValue | null>(null)

// @implements ui.human-review
export function DocReviewProvider({
  blocks,
  onMutate,
  children,
}: {
  blocks: readonly SemanticBlock[]
  onMutate: () => void
  children: ReactNode
}) {
  const value = useMemo(() => ({ blocksById: new Map(blocks.map((b) => [b.id, b])), onMutate }), [blocks, onMutate])
  return <DocReviewContext.Provider value={value}>{children}</DocReviewContext.Provider>
}

function useSemanticBlock(id?: string): { block?: SemanticBlock; onMutate?: () => void } {
  const ctx = useContext(DocReviewContext)
  if (!ctx || !id) return {}
  return { block: ctx.blocksById.get(id), onMutate: ctx.onMutate }
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export interface SpecBlockProps {
  id?: string
  intent?: string
  stability?: string
  derives?: string
  title?: string
  children?: ReactNode
}

export function SpecBlock({ id, intent, stability, derives, title, children }: SpecBlockProps) {
  const { block, onMutate } = useSemanticBlock(id)
  const safeIntent = isSpecIntent(intent) ? intent : 'normative'
  const safeStability = block?.stability ?? (isStability(stability) ? stability : 'evolving')
  const deriveList = splitCsv(derives)
  const reviewClass = block ? ` sem-state-${block.review}${block.suspect ? ' sem-state-suspect' : ''}` : ''

  return (
    <section
      id={id ? `block-${id}` : undefined}
      className={`sem-block sem-spec sem-intent-${safeIntent} sem-stability-${safeStability}${reviewClass}`}
    >
      <header className="sem-header">
        <span className="sem-kind sem-kind-spec">SPEC</span>
        {id && <code className="sem-id">{id}</code>}
        {title && <span className="sem-title">{title}</span>}
        <span className="sem-badges">
          {safeIntent !== 'normative' && <span className={`sem-pill sem-pill-${safeIntent}`}>{safeIntent}</span>}
          {!block && <span className={`sem-pill sem-pill-${safeStability}`}>{safeStability}</span>}
        </span>
      </header>
      {block && onMutate && <BlockReviewControls block={block} onMutate={onMutate} />}
      <div className="sem-body">{children}</div>
      {deriveList.length > 0 && (
        <footer className="sem-footer">
          <span className="sem-meta-label">derives</span>
          {deriveList.map((ref) => (
            <code key={ref} className="sem-ref-chip">
              {ref}
            </code>
          ))}
        </footer>
      )}
    </section>
  )
}

export interface ConstraintBlockProps {
  id?: string
  scope?: string
  stability?: string
  title?: string
  children?: ReactNode
}

export function ConstraintBlock({ id, scope, stability, title, children }: ConstraintBlockProps) {
  const { block, onMutate } = useSemanticBlock(id)
  const safeStability = block?.stability ?? (isStability(stability) ? stability : 'stable')
  const reviewClass = block ? ` sem-state-${block.review}${block.suspect ? ' sem-state-suspect' : ''}` : ''

  return (
    <section id={id ? `block-${id}` : undefined} className={`sem-block sem-constraint${reviewClass}`}>
      <header className="sem-header">
        <span className="sem-kind sem-kind-constraint">CONSTRAINT</span>
        {id && <code className="sem-id">{id}</code>}
        {title && <span className="sem-title">{title}</span>}
        <span className="sem-badges">
          {scope && <span className="sem-pill sem-pill-scope">{scope}</span>}
          {!block && <span className={`sem-pill sem-pill-${safeStability}`}>{safeStability}</span>}
        </span>
      </header>
      {block && onMutate && <BlockReviewControls block={block} onMutate={onMutate} />}
      <div className="sem-body">{children}</div>
    </section>
  )
}

export interface DecisionBlockProps {
  id?: string
  summary?: string
  date?: string
  supersedes?: string
  stability?: string
  title?: string
  children?: ReactNode
}

export function DecisionBlock({ id, summary, date, supersedes, stability, title, children }: DecisionBlockProps) {
  const { block, onMutate } = useSemanticBlock(id)
  const safeStability = block?.stability ?? (isStability(stability) ? stability : 'stable')
  const superseded = splitCsv(supersedes)
  const reviewClass = block ? ` sem-state-${block.review}${block.suspect ? ' sem-state-suspect' : ''}` : ''

  return (
    <section id={id ? `block-${id}` : undefined} className={`sem-block sem-decision${reviewClass}`}>
      <header className="sem-header">
        <span className="sem-kind sem-kind-decision">DECISION</span>
        {id && <code className="sem-id">{id}</code>}
        {title && <span className="sem-title">{title}</span>}
        <span className="sem-badges">
          {date && <span className="sem-pill sem-pill-scope">{date}</span>}
          {!block && <span className={`sem-pill sem-pill-${safeStability}`}>{safeStability}</span>}
        </span>
      </header>
      {block && onMutate && <BlockReviewControls block={block} onMutate={onMutate} />}
      {summary && <div className="sem-decision-summary">{summary}</div>}
      <div className="sem-body">{children}</div>
      {superseded.length > 0 && (
        <footer className="sem-footer">
          <span className="sem-meta-label">supersedes</span>
          {superseded.map((ref) => (
            <code key={ref} className="sem-ref-chip">
              {ref}
            </code>
          ))}
        </footer>
      )}
    </section>
  )
}

export function DecisionSubBlock({
  kind,
  option,
  children,
}: {
  kind: 'context' | 'chosen' | 'rejected' | 'tradeoff'
  option?: string
  children?: ReactNode
}) {
  const label =
    kind === 'context' ? 'Context' : kind === 'chosen' ? 'Chosen' : kind === 'rejected' ? 'Rejected' : 'Trade-off'
  return (
    <div className={`sem-decision-sub sem-decision-sub-${kind}`}>
      <span className="sem-decision-sub-label">
        {label}
        {option ? `: ${option}` : ''}
      </span>
      <div className="sem-decision-sub-body">{children}</div>
    </div>
  )
}

export interface TestBlockProps {
  id?: string
  verifies?: string
  level?: string
  stability?: string
  title?: string
  children?: ReactNode
}

export function TestBlock({ id, verifies, level, stability, title, children }: TestBlockProps) {
  const { block, onMutate } = useSemanticBlock(id)
  const safeStability = block?.stability ?? (isStability(stability) ? stability : 'evolving')
  const verifiedTargets = splitCsv(verifies)
  const reviewClass = block ? ` sem-state-${block.review}${block.suspect ? ' sem-state-suspect' : ''}` : ''

  return (
    <section id={id ? `block-${id}` : undefined} className={`sem-block sem-test${reviewClass}`}>
      <header className="sem-header">
        <span className="sem-kind sem-kind-test">TEST</span>
        {id && <code className="sem-id">{id}</code>}
        {title && <span className="sem-title">{title}</span>}
        <span className="sem-badges">
          {level && <span className="sem-pill sem-pill-scope">{level}</span>}
          {!block && <span className={`sem-pill sem-pill-${safeStability}`}>{safeStability}</span>}
        </span>
      </header>
      {block && onMutate && <BlockReviewControls block={block} onMutate={onMutate} />}
      <div className="sem-body">{children}</div>
      {verifiedTargets.length > 0 && (
        <footer className="sem-footer">
          <span className="sem-meta-label">verifies</span>
          {verifiedTargets.map((ref) => (
            <code key={ref} className="sem-ref-chip">
              {ref}
            </code>
          ))}
        </footer>
      )}
    </section>
  )
}

export interface NoteBlockProps {
  intent?: string
  title?: string
  children?: ReactNode
}

export function NoteBlock({ intent, title, children }: NoteBlockProps) {
  const { t } = useTranslation()
  const safeIntent = isNoteIntent(intent) ? intent : 'informative'
  const label =
    safeIntent === 'idea'
      ? t('blocks.noteIdea')
      : safeIntent === 'rejected'
        ? t('blocks.noteRejected')
        : t('blocks.noteInformative')
  return (
    <aside className={`sem-block sem-note sem-note-${safeIntent}`}>
      <header className="sem-header">
        <span className={`sem-kind sem-kind-note-${safeIntent}`}>{label}</span>
        {title && <span className="sem-title">{title}</span>}
      </header>
      <div className="sem-body">{children}</div>
    </aside>
  )
}

export interface TermDefBlockProps {
  id?: string
  aliases?: string
  symbols?: string
  children?: ReactNode
}

export function TermDefBlock({ id, aliases, symbols, children }: TermDefBlockProps) {
  const { block, onMutate } = useSemanticBlock(id)
  const aliasList = splitCsv(aliases)
  const symbolList = splitCsv(symbols)
  const reviewClass = block ? ` sem-state-${block.review}${block.suspect ? ' sem-state-suspect' : ''}` : ''

  return (
    <section id={id ? `block-${id}` : undefined} className={`sem-block sem-term${reviewClass}`}>
      <header className="sem-header">
        <span className="sem-kind sem-kind-term">TERM</span>
        {id && <strong className="sem-term-name">{id}</strong>}
        {aliasList.length > 0 && (
          <span className="sem-badges">
            {aliasList.map((a) => (
              <span key={a} className="sem-pill sem-pill-alias">
                {a}
              </span>
            ))}
          </span>
        )}
      </header>
      {block && onMutate && <BlockReviewControls block={block} onMutate={onMutate} />}
      <div className="sem-body">{children}</div>
      {symbolList.length > 0 && (
        <footer className="sem-footer">
          <span className="sem-meta-label">symbols</span>
          {symbolList.map((sym) => (
            <code key={sym} className="sem-ref-chip">
              {sym}
            </code>
          ))}
        </footer>
      )}
    </section>
  )
}
