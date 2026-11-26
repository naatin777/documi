import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { Hono } from 'hono'
import { getMediaMimeType, resolveLocalMediaPath } from '../../core/media'
import type { DocsStore } from '../store'

interface ByteRange {
  start: number
  end: number
}

function parseRangeHeader(header: string, size: number): ByteRange | 'invalid' {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match) return 'invalid'
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return 'invalid'

  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }

  const start = Number(rawStart)
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || start > end) {
    return 'invalid'
  }
  return { start, end }
}

/**
 * docs/ 配下のローカルメディアファイル（画像・動画・音声）を安全に配信するルート。
 * docs/ 外へのトラバーサル・symlink 脱出・未許可拡張子を拒否し、
 * SVG には `Content-Security-Policy: sandbox`、動画・音声には HTTP Range (`206`) を返す。
 */
export function createMediaRoutes(store: DocsStore) {
  return new Hono().get('/:path{.+}', async (c) => {
    const rawPath = c.req.param('path')
    const resolved = resolveLocalMediaPath(rawPath, '')
    if (!resolved.ok) {
      const status = resolved.reason === 'outside-docs' ? 403 : 400
      return c.json({ error: 'Invalid media path' }, status)
    }

    const mime = getMediaMimeType(resolved.relPath)
    if (!mime) {
      return c.json({ error: 'Unsupported media type' }, 403)
    }

    const rootDir = path.resolve(store.rootDir)
    const realRoot = await realpath(rootDir).catch(() => rootDir)
    const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`
    const absPath = path.join(rootDir, resolved.relPath)

    let realAbs: string
    let size: number
    try {
      realAbs = await realpath(absPath)
      if (!realAbs.startsWith(rootPrefix)) {
        return c.json({ error: 'Media path escapes docs directory' }, 403)
      }
      const st = await stat(realAbs)
      if (!st.isFile()) {
        return c.json({ error: 'Media file not found' }, 404)
      }
      size = st.size
    } catch {
      return c.json({ error: 'Media file not found' }, 404)
    }

    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=3600',
    }
    if (mime === 'image/svg+xml') {
      headers['Content-Security-Policy'] = 'sandbox'
    }

    const rangeHeader = c.req.header('range')
    if (rangeHeader) {
      if (size === 0) {
        return new Response(null, {
          status: 416,
          headers: { ...headers, 'Content-Range': 'bytes */0' },
        })
      }
      const parsed = parseRangeHeader(rangeHeader, size)
      if (parsed === 'invalid') {
        return new Response(null, {
          status: 416,
          headers: { ...headers, 'Content-Range': `bytes */${size}` },
        })
      }
      const { start, end } = parsed
      const chunkLength = end - start + 1
      return new Response(Bun.file(realAbs).slice(start, end + 1), {
        status: 206,
        headers: {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(chunkLength),
        },
      })
    }

    return new Response(Bun.file(realAbs), {
      status: 200,
      headers: {
        ...headers,
        'Content-Length': String(size),
      },
    })
  })
}
