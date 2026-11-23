/**
 * 単一文書および複数文書バンドルの HTML / PDF / 印刷書き出しユーティリティ。
 */

const DOCUMENT_SELECTOR = '.doc-page'
const BUNDLE_SELECTOR = '.bundle-root'

function collectCss(): string {
  const chunks: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) chunks.push(rule.cssText)
    } catch {
      // クロスオリジンの stylesheet は読み取れないので無視する
    }
  }
  return chunks.join('\n')
}

function buildStandaloneHtml(selector: string, bodyClass: string, fallbackTitle: string): string | null {
  const source = document.querySelector<HTMLElement>(selector)
  if (!source) return null

  const clone = source.cloneNode(true) as HTMLElement
  for (const el of clone.querySelectorAll('button, .bundle-toolbar, .codeblock-toolbar, .sem-feedback-form')) {
    el.remove()
  }

  const title = source.querySelector('h1')?.textContent?.trim() || fallbackTitle
  const description = source.querySelector('.doc-description')?.textContent?.trim()
  const css = collectCss()
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(document.documentElement.lang || 'en')}" data-theme="${escapeHtml(document.documentElement.dataset.theme ?? 'light')}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} — Documi</title>`,
    description ? `<meta name="description" content="${escapeHtml(description)}">` : '',
    `<style>\n${css}\n</style>`,
    '</head>',
    `<body class="${bodyClass}">`,
    clone.outerHTML,
    '</body>',
    '</html>',
  ].join('\n')
}

/** 現在表示中の単一文書を HTML ファイルとしてダウンロードする。 */
export function exportDocumentHtml(): boolean {
  const html = buildStandaloneHtml(DOCUMENT_SELECTOR, 'documi-export', 'Documi')
  if (!html) return false
  downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${baseFileName(DOCUMENT_SELECTOR)}.html`)
  return true
}

/** /bundle 画面で描画済みの複数文書を 1 ファイル完結 HTML としてダウンロードする。 */
export function exportBundleHtmlFromDom(filename?: string): boolean {
  const html = buildStandaloneHtml(BUNDLE_SELECTOR, 'documi-export documi-bundle-export', 'Documi Bundle')
  if (!html) return false
  const name = safeFileName(filename || baseFileName(BUNDLE_SELECTOR))
  downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${name}.html`)
  return true
}

/** 現在表示中の単一文書をサーバー経由で PDF 化する。 */
export async function exportDocumentPdf(): Promise<boolean> {
  const html = buildStandaloneHtml(DOCUMENT_SELECTOR, 'documi-export', 'Documi')
  if (!html) return false
  try {
    const res = await fetch('/api/export/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, filename: baseFileName(DOCUMENT_SELECTOR) }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `${res.status} ${res.statusText}`)
    }
    downloadBlob(await res.blob(), `${baseFileName(DOCUMENT_SELECTOR)}.pdf`)
    return true
  } catch (error) {
    console.warn('PDF の書き出しに失敗しました', error)
    return false
  }
}

export interface BundleExportParams {
  scope?: string
  ids?: string[]
  title?: string
  filename?: string
  action?: 'print' | 'download-html'
}

export function buildBundleUrl(params: BundleExportParams): string {
  const qs = new URLSearchParams()
  if (params.ids && params.ids.length > 0) qs.set('ids', params.ids.join(','))
  else qs.set('scope', params.scope || 'all')
  if (params.title) qs.set('title', params.title)
  if (params.action) qs.set('action', params.action)
  return `/bundle?${qs.toString()}`
}

/** 複数ドキュメントを /bundle 経由でサーバー側 PDF 生成してダウンロードする。 */
export async function exportBundlePdf(params: BundleExportParams): Promise<boolean> {
  try {
    const res = await fetch('/api/export/bundle-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: params.scope,
        ids: params.ids,
        title: params.title,
        filename: params.filename ?? params.title ?? 'documi-bundle',
        baseUrl: window.location.origin,
      }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `${res.status} ${res.statusText}`)
    }
    const name = safeFileName(params.filename ?? params.title ?? 'documi-bundle')
    downloadBlob(await res.blob(), `${name}.pdf`)
    return true
  } catch (error) {
    console.warn('バンドル PDF の書き出しに失敗しました', error)
    return false
  }
}

/** ブラウザの印刷ダイアログを開く */
export function printDocument(): void {
  window.print()
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function baseFileName(selector: string): string {
  const title = document.querySelector(`${selector} h1`)?.textContent?.trim() || 'documi'
  return safeFileName(title)
}

function safeFileName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 80)
  return safe || 'documi'
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
