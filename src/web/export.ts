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

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName()
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}

/** ブラウザの印刷ダイアログを開く (PDF 保存はここから行う) */
export function printDocument(): void {
  window.print()
}

function fileName(): string {
  const title = document.querySelector('.doc-page h1')?.textContent?.trim() || 'documi'
  const safe = title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 80)
  return `${safe || 'documi'}.html`
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
