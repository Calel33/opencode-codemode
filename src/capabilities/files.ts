// src/capabilities/files.ts
// Host-side file adapters behind the dispatcher (guest helpers read/write/edit).
// All three are root-scoped via src/security/paths.ts and bounded:
//   - MAX_READ_BYTES (50 KiB, the MAX_OUTPUT_BYTES semantics reused from
//     execute-tools.ts) caps read output with an explicit marker;
//   - MAX_READ_FILE_BYTES (4 MiB) refuses whole-file loads beyond a size a
//     Code Mode read should ever need (host memory bound);
//   - MAX_WRITE_BYTES (1 MiB) refuses oversized write payloads.
// Behavior ported from the original package's file-tools.ts (research §2.8):
// read slices LINES by zero-based offset/limit; write writes exact content and
// creates missing parents; edit is replace_in_file semantics — every oldText
// must match exactly once and non-overlapping, all validated BEFORE any write.
// Deliberate deviations (recorded for review):
//   - the original returned a unified diff from replace_in_file; this slice
//     returns a bounded summary message instead (no file contents in results);
//   - reads cap output at 50 KiB with a marker (the original returned whole
//     files) and add a whole-file guard.
// yolo does NOT unrestrict file paths here: Task 11 delivers only the
// explicit shell escape hatch (capability group "shell"); read/write/edit stay
// root-scoped in every mode.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { dispatchError } from "../codemode/dispatch.js"
import type { DispatchCapability, DispatchEnvironment, DispatchOutcome } from "../codemode/dispatch.js"
import { resolveGuestPath } from "../security/paths.js"

/** Read output cap: the MAX_OUTPUT_BYTES (execute-tools.ts) semantics, reused. */
export const MAX_READ_BYTES = 50 * 1024
/** Whole-file guard: a Code Mode read should never load more than this. */
export const MAX_READ_FILE_BYTES = 4 * 1024 * 1024
/** Write payload cap: bounds host memory and accidental bulk rewrites. */
export const MAX_WRITE_BYTES = 1024 * 1024

const TRUNCATION_MARKER = `\n[truncated at ${MAX_READ_BYTES / 1024} KiB]`
const MAX_DIAGNOSTIC_CHARS = 200

export function createFileCapabilities(): readonly DispatchCapability[] {
  return [
    { name: "read", group: "files", run: runRead },
    { name: "write", group: "files", run: runWrite },
    { name: "edit", group: "files", run: runEdit },
  ]
}

