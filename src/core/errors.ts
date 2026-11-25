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
