// src/config/policy.ts
// Mode policy record and pure functions. Ports the original Pi config
// semantics (research §2.12):
//   - modes `off | on | yolo` with permissiveness {off:0, on:1, yolo:2}
//   - project `mode`/`cli` may only NARROW the effective global values
//   - `lock: true` ignores project `mode`/`cli` overrides
//   - `executor` shallow-merges with project precedence
//   - defaults preserved from the shipped package:
//     { mode: "on", executor: { type: "quickjs", timeoutMs: 120000 } }
// Validation is strict for the plugin-owned schema: malformed values fail
// closed (mode off, lock true, source "fail-closed") — see failClosedPolicy().
// NEVER reads Pi config paths; the only input is whatever the host hands over
// in ctx.options (plan §API design, research §2.12/§3.7).

export type Mode = "off" | "on" | "yolo"

/** Pi permissiveness ordering (research §2.12). Higher = more permissive. */
export const MODE_RANK: Readonly<Record<Mode, number>> = { off: 0, on: 1, yolo: 2 }

/**
 * Availability gate for `yolo` (flipped true by Task 11, which delivered the
 * explicit shell-escape slice). `yolo` is still never implicit: the effective
 * policy must select it (a narrow-only project overlay cannot widen into it)
 * and only then does capabilitiesFor() open the `shell` group.
 */
export const YOLO_AVAILABLE = true

export function modeRank(mode: Mode): number {
  return MODE_RANK[mode]
}

export function isMode(value: unknown): value is Mode {
  return value === "off" || value === "on" || value === "yolo"
}

export function isModeAvailable(mode: Mode): boolean {
  return mode !== "yolo" || YOLO_AVAILABLE
}

export type ExecutorType = "quickjs"

export interface ExecutorPolicy {
  readonly type: ExecutorType
  readonly timeoutMs: number
}

/** Preserved from the shipped Pi package (research §2.12/§1). */
export const DEFAULT_MODE: Mode = "on"
export const DEFAULT_EXECUTOR: ExecutorPolicy = { type: "quickjs", timeoutMs: 120_000 }

/**
 * Task 10 Jev policy (optional TypeSafe integration). Pi-parity defaults
 * (research §2.13): model "jev-latest", 8000 ms timeout. `enabled: false` is
 * the documented opt-out and forces the capability unavailable even with
 * credentials present; absence of credentials is a runtime fact answered by
 * the host adapter (capabilities/jev.ts), never by this record.
 */
export interface JevPolicy {
  readonly enabled: boolean
  readonly model: string
  readonly timeoutMs: number
}

/** Pi-parity Jev defaults: enabled, model "jev-latest", 8000 ms (research §2.13). */
export const DEFAULT_JEV: JevPolicy = { enabled: true, model: "jev-latest", timeoutMs: 8_000 }

/** Upper bound the strict option parser accepts for jev.timeoutMs. */
export const JEV_MAX_TIMEOUT_MS = 60_000

/** Upper bound the strict option parser accepts for jev.model. */
export const JEV_MODEL_MAX_CHARS = 200

/** Tool name -> allowed operation names. Empty object = no CLI access. */
export type CliAllowlist = Readonly<Record<string, readonly string[]>>

/** Which layer produced the effective policy (plan §Data design). */
export type PolicySource = "default" | "global" | "project" | "fail-closed"

export interface Policy {
  readonly mode: Mode
  readonly executor: ExecutorPolicy
  readonly cli: CliAllowlist
  readonly lock: boolean
  /** Task 10 optional Jev (TypeSafe) policy record. */
  readonly jev: JevPolicy
  readonly source: PolicySource
}

export function defaultPolicy(): Policy {
  return { mode: DEFAULT_MODE, executor: DEFAULT_EXECUTOR, cli: {}, lock: false, jev: DEFAULT_JEV, source: "default" }
}

/** The safe default when options are malformed: no capabilities, locked. */
export function failClosedPolicy(): Policy {
  return {
    mode: "off",
    executor: DEFAULT_EXECUTOR,
    cli: {},
    lock: true,
    // Fail-closed also opts the optional Jev capability out explicitly (mode
    // "off" already closes every group; this keeps the intent readable).
    jev: { ...DEFAULT_JEV, enabled: false },
    source: "fail-closed",
  }
}

