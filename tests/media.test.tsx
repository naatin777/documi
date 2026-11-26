import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { runDocsCheck } from '../src/core/checker'
import { loadDocuments } from '../src/core/loader'
import {
  getMediaKind,
  getMediaMimeType,
  isSafeExternalMediaUrl,
  isSupportedLocalMedia,
  resolveLocalMediaPath,
} from '../src/core/media'
import { createApp } from '../src/server/app'
import { buildStaticSite } from '../src/server/site'
import { parseMarkdown, renderMarkdown } from '../src/web/mdast'

const SAMPLE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const SAMPLE_MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32])
const SAMPLE_MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00])
const SAMPLE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>'

describe('media utilities', () => {
  test('[core.document-model] classifies image, video, and audio extensions and MIME types', () => {
    expect(getMediaKind('./diagram.png')).toBe('image')
    expect(getMediaKind('./walkthrough.mp4?t=1')).toBe('video')
    expect(getMediaKind('./clip.WEBM')).toBe('video')
    expect(getMediaKind('./narration.mp3')).toBe('audio')
    expect(getMediaKind('./voice.m4a#t=10')).toBe('audio')
    expect(getMediaKind('https://example.com/avatar')).toBe('image')

    expect(getMediaMimeType('assets/diagram.png')).toBe('image/png')
    expect(getMediaMimeType('assets/diagram.svg')).toBe('image/svg+xml')
    expect(getMediaMimeType('assets/demo.mp4')).toBe('video/mp4')
    expect(getMediaMimeType('assets/note.mp3')).toBe('audio/mpeg')
    expect(getMediaMimeType('specs/doc.mdx')).toBeUndefined()
    expect(isSupportedLocalMedia('assets/demo.webm')).toBe(true)
    expect(isSupportedLocalMedia('.env')).toBe(false)
  })

  test('[core.document-model] resolves relative media paths and blocks docs/ escapes', () => {
    expect(resolveLocalMediaPath('./img/a.png', 'specs/ui')).toEqual({ ok: true, relPath: 'specs/ui/img/a.png' })
    expect(resolveLocalMediaPath('../assets/demo.mp4', 'specs/ui')).toEqual({
      ok: true,
      relPath: 'specs/assets/demo.mp4',
    })
    expect(resolveLocalMediaPath('/assets/logo.svg', 'specs/ui')).toEqual({ ok: true, relPath: 'assets/logo.svg' })
    expect(resolveLocalMediaPath('../../secret.png', 'specs')).toEqual({ ok: false, reason: 'outside-docs' })
    expect(resolveLocalMediaPath('../guard/reviews.json', 'specs')).toEqual({ ok: false, reason: 'outside-docs' })
    expect(resolveLocalMediaPath('./.hidden/a.png', 'specs')).toEqual({ ok: false, reason: 'outside-docs' })
    expect(resolveLocalMediaPath('https://example.com/a.png', 'specs')).toEqual({ ok: false, reason: 'external' })
    expect(resolveLocalMediaPath('javascript:alert(1)', 'specs')).toEqual({ ok: false, reason: 'external' })
    expect(isSafeExternalMediaUrl('https://example.com/a.png')).toBe(true)
    expect(isSafeExternalMediaUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    expect(isSafeExternalMediaUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
    expect(isSafeExternalMediaUrl('javascript:alert(1)')).toBe(false)
  })
})

describe('local media validation & API serving', () => {
  test('[core.document-model] validates local media links and reports broken-media issues', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'documi-media-check-'))
    const docsDir = path.join(tmp, 'docs')
    try {
      await mkdir(path.join(docsDir, 'goals'), { recursive: true })
      await mkdir(path.join(docsDir, 'specs', 'assets'), { recursive: true })
      await writeFile(path.join(tmp, 'outside.png'), SAMPLE_PNG)
      await writeFile(path.join(docsDir, 'specs', 'assets', 'ok.png'), SAMPLE_PNG)
      await writeFile(path.join(docsDir, 'specs', 'assets', 'demo.mp4'), SAMPLE_MP4)
      await writeFile(path.join(docsDir, 'specs', 'assets', 'voice.mp3'), SAMPLE_MP3)
      await symlink(path.join(tmp, 'outside.png'), path.join(docsDir, 'specs', 'assets', 'escape.png'))

      await writeFile(
        path.join(docsDir, 'goals', 'main.mdx'),
        '---\ntype: goal\ntitle: Main Goal\n---\n\n# Main Goal\n',
      )
      await writeFile(
        path.join(docsDir, 'specs', 'valid.mdx'),
        `---
type: spec
title: Valid Media
derives: [goals/main]
---

![diagram](./assets/ok.png)
![demo](./assets/demo.mp4)
![audio](./assets/voice.mp3)
![remote](https://example.com/remote.png)
`,
      )
      await writeFile(
        path.join(docsDir, 'specs', 'broken.mdx'),
        `---
type: spec
title: Broken Media
derives: [goals/main]
---

![missing](./assets/missing.png)
![escape](../../outside.png)
![symlink](./assets/escape.png)
![unsupported](./valid.mdx)
![xss](javascript:alert(1))
`,
      )

      const index = await loadDocuments(docsDir)
      const validDoc = index.byId.get('specs/valid')!
      expect(validDoc.issues.filter((i) => i.code === 'broken-media')).toHaveLength(0)

      const brokenDoc = index.byId.get('specs/broken')!
      const mediaIssues = brokenDoc.issues.filter((i) => i.code === 'broken-media')
      expect(mediaIssues).toHaveLength(5)

      const check = await runDocsCheck({ docsDir, projectRoot: tmp })
      expect(check.ok).toBe(false)
      expect(check.errors.filter((e) => e.code === 'broken-media')).toHaveLength(5)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('[ui.web-viewer] serves local media with nosniff, SVG sandbox CSP, HTTP Range, and boundary checks', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'documi-media-api-'))
    const docsDir = path.join(tmp, 'docs')
    try {
      await mkdir(path.join(docsDir, 'assets'), { recursive: true })
      await writeFile(path.join(tmp, 'secret.png'), SAMPLE_PNG)
      await writeFile(path.join(docsDir, 'assets', 'pic.png'), SAMPLE_PNG)
      await writeFile(path.join(docsDir, 'assets', 'icon.svg'), SAMPLE_SVG)
      await writeFile(path.join(docsDir, 'assets', 'demo.mp4'), SAMPLE_MP4)
      await writeFile(path.join(docsDir, 'guide.mdx'), '---\ntype: guide\ntitle: Guide\n---\n\n# Guide\n')
      await symlink(path.join(tmp, 'secret.png'), path.join(docsDir, 'assets', 'link.png'))

      const index = await loadDocuments(docsDir)
      const app = createApp(index, { projectRoot: tmp })

      // PNG 200
      const pngRes = await app.request('/api/media/assets/pic.png')
      expect(pngRes.status).toBe(200)
      expect(pngRes.headers.get('content-type')).toBe('image/png')
      expect(pngRes.headers.get('x-content-type-options')).toBe('nosniff')
      expect(pngRes.headers.get('accept-ranges')).toBe('bytes')
      expect(new Uint8Array(await pngRes.arrayBuffer())).toEqual(SAMPLE_PNG)

      // SVG has sandbox CSP
      const svgRes = await app.request('/api/media/assets/icon.svg')
      expect(svgRes.status).toBe(200)
      expect(svgRes.headers.get('content-type')).toBe('image/svg+xml')
      expect(svgRes.headers.get('content-security-policy')).toBe('sandbox')

      // MP4 HTTP Range 206
      const rangeRes = await app.request('/api/media/assets/demo.mp4', {
        headers: { Range: 'bytes=0-3' },
      })
      expect(rangeRes.status).toBe(206)
      expect(rangeRes.headers.get('content-range')).toBe(`bytes 0-3/${SAMPLE_MP4.length}`)
      expect(rangeRes.headers.get('content-length')).toBe('4')
      expect(new Uint8Array(await rangeRes.arrayBuffer())).toEqual(SAMPLE_MP4.slice(0, 4))

      // Invalid Range 416
      const badRangeRes = await app.request('/api/media/assets/demo.mp4', {
        headers: { Range: 'bytes=999-1000' },
      })
      expect(badRangeRes.status).toBe(416)

      // Rejects non-media extension, traversal, symlink escape, missing
      const mdxRes = await app.request('/api/media/guide.mdx')
      expect(mdxRes.status).toBe(403)

      const traversalRes = await app.request('/api/media/assets/..%2F..%2Fsecret.png')
      expect(traversalRes.status).toBe(403)

      const guardRes = await app.request('/api/media/guard/reviews.json')
      expect(guardRes.status).toBe(403)

      const symlinkRes = await app.request('/api/media/assets/link.png')
      expect(symlinkRes.status).toBe(403)

      const missingRes = await app.request('/api/media/assets/nope.png')
      expect(missingRes.status).toBe(404)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test('[ui.web-viewer] renders local image, video, and audio in mdast and blocks unsafe URLs', () => {
    const md = `
![Screen](./img/screen.png "Preview")

![Walkthrough](../media/demo.mp4)

![Voice](./audio/clip.mp3)

![RefImg][shot]

![Bad](javascript:alert(1))

[shot]: ./img/ref.webp
`
    const tree = parseMarkdown(md, 'mdx')
    const html = renderToStaticMarkup(<MemoryRouter>{renderMarkdown(tree, { currentDir: 'specs/ui' })}</MemoryRouter>)

    expect(html).toContain('<img class="md-media md-image" src="/api/media/specs/ui/img/screen.png"')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('<video class="md-media md-video" src="/api/media/specs/media/demo.mp4"')
    expect(html).toContain('controls=""')
    expect(html).toContain('<audio class="md-media md-audio" src="/api/media/specs/ui/audio/clip.mp3"')
    expect(html).toContain('src="/api/media/specs/ui/img/ref.webp"')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('class="md-broken-ref"')
  })

  test('[ui.web-viewer] bundles local media files into outDir/media/ during buildStaticSite', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'documi-media-site-'))
    const docsDir = path.join(tmp, 'docs')
    const clientDist = path.join(tmp, 'client-dist')
    const outDir = path.join(tmp, 'out-site')
    try {
      await mkdir(path.join(docsDir, 'assets'), { recursive: true })
      await mkdir(clientDist, { recursive: true })
      await writeFile(path.join(clientDist, 'index.html'), '<!doctype html><html><head></head><body></body></html>')
      await writeFile(
        path.join(docsDir, 'guide.mdx'),
        '---\ntype: guide\ntitle: Guide\n---\n\n![pic](./assets/pic.png)\n',
      )
      await writeFile(path.join(docsDir, 'assets', 'pic.png'), SAMPLE_PNG)
      await writeFile(path.join(docsDir, 'assets', 'demo.mp4'), SAMPLE_MP4)

      const result = await buildStaticSite({
        docsDir,
        projectRoot: tmp,
        outDir,
        clientDist,
        includeCode: false,
      })

      expect(result.mediaFileCount).toBe(2)
      expect(existsSync(path.join(outDir, 'media', 'assets', 'pic.png'))).toBe(true)
      expect(existsSync(path.join(outDir, 'media', 'assets', 'demo.mp4'))).toBe(true)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
