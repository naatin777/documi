import { matchError } from 'better-result'
import type { HistoryDomainError, ReadCodeFileError, ReviewDomainError, SourceDomainError } from '../core/errors'
import type { ErrorStatusCode } from './validator'

export interface HttpErrorResponse {
  status: ErrorStatusCode
  body: { error: string }
}

/** Review ドメインエラーを網羅的に HTTP ステータスへ変換する */
export function reviewErrorToHttp(error: ReviewDomainError): HttpErrorResponse {
  const status: ErrorStatusCode = matchError(error, {
    BlockNotFoundError: () => 404 as const,
    DocumentNotFoundError: () => 404 as const,
  })
  return { status, body: { error: error.message } }
}

/** Git 履歴ドメインエラーを網羅的に HTTP ステータスへ変換する */
export function historyErrorToHttp(error: HistoryDomainError): HttpErrorResponse {
  const status: ErrorStatusCode = matchError(error, {
    InvalidCommitShaError: () => 400 as const,
    GitRepoUnavailableError: () => 404 as const,
    CommitNotFoundError: () => 404 as const,
    DocumentNotInCommitError: () => 404 as const,
  })
  return { status, body: { error: error.message } }
}

/** Source 抽出エンドポイント (/api/source, /api/source/exports) 向けの網羅的 HTTP 変換 */
export function sourceErrorToHttp(error: SourceDomainError): HttpErrorResponse {
  const status: ErrorStatusCode = matchError(error, {
    InvalidSourcePathError: () => 400 as const,
    PathOutsideRootError: (e) => (e.reason === 'symlink' ? (403 as const) : (400 as const)),
    SourceFileNotFoundError: () => 404 as const,
    NotAFileError: () => 400 as const,
    FileTooLargeError: () => 413 as const,
    BinaryFileError: () => 400 as const,
    UnsupportedExtensionError: () => 400 as const,
    InvalidLineRangeError: () => 400 as const,
    InvalidSymbolQueryError: () => 400 as const,
    AstParseError: () => 422 as const,
    SymbolNotFoundError: () => 404 as const,
    AmbiguousSymbolError: () => 409 as const,
  })
  return { status, body: { error: error.message } }
}

/** Code Explorer (/api/code/file) 向けの網羅的 HTTP 変換（境界違反は常に 403、サイズ超過は 400） */
export function codeFileErrorToHttp(error: ReadCodeFileError): HttpErrorResponse {
  const status: ErrorStatusCode = matchError(error, {
    InvalidSourcePathError: () => 400 as const,
    PathOutsideRootError: () => 403 as const,
    SourceFileNotFoundError: () => 404 as const,
    NotAFileError: () => 400 as const,
    FileTooLargeError: () => 400 as const,
    BinaryFileError: () => 400 as const,
    UnsupportedExtensionError: () => 400 as const,
  })
  return { status, body: { error: error.message } }
}
