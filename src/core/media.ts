/**
 * ドキュメント内メディア（画像・動画・音声）の種別判定・MIME マッピング・パス正規化。
 * `node:*` に依存しない純粋モジュールのため、`src/core/`・`src/server/`・`src/web/` で共有できる。
 */

export type MediaKind = 'image' | 'video' | 'audio'

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
}

const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
}

const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
}

const ALL_MEDIA_MIME: Record<string, string> = {
  ...IMAGE_MIME,
  ...VIDEO_MIME,
  ...AUDIO_MIME,
}

function extractExt(urlOrPath: string): string {
  const clean = urlOrPath.split(/[?#]/)[0] ?? ''
  const base = clean.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

/** 拡張子から画像 / 動画 / 音声を判定する（拡張子なし外部 URL 等は image 扱い） */
export function getMediaKind(urlOrPath: string): MediaKind {
  const ext = extractExt(urlOrPath)
  if (ext in VIDEO_MIME) return 'video'
  if (ext in AUDIO_MIME) return 'audio'
  return 'image'
}

/** ローカル配信を許可するメディア拡張子の MIME タイプを返す（未許可拡張子は undefined） */
export function getMediaMimeType(relPath: string): string | undefined {
  return ALL_MEDIA_MIME[extractExt(relPath)]
}

/** ローカルメディアとして配信・コピーを許可する拡張子かを判定する */
export function isSupportedLocalMedia(relPath: string): boolean {
  return getMediaMimeType(relPath) !== undefined
}

/** 外部メディア URL のスキーム安全性を検証する（http/https と安全なラスタ data:image/* のみ許可） */
export function isSafeExternalMediaUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim()
  if (/^https?:\/\//i.test(trimmed)) return true
  if (/^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,/i.test(trimmed)) return true
  return false
}

export type LocalMediaResolution =
  | { ok: true; relPath: string }
  | { ok: false; reason: 'external' | 'outside-docs' | 'invalid' }

/**
 * Markdown 内の画像/メディア参照 URL を `docs/` 基準の POSIX 相対パスへ解決する。
 * 外部 URL (`http://`, `https://`, `data:` 等) は `{ ok: false, reason: 'external' }`、
 * `docs/` の外へ脱出する相対パス (`../../secret.png`) は `{ ok: false, reason: 'outside-docs' }` を返す。
 */
export function resolveLocalMediaPath(rawUrl: string, currentDir: string): LocalMediaResolution {
  const trimmed = rawUrl.trim()
  if (!trimmed) return { ok: false, reason: 'invalid' }

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) {
    return { ok: false, reason: 'external' }
  }

  const rawPath = trimmed.split(/[?#]/)[0] ?? ''
  if (!rawPath) return { ok: false, reason: 'invalid' }

  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (decoded.includes('\0') || decoded.includes('\\')) {
    return { ok: false, reason: 'invalid' }
  }

  const isRootRel = decoded.startsWith('/')
  const stripped = isRootRel ? decoded.replace(/^\/+/, '') : decoded
  const baseParts = isRootRel ? [] : currentDir ? currentDir.split('/').filter(Boolean) : []
  const out = [...baseParts]

  for (const part of stripped.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return { ok: false, reason: 'outside-docs' }
      out.pop()
    } else {
      out.push(part)
    }
  }

  if (out.length === 0) return { ok: false, reason: 'invalid' }
  if (out.some((p) => p.startsWith('.') || p === 'node_modules') || out[0] === 'guard') {
    return { ok: false, reason: 'outside-docs' }
  }

  return { ok: true, relPath: out.join('/') }
}
