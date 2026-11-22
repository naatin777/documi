import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { Hono } from 'hono'
import { generateManifest } from 'material-icon-theme'

export interface MaterialIconManifest {
  file: string
  folder: string
  folderExpanded: string
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
  folderNames: Record<string, string>
  folderNamesExpanded: Record<string, string>
  light: {
    fileNames: Record<string, string>
    fileExtensions: Record<string, string>
    folderNames: Record<string, string>
    folderNamesExpanded: Record<string, string>
  }
}

interface LoadedIcons {
  manifest: MaterialIconManifest
  iconFileMap: Map<string, string>
  iconsDir: string
}

let cached: LoadedIcons | null = null
const svgCache = new Map<string, string>()

function normalizeRecord(input: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!input) return out
  for (const [key, value] of Object.entries(input)) {
    const lower = key.toLowerCase()
    if (!(lower in out)) {
      out[lower] = value
    }
  }
  return out
}

function loadMaterialIcons(): LoadedIcons {
  if (cached) return cached

  const raw = generateManifest({ activeIconPack: 'react' })
  const require = createRequire(import.meta.url)
  const pkgPath = require.resolve('material-icon-theme/package.json')
  const iconsDir = path.join(path.dirname(pkgPath), 'icons')

  const iconFileMap = new Map<string, string>()
  for (const [id, def] of Object.entries(raw.iconDefinitions ?? {})) {
    if (typeof def?.iconPath === 'string') {
      const fileName = path.basename(def.iconPath)
      if (fileName.endsWith('.svg')) {
        iconFileMap.set(id, fileName)
      }
    }
  }

  const manifest: MaterialIconManifest = {
    file: raw.file ?? 'file',
    folder: raw.folder ?? 'folder',
    folderExpanded: raw.folderExpanded ?? 'folder-open',
    fileNames: normalizeRecord(raw.fileNames),
    fileExtensions: normalizeRecord(raw.fileExtensions),
    folderNames: normalizeRecord(raw.folderNames),
    folderNamesExpanded: normalizeRecord(raw.folderNamesExpanded),
    light: {
      fileNames: normalizeRecord(raw.light?.fileNames),
      fileExtensions: normalizeRecord(raw.light?.fileExtensions),
      folderNames: normalizeRecord(raw.light?.folderNames),
      folderNamesExpanded: normalizeRecord(raw.light?.folderNamesExpanded),
    },
  }

  cached = { manifest, iconFileMap, iconsDir }
  return cached
}

export function createIconsRoutes() {
  return new Hono()
    .get('/manifest', (c) => {
      const { manifest } = loadMaterialIcons()
      c.header('Cache-Control', 'public, max-age=86400')
      return c.json(manifest)
    })
    .get('/:name', async (c) => {
      const rawName = c.req.param('name')
      if (!rawName || rawName.includes('/') || rawName.includes('\\') || rawName.includes('..')) {
        return c.json({ error: '不正なアイコン名です' }, 404)
      }
      const iconId = rawName.endsWith('.svg') ? rawName.slice(0, -4) : rawName
      const { iconFileMap, iconsDir } = loadMaterialIcons()
      const svgFile = iconFileMap.get(iconId)
      if (!svgFile) {
        return c.json({ error: `アイコンが見つかりません: ${rawName}` }, 404)
      }

      let svg = svgCache.get(svgFile)
      if (!svg) {
        const abs = path.resolve(iconsDir, svgFile)
        if (!abs.startsWith(iconsDir + path.sep)) {
          return c.json({ error: '不正なアイコンパスです' }, 404)
        }
        try {
          svg = await readFile(abs, 'utf-8')
        } catch {
          return c.json({ error: `アイコンの読み込みに失敗しました: ${rawName}` }, 404)
        }
        svgCache.set(svgFile, svg)
      }

      return new Response(svg, {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    })
}
