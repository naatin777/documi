import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runDocsCheck } from '../src/core/checker'
import { loadDocuments } from '../src/core/loader'
import {
  getMediaKind,
  getMediaMimeType,
  isSafeExternalMediaUrl,
  isSupportedLocalMedia,
  resolveLocalMediaPath,
} from '../src/core/media'

const SAMPLE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const SAMPLE_MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32])
const SAMPLE_MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00])

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
})
