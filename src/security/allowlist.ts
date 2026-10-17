// src/security/allowlist.ts
// CLI security primitives, kept pure and independent of spawning:
//   - cliAllowlistAllows: the effective allowlist gate (policy.cli: tool ->
//     allowed operation names). Defensive by design: anything that is not an
//     explicit tool + operation string pair in the allowlist is denied.
//   - hostCommandEnv: the environment allowlist for spawned executables,
//     ported from the original package's hostCommandEnv (research §2.9):
//     PATH/HOME/XDG_CONFIG_HOME only, plus GH_TOKEN/GITHUB_TOKEN/GITHUB_HOST
//     for `gh`. Nothing else from process.env reaches a spawned tool, so host
//     secrets cannot leak through the child environment.
import type { CliAllowlist } from "../config/policy.js"

/** True only when the effective allowlist grants exactly this tool + operation. */
export function cliAllowlistAllows(
  allowlist: CliAllowlist | undefined,
  tool: string,
  operation: string,
): boolean {
  if (allowlist === undefined || allowlist === null) return false
  if (typeof tool !== "string" || typeof operation !== "string") return false
  const operations = (allowlist as Record<string, unknown>)[tool]
  if (!Array.isArray(operations)) return false
  return operations.includes(operation)
}

/**
 * Minimal environment for a spawned CLI tool (Pi parity, research §2.9).
 * `undefined` values are ignored by child_process.spawn (Node docs), so a
 * missing HOME/XDG_CONFIG_HOME in the host environment simply means the
 * variable is absent for the child instead of an empty string.
 */
export function hostCommandEnv(tool: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: base.PATH ?? "",
    HOME: base.HOME,
    XDG_CONFIG_HOME: base.XDG_CONFIG_HOME,
  }
  if (tool === "gh") {
    env.GH_TOKEN = base.GH_TOKEN
    env.GITHUB_TOKEN = base.GITHUB_TOKEN
    env.GITHUB_HOST = base.GITHUB_HOST
  }
  return env
}
