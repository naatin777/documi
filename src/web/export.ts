/**
 * ブラウザ上で描画済みのドキュメントを書き出す。
 * Mermaid / Shiki / KaTeX は描画後の DOM をそのまま複製するため、出力 HTML にも反映される。
 */

/** 書き出す対象 (DocViewer / GlossaryLayout の共通ルート) */
const DOCUMENT_SELECTOR = '.doc-page'

/** 同一オリジンの stylesheet をすべて集める (dev の <style> と本番の <link> の両方に対応) */
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

function buildHtml(): string | null {
  const source = document.querySelector<HTMLElement>(DOCUMENT_SELECTOR)
  if (!source) return null

  const clone = source.cloneNode(true) as HTMLElement
  // 操作系の要素は出力しない (印刷・書き出しボタン、コピーボタン、タブなど)
  for (const el of clone.querySelectorAll('button, .doc-tabs, .codeblock-toolbar')) el.remove()

  const title = source.querySelector('h1')?.textContent?.trim() || 'Documi'
  const description = source.querySelector('.doc-description')?.textContent?.trim()
  const css = collectCss()
  return [
    '<!doctype html>',
    `<html lang="ja" data-theme="${escapeHtml(document.documentElement.dataset.theme ?? 'light')}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} — Documi</title>`,
    description ? `<meta name="description" content="${escapeHtml(description)}">` : '',
    `<style>\n${css}\n</style>`,
    '</head>',
    '<body class="documi-export">',
    clone.outerHTML,
    '</body>',
    '</html>',
  ].join('\n')
}

/** 現在表示中の文書を HTML ファイルとしてダウンロードする。対象が無い場合は false。 */
export function exportDocumentHtml(): boolean {
  const html = buildHtml()
  if (!html) return false
  downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${baseFileName()}.html`)
  return true
}

/**
 * 描画済み HTML をサーバー (headless Chrome) に渡して PDF をダウンロードする。
 * Chrome が無い等で失敗した場合は false を返すので、呼び出し側で HTML 出力へフォールバックする。
 */
export async function exportDocumentPdf(): Promise<boolean> {
  const html = buildHtml()
  if (!html) return false
  try {
    const res = await fetch('/api/export/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, filename: baseFileName() }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(body.error ?? `${res.status} ${res.statusText}`)
    }
    downloadBlob(await res.blob(), `${baseFileName()}.pdf`)
    return true
  } catch (error) {
    console.warn('PDF の書き出しに失敗しました', error)
    return false
  }
}

/** ブラウザの印刷ダイアログを開く (PDF 保存はここから行う) */
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

function baseFileName(): string {
  const title = document.querySelector('.doc-page h1')?.textContent?.trim() || 'documi'
  const safe = title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 80)
  return safe || 'documi'
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
