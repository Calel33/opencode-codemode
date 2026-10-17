// src/capabilities/enumerate.ts
// Host-side, IN-PROCESS implementations of the enumerated CLI operations —
// cli.find.files, cli.grep.search, cli.ls.list. They are declared,
// allowlist-gated, and typed-arg-validated exactly like the spawned CLI
// adapters (cli.ts branches here after the same gate), but they never consult
// PATH and never spawn a child process:
//   - stock Windows has no `grep`;
//   - `ls` on Windows is a PowerShell alias for Get-ChildItem, not a binary;
//   - Windows `find.exe` is an UNRELATED string-search utility ("FIND:
//     Parameter format not correct" when handed find's flags).
// One Node-fs implementation keeps all three OS-independent.
//
// Deliberate deviations from POSIX (recorded for review; README "Limitations"):
//   - every printed path is ROOT-RELATIVE with forward slashes; the root
//     itself prints as "." (POSIX prints the path as typed — root-relative is
//     the safe form inside the sandbox);
//   - find/grep walks skip `.git` and `node_modules` directories and never
//     descend symlinked directories (bounded traversal, cycle-safe; POSIX
//     find descends both);
//   - `ls.long` renders real stat.mode bits on POSIX, but SYNTHESIZES
//     type-only modes on Windows (`drwxr-xr-x` / `-rw-r--r--` /
//     `lrwxrwxrwx`) — Windows has no POSIX mode, and pretending otherwise
//     would be dishonest data;
//   - grep prints its own stable `<path>:<line>:<text>` format (lines are
//     1-indexed; `\r\n` terminators are stripped);
//   - the synthesized exitCode is always 0 on success — unlike POSIX grep,
//     "no matches" is not signaled as a nonzero exit;
//   - a start path is canonicalized by the path policy before walking
//     (resolveGuestPath reads through links that stay inside the root).
// Guest-supplied paths resolve through src/security/paths.ts (read
// containment); every outcome is a DispatchOutcome — errors are data, never
// throws. Caps are named constants at the top of this module; every cap that
// bites is reported via `truncated.stdout`.
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs"
import type { Dirent, Stats } from "node:fs"
import { userInfo } from "node:os"
import { basename, join, relative } from "node:path"

import { dispatchError } from "../codemode/dispatch.js"
import type { DispatchEnvironment, DispatchOutcome } from "../codemode/dispatch.js"
import { resolveGuestPath } from "../security/paths.js"

/** Operations served by this module; cli.ts branches on these keys. */
export const ENUMERATED_OPERATIONS: ReadonlySet<string> = new Set(["find.files", "grep.search", "ls.list"])

/** find/grep walk clamp: the start point is depth 0; deeper levels are never entered. */
const MAX_DEPTH = 32
/** find stdout breadth cap (entries reported). */
const MAX_FIND_RESULTS = 2_000
/** ls stdout breadth cap (entries reported). */
const MAX_LS_ENTRIES = 2_000
/** Directories no find/grep walk enters (deliberate deviation from POSIX find). */
const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"])
/** grep: files scanned per call. */
const GREP_MAX_FILES = 1_000
/** grep: total bytes read per call. */
const GREP_MAX_TOTAL_BYTES = 16 * 1024 * 1024
/** grep: bytes read per file (a larger file is scanned partially, flagged). */
const GREP_MAX_FILE_BYTES = 1024 * 1024
/** grep: matches reported per call. */
export const GREP_MAX_MATCHES = 1_000
/** grep: characters kept per matched line. */
export const GREP_MAX_LINE_CHARS = 500
/** stdout byte backstop; mirrors MAX_CLI_STREAM_BYTES in cli.ts (duplicated to avoid an import cycle). */
const MAX_ENUMERATED_STDOUT_BYTES = 50 * 1024

/** The synthesized CLI result; mirrors CliResult in cli.ts (kept local: no import cycle). */
interface EnumeratedCliResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean }
}

type EntryKind = "file" | "directory" | "symlink" | "other"

interface WalkEntry {
  /** Absolute (canonicalized) path. */
  readonly path: string
  readonly kind: EntryKind
  readonly depth: number
}