/** Top-level `ctx.options` keys that configure the effective global policy. */
export interface PolicyGlobalOptions {
  readonly mode?: Mode
  readonly executor?: Partial<ExecutorPolicy>
  readonly cli?: CliAllowlist
  readonly lock?: boolean
  readonly jev?: Partial<JevPolicy>
}

/**
 * The explicit project overlay (`ctx.options.project`). Only values that
 * narrow the global policy; `lock` is deliberately not accepted here (Pi
 * treats lock as a global-only flag). `jev.enabled` may only turn off.
 */
export interface ProjectOverlay {
  readonly mode?: Mode
  readonly executor?: Partial<ExecutorPolicy>
  readonly cli?: CliAllowlist
  readonly jev?: Partial<JevPolicy>
}

export interface ParsedPolicyInput {
  readonly global: PolicyGlobalOptions
  readonly project?: ProjectOverlay
  readonly ignoredKeys: readonly string[]
}

export type PolicyInputValidation =
  | { readonly ok: true; readonly parsed: ParsedPolicyInput }
  | { readonly ok: false; readonly errors: readonly string[] }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseExecutor(
  raw: unknown,
  label: string,
  errors: string[],
): Partial<ExecutorPolicy> | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    errors.push(`${label}.executor must be an object`)
    return undefined
  }
  const parsed: { type?: ExecutorType; timeoutMs?: number } = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === "type") {
      if (value !== "quickjs") errors.push(`${label}.executor.type must be "quickjs"`)
      else parsed.type = "quickjs"
    } else if (key === "timeoutMs") {
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        errors.push(`${label}.executor.timeoutMs must be a positive integer`)
      } else {
        parsed.timeoutMs = value
      }
    } else {
      errors.push(`${label}.executor.${key} is not supported`)
    }
  }
  return parsed
}

function parseJev(raw: unknown, label: string, errors: string[]): Partial<JevPolicy> | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    errors.push(`${label}.jev must be an object`)
    return undefined
  }
  const parsed: { enabled?: boolean; model?: string; timeoutMs?: number } = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === "enabled") {
      if (typeof value !== "boolean") errors.push(`${label}.jev.enabled must be a boolean`)
      else parsed.enabled = value
    } else if (key === "model") {
      if (typeof value !== "string" || value.trim().length === 0 || value.length > JEV_MODEL_MAX_CHARS) {
        errors.push(`${label}.jev.model must be a non-empty string of at most ${JEV_MODEL_MAX_CHARS} chars`)
      } else {
        parsed.model = value
      }
    } else if (key === "timeoutMs") {
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > JEV_MAX_TIMEOUT_MS) {
        errors.push(`${label}.jev.timeoutMs must be a positive integer of at most ${JEV_MAX_TIMEOUT_MS}`)
      } else {
        parsed.timeoutMs = value
      }
    } else {
      errors.push(`${label}.jev.${key} is not supported`)
    }
  }
  return parsed
}

function parseCli(raw: unknown, label: string, errors: string[]): CliAllowlist | undefined {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    errors.push(`${label}.cli must be an object mapping tool names to operation lists`)
    return undefined
  }
  const parsed: Record<string, readonly string[]> = {}
  for (const [tool, operations] of Object.entries(raw)) {
    if (!Array.isArray(operations) || operations.some((operation) => typeof operation !== "string")) {
      errors.push(`${label}.cli.${tool} must be an array of operation name strings`)
      continue
    }
    parsed[tool] = operations as string[]
  }
  return parsed
}

function parseProject(raw: unknown, errors: string[]): ProjectOverlay | undefined {
  if (!isPlainObject(raw)) {
    errors.push("options.project must be an object (project overlay)")
    return undefined
  }
  const parsed: { mode?: Mode; executor?: Partial<ExecutorPolicy>; cli?: CliAllowlist; jev?: Partial<JevPolicy> } = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === "mode") {
      if (!isMode(value)) errors.push('options.project.mode must be one of "off" | "on" | "yolo"')
      else parsed.mode = value
    } else if (key === "executor") {
      const executor = parseExecutor(value, "options.project", errors)
      if (executor) parsed.executor = executor
    } else if (key === "cli") {
      const cli = parseCli(value, "options.project", errors)
      if (cli) parsed.cli = cli
    } else if (key === "jev") {
      const jev = parseJev(value, "options.project", errors)
      if (jev) parsed.jev = jev
    } else {
      // The project overlay is 100% plugin-owned schema: an unknown key here
      // is a malformed narrowing attempt, so it fails closed rather than being
      // silently ignored (which could widen relative to intent).
      errors.push(`options.project.${key} is not supported`)
    }
  }
  return parsed
}

