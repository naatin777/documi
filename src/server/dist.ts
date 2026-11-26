import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * ビルド済みフロントエンド (`dist/`) の既定パスを解決する。
 * `bun build --compile` で生成された単一バイナリ実行時は実行ファイルと同階層の `dist/` を優先し、
 * ソース実行時はリポジトリルートの `dist/` へフォールバックする。
 */
export function resolveDefaultClientDist(): string {
  const besideExe = path.resolve(path.dirname(process.execPath), 'dist')
  if (existsSync(path.join(besideExe, 'index.html'))) {
    return besideExe
  }
  return path.resolve(import.meta.dir, '../../dist')
}