/** True when this declared tool/operation is served by the in-process path. */
export function isEnumeratedOperation(tool: string, operation: string): boolean {
  return ENUMERATED_OPERATIONS.has(`${tool}.${operation}`)
}

/**
 * Runs one enumerated operation on ALREADY-VALIDATED args (validation happens
 * in cli.ts runCliOperation, exactly like the spawned tools). Returns the same
 * DispatchOutcome shape as the spawn path: data = CliResult with synthesized
 * stdout, empty stderr, exitCode 0, and honest truncation flags.
 */
export function runEnumeratedOperation(
  tool: string,
  operation: string,
  args: Record<string, unknown>,
  env: DispatchEnvironment,
): DispatchOutcome {
  const rooted = rootOf(env)
  if (!rooted.ok) return rooted.outcome
  switch (`${tool}.${operation}`) {
    case "find.files":
      return runFindFiles(args, rooted.root)
    case "grep.search":
      return runGrepSearch(args, rooted.root)
    case "ls.list":
      return runLsList(args, rooted.root)
    default:
      return dispatchError("input", `unknown enumerated operation: ${tool}.${operation}`)
  }
}

/** Mirrors files.ts rootOf: an unknown root fails closed. */
function rootOf(env: DispatchEnvironment): { readonly ok: true; readonly root: string } | { readonly ok: false; readonly outcome: DispatchOutcome } {
  if (typeof env.root === "string" && env.root.length > 0) return { ok: true, root: env.root }
  return { ok: false, outcome: dispatchError("root", "the active project root is unknown; enumerated CLI operations are disabled") }
}

// ---------------------------------------------------------------------------
// ls.list
// ---------------------------------------------------------------------------

function runLsList(args: Record<string, unknown>, root: string): DispatchOutcome {
  const requested = stringArg(args, "path") ?? "."
  const resolved = resolveGuestPath(root, requested, "read")
  if (!resolved.ok) return dispatchError("path", resolved.reason)

  let entries: Dirent[]
  try {
    entries = readdirSync(resolved.path, { withFileTypes: true })
  } catch (error) {
    return dispatchError("io", errorMessage(error))
  }

  const includeHidden = args.all === true
  const long = args.long === true
  const selected = entries.filter((entry) => includeHidden || !entry.name.startsWith("."))
  selected.sort((a, b) => compareNames(a.name, b.name))

  const base = displayPath(root, resolved.path)
  const owner = long ? userInfo().username : ""
  const lines: string[] = []
  let truncated = false
  for (const entry of selected) {
    if (lines.length >= MAX_LS_ENTRIES) {
      truncated = true
      break
    }
    const display = childDisplay(base, entry.name)
    if (!long) {
      lines.push(display)
      continue
    }
    let stats: Stats
    try {
      stats = lstatSync(join(resolved.path, entry.name)) // never follow links
    } catch {
      continue // entry vanished between readdir and lstat; omit it (bounded walk)
    }
    lines.push(formatLongLine(stats, display, owner))
  }
  return synthesized(lines, truncated)
}

/** `<mode> <links> <owner> <group> <size> <YYYY-MM-DD HH:MM> <name>` (group always "-"). */
function formatLongLine(stats: Stats, display: string, owner: string): string {
  return `${formatMode(stats)} ${stats.nlink} ${owner} - ${stats.size} ${formatTimestamp(stats.mtime)} ${display}`
}

/** POSIX renders real stat.mode bits; Windows has no POSIX mode, so type-only bits are synthesized (documented). */
function formatMode(stats: Stats): string {
  if (process.platform === "win32") {
    if (stats.isSymbolicLink()) return "lrwxrwxrwx"
    if (stats.isDirectory()) return "drwxr-xr-x"
    return "-rw-r--r--"
  }
  return posixMode(stats.mode)
}

