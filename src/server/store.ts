import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import path from 'node:path'
import { loadDocuments } from '../core/loader'
import { enrichWithRealization, type RawPullRequest } from '../core/trace'
import type { DocsIndex, DocsMount } from '../core/types'

export type IndexListener = (index: DocsIndex) => void

export interface DocsStoreOptions {
  projectRoot?: string
  mounts?: DocsMount[]
  testReportPath?: string
  testReportPaths?: string[]
  fetchPrs?: boolean
  pullRequests?: RawPullRequest[]
  /** false のときコード走査 (realization) をスキップ */
  enrichTrace?: boolean
}

/**
 * DocsIndex を保持し、ファイルシステムの変更を監視して自動リロード・通知するストア。
 */
export class DocsStore {
  private index: DocsIndex
  private listeners = new Set<IndexListener>()
  private reloading: Promise<DocsIndex> | null = null
  private pendingReload: Promise<DocsIndex> | null = null
  public readonly projectRoot: string

  private constructor(
    public readonly rootDir: string,
    initial: DocsIndex,
    private readonly options: DocsStoreOptions = {},
  ) {
    this.index = initial
    this.projectRoot = path.resolve(options.projectRoot ?? path.dirname(rootDir))
  }

  static async open(rootDir: string, options: DocsStoreOptions = {}): Promise<DocsStore> {
    const index = await loadDocuments(rootDir, { mounts: options.mounts })
    const projectRoot = path.resolve(options.projectRoot ?? path.dirname(index.rootDir))
    if (options.enrichTrace !== false) {
      await enrichWithRealization(index, {
        projectRoot,
        testReportPath: options.testReportPath,
        testReportPaths: options.testReportPaths,
        fetchPrs: options.fetchPrs,
        pullRequests: options.pullRequests,
      })
    }
    return new DocsStore(index.rootDir, index, options)
  }

  static fromIndex(index: DocsIndex, options: DocsStoreOptions = {}): DocsStore {
    return new DocsStore(index.rootDir, index, options)
  }

  getIndex(): DocsIndex {
    return this.index
  }

  async reload(): Promise<DocsIndex> {
    if (this.reloading) {
      // リロード中に起きた変更を取りこぼさないよう、実行中の完了後にもう 1 回だけ追従リロードする
      this.pendingReload ??= this.reloading
        .catch(() => undefined)
        .then(() => {
          this.pendingReload = null
          return this.reload()
        })
      return this.pendingReload
    }
    const task = (async () => {
      try {
        const next = await loadDocuments(this.rootDir, { mounts: this.options.mounts })
        if (this.options.enrichTrace !== false) {
          await enrichWithRealization(next, {
            projectRoot: this.projectRoot,
            testReportPath: this.options.testReportPath,
            testReportPaths: this.options.testReportPaths,
            fetchPrs: this.options.fetchPrs,
            pullRequests: this.options.pullRequests,
          })
        }
        this.index = next
        for (const listener of this.listeners) {
          try {
            listener(next)
          } catch {
            // 個別リスナーの例外で他の通知を止めない
          }
        }
        return next
      } finally {
        this.reloading = null
      }
    })()
    this.reloading = task
    return task
  }

  subscribe(listener: IndexListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 全マウントの docs ディレクトリを再帰監視し、Markdown / MDX / reviews.json / test-results.xml の変更を自動リロードする。
   */
  watch(debounceMs = 150): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null
    const watchers: FSWatcher[] = []

    const scheduleReload = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void this.reload()
      }, debounceMs)
    }

    const dirsToWatch = this.index.mounts.length > 0 ? this.index.mounts.map((m) => m.dir) : [this.rootDir]
    for (const dir of new Set(dirsToWatch)) {
      try {
        const w = watch(dir, { recursive: true }, (_event, filename) => {
          if (filename && shouldIgnorePath(filename)) return
          scheduleReload()
        })
        watchers.push(w)
      } catch (error) {
        // recursive watch 非対応環境でもサーバー起動は継続するが、自動リロードされない旨は通知する
        console.warn(
          `File watching is unavailable for ${dir}; documents will not reload automatically: ${String(error)}`,
        )
      }
    }

    // プロジェクトルート直下・設定済みの JUnit XML 出力ディレクトリ更新も追従する
    const reportCandidates =
      this.options.testReportPaths && this.options.testReportPaths.length > 0
        ? this.options.testReportPaths
        : [this.options.testReportPath ?? path.join(this.projectRoot, '.documi/test-results.xml')]
    const watchedReportDirs = new Set<string>()
    for (const reportFile of reportCandidates) {
      const reportDir = path.dirname(reportFile)
      if (watchedReportDirs.has(reportDir)) continue
      watchedReportDirs.add(reportDir)
      try {
        const rw = watch(reportDir, (_event, filename) => {
          if (filename && !filename.endsWith('.xml')) return
          scheduleReload()
        })
        watchers.push(rw)
      } catch {
        // ディレクトリがまだ存在しない場合は監視しない
      }
    }

    return () => {
      if (timer) clearTimeout(timer)
      for (const w of watchers) w.close()
    }
  }
}

function shouldIgnorePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/')
  if (
    normalized === 'guard/reviews.json' ||
    normalized.endsWith('/guard/reviews.json') ||
    normalized === '.documi/test-results.xml' ||
    normalized.endsWith('/.documi/test-results.xml')
  ) {
    return false
  }
  const parts = normalized.split('/')
  if (parts.some((p) => p.startsWith('.') || p === 'node_modules')) return true
  const last = parts[parts.length - 1] ?? ''
  if (last.includes('.') && !/\.(mdx|md)$/i.test(last)) return true
  return false
}
