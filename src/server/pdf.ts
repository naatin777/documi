import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_HTML_BYTES = 5 * 1024 * 1024
const CHROME_TIMEOUT_MS = 5000

export class PdfError extends Error {
  constructor(
    message: string,
    public status = 500,
  ) {
    super(message)
    this.name = 'PdfError'
  }
}

/** PDF 生成に使う Chrome のパスを解決する */
function findChrome(): string | null {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH

  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = Bun.which(name)
    if (found) return found
  }
  return null
}

/**
 * 描画済みの HTML を headless Chrome で PDF にする。
 * HTML はクライアント側で Mermaid / Shiki の描画が済んだものを想定する。
 */
export async function renderPdf(html: string): Promise<Uint8Array> {
  if (typeof html !== 'string' || html.trim() === '') {
    throw new PdfError('html が必要です', 400)
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new PdfError(`HTML が大きすぎます (上限 ${MAX_HTML_BYTES / 1024 / 1024}MB)`, 413)
  }

  const chrome = findChrome()
  if (!chrome) {
    throw new PdfError('PDF 生成用の Chrome が見つかりません (CHROME_PATH を設定してください)', 501)
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'documi-pdf-'))
  try {
    const input = path.join(dir, 'input.html')
    const output = path.join(dir, 'output.pdf')
    // 自前の書き出し HTML だが、念のため script は除去して実行させない
    const safeHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    await writeFile(input, safeHtml, 'utf8')

    const result = Bun.spawnSync({
      cmd: [
        chrome,
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        `--user-data-dir=${path.join(dir, 'profile')}`,
        '--no-pdf-header-footer',
        `--timeout=${CHROME_TIMEOUT_MS}`,
        `--print-to-pdf=${output}`,
        pathToFileURL(input).href,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    })

    if (!result.success || result.exitCode !== 0) {
      const detail = result.stderr.toString().trim().slice(-500)
      throw new PdfError(`Chrome での PDF 生成に失敗しました${detail ? `: ${detail}` : ''}`, 500)
    }

    try {
      return await readFile(output)
    } catch {
      throw new PdfError('PDF ファイルが生成されませんでした', 500)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
