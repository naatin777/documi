import { File, Folder, FolderOpen } from 'lucide-react'
import { useState } from 'react'
import type { MaterialIconManifest } from '../../server/routes/icons'
import { isStaticSite, staticAssetUrl } from '../api'
import { useIconManifestQuery } from '../queries'
import { useTheme } from '../theme'

export function resolveFileIconId(
  manifest: MaterialIconManifest | undefined,
  fileNameOrPath: string,
  theme: 'light' | 'dark',
): string {
  if (!manifest) return 'file'
  const base = fileNameOrPath.split('/').pop() ?? fileNameOrPath
  const lower = base.toLowerCase()
  const isLight = theme === 'light'

  if (isLight && manifest.light.fileNames[lower]) {
    return manifest.light.fileNames[lower]
  }
  if (manifest.fileNames[lower]) {
    return manifest.fileNames[lower]
  }

  const parts = lower.split('.')
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.')
    if (!ext) continue
    if (isLight && manifest.light.fileExtensions[ext]) {
      return manifest.light.fileExtensions[ext]
    }
    if (manifest.fileExtensions[ext]) {
      return manifest.fileExtensions[ext]
    }
  }

  return manifest.file || 'file'
}

export function resolveFolderIconId(
  manifest: MaterialIconManifest | undefined,
  folderName: string,
  open: boolean,
  theme: 'light' | 'dark',
): string {
  if (!manifest) return open ? 'folder-open' : 'folder'
  const lower = folderName.toLowerCase()
  const isLight = theme === 'light'

  if (open) {
    if (isLight && manifest.light.folderNamesExpanded[lower]) {
      return manifest.light.folderNamesExpanded[lower]
    }
    if (manifest.folderNamesExpanded[lower]) {
      return manifest.folderNamesExpanded[lower]
    }
    return manifest.folderExpanded || 'folder-open'
  }

  if (isLight && manifest.light.folderNames[lower]) {
    return manifest.light.folderNames[lower]
  }
  if (manifest.folderNames[lower]) {
    return manifest.folderNames[lower]
  }
  return manifest.folder || 'folder'
}

function iconSrc(iconId: string): string {
  const encoded = encodeURIComponent(iconId)
  return isStaticSite() ? staticAssetUrl(`data/icons/${encoded}.svg`) : `/api/icons/${encoded}.svg`
}

export function MaterialFileIcon({ name, size = 15, className }: { name: string; size?: number; className?: string }) {
  const { data: manifest } = useIconManifestQuery()
  const { resolved } = useTheme()
  const iconId = resolveFileIconId(manifest, name, resolved)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const src = iconSrc(iconId)

  if (failedSrc === src) {
    return <File size={size} strokeWidth={1.75} className={className} aria-hidden="true" />
  }

  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
      className={`inline-block shrink-0 object-contain align-middle select-none${className ? ` ${className}` : ''}`}
      onError={() => setFailedSrc(src)}
    />
  )
}

export function MaterialFolderIcon({
  name,
  open = false,
  size = 15,
  className,
}: {
  name: string
  open?: boolean
  size?: number
  className?: string
}) {
  const { data: manifest } = useIconManifestQuery()
  const { resolved } = useTheme()
  const iconId = resolveFolderIconId(manifest, name, open, resolved)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const src = iconSrc(iconId)

  if (failedSrc === src) {
    return open ? (
      <FolderOpen size={size} strokeWidth={1.75} className={className} aria-hidden="true" />
    ) : (
      <Folder size={size} strokeWidth={1.75} className={className} aria-hidden="true" />
    )
  }

  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
      className={`inline-block shrink-0 object-contain align-middle select-none${className ? ` ${className}` : ''}`}
      onError={() => setFailedSrc(src)}
    />
  )
}
