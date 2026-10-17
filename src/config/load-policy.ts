// src/config/load-policy.ts
// Resolves the effective Policy from raw plugin options (ctx.options).
//
// How ctx.options maps to global/project sources (research §3.7 limitation,
// encoded honestly):
//   - The host applies plugin config precedence across `plugins` entries
//     (lowest -> highest) and hands the plugin ONE merged options record for
//     its entry. The plugin cannot reconstruct the host's per-layer history,
//     and the host does NOT merge a single plugin's options in a narrow-only
//     direction. So the plugin implements the intersection itself:
//       * top-level keys (`mode`, `executor`, `cli`, `lock`, `jev`) are
//         treated as the effective GLOBAL policy;
//       * the optional `project` key is the explicit project overlay, applied
//         with narrow-only + lock semantics via narrowOnly().
//   - A project that wants to narrow sets `project: { ... }` in its own
//     opencode.json entry; anything it cannot narrow is ignored with a note.
//   - Malformed options fail closed (failClosedPolicy): mode off, no CLI
//     access, locked.
// NEVER reads Pi config paths (`~/.pi/...`).
import type { Policy } from "./policy.js"
import { defaultPolicy, failClosedPolicy, narrowOnly, validatePolicyInput } from "./policy.js"

export interface PolicyResolution {
  readonly policy: Policy
  /** Populated only when the input was malformed (fail-closed path). */
  readonly errors: readonly string[]
  /** Human-readable explanations of clamping / ignored widening attempts. */
  readonly notes: readonly string[]
  /** Unknown top-level option keys that were tolerated (host-owned namespace). */
  readonly ignoredKeys: readonly string[]
}

/**
 * Pure resolution: validate raw options, build the global policy, then apply
 * the project overlay narrow-only. (Task 11: `yolo` is activatable; the
 * pre-Task-11 clamp is gone and narrowing/lock semantics are unchanged.)
 * Never throws; malformed input resolves the fail-closed policy with errors.
 */
export function resolvePolicy(raw: unknown): PolicyResolution {
  const validation = validatePolicyInput(raw)
  if (!validation.ok) {
    return { policy: failClosedPolicy(), errors: validation.errors, notes: [], ignoredKeys: [] }
  }

  const { global: globalOptions, project, ignoredKeys } = validation.parsed
  const base = defaultPolicy()
  const hasGlobalKeys =
    globalOptions.mode !== undefined ||
    globalOptions.executor !== undefined ||
    globalOptions.cli !== undefined ||
    globalOptions.lock !== undefined ||
    globalOptions.jev !== undefined

  let policy: Policy = {
    mode: globalOptions.mode ?? base.mode,
    executor: {
      type: globalOptions.executor?.type ?? base.executor.type,
      timeoutMs: globalOptions.executor?.timeoutMs ?? base.executor.timeoutMs,
    },
    cli: globalOptions.cli ?? base.cli,
    lock: globalOptions.lock ?? base.lock,
    jev: {
      enabled: globalOptions.jev?.enabled ?? base.jev.enabled,
      model: globalOptions.jev?.model ?? base.jev.model,
      timeoutMs: globalOptions.jev?.timeoutMs ?? base.jev.timeoutMs,
    },
    source: hasGlobalKeys ? "global" : "default",
  }

  const notes: string[] = []

  if (project !== undefined) {
    const narrowed = narrowOnly(policy, project)
    policy = narrowed.policy
    notes.push(...narrowed.notes)
  }

  return { policy, errors: [], notes, ignoredKeys }
}
