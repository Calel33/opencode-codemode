// src/codemode/strings.ts
// Task 9: named string constants for one execute_tools call (the tool's
// `strings` parameter), injected into the guest as the `π` global for values
// that are hard to quote inside code.
//
// Pi semantics matched exactly (source: pi-codemode-src):
//   - input schema: an optional record<string, string> (execute-tool.ts:105-108)
//   - the `π` global ALWAYS exists; absent/undefined strings install as {}
//     (quickjs-executor.ts:134-136: `vm.setProp(global, "π", newJsonHandle(vm, options?.strings ?? {}))`)
//   - missing keys are plain property reads on a JSON round-tripped object,
//     i.e. undefined (stable)
//   - typechecker declaration is unconditional:
//     `declare const π: Readonly<Record<string, string>>;` (type-generator.ts:386-387)
//   - cleanup nulls `globalThis.π` before vm.dispose() (quickjs-executor.ts:297)
//
// Documented divergence: Pi performs no size validation on `strings`. This
// port validates at the tool boundary BEFORE any guest execution (plain
// object, non-empty keys, string values only) and caps the total
// JSON-serialized payload at 50 KiB — the port's shared bound
// (MAX_OUTPUT_BYTES = 50 * 1024 in execute-tools.ts).
//
// Values are per-execution data: never persisted, never shared across
// executions, never logged by host code paths.

/** Total serialized-byte bound for one `strings` input (50 KiB, shared convention). */
export const STRINGS_MAX_BYTES = 50 * 1024

/** Guest-visible global name; exact Pi form. */
export const STRINGS_GLOBAL_NAME = "π"

/** Typechecker declaration; exact Pi form (type-generator.ts:386-387). */
export const STRINGS_DECLARATION = `/** Named string constants passed via the 'strings' parameter. Use for file content that's hard to quote in JS. */
declare const π: Readonly<Record<string, string>>;`

export type StringsValidation =
  | { readonly ok: true; readonly strings: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string }

function describeValue(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/** Bounds a key echoed in an error message (values are never echoed). */
function boundedKey(key: string): string {
  return key.length > 40 ? `${key.slice(0, 40)}…` : key
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Validates the `strings` tool input at the boundary. Absent (undefined) is
 * valid and means "no constants": π installs as {} (Pi-exact). Any other
 * shape must be a plain JSON-serializable object whose keys are non-empty
 * strings and whose values are strings; everything else is refused with a
 * bounded reason — the guest never runs. Error messages may echo key names
 * (bounded) but never values.
 */
export function validateStrings(input: unknown): StringsValidation {
  if (input === undefined) return { ok: true, strings: {} }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: `\`strings\` must be a plain object of string values (got ${describeValue(input)})` }
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false, reason: "`strings` must be a plain object (class instances are not accepted)" }
  }
  let serialized: string
  try {
    serialized = JSON.stringify(input)
  } catch {
    return { ok: false, reason: "`strings` must be JSON-serializable" }
  }
  const bytes = byteLength(serialized)
  if (bytes > STRINGS_MAX_BYTES) {
    return {
      ok: false,
      reason: `\`strings\` is too large: ${bytes} serialized bytes exceed the 50 KiB (${STRINGS_MAX_BYTES}-byte) limit`,
    }
  }
  const strings: Record<string, string> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key.length === 0) return { ok: false, reason: "`strings` keys must be non-empty strings" }
    if (typeof value !== "string") {
      return { ok: false, reason: `\`strings.${boundedKey(key)}\` must be a string (got ${describeValue(value)})` }
    }
    strings[key] = value
  }
  return { ok: true, strings }
}
