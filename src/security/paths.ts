// src/security/paths.ts
// Path policy for the root-scoped file helpers: active-root resolution plus
// lexical and symlink-aware containment. Ported behaviorally from the original
// package's path handling (research §2.8), not copied:
//   - lexical containment is checked BEFORE touching the filesystem, so `..`
//     traversal is rejected without I/O;
//   - reads realpath the target — symlinks/junctions leaving the root are denied;
//   - writes realpath the deepest EXISTING ancestor and rejoin the missing tail,
//     so a not-yet-existing target cannot escape through a link;
//   - Pi-parity protected write paths: `.mcp.json` and any `.pi/` directory are
//     refused for writes (reads stay allowed).
// Windows notes: normalization and case-insensitive comparison come from
// node:path win32 semantics; drive-relative forms ("C:foo") are rejected
// because path.resolve would resolve them against the process CWD
// (nondeterministic). The root is canonicalized with realpathSync and must be
// an existing directory — otherwise the helpers fail closed (no root, no file
// access).
import { existsSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path"

const IS_WINDOWS = process.platform === "win32"

export type RootResolution =
  | { readonly ok: true; readonly root: string; readonly source: "directory" | "project.canonical" }
  | { readonly ok: false; readonly reason: string }

/** Structural subset of @opencode/schema Location.Info (context.md §1.3). */
export interface ActiveRootLocation {
  readonly directory?: unknown
  readonly project?: { readonly canonical?: unknown } | null | undefined
}

/**
 * Resolves the active checkout root from the setup-time location context.
 * The per-call ToolContext has no location field in @opencode/plugin@2.0.19
 * (context.md §1.4), so the root is resolved once at setup from
 * `ctx.location.directory` (the session's operative checkout), falling back to
 * `ctx.location.project.canonical` (the canonical project root). Anything
 * missing, non-absolute, nonexistent, or not a directory fails closed.
 */
export function resolveActiveRoot(location: ActiveRootLocation | null | undefined): RootResolution {
  const candidates = [
    { source: "directory" as const, label: "ctx.location.directory", value: location?.directory },
    { source: "project.canonical" as const, label: "ctx.location.project.canonical", value: location?.project?.canonical },
  ]
  const reasons: string[] = []
  for (const candidate of candidates) {
    if (typeof candidate.value !== "string" || candidate.value.trim() === "") {
      reasons.push(`${candidate.label} is missing`)
      continue
    }
    if (!isAbsolute(candidate.value)) {
      reasons.push(`${candidate.label} is not absolute`)
      continue
    }
    let real: string
    try {
      real = realpathSync(normalize(candidate.value))
    } catch {
      reasons.push(`${candidate.label} does not exist`)
      continue
    }
    let isDirectory = false
    try {
      isDirectory = statSync(real).isDirectory()
    } catch {
      reasons.push(`${candidate.label} is not readable`)
      continue
    }
    if (!isDirectory) {
      reasons.push(`${candidate.label} is not a directory`)
      continue
    }
    return { ok: true, root: real, source: candidate.source }
  }
  return { ok: false, reason: reasons.join("; ") }
}

export type PathCheck = { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string }

/** drive-relative form ("C:foo") — node:path resolves it against the CWD, so reject. */
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/

/**
 * Resolves a guest-supplied path against the canonical root and enforces
 * containment. `operation` selects the existence requirement: reads need an
 * existing target; writes resolve the deepest existing ancestor and rejoin the
 * missing tail, then apply the protected-path write check.
 */
export function resolveGuestPath(root: string, userPath: unknown, operation: "read" | "write"): PathCheck {
  if (typeof userPath !== "string" || userPath.length === 0) {
    return { ok: false, reason: "path must be a non-empty string" }
  }
  if (userPath.includes("\u0000")) return { ok: false, reason: "path contains a NUL byte" }
  if (IS_WINDOWS && DRIVE_RELATIVE.test(userPath)) {
    return { ok: false, reason: `unsupported drive-relative path: ${userPath}` }
  }

  let safeRoot: string
  try {
    safeRoot = realpathSync(normalize(root))
    if (!statSync(safeRoot).isDirectory()) return { ok: false, reason: "project root is not a directory" }
  } catch {
    return { ok: false, reason: "project root is unavailable" }
  }

  const candidate = isAbsolute(userPath) ? normalize(userPath) : resolve(safeRoot, userPath)

  // Lexical containment before touching the filesystem blocks `..` traversal.
  if (!isInside(safeRoot, candidate)) return { ok: false, reason: `path outside the project root: ${userPath}` }

  if (operation === "read") {
    if (!existsSync(candidate)) return { ok: false, reason: `file not found: ${userPath}` }
    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      return { ok: false, reason: `unreadable path: ${userPath}` }
    }
    if (!isInside(safeRoot, real)) return { ok: false, reason: `path outside the project root: ${userPath}` }
    return { ok: true, path: real }
  }

  // Write: existing target realpath'd whole (a symlinked file escaping the root
  // is denied); a missing target resolves through its deepest existing ancestor.
  if (existsSync(candidate)) {
    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      return { ok: false, reason: `unreadable path: ${userPath}` }
    }
    if (!isInside(safeRoot, real)) return { ok: false, reason: `path outside the project root: ${userPath}` }
    if (isProtectedWrite(safeRoot, real)) return { ok: false, reason: protectedReason(userPath) }
    return { ok: true, path: real }
  }

  let probe = candidate
  const missing: string[] = []
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) return { ok: false, reason: `path outside the project root: ${userPath}` }
    missing.unshift(basename(probe))
    probe = parent
  }
  let realBase: string
  try {
    realBase = realpathSync(probe)
  } catch {
    return { ok: false, reason: `unreadable path: ${userPath}` }
  }
  if (!isInside(safeRoot, realBase)) return { ok: false, reason: `path outside the project root: ${userPath}` }
  const rebuilt = missing.length > 0 ? join(realBase, ...missing) : realBase
  if (!isInside(safeRoot, rebuilt)) return { ok: false, reason: `path outside the project root: ${userPath}` }
  if (isProtectedWrite(safeRoot, rebuilt)) return { ok: false, reason: protectedReason(userPath) }
  return { ok: true, path: rebuilt }
}

/** Containment via relative segments (win32 case-insensitive through node:path). */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  if (rel === "" || rel === ".") return true
  if (isAbsolute(rel)) return false
  const first = rel.split(/[\\/]/)[0]
  return first !== ".." && first !== ""
}

/** Pi parity (research §2.8): write-denied under the root — root `.mcp.json`, any `.pi/`. */
function isProtectedWrite(root: string, target: string): boolean {
  const rel = relative(root, target)
  if (rel === "") return false
  const segments = rel.split(/[\\/]/).map((segment) => segment.toLowerCase())
  if (segments.length === 1 && segments[0] === ".mcp.json") return true
  return segments.includes(".pi")
}

function protectedReason(userPath: string): string {
  return `path is policy-protected (.mcp.json / .pi/ are not writable through CodeMode): ${userPath}`
}
