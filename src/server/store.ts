import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import path from 'node:path'
import { loadDocuments } from '../core/loader'
import { enrichWithRealization, type RawPullRequest } from '../core/trace'
import type { DocsIndex } from '../core/types'

export type IndexListener = (index: DocsIndex) => void

export interface DocsStoreOptions {
  projectRoot?: string
  testReportPath?: string
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
    const index = await loadDocuments(rootDir)
    const projectRoot = path.resolve(options.projectRoot ?? path.dirname(index.rootDir))
    if (options.enrichTrace !== false) {
      await enrichWithRealization(index, {
        projectRoot,
        testReportPath: options.testReportPath,
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
    if (this.reloading) return this.reloading
    const task = (async () => {
      try {
        const next = await loadDocuments(this.rootDir)
        if (this.options.enrichTrace !== false) {
          await enrichWithRealization(next, {
            projectRoot: this.projectRoot,
            testReportPath: this.options.testReportPath,
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
   * docs ディレクトリを再帰監視し、Markdown / MDX / reviews.json / test-results.xml の変更を自動リロードする。
   */
  watch(debounceMs = 150): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null
    let watcher: FSWatcher | null = null

    const scheduleReload = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void this.reload()
      }, debounceMs)
    }

    try {
      watcher = watch(this.rootDir, { recursive: true }, (_event, filename) => {
        if (filename && shouldIgnorePath(filename)) return
        scheduleReload()
      })
    } catch {
      // recursive watch 非対応環境でもサーバー起動は継続する
    }

    return () => {
      if (timer) clearTimeout(timer)
      watcher?.close()
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
