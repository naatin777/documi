import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { SearchHit } from '../../core/bundle'
import { encodeDocId } from '../api'
import { useSearchQuery } from '../queries'
import { AppDialog } from './ui/Dialog'

interface SearchModalProps {
  open: boolean
  onClose: () => void
}

// @implements ui.search-palette
export default function SearchModal({ open, onClose }: SearchModalProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setActiveIdx(0)
  }, [open])

  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (!q) {
      setDebouncedQuery('')
      return
    }
    const timer = setTimeout(() => setDebouncedQuery(q), 120)
    return () => clearTimeout(timer)
  }, [open, query])

  const searchQuery = useSearchQuery(debouncedQuery, open)
  const results = debouncedQuery ? (searchQuery.data?.results ?? []) : []
  const loading = Boolean(debouncedQuery) && searchQuery.isFetching

  useEffect(() => {
    setActiveIdx(0)
  }, [results])

  const openHit = (hit: SearchHit) => {
    const hash = hit.kind === 'block' ? `#block-${encodeURIComponent(hit.id)}` : ''
    navigate(`/docs/${encodeDocId(hit.docId)}${hash}`)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, Math.max(0, results.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[activeIdx]) {
      e.preventDefault()
      openHit(results[activeIdx]!)
    }
  }

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      ariaLabel={t('search.dialogAria')}
      initialFocus={inputRef}
    >
      <div className="border-b border-line px-3.5 py-3">
        <input
          ref={inputRef}
          type="search"
          className="w-full border-0 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-muted"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('search.placeholder')}
        />
      </div>
      <div className="grid max-h-[60vh] gap-0.5 overflow-y-auto p-1.5">
        {!query.trim() && <p className="my-4 text-center text-[13px] text-fg-muted">{t('search.prompt')}</p>}
        {query.trim() && loading && results.length === 0 && (
          <p className="my-4 text-center text-[13px] text-fg-muted">{t('search.searching')}</p>
        )}
        {query.trim() && !loading && results.length === 0 && (
          <p className="my-4 text-center text-[13px] text-fg-muted">{t('search.noResults')}</p>
        )}
        {results.map((hit, i) => (
          <button
            key={`${hit.kind}:${hit.id}`}
            type="button"
            className={`flex w-full cursor-pointer flex-col gap-1 rounded-lg border-0 px-2.5 py-2 text-left text-fg transition-colors hover:bg-hover ${i === activeIdx ? 'bg-hover' : 'bg-transparent'}`}
            onMouseEnter={() => setActiveIdx(i)}
            onClick={() => openHit(hit)}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`badge badge-type type-${hit.type}`}>{t(`types.singular.${hit.type}`)}</span>
              {hit.blockKind && <span className="rp-block-kind">{hit.blockKind}</span>}
              <strong className="text-[13.5px]">{hit.title}</strong>
              <span className="mono ml-auto text-[11px] text-fg-muted">{hit.docId}</span>
            </div>
            {hit.snippet && <div className="text-xs leading-[1.45] text-fg-muted">{hit.snippet}</div>}
          </button>
        ))}
      </div>
    </AppDialog>
  )
}