function posixMode(mode: number): string {
  const fileType = (mode & 0o170000) === 0o040000 ? "d" : (mode & 0o170000) === 0o120000 ? "l" : "-"
  const groups: ReadonlyArray<readonly [number, string | undefined]> = [
    [(mode >> 6) & 0o7, (mode & 0o4000) !== 0 ? "s" : undefined],
    [(mode >> 3) & 0o7, (mode & 0o2000) !== 0 ? "s" : undefined],
    [mode & 0o7, (mode & 0o1000) !== 0 ? "t" : undefined],
  ]
  let text = fileType
  for (const [bits, special] of groups) {
    text += (bits & 0o4) !== 0 ? "r" : "-"
    text += (bits & 0o2) !== 0 ? "w" : "-"
    if (special === undefined) text += (bits & 0o1) !== 0 ? "x" : "-"
    else text += (bits & 0o1) !== 0 ? special : special.toUpperCase()
  }
  return text
}

function formatTimestamp(value: Date): string {
  const pad = (part: number): string => String(part).padStart(2, "0")
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`
}

// ---------------------------------------------------------------------------
// find.files
// ---------------------------------------------------------------------------

function runFindFiles(args: Record<string, unknown>, root: string): DispatchOutcome {
  const requested = stringArg(args, "path") ?? "."
  const resolved = resolveGuestPath(root, requested, "read")
  if (!resolved.ok) return dispatchError("path", resolved.reason)

  let startKind: EntryKind
  try {
    startKind = kindOfStats(lstatSync(resolved.path))
  } catch (error) {
    return dispatchError("io", errorMessage(error))
  }

  const namePattern = stringArg(args, "name")
  let nameMatcher: RegExp | undefined
  if (namePattern !== undefined && namePattern.length > 0) {
    try {
      nameMatcher = globToRegExp(namePattern)
    } catch (error) {
      return dispatchError("input", `invalid -name glob: ${errorMessage(error)}`)
    }
  }
  const typeFilter = args.type === "file" || args.type === "directory" ? args.type : undefined
  const maxDepth = clampDepth(args.maxDepth)

  const results: string[] = []
  let truncated = false
  const stack: WalkEntry[] = [{ path: resolved.path, kind: startKind, depth: 0 }]
  while (stack.length > 0) {
    const entry = stack.pop()
    if (entry === undefined) continue
    if (matchesFindEntry(entry, nameMatcher, typeFilter)) {
      if (results.length >= MAX_FIND_RESULTS) {
        truncated = true
        break
      }
      results.push(displayPath(root, entry.path))
    }
    if (entry.kind !== "directory" || entry.depth >= maxDepth) continue
    const children = readDirectory(entry.path)
    if (children === undefined) continue // unreadable directory: subtree skipped (bounded walk)
    for (const child of children) {
      if (child.isDirectory() && SKIP_DIRECTORIES.has(child.name)) continue
      stack.push({ path: join(entry.path, child.name), kind: kindOfDirent(child), depth: entry.depth + 1 })
    }
  }
  results.sort(compareNames)
  return synthesized(results, truncated)
}

function matchesFindEntry(
  entry: WalkEntry,
  nameMatcher: RegExp | undefined,
  typeFilter: "file" | "directory" | undefined,
): boolean {
  if (typeFilter === "file" && entry.kind !== "file") return false
  if (typeFilter === "directory" && entry.kind !== "directory") return false
  if (nameMatcher === undefined) return true
  return nameMatcher.test(basename(entry.path))
}

function clampDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return MAX_DEPTH
  return Math.min(Math.max(value, 0), MAX_DEPTH)
}

/**
 * find `-name` semantics: a case-sensitive BASENAME glob supporting `*`, `?`,
 * and `[...]` (leading `!`/`^` negates). Everything else is escaped, so a
 * glob can never smuggle regex syntax.
 */
function globToRegExp(glob: string): RegExp {
  let source = "^"
  let index = 0
  while (index < glob.length) {
    const char = glob[index]
    if (char === "*") {
      source += "[^/]*"
      index += 1
      continue
    }
    if (char === "?") {
      source += "[^/]"
      index += 1
      continue
    }
    if (char === "[") {
      const end = classEnd(glob, index + 1)
      if (end === -1) {
        source += "\\["
        index += 1
        continue
      }
      const body = glob.slice(index + 1, end)
      const negated = body.startsWith("!") || body.startsWith("^")
      source += `[${negated ? "^" : ""}${escapeClassBody(negated ? body.slice(1) : body)}]`
      index = end + 1
      continue
    }
    source += escapeRegexChar(char)
    index += 1
  }
  return new RegExp(`${source}$`)
}

function classEnd(glob: string, start: number): number {
  let index = start
  if (index < glob.length && (glob[index] === "!" || glob[index] === "^")) index += 1
  if (index < glob.length && glob[index] === "]") index += 1
  while (index < glob.length && glob[index] !== "]") {
    if (glob[index] === "\\") index += 1
    index += 1
  }
  return index < glob.length ? index : -1
}

function escapeClassBody(body: string): string {
  let escaped = ""
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (char === "\\" && index + 1 < body.length) {
      escaped += escapeRegexChar(body[index + 1])
      index += 1
      continue
    }
    escaped += char === "]" || char === "^" || char === "\\" ? `\\${char}` : char
  }
  return escaped
}

function escapeRegexChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

// ---------------------------------------------------------------------------
// grep.search
// ---------------------------------------------------------------------------

function runGrepSearch(args: Record<string, unknown>, root: string): DispatchOutcome {
  const pattern = stringArg(args, "pattern")
  if (pattern === undefined || pattern.length === 0) {
    return dispatchError("input", "grep pattern is required")
  }
  let matcher: RegExp
  try {
    matcher = new RegExp(pattern, args.ignoreCase === true ? "i" : "")
  } catch (error) {
    return dispatchError("input", `invalid regular expression: ${errorMessage(error)}`)
  }

  const rawPaths = args.paths
  let requestedPaths: string[]
  if (rawPaths === undefined || (Array.isArray(rawPaths) && rawPaths.length === 0)) {
    requestedPaths = ["."]
  } else if (Array.isArray(rawPaths) && rawPaths.every((entry) => typeof entry === "string")) {
    requestedPaths = rawPaths as string[]
  } else {
    return dispatchError("input", "grep paths must be an array of strings")
  }
  const recursive = args.recursive === true

  const candidates: string[] = []
  for (const requestedPath of requestedPaths) {
    const resolved = resolveGuestPath(root, requestedPath, "read")
    if (!resolved.ok) return dispatchError("path", resolved.reason)
    let kind: EntryKind
    try {
      kind = kindOfStats(lstatSync(resolved.path))
    } catch (error) {
      return dispatchError("io", errorMessage(error))
    }
    if (kind === "directory") {
      collectGrepCandidates(resolved.path, recursive, candidates)
    } else {
      candidates.push(resolved.path) // explicit file operand
    }
  }

  // Deduplicate + sort the candidate files so overlapping operands stay reproducible.
  const unique: Array<{ readonly file: string; readonly display: string }> = []
  const seen = new Set<string>()
  for (const file of candidates) {
    if (seen.has(file)) continue
    seen.add(file)
    unique.push({ file, display: displayPath(root, file) })
  }
  unique.sort((a, b) => compareNames(a.display, b.display))

  const lines: string[] = []
  let truncated = false
  let filesScanned = 0
  let totalBytes = 0
  for (const candidate of unique) {
    if (filesScanned >= GREP_MAX_FILES || totalBytes >= GREP_MAX_TOTAL_BYTES) {
      truncated = true
      break
    }
    const budget = Math.min(GREP_MAX_FILE_BYTES, GREP_MAX_TOTAL_BYTES - totalBytes)
    let read: PrefixRead
    try {
      read = readPrefix(candidate.file, budget)
    } catch {
      continue // unreadable file: skipped (bounded walk; no stderr channel)
    }
    filesScanned += 1
    totalBytes += read.data.length
    if (!read.complete) truncated = true
    if (read.data.includes(0)) continue // binary operand: skipped
    const scan = scanFile(read.data, read.complete, candidate.display, matcher)
    lines.push(...scan.lines)
    if (scan.clippedLine) truncated = true
    if (scan.capReached) {
      truncated = true
      break
    }
  }
  return synthesized(lines, truncated)
}

function collectGrepCandidates(start: string, recursive: boolean, out: string[]): void {
  if (!recursive) {
    const entries = readDirectory(start)
    if (entries === undefined) return
    for (const entry of entries) {
      if (entry.isFile()) out.push(join(start, entry.name))
    }
    return
  }
  const stack: string[] = [start]
  while (stack.length > 0) {
    const directory = stack.pop()
    if (directory === undefined) continue
    const entries = readDirectory(directory)
    if (entries === undefined) continue
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        stack.push(join(directory, entry.name))
      } else if (entry.isFile()) {
        out.push(join(directory, entry.name))
      }
      // symlinks are neither entered nor scanned
    }
  }
}

interface FileScan {
  readonly lines: string[]
  readonly capReached: boolean
  readonly clippedLine: boolean
}

function scanFile(data: Buffer, complete: boolean, display: string, matcher: RegExp): FileScan {
  let text = data.toString("utf-8")
  if (!complete) {
    const lastBreak = text.lastIndexOf("\n")
    text = lastBreak === -1 ? "" : text.slice(0, lastBreak) // drop the partial trailing line
  }
  const rawLines = text === "" ? [] : text.split("\n")
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop()
  const matches: string[] = []
  let capReached = false
  let clippedLine = false
  for (let index = 0; index < rawLines.length; index++) {
    if (matches.length >= GREP_MAX_MATCHES) {
      capReached = true
      break
    }
    const raw = rawLines[index] ?? ""
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (!matcher.test(line)) continue
    const clipped = line.length > GREP_MAX_LINE_CHARS ? line.slice(0, GREP_MAX_LINE_CHARS) : line
    if (clipped.length !== line.length) clippedLine = true
    matches.push(`${display}:${index + 1}:${clipped}`)
  }
  return { lines: matches, capReached, clippedLine }
}

interface PrefixRead {
  readonly data: Buffer
  readonly complete: boolean
}

/** Reads at most maxBytes from the file head; complete = the WHOLE file fit. */
function readPrefix(path: string, maxBytes: number): PrefixRead {
  const fd = openSync(path, "r")
  try {
    const size = fstatSync(fd).size
    const capacity = Math.max(Math.min(maxBytes, size), 0)
    const data = Buffer.alloc(capacity)
    let filled = 0
    while (filled < capacity) {
      const chunk = readSync(fd, data, filled, capacity - filled, filled)
      if (chunk <= 0) break
      filled += chunk
    }
    return { data: filled === capacity ? data : data.subarray(0, filled), complete: size <= capacity }
  } finally {
    closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function readDirectory(path: string): Dirent[] | undefined {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return undefined
  }
}

function kindOfStats(stats: Stats): EntryKind {
  if (stats.isDirectory()) return "directory"
  if (stats.isFile()) return "file"
  if (stats.isSymbolicLink()) return "symlink"
  return "other"
}

function kindOfDirent(entry: Dirent): EntryKind {
  if (entry.isDirectory()) return "directory"
  if (entry.isFile()) return "file"
  if (entry.isSymbolicLink()) return "symlink"
  return "other"
}

/** Root-relative display form with forward slashes; the root itself is ".". */
function displayPath(root: string, absolute: string): string {
  const rel = relative(root, absolute)
  if (rel === "") return "."
  return rel.split("\\").join("/")
}

function childDisplay(base: string, name: string): string {
  return base === "." ? name : `${base}/${name}`
}

/** Deterministic order: case-insensitive compare, then case-sensitive tiebreak. */
function compareNames(a: string, b: string): number {
  const lowerA = a.toLowerCase()
  const lowerB = b.toLowerCase()
  if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1
  if (a === b) return 0
  return a < b ? -1 : 1
}

function synthesized(lines: readonly string[], truncated: boolean): DispatchOutcome {
  const joined = lines.join("\n")
  const capped = byteLength(joined) > MAX_ENUMERATED_STDOUT_BYTES
  const data: EnumeratedCliResult = {
    stdout: capped ? truncateToBytes(joined, MAX_ENUMERATED_STDOUT_BYTES) : joined,
    stderr: "",
    exitCode: 0,
    truncated: { stdout: truncated || capped, stderr: false },
  }
  return { ok: true, data }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" ? value : undefined
}

function truncateToBytes(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length <= maxBytes) return value
  return new TextDecoder().decode(bytes.subarray(0, maxBytes))
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
