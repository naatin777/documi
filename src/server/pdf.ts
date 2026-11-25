const MAX_HTML_BYTES = 5 * 1024 * 1024
const DEFAULT_BUNDLE_TIMEOUT_MS = 15000

export class PdfError extends Error {
  constructor(
    message: string,
    public status = 500,
  ) {
    super(message)
    this.name = 'PdfError'
  }
}

function createChromeWebView(): InstanceType<typeof Bun.WebView> {
  if (typeof Bun.WebView === 'undefined') {
    throw new PdfError('Bun.WebView is not available (requires Bun 1.3.12 or later)', 501)
  }
  try {
    return new Bun.WebView({ backend: 'chrome' })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new PdfError(`Failed to launch Chrome backend: ${detail} (requires BUN_CHROME_PATH or Chrome installed)`, 501)
  }
}

function assertLoopbackBundleUrl(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new PdfError(`Invalid URL: ${rawUrl}`, 400)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new PdfError('Only http / https URLs are allowed', 400)
  }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) {
    throw new PdfError('PDF generation is only allowed for localhost /bundle URLs', 403)
  }
  if (!parsed.pathname.startsWith('/bundle')) {
    throw new PdfError('Only /bundle paths are allowed', 400)
  }
  return parsed
}

async function waitForBundleReady(view: InstanceType<typeof Bun.WebView>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await view.evaluate('Boolean(window.__DOCUMI_BUNDLE_READY__)')
    if (ready === true) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new PdfError('Timed out waiting for bundle render completion', 504)
}

/**
 * 描画済み HTML を Bun.WebView (Chrome backend) の CDP で PDF にする (単体文書用)。
 */
export async function renderPdf(html: string): Promise<Uint8Array> {
  if (typeof html !== 'string' || html.trim() === '') {
    throw new PdfError('html is required', 400)
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new PdfError(`HTML exceeds size limit (max ${MAX_HTML_BYTES / 1024 / 1024}MB)`, 413)
  }

  const view = createChromeWebView()
  try {
    await view.navigate('about:blank')
    const safeHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    await view.evaluate(`(() => { document.open(); document.write(${JSON.stringify(safeHtml)}); document.close(); })()`)

    const result = await view.cdp<{ data?: string }>('Page.printToPDF', {
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: true,
    })
    if (!result?.data) throw new PdfError('Failed to obtain PDF data', 500)
    return new Uint8Array(Buffer.from(result.data, 'base64'))
  } catch (error) {
    if (error instanceof PdfError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new PdfError(`Failed to generate PDF: ${detail}`, 500)
  } finally {
    view.close()
  }
}

/**
 * ローカルサーバーの /bundle URL を Bun.WebView で直接開き、
 * Mermaid / Shiki / SourceRef の描画完了後に PDF を生成する (複数文書まとめ Export / CLI 用)。
 */
export async function renderPdfFromUrl(rawUrl: string, options: { timeoutMs?: number } = {}): Promise<Uint8Array> {
  const url = assertLoopbackBundleUrl(rawUrl)
  const view = createChromeWebView()
  try {
    await view.navigate(url.toString())
    await waitForBundleReady(view, options.timeoutMs ?? DEFAULT_BUNDLE_TIMEOUT_MS)

    const result = await view.cdp<{ data?: string }>('Page.printToPDF', {
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: true,
    })
    if (!result?.data) throw new PdfError('Failed to obtain PDF data', 500)
    return new Uint8Array(Buffer.from(result.data, 'base64'))
  } catch (error) {
    if (error instanceof PdfError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new PdfError(`Failed to generate bundle PDF: ${detail}`, 500)
  } finally {
    view.close()
  }
}

/**
 * ローカルサーバーの /bundle URL を Bun.WebView で開き、
 * CSS・描画済み SVG/HTML をすべてインライン化した単一 HTML 文字列を抽出する (CLI HTML Export 用)。
 */
export async function renderStandaloneHtmlFromUrl(
  rawUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const url = assertLoopbackBundleUrl(rawUrl)
  const view = createChromeWebView()
  try {
    await view.navigate(url.toString())
    await waitForBundleReady(view, options.timeoutMs ?? DEFAULT_BUNDLE_TIMEOUT_MS)

    const html = await view.evaluate(`(() => {
      const root = document.querySelector('.bundle-root');
      if (!root) return '';
      const clone = root.cloneNode(true);
      for (const el of clone.querySelectorAll('button, .bundle-toolbar, .codeblock-toolbar, .term-popover')) el.remove();
      const chunks = [];
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) chunks.push(rule.cssText);
        } catch {}
      }
      const title = document.title || 'Documi Bundle';
      const theme = document.documentElement.dataset.theme || 'light';
      return '<!doctype html>\\n<html lang="ja" data-theme="' + theme + '">\\n<head>\\n<meta charset="utf-8">\\n<meta name="viewport" content="width=device-width, initial-scale=1">\\n<title>' + title.replace(/</g, '&lt;') + '</title>\\n<style>\\n' + chunks.join('\\n') + '\\n</style>\\n</head>\\n<body class="documi-export documi-bundle-export">\\n' + clone.outerHTML + '\\n</body>\\n</html>';
    })()`)

    if (typeof html !== 'string' || !html) {
      throw new PdfError('Failed to extract bundle HTML', 500)
    }
    return html
  } catch (error) {
    if (error instanceof PdfError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new PdfError(`Failed to generate bundle HTML: ${detail}`, 500)
  } finally {
    view.close()
  }
}
