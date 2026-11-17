const MAX_HTML_BYTES = 5 * 1024 * 1024

export class PdfError extends Error {
  constructor(
    message: string,
    public status = 500,
  ) {
    super(message)
    this.name = 'PdfError'
  }
}

/**
 * 描画済み HTML を Bun.WebView (Chrome backend) の CDP で PDF にする。
 * cli の spawn や一時ファイルが不要で、Bun がブラウザプロセスの寿命を管理する。
 * HTML はクライアント側で Mermaid / Shiki の描画が済んだものを想定する。
 */
export async function renderPdf(html: string): Promise<Uint8Array> {
  if (typeof html !== 'string' || html.trim() === '') {
    throw new PdfError('html が必要です', 400)
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new PdfError(`HTML が大きすぎます (上限 ${MAX_HTML_BYTES / 1024 / 1024}MB)`, 413)
  }
  if (typeof Bun.WebView === 'undefined') {
    throw new PdfError('Bun.WebView が利用できません (Bun 1.3.12 以上が必要です)', 501)
  }

  let view: InstanceType<typeof Bun.WebView>
  try {
    view = new Bun.WebView({ backend: 'chrome' })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new PdfError(
      `Chrome backend を起動できません: ${detail} (BUN_CHROME_PATH または Chrome のインストールが必要です)`,
      501,
    )
  }

  try {
    await view.navigate('about:blank')
    // 念のため script は除去して実行させない
    const safeHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    await view.evaluate(`(() => { document.open(); document.write(${JSON.stringify(safeHtml)}); document.close(); })()`)

    const result = (await view.cdp('Page.printToPDF', {
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: true,
    })) as { data?: string }
    if (!result?.data) throw new PdfError('PDF データが取得できませんでした', 500)
    return new Uint8Array(Buffer.from(result.data, 'base64'))
  } catch (error) {
    if (error instanceof PdfError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new PdfError(`PDF の生成に失敗しました: ${detail}`, 500)
  } finally {
    view.close()
  }
}
