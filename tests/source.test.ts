import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveSourceLines, resolveSourceSymbol } from '../src/core/source'

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'documi-source-test-'))
  const write = async (rel: string, content: string) => {
    const file = path.join(root, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }

  await write(
    'src/sample.ts',
    [
      '// 日本語コメントを含むファイル (マルチバイト文字のオフセット検証)',
      'export class Registry {',
      '  register(name: string): void {}',
      '  static create(): Registry { return new Registry() }',
      '}',
      '',
      'export function helper(x: number): number {',
      '  return x * 2',
      '}',
      '',
      'namespace Utils {',
      '  export function deep(): void {}',
      '}',
      '',
    ].join('\n'),
  )
  await write(
    'core/registry.go',
    [
      'package main',
      '',
      'type Registry struct{}',
      '',
      'func (r *Registry) Register(name string) {}',
      '',
      'func main() {}',
      '',
    ].join('\n'),
  )
  await write(
    'src/store.rs',
    [
      'pub struct Store;',
      '',
      'impl Store {',
      '    pub fn get(&self) -> i32 { 1 }',
      '}',
      '',
      'fn top_level() {}',
      '',
    ].join('\n'),
  )
  await write(
    'src/app.py',
    ['class Foo:', '    def method(self):', '        pass', '', 'def top():', '    pass', ''].join('\n'),
  )
  await write(
    'src/Sample.java',
    ['public class Sample {', '    public void run() {}', '}', 'interface Iface { void m(); }', ''].join('\n'),
  )
  await write('src/sample.kt', 'class Greeter {\n    fun greet() {}\n}\nfun topLevel() {}\n')
  await write('src/sample.swift', 'class Model {\n    func load() {}\n}\nfunc topLevel() {}\n')
  await write('src/amb.ts', 'class A { run() {} }\nclass B { run() {} }\n')
  await write('notes/readme.txt', 'line1\nline2\nline3\n')
  await write('binary.dat', 'a\0b')
  // ルート外へのシンボリックリンク
  const outsideSecret = path.join(path.dirname(root), `documi-outside-${path.basename(root)}.txt`)
  await writeFile(outsideSecret, 'should-not-leak')
  try {
    await symlink(outsideSecret, path.join(root, 'link-escape.txt'))
  } catch {
    // symlink 非対応環境ではスキップ
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(path.join(path.dirname(root), `documi-outside-${path.basename(root)}.txt`), { force: true })
})

describe('resolveSourceLines', () => {
  test('行範囲を取得する', async () => {
    const r = (await resolveSourceLines(root, 'notes/readme.txt', '2-3')).unwrap()
    expect(r.code).toBe('line2\nline3')
    expect(r.startLine).toBe(2)
    expect(r.endLine).toBe(3)
    expect(r.language).toBe('txt')
  })

  test('単一行を取得する', async () => {
    const r = (await resolveSourceLines(root, 'notes/readme.txt', '1')).unwrap()
    expect(r.code).toBe('line1')
  })

  test('範囲外・不正な形式はエラー', async () => {
    const outOfRange = await resolveSourceLines(root, 'notes/readme.txt', '5-9')
    expect(outOfRange.isErr()).toBe(true)
    if (outOfRange.isErr()) expect(outOfRange.error._tag).toBe('InvalidLineRangeError')

    const badFormat = await resolveSourceLines(root, 'notes/readme.txt', 'abc')
    expect(badFormat.isErr()).toBe(true)
    if (badFormat.isErr()) expect(badFormat.error._tag).toBe('InvalidLineRangeError')
  })

  test('末尾の改行を余分な行として数えない', async () => {
    const r = (await resolveSourceLines(root, 'notes/readme.txt', '2')).unwrap()
    expect(r.totalLines).toBe(3)
    expect(r.code).toBe('line2')
    const out = await resolveSourceLines(root, 'notes/readme.txt', '4')
    expect(out.isErr()).toBe(true)
    if (out.isErr()) expect(out.error._tag).toBe('InvalidLineRangeError')
  })

  test('空ファイルは 0 行として扱う', async () => {
    await writeFile(path.join(root, 'notes/empty.txt'), '')
    const empty = await resolveSourceLines(root, 'notes/empty.txt', '1')
    expect(empty.isErr()).toBe(true)
    if (empty.isErr()) expect(empty.error._tag).toBe('InvalidLineRangeError')
  })

  test('パストラバーサルと絶対パスを拒否する', async () => {
    const rel = await resolveSourceLines(root, '../etc/passwd', '1-1')
    expect(rel.isErr()).toBe(true)
    if (rel.isErr()) expect(rel.error).toMatchObject({ _tag: 'PathOutsideRootError', reason: 'traversal' })

    const abs = await resolveSourceLines(root, '/etc/passwd', '1-1')
    expect(abs.isErr()).toBe(true)
    if (abs.isErr()) expect(abs.error).toMatchObject({ _tag: 'PathOutsideRootError', reason: 'traversal' })
  })

  test('シンボリックリンクのルート外参照を拒否する', async () => {
    const sym = await resolveSourceLines(root, 'link-escape.txt', '1-1')
    expect(sym.isErr()).toBe(true)
    if (sym.isErr()) expect(sym.error).toMatchObject({ _tag: 'PathOutsideRootError', reason: 'symlink' })
  })

  test('存在しないファイル・バイナリ・未対応拡張子をエラーにする', async () => {
    const missing = await resolveSourceLines(root, 'nope.txt', '1-1')
    expect(missing.isErr()).toBe(true)
    if (missing.isErr()) expect(missing.error._tag).toBe('SourceFileNotFoundError')

    const bin = await resolveSourceLines(root, 'binary.dat', '1-1')
    expect(bin.isErr()).toBe(true)
    if (bin.isErr()) expect(bin.error._tag).toBe('BinaryFileError')

    const unknown = await resolveSourceLines(root, 'x.unknownext', '1-1')
    expect(unknown.isErr()).toBe(true)
    if (unknown.isErr()) expect(unknown.error._tag).toBe('SourceFileNotFoundError')
  })
})

