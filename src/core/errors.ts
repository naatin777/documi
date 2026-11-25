import { TaggedError } from 'better-result'

// ---------------------------------------------------------------------------
// Review domain errors (no HTTP status codes in src/core)
// ---------------------------------------------------------------------------

export class BlockNotFoundError extends TaggedError('BlockNotFoundError')<{
  blockId: string
  message: string
}> {}

export class DocumentNotFoundError extends TaggedError('DocumentNotFoundError')<{
  docId: string
  message: string
}> {}

export type ReviewDomainError = BlockNotFoundError | DocumentNotFoundError

// ---------------------------------------------------------------------------
// Source & Code Explorer domain errors (no HTTP status codes in src/core)
// ---------------------------------------------------------------------------

export class InvalidSourcePathError extends TaggedError('InvalidSourcePathError')<{
  file: string
  message: string
}> {}

export class PathOutsideRootError extends TaggedError('PathOutsideRootError')<{
  file: string
  reason: 'traversal' | 'symlink'
  message: string
}> {}

export class SourceFileNotFoundError extends TaggedError('SourceFileNotFoundError')<{
  file: string
  message: string
}> {}

export class NotAFileError extends TaggedError('NotAFileError')<{
  file: string
  message: string
}> {}

export class FileTooLargeError extends TaggedError('FileTooLargeError')<{
  file: string
  maxBytes: number
  actualBytes: number
  message: string
}> {}

export class BinaryFileError extends TaggedError('BinaryFileError')<{
  file: string
  message: string
}> {}

export class UnsupportedExtensionError extends TaggedError('UnsupportedExtensionError')<{
  file: string
  ext: string
  message: string
}> {}

export class InvalidLineRangeError extends TaggedError('InvalidLineRangeError')<{
  file: string
  lines: string
  message: string
}> {}

export class InvalidSymbolQueryError extends TaggedError('InvalidSymbolQueryError')<{
  file: string
  message: string
}> {}

export class AstParseError extends TaggedError('AstParseError')<{
  file: string
  language: string
  message: string
}> {}

export class SymbolNotFoundError extends TaggedError('SymbolNotFoundError')<{
  file: string
  symbol: string
  candidates: string[]
  message: string
}> {}

export class AmbiguousSymbolError extends TaggedError('AmbiguousSymbolError')<{
  file: string
  symbol: string
  matches: string[]
  message: string
}> {}

export type LoadSourceError =
  | InvalidSourcePathError
  | PathOutsideRootError
  | SourceFileNotFoundError
  | NotAFileError
  | FileTooLargeError
  | BinaryFileError

export type ResolveLinesError = LoadSourceError | UnsupportedExtensionError | InvalidLineRangeError

export type ResolveSymbolError =
  | LoadSourceError
  | UnsupportedExtensionError
  | InvalidSymbolQueryError
  | AstParseError
  | SymbolNotFoundError
  | AmbiguousSymbolError

export type ExtractExportsError = LoadSourceError | UnsupportedExtensionError

export type ReadCodeFileError = LoadSourceError | UnsupportedExtensionError

export type SourceDomainError = ResolveLinesError | ResolveSymbolError | ExtractExportsError | ReadCodeFileError

// ---------------------------------------------------------------------------
// Frontmatter domain errors
// ---------------------------------------------------------------------------

export class UnclosedFrontmatterError extends TaggedError('UnclosedFrontmatterError')<{
  message: string
}> {}

export class FrontmatterParseError extends TaggedError('FrontmatterParseError')<{
  message: string
}> {}

export type FrontmatterDomainError = UnclosedFrontmatterError | FrontmatterParseError

// ---------------------------------------------------------------------------
// Project config domain errors
// ---------------------------------------------------------------------------

export class ConfigReadError extends TaggedError('ConfigReadError')<{
  configPath: string
  message: string
}> {}

export class ConfigParseError extends TaggedError('ConfigParseError')<{
  configPath: string
  message: string
}> {}

export class ConfigValidationError extends TaggedError('ConfigValidationError')<{
  configPath: string
  message: string
}> {}

export type ConfigDomainError = ConfigReadError | ConfigParseError | ConfigValidationError

// ---------------------------------------------------------------------------
// Git history domain errors
// ---------------------------------------------------------------------------

export class InvalidCommitShaError extends TaggedError('InvalidCommitShaError')<{
  commitSha: string
  message: string
}> {}

export class GitRepoUnavailableError extends TaggedError('GitRepoUnavailableError')<{
  message: string
}> {}

export class CommitNotFoundError extends TaggedError('CommitNotFoundError')<{
  commitSha: string
  message: string
}> {}

export class DocumentNotInCommitError extends TaggedError('DocumentNotInCommitError')<{
  commitSha: string
  docPath: string
  message: string
}> {}

export type HistoryDomainError =
  | InvalidCommitShaError
  | GitRepoUnavailableError
  | CommitNotFoundError
  | DocumentNotInCommitError

// ---------------------------------------------------------------------------
// Surgical editor domain errors
// ---------------------------------------------------------------------------

export class InvalidDocPathError extends TaggedError('InvalidDocPathError')<{
  path: string
  message: string
}> {}

export class ProtectedPathWriteError extends TaggedError('ProtectedPathWriteError')<{
  path: string
  message: string
}> {}

export class DocPathOutsideRootError extends TaggedError('DocPathOutsideRootError')<{
  path: string
  reason: 'traversal' | 'symlink'
  message: string
}> {}

export class UnsafeMdxError extends TaggedError('UnsafeMdxError')<{
  docId: string
  message: string
}> {}

export class InvalidEditInputError extends TaggedError('InvalidEditInputError')<{
  message: string
}> {}

export class EditTargetNotFoundError extends TaggedError('EditTargetNotFoundError')<{
  target: string
  message: string
}> {}

export class EditConflictError extends TaggedError('EditConflictError')<{
  target: string
  message: string
}> {}

export type EditDomainError =
  | InvalidDocPathError
  | ProtectedPathWriteError
  | DocPathOutsideRootError
  | UnsafeMdxError
  | InvalidEditInputError
  | EditTargetNotFoundError
  | EditConflictError
  | FrontmatterDomainError

// ---------------------------------------------------------------------------
// Embedding / Hybrid RAG domain errors
// ---------------------------------------------------------------------------

export class EmbeddingInitError extends TaggedError('EmbeddingInitError')<{
  provider: string
  model: string
  message: string
}> {}

export class EmbeddingRequestError extends TaggedError('EmbeddingRequestError')<{
  provider: string
  model: string
  status?: number
  message: string
}> {}

export class EmbeddingResponseError extends TaggedError('EmbeddingResponseError')<{
  provider: string
  model: string
  message: string
}> {}

export type EmbeddingDomainError = EmbeddingInitError | EmbeddingRequestError | EmbeddingResponseError
