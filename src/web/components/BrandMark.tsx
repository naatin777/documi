import { Blocks, BookMarked, BookOpen, Cable, FileCheck2, Layers, Scale, ShieldCheck, Target } from 'lucide-react'
import type { ArtifactType } from '../../core/types'

export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" className="brand-mark-bg" />
      <path
        d="M8.2 6.8h5.3l3.3 3.3v6.7a1.2 1.2 0 0 1-1.2 1.2H8.2A1.2 1.2 0 0 1 7 16.8V8a1.2 1.2 0 0 1 1.2-1.2Z"
        className="brand-mark-sheet"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M13.3 6.8v3.4h3.5" className="brand-mark-sheet" strokeWidth="1.35" strokeLinejoin="round" />
      <path
        d="M9.7 11.4 13.7 13.7 10.3 15.6"
        stroke="#6ea0f7"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9.7" cy="11.4" r="1.35" fill="#f59e0b" />
      <circle cx="13.8" cy="13.7" r="1.25" fill="#6ea0f7" />
      <circle cx="10.2" cy="15.6" r="1.2" fill="#14b8a6" />
    </svg>
  )
}

export function ArtifactTypeIcon({
  type,
  size = 13,
  className,
}: {
  type: ArtifactType
  size?: number
  className?: string
}) {
  const props = { size, strokeWidth: 1.8, className: className ?? 'artifact-type-icon', 'aria-hidden': true as const }
  switch (type) {
    case 'goal':
      return <Target {...props} />
    case 'architecture':
      return <Blocks {...props} />
    case 'domain':
      return <BookOpen {...props} />
    case 'spec':
      return <FileCheck2 {...props} />
    case 'contract':
      return <Cable {...props} />
    case 'design':
      return <Layers {...props} />
    case 'decision':
      return <Scale {...props} />
    case 'verification':
      return <ShieldCheck {...props} />
    case 'guide':
      return <BookMarked {...props} />
  }
}