/**
 * Validates raw `ctx.options`. Known keys are checked strictly; unknown
 * TOP-LEVEL keys are recorded in `ignoredKeys` because the top-level options
 * record is host-owned as well (e.g. `hostProbe` is consumed by the plugin
 * entry itself and other tooling may co-locate keys).
 */
export function validatePolicyInput(raw: unknown): PolicyInputValidation {
  if (raw === undefined) return { ok: true, parsed: { global: {}, ignoredKeys: [] } }
  if (!isPlainObject(raw)) return { ok: false, errors: ["plugin options must be a plain object"] }

  const errors: string[] = []
  const ignoredKeys: string[] = []
  const global: {
    mode?: Mode
    executor?: Partial<ExecutorPolicy>
    cli?: CliAllowlist
    lock?: boolean
    jev?: Partial<JevPolicy>
  } = {}
  let project: ProjectOverlay | undefined

  for (const [key, value] of Object.entries(raw)) {
    if (key === "mode") {
      if (!isMode(value)) errors.push('options.mode must be one of "off" | "on" | "yolo"')
      else global.mode = value
    } else if (key === "executor") {
      const executor = parseExecutor(value, "options", errors)
      if (executor) global.executor = executor
    } else if (key === "cli") {
      const cli = parseCli(value, "options", errors)
      if (cli) global.cli = cli
    } else if (key === "lock") {
      if (typeof value !== "boolean") errors.push("options.lock must be a boolean")
      else global.lock = value
    } else if (key === "jev") {
      const jev = parseJev(value, "options", errors)
      if (jev) global.jev = jev
    } else if (key === "project") {
      project = parseProject(value, errors)
    } else {
      ignoredKeys.push(key)
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    parsed: project === undefined ? { global, ignoredKeys } : { global, project, ignoredKeys },
  }
}

export interface NarrowResult {
  readonly policy: Policy
  readonly notes: readonly string[]
  readonly projectApplied: boolean
}

/**
 * Applies the project overlay to an effective global policy using Pi's rules:
 * `mode` and `cli` may only narrow (never widen); `lock: true` ignores project
 * `mode`/`cli` entirely; `executor` shallow-merges with project precedence.
 * Widening attempts are recorded in `notes`, never applied silently.
 */
export function narrowOnly(global: Policy, overlay: ProjectOverlay): NarrowResult {
  const notes: string[] = []
  let projectApplied = false
  let mode = global.mode
  let cli = global.cli
  let jev = global.jev

  if (global.lock) {
    if (overlay.mode !== undefined || overlay.cli !== undefined) {
      notes.push(
        'lock: true — project mode/cli overrides ignored (Pi §2.12; the MCP overlay exception is not modeled in this slice).',
      )
    }
    if (overlay.jev !== undefined) {
      notes.push("lock: true — project jev overrides ignored.")
    }
  } else {
    if (overlay.mode !== undefined) {
      if (modeRank(overlay.mode) <= modeRank(global.mode)) {
        if (overlay.mode !== global.mode) {
          mode = overlay.mode
          projectApplied = true
        }
      } else {
        notes.push(
          `project mode "${overlay.mode}" ignored: it would widen the effective mode "${global.mode}" (narrow-only).`,
        )
      }
    }
    if (overlay.cli !== undefined) {
      const intersection = intersectCli(global.cli, overlay.cli)
      cli = intersection.cli
      if (intersection.changed) projectApplied = true
      notes.push(...intersection.notes)
    }
    if (overlay.jev !== undefined) {
      // `enabled` may only narrow (turn off); model/timeoutMs shallow-merge
      // with project precedence like executor (both stay policy-bounded at
      // parse time: model length, timeoutMs ceiling).
      const enabled = global.jev.enabled && overlay.jev.enabled !== false
      if (overlay.jev.enabled === true && !global.jev.enabled) {
        notes.push('project jev.enabled "true" ignored: the effective global policy disabled jev (narrow-only).')
      }
      const merged: JevPolicy = {
        enabled,
        model: overlay.jev.model ?? global.jev.model,
        timeoutMs: overlay.jev.timeoutMs ?? global.jev.timeoutMs,
      }
      if (
        merged.enabled !== global.jev.enabled ||
        merged.model !== global.jev.model ||
        merged.timeoutMs !== global.jev.timeoutMs
      ) {
        projectApplied = true
      }
      jev = merged
    }
  }

  const executor = overlay.executor !== undefined ? { ...global.executor, ...overlay.executor } : global.executor
  if (executor.type !== global.executor.type || executor.timeoutMs !== global.executor.timeoutMs) {
    projectApplied = true
  }

  return {
    policy: { ...global, mode, cli, executor, jev, source: projectApplied ? "project" : global.source },
    notes,
    projectApplied,
  }
}

function intersectCli(
  global: CliAllowlist,
  overlay: CliAllowlist,
): { cli: CliAllowlist; changed: boolean; notes: string[] } {
  const notes: string[] = []
  const result: Record<string, readonly string[]> = {}
  for (const [tool, operations] of Object.entries(global)) result[tool] = operations

  let changed = false
  for (const [tool, operations] of Object.entries(overlay)) {
    const granted = result[tool]
    if (granted === undefined) {
      notes.push(`project cli tool "${tool}" ignored: not granted by the effective global policy (narrow-only).`)
      continue
    }
    const kept = operations.filter((operation) => granted.includes(operation))
    const rejected = operations.filter((operation) => !granted.includes(operation))
    if (kept.length === 0) {
      delete result[tool]
      changed = true
      notes.push(`project cli tool "${tool}" narrowed to no operations — access removed.`)
    } else {
      result[tool] = kept
      if (kept.length !== granted.length) changed = true
      if (rejected.length > 0) {
        notes.push(`project cli tool "${tool}" ignored operation(s) not granted globally: ${rejected.join(", ")}.`)
      }
    }
  }
  return { cli: result, changed, notes }
}

/** Capability groups the guest surface can expose, gated by mode + policy. */
export interface Capabilities {
  readonly executeTools: boolean
  readonly files: boolean
  readonly cli: boolean
  /**
   * Task 11: the explicit `yolo` shell escape hatch (`shell.run`). Open only
   * when the effective mode is yolo; `on`/`off` keep it closed.
   */
  readonly shell: boolean
  /**
   * Task 7 surface: the `codemode.*` discovery helpers and the dynamic
   * `mcp.<namespace>.<tool>` guests. Enabled whenever mode is not off — the
   * catalog's own selection (disabled / codemode:false / remote / unreachable
   * servers) narrows which namespaces actually exist.
   */
  readonly mcp: boolean
  /**
   * Task 10 (optional): the `jev.ask` guest surface. Enabled whenever mode is
   * not off AND `jev.enabled` is true; runtime availability of the SDK and the
   * TYPESAFE_API_KEY credential is answered by the host adapter per call as a
   * bounded "unavailable" outcome.
   */
  readonly jev: boolean
}

const OFF_CAPABILITIES: Capabilities = {
  executeTools: false,
  files: false,
  cli: false,
  shell: false,
  mcp: false,
  jev: false,
}

/**
 * Which capability groups are enabled: off = none; on = policy-defined
 * (files always, CLI only when the allowlist grants an operation, the MCP
 * surface whenever a catalog is wired, Jev unless opted out); yolo = on + the
 * explicit shell escape hatch (Task 11).
 */
export function capabilitiesFor(policy: Policy): Capabilities {
  if (policy.mode === "off") return OFF_CAPABILITIES
  return {
    executeTools: true,
    files: true,
    cli: Object.values(policy.cli).some((operations) => operations.length > 0),
    shell: policy.mode === "yolo" && isModeAvailable("yolo"),
    mcp: true,
    jev: policy.jev.enabled,
  }
}