describe('resolveSourceSymbol', () => {
  test('TypeScript: クラスメソッド・関数・名前空間を修飾名で解決する', async () => {
    const m = (await resolveSourceSymbol(root, 'src/sample.ts', 'Registry.register')).unwrap()
    expect(m.symbol?.kind).toBe('method')
    expect(m.code).toContain('register(name: string)')

    const f = (await resolveSourceSymbol(root, 'src/sample.ts', 'helper')).unwrap()
    expect(f.symbol?.kind).toBe('function')
    expect(f.code).toContain('return x * 2')
    expect(f.code.startsWith('export function helper')).toBe(true)

    const n = (await resolveSourceSymbol(root, 'src/sample.ts', 'Utils.deep')).unwrap()
    expect(n.symbol?.qualifiedName).toBe('Utils.deep')
  })

  test('Go: レシーバからメソッドの修飾名を解決する', async () => {
    const r = (await resolveSourceSymbol(root, 'core/registry.go', 'Registry.Register')).unwrap()
    expect(r.symbol?.kind).toBe('method')
    expect(r.code).toContain('func (r *Registry) Register')

    const main = (await resolveSourceSymbol(root, 'core/registry.go', 'main')).unwrap()
    expect(main.symbol?.kind).toBe('function')
  })

  test('Rust: impl 内メソッドを型名で修飾して解決する', async () => {
    const r = (await resolveSourceSymbol(root, 'src/store.rs', 'Store.get')).unwrap()
    expect(r.symbol?.kind).toBe('function')
    expect(r.code).toContain('pub fn get')
  })

  test('Python / Java / Kotlin / Swift の定義を抽出する', async () => {
    const py = (await resolveSourceSymbol(root, 'src/app.py', 'Foo.method')).unwrap()
    expect(py.code).toContain('def method')

    const java = (await resolveSourceSymbol(root, 'src/Sample.java', 'Sample.run')).unwrap()
    expect(java.symbol?.kind).toBe('method')

    const kt = (await resolveSourceSymbol(root, 'src/sample.kt', 'Greeter.greet')).unwrap()
    expect(kt.symbol?.qualifiedName).toBe('Greeter.greet')

    const swift = (await resolveSourceSymbol(root, 'src/sample.swift', 'Model.load')).unwrap()
    expect(swift.code).toContain('func load')
  })

  test('未検出・曖昧・未対応言語を区別してエラーにする', async () => {
    const missing = await resolveSourceSymbol(root, 'src/sample.ts', 'nope')
    expect(missing.isErr()).toBe(true)
    if (missing.isErr()) expect(missing.error._tag).toBe('SymbolNotFoundError')

    const amb = await resolveSourceSymbol(root, 'src/amb.ts', 'run')
    expect(amb.isErr()).toBe(true)
    if (amb.isErr()) {
      expect(amb.error._tag).toBe('AmbiguousSymbolError')
      expect(amb.error.message).toContain('A.run')
      expect(amb.error.message).toContain('B.run')
    }

    const unsupported = await resolveSourceSymbol(root, 'notes/readme.txt', 'foo')
    expect(unsupported.isErr()).toBe(true)
    if (unsupported.isErr()) expect(unsupported.error._tag).toBe('UnsupportedExtensionError')
  })

  test('ファイル変更後は最新の内容を返す', async () => {
    const before = (await resolveSourceSymbol(root, 'src/sample.ts', 'helper')).unwrap()
    expect(before.code).toContain('return x * 2')
    await writeFile(
      path.join(root, 'src/sample.ts'),
      'export function helper(x: number): number {\n  return x * 3\n}\n',
    )
    const after = (await resolveSourceSymbol(root, 'src/sample.ts', 'helper')).unwrap()
    expect(after.code).toContain('return x * 3')
    expect(after.code).not.toContain('return x * 2')
  })
})
