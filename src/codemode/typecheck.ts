// src/codemode/typecheck.ts
// Pi-style "typecheck before effects": TypeScript diagnostics for the guest
// code body, computed on a VIRTUAL program with no host state, before any guest
// execution and before any host side effect. The program's inputs are:
//   - the installed TypeScript lib es2022 .d.ts set (loaded once by following
//     /// <reference lib="..." /> directives; no DOM, so window/fetch/setTimeout
//     are correctly unknown to the guest)
//   - the guest global declarations from globals.ts (the same registry the
//     runtime installer uses)
//   - the user's code body wrapped as `(async () => { ... })();`
// Reported line numbers are mapped back to the user's code body.
//
// Lib resolution note: the task plan suggested
// `createRequire(import.meta.url).resolve("typescript/lib/lib.es2022.d.ts")`.
// Resolution here instead uses the executing compiler's own lib-dir source of
// truth (`ts.getDefaultLibFilePath` + `ts.sys`) — exactly the directory this
// TypeScript instance loads its default libs from, independent of hoisting or
// layout. (Task 5 added @types/node + tsconfig `types: ["node"]` for the file
// adapters; this file keeps its approach because it is robust either way.)
import ts from "typescript"
import { buildTypeDefs } from "./globals.js"

export const VIRTUAL_SOURCE_FILE = "execute_tools.ts"

export interface TypeDiagnostic {
  file: string
  /** 1-indexed line in the user's code body (0 when it cannot be mapped). */
  line: number
  /** 1-indexed column. */
  col: number
  message: string
}

export interface TypeCheckResult {
  diagnostics: TypeDiagnostic[]
}

/**
 * Resolve the on-disk TypeScript `lib` directory from the executing compiler:
 * `ts.getDefaultLibFilePath({ target: ES2022 })` is
 * `<typescript>/lib/lib.es2022.d.ts` and its directory is the lib dir.
 */
export function resolveTypeScriptLibDir(): string {
  const defaultLib = ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 })
  const dir = dirName(defaultLib)
  if (ts.sys.fileExists(joinPath(dir, "lib.es2022.d.ts"))) return dir
  throw new Error(
    `code-mode typechecker could not find lib.es2022.d.ts next to the executing typescript (tried ${defaultLib})`,
  )
}

/** Minimal path helpers (node:path is unavailable under this tsconfig's types: []). */
function dirName(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))
  return index > 0 ? filePath.slice(0, index) : "."
}

function joinPath(dir: string, name: string): string {
  const separator = dir.includes("\\") && !dir.includes("/") ? "\\" : "/"
  return `${dir}${separator}${name}`
}

interface LibFile {
  content: string
  sourceFile?: ts.SourceFile
}

let libFiles: Map<string, LibFile> | null = null

/** Loads the ES2022 lib set once (57 files on typescript 6.0.3). */
function loadLibFiles(): Map<string, LibFile> {
  if (libFiles) return libFiles
  const dir = resolveTypeScriptLibDir()
  const files = new Map<string, LibFile>()
  const visit = (name: string): void => {
    if (files.has(name)) return
    const filePath = joinPath(dir, name)
    if (!ts.sys.fileExists(filePath)) return
    const content = ts.sys.readFile(filePath)
    if (content === undefined) return
    files.set(name, { content })
    for (const match of content.matchAll(/\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/?>/g)) {
      visit(`lib.${match[1]}.d.ts`)
    }
  }
  visit("lib.es2022.d.ts")
  if (files.size === 0) throw new Error(`code-mode typechecker found no TypeScript lib files under ${dir}`)
  libFiles = files
  return files
}

/**
 * Type-checks a guest code body. No side effects: everything runs against the
 * virtual compiler host; the real filesystem is only read for the TS libs.
 */
export function typeCheck(code: string, typeDefs: string = buildTypeDefs()): TypeCheckResult {
  const libs = loadLibFiles()
  // typeDefs line count + the "(async () => {" wrapper line
  const prefixLineCount = typeDefs.split("\n").length + 1
  const fullSource = `${typeDefs}\n(async () => {\n${code}\n})();\n`
  const sourceFile = ts.createSourceFile(VIRTUAL_SOURCE_FILE, fullSource, ts.ScriptTarget.ESNext, true)

  const normalize = (fileName: string): string => (fileName.startsWith("/") ? fileName.slice(1) : fileName)
  const getLib = (name: string): LibFile | undefined => libs.get(name) ?? libs.get(normalize(name))
  const getLibSourceFile = (name: string): ts.SourceFile | undefined => {
    const lib = getLib(name)
    if (!lib) return undefined
    lib.sourceFile ??= ts.createSourceFile(name, lib.content, ts.ScriptTarget.ESNext, true)
    return lib.sourceFile
  }

  const host: ts.CompilerHost = {
    getSourceFile: (fileName) => (fileName === VIRTUAL_SOURCE_FILE ? sourceFile : getLibSourceFile(fileName)),
    getDefaultLibFileName: () => "lib.es5.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (fileName) => fileName === VIRTUAL_SOURCE_FILE || getLib(fileName) !== undefined,
    readFile: (fileName) => (fileName === VIRTUAL_SOURCE_FILE ? undefined : getLib(fileName)?.content),
    directoryExists: () => false,
    getDirectories: () => [],
    realpath: (fileName) => fileName,
  }

  const program = ts.createProgram(
    [VIRTUAL_SOURCE_FILE, ...libs.keys()],
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    host,
  )

  const diagnostics = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ]

  return {
    diagnostics: diagnostics.map((diagnostic): TypeDiagnostic => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
      if (diagnostic.file && diagnostic.start !== undefined) {
        const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        return {
          file: VIRTUAL_SOURCE_FILE,
          line: Math.max(1, pos.line - prefixLineCount + 1),
          col: pos.character + 1,
          message,
        }
      }
      return { file: VIRTUAL_SOURCE_FILE, line: 0, col: 0, message }
    }),
  }
}
