import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import type { SearchHit } from '../../core/bundle'
import { encodeDocId } from '../api'
import { useSearchQuery } from '../queries'

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
    setTimeout(() => inputRef.current?.focus(), 0)
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

  if (!open) return null

  const openHit = (hit: SearchHit) => {
    const hash = hit.kind === 'block' ? `#block-${encodeURIComponent(hit.id)}` : ''
    navigate(`/docs/${encodeDocId(hit.docId)}${hash}`)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
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
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card search-modal"
        role="dialog"
        aria-label={t('search.dialogAria')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="search-input-row">
          <input
            ref={inputRef}
            type="search"
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('search.placeholder')}
          />
        </div>
        <div className="search-results">
          {!query.trim() && <p className="search-empty">{t('search.prompt')}</p>}
          {query.trim() && loading && results.length === 0 && <p className="search-empty">{t('search.searching')}</p>}
          {query.trim() && !loading && results.length === 0 && <p className="search-empty">{t('search.noResults')}</p>}
          {results.map((hit, i) => (
            <button
              key={`${hit.kind}:${hit.id}`}
              type="button"
              className={`search-hit${i === activeIdx ? ' active' : ''}`}
              onMouseEnter={() => setActiveIdx(i)}
              onClick={() => openHit(hit)}
            >
              <div className="search-hit-head">
                <span className={`badge badge-type type-${hit.type}`}>{t(`types.singular.${hit.type}`)}</span>
                {hit.blockKind && <span className="rp-block-kind">{hit.blockKind}</span>}
                <strong className="search-hit-title">{hit.title}</strong>
                <span className="search-hit-id mono">{hit.docId}</span>
              </div>
              {hit.snippet && <div className="search-hit-snippet">{hit.snippet}</div>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