function rootOf(env: DispatchEnvironment): { readonly ok: true; readonly root: string } | { readonly ok: false; readonly outcome: DispatchOutcome } {
  if (typeof env.root === "string" && env.root.length > 0) return { ok: true, root: env.root }
  return { ok: false, outcome: dispatchError("root", "the active project root is unknown; file helpers are disabled") }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

function runRead(input: unknown, env: DispatchEnvironment): DispatchOutcome {
  const rooted = rootOf(env)
  if (!rooted.ok) return rooted.outcome
  const params = asRecord(input)
  if (!params) return dispatchError("input", "read expects an object: { path, offset?, limit? }")

  const pathCheck = resolveGuestPath(rooted.root, params.path, "read")
  if (!pathCheck.ok) return dispatchError("path", pathCheck.reason)

  const offsetCheck = parseLineBound(params.offset, "offset")
  if (!offsetCheck.ok) return offsetCheck.outcome
  const limitCheck = parseLineBound(params.limit, "limit")
  if (!limitCheck.ok) return limitCheck.outcome

  let size: number
  try {
    const stats = statSync(pathCheck.path)
    if (!stats.isFile()) return dispatchError("io", `not a regular file: ${boundedPath(params.path)}`)
    size = stats.size
  } catch (error) {
    return dispatchError("io", errorMessage(error))
  }
  if (size > MAX_READ_FILE_BYTES) {
    return dispatchError("limit", `file is too large to read (${size} bytes; limit ${MAX_READ_FILE_BYTES} bytes)`)
  }

  let content: string
  try {
    content = readFileSync(pathCheck.path, "utf-8")
  } catch (error) {
    return dispatchError("io", errorMessage(error))
  }

  if (offsetCheck.value !== undefined || limitCheck.value !== undefined) {
    const lines = content.split("\n")
    const offset = offsetCheck.value ?? 0
    if (offset >= lines.length) return { ok: true, data: "" }
    const limit = limitCheck.value ?? lines.length
    content = lines.slice(offset, offset + limit).join("\n")
  }

  return { ok: true, data: capReadOutput(content) }
}

function runWrite(input: unknown, env: DispatchEnvironment): DispatchOutcome {
  const rooted = rootOf(env)
  if (!rooted.ok) return rooted.outcome
  const params = asRecord(input)
  if (!params) return dispatchError("input", "write expects an object: { path, content }")
  if (typeof params.content !== "string") return dispatchError("input", "write content must be a string")

  const bytes = byteLength(params.content)
  if (bytes > MAX_WRITE_BYTES) {
    return dispatchError("limit", `write content is too large (${bytes} bytes; limit ${MAX_WRITE_BYTES} bytes)`)
  }

  const pathCheck = resolveGuestPath(rooted.root, params.path, "write")
  if (!pathCheck.ok) return dispatchError("path", pathCheck.reason)

  try {
    mkdirSync(dirname(pathCheck.path), { recursive: true })
    writeFileSync(pathCheck.path, params.content, "utf-8")
  } catch (error) {
    return dispatchError("io", errorMessage(error))
  }
  return { ok: true, data: null }
}

function runEdit(input: unknown, env: DispatchEnvironment): DispatchOutcome {
  const rooted = rootOf(env)
  if (!rooted.ok) return rooted.outcome
  const params = asRecord(input)
  if (!params) return dispatchError("input", "edit expects an object: { path, edits }")
  const editsCheck = parseEdits(params.edits)
  if (!editsCheck.ok) return editsCheck.outcome

  const pathCheck = resolveGuestPath(rooted.root, params.path, "write")
  if (!pathCheck.ok) return dispatchError("path", pathCheck.reason)

  const editBytes = editsCheck.edits.reduce(
    (total, edit) => total + byteLength(edit.oldText) + byteLength(edit.newText),
    0,
  )
  if (editBytes > MAX_WRITE_BYTES) {
    return dispatchError("limit", `edit payload is too large (${editBytes} bytes; limit ${MAX_WRITE_BYTES} bytes)`)
  }

  let content: string
  try {
    const stats = statSync(pathCheck.path)
    if (!stats.isFile()) return dispatchError("io", `not a regular file: ${boundedPath(params.path)}`)
    if (stats.size > MAX_READ_FILE_BYTES) {
      return dispatchError("limit", `file is too large to edit (${stats.size} bytes; limit ${MAX_READ_FILE_BYTES} bytes)`)
    }
    content = readFileSync(pathCheck.path, "utf-8")
  } catch (error) {
    return dispatchError("io", errorMessage(error))
  }

  // First pass: validate every edit (exact, unique, non-overlapping) BEFORE
  // any write — a failed edit must leave the file byte-identical.
  const positions: Array<{ start: number; end: number; oldText: string; newText: string }> = []
  for (const edit of editsCheck.edits) {
    const found = findAllPositions(content, edit.oldText)
    if (found.length === 0) {
      return dispatchError("not-found", `oldText not found: ${diagnostic(edit.oldText)}`)
    }
    if (found.length > 1) {
      return dispatchError(
        "not-found",
        `oldText matches ${found.length} times, expected exactly 1: ${diagnostic(edit.oldText)}`,
      )
    }
    positions.push({ start: found[0], end: found[0] + edit.oldText.length, oldText: edit.oldText, newText: edit.newText })
  }
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i]
      const b = positions[j]
      if (a.start < b.end && b.start < a.end) {
        return dispatchError("input", `edits overlap: ${diagnostic(a.oldText)} and ${diagnostic(b.oldText)}`)
      }
    }
  }

  positions.sort((a, b) => b.start - a.start)
  let updated = content
  for (const edit of positions) {
    updated = updated.slice(0, edit.start) + edit.newText + updated.slice(edit.end)
  }
  const updatedBytes = byteLength(updated)
  if (updatedBytes > MAX_READ_FILE_BYTES) {
    return dispatchError("limit", `edited file would be too large (${updatedBytes} bytes; limit ${MAX_READ_FILE_BYTES} bytes)`)
  }

  try {
    writeFileSync(pathCheck.path, updated, "utf-8")
  } catch (error) {
    return dispatchError("io", errorMessage(error))
  }
  const count = editsCheck.edits.length
  return { ok: true, data: `Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${boundedPath(params.path)}` }
}

interface EditPair {
  readonly oldText: string
  readonly newText: string
}

function parseEdits(
  input: unknown,
): { readonly ok: true; readonly edits: EditPair[] } | { readonly ok: false; readonly outcome: DispatchOutcome } {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, outcome: dispatchError("input", "edit edits must be a non-empty array of { oldText, newText }") }
  }
  const edits: EditPair[] = []
  for (const entry of input) {
    const record = asRecord(entry)
    if (!record || typeof record.oldText !== "string" || typeof record.newText !== "string") {
      return { ok: false, outcome: dispatchError("input", "each edit must be an object with string oldText and newText") }
    }
    if (record.oldText.length === 0) {
      return { ok: false, outcome: dispatchError("input", "edit oldText must be non-empty") }
    }
    edits.push({ oldText: record.oldText, newText: record.newText })
  }
  return { ok: true, edits }
}

function parseLineBound(
  value: unknown,
  name: "offset" | "limit",
): { readonly ok: true; readonly value: number | undefined } | { readonly ok: false; readonly outcome: DispatchOutcome } {
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { ok: false, outcome: dispatchError("input", `${name} must be a non-negative integer`) }
  }
  return { ok: true, value }
}

function findAllPositions(content: string, search: string): number[] {
  const positions: number[] = []
  let pos = 0
  while ((pos = content.indexOf(search, pos)) !== -1) {
    positions.push(pos)
    pos += 1
  }
  return positions
}

function capReadOutput(content: string): string {
  if (byteLength(content) <= MAX_READ_BYTES) return content
  const budget = Math.max(MAX_READ_BYTES - byteLength(TRUNCATION_MARKER), 0)
  return `${truncateToBytes(content, budget)}${TRUNCATION_MARKER}`
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

function boundedPath(value: unknown): string {
  const text = typeof value === "string" ? value : String(value)
  return text.length > MAX_DIAGNOSTIC_CHARS ? `${text.slice(0, MAX_DIAGNOSTIC_CHARS)}...` : text
}

function diagnostic(text: string): string {
  return JSON.stringify(boundedPath(text))
}
