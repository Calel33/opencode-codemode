// src/plugin/register.ts
// Registers the `execute_tools` custom tool + mode enforcement on the
// installed @opencode/plugin@2.0.19 contract (promise flavor):
//   ctx.tool.transform((editor) => editor.add(Tool.Info))
// `options.codemode: false` (flipped from true in Task 4): with
// `codemode: true` the tool was reachable ONLY from inside the host's Code
// Mode runtime — a direct model call failed with "No tool named execute_tools
// is currently available" (Task 2 evidence). The port targets Pi parity =
// direct top-level model exposure.
import type { Plugin } from "@opencode/plugin"
import type { McpCatalog } from "../capabilities/mcp.js"
import type { Capabilities, CliAllowlist, JevPolicy, Mode, Policy } from "../config/policy.js"
import { DEFAULT_JEV, capabilitiesFor, defaultPolicy } from "../config/policy.js"
import { executeTools, formatExecuteToolsResult } from "../codemode/execute-tools.js"
import type { SessionModeStore } from "./command.js"

export const EXECUTE_TOOLS_NAME = "execute_tools"

export const EXECUTE_TOOLS_DESCRIPTION =
  "Execute a TypeScript code body in an isolated guest runtime. The body is wrapped as " +
  "(async function() { ... })() and its return value becomes the tool result. print(...) output " +
  "is captured. The guest has no filesystem, network, environment, or process access."

// JSON Schema (effect JsonSchema.JsonSchema is an open record, so raw literals are valid).
export const EXECUTE_TOOLS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description: "TypeScript code body, wrapped as (async function() { ... })()",
    },
    strings: {
      type: "object",
      propertyNames: { type: "string" },
      additionalProperties: { type: "string" },
      description:
        "Named string constants injected into the guest as π.<key> — e.g. π.script. Use for text that would be " +
        "hard to quote inside code (file content, templates, shell scripts); values need only standard JSON " +
        "escaping. Bounded at 50 KiB serialized; available only for this execution.",
    },
  },
  required: ["code"],
  additionalProperties: false,
} as const

const registrations = new WeakMap<object, { dispose: () => Promise<void> }>()

/** Session mode lookup injected by the plugin entry (src/index.ts). */
export interface ExecuteToolsGate {
  /**
   * Effective mode for an invocation. Defaults to "on" when omitted
   * (registration-only callers, e.g. test harnesses of earlier tasks).
   */
  readonly modeForSession?: (sessionID: string) => Mode
  /**
   * Capability groups for an invocation (capabilitiesFor() over the effective
   * per-session policy). Defaults to the default policy's groups for `mode`.
   */
  readonly capabilitiesForSession?: (sessionID: string) => Capabilities
  /** Effective executor deadline from the resolved global/project policy. */
  readonly executorTimeoutMsForSession?: (sessionID: string) => number
  /**
   * Canonical active checkout root resolved once at setup from ctx.location
   * (src/security/paths.ts resolveActiveRoot). Undefined = unknown → the guest
   * file helpers fail closed at dispatch time.
   */
  readonly activeRoot?: string
  /**
   * Effective CLI allowlist for an invocation (Task 6; policy.cli after
   * narrow-only resolution). Defaults to {} — no `cli` guest surface and
   * every CLI dispatch denied.
   */
  readonly cliAllowlistForSession?: (sessionID: string) => CliAllowlist
  /**
   * Plugin-owned MCP catalog (Task 7). When present and the mcp capability
   * group is on, the catalog is refreshed on use (TTL-bounded) and its live
   * surface is exposed to the guest. The host offers no invocation surface,
   * so this bridge is plugin-owned (host/opencode.ts TASK7_BRIDGE_DEVIATION).
   */
  readonly mcpCatalog?: McpCatalog
  /**
   * Effective Jev policy for an invocation (Task 10). When the jev capability
   * group is on, the pipeline receives it and the guest `jev` surface
   * installs; the credential (TYPESAFE_API_KEY) and the optional SDK are read
   * lazily inside the host adapter per call. Defaults to DEFAULT_JEV —
   * defaults-on so an unconfigured install still passes core tests.
   */
  readonly jevPolicyForSession?: (sessionID: string) => JevPolicy
}

/**
 * Registers execute_tools via ctx.tool.transform. Idempotent per context (a
 * second call with the same ctx is a no-op); the returned cleanup disposes the
 * registration (v2 dispose path) and re-arms the context for a later load.
 */
export async function registerExecuteTools(ctx: Plugin.Context, gate?: ExecuteToolsGate): Promise<Plugin.Cleanup> {
  if (registrations.has(ctx)) return () => {}
  const registration = await ctx.tool.transform((editor) => {
    editor.add({
      name: EXECUTE_TOOLS_NAME,
      description: EXECUTE_TOOLS_DESCRIPTION,
      input: EXECUTE_TOOLS_INPUT_SCHEMA,
      options: { codemode: false },
      execute: async (input, context) => {
        // Session-scoped mode gate (criteria 1 + 4): the decision is made from
        // THIS call's sessionID; no other session is affected.
        const sessionID = String(context.sessionID)
        const mode = gate?.modeForSession?.(sessionID) ?? "on"
        if (mode === "off") {
          return {
            content: "CodeMode is off for this session. Run /codemode on to enable it.",
            metadata: { errorKind: "mode", blocked: true },
          }
        }
        const request = input as { code?: unknown; strings?: unknown } | undefined
        if (typeof request?.code !== "string") {
          return {
            content: "Invalid input: `code` must be a string.",
            metadata: { errorKind: "input", truncated: false },
          }
        }
        // Host environment for the guest helpers (Task 5): per-session
        // capability groups + the setup-time active checkout root. An unknown
        // root (undefined) fails closed inside the dispatcher.
        const capabilities =
          gate?.capabilitiesForSession?.(sessionID) ?? capabilitiesFor({ ...defaultPolicy(), mode })
        // Task 7: refresh the plugin-owned MCP catalog on use (TTL-bounded,
        // deadline-bounded host config read; a catalog failure must not block
        // execution) and expose its live surface through the host environment.
        let mcpCatalog: McpCatalog | undefined
        if (gate?.mcpCatalog !== undefined && capabilities.mcp) {
          try {
            await gate.mcpCatalog.ensureFresh()
            mcpCatalog = gate.mcpCatalog
          } catch {
            // belt and braces: the catalog contract is throw-free
          }
        }
        const result = await executeTools(request.code, {
          timeoutMs: gate?.executorTimeoutMsForSession?.(sessionID),
          signal: context.signal,
          strings: request.strings,
          host: {
            mode,
            capabilities,
            root: gate?.activeRoot,
            cli: gate?.cliAllowlistForSession?.(sessionID) ?? {},
            mcp: mcpCatalog,
            // Task 10: hand the pipeline the effective Jev policy only when
            // the capability group is on; the adapter reads the host env and
            // loads the optional SDK lazily per call.
            jev: capabilities.jev ? { policy: gate?.jevPolicyForSession?.(sessionID) ?? DEFAULT_JEV } : undefined,
          },
        })
        return {
          content: formatExecuteToolsResult(result),
          // Host defect reproduced on opencode 2.0.29 (e2e, differential
          // probe): a metadata property whose value is `undefined` makes the
          // host's `session.tool.success` event encode fail, so the part is
          // never stored, the model receives "Tool result missing", and the
          // call never resolves. Omit absent keys — never emit `undefined`.
          metadata: {
            ...(result.errorKind === undefined ? {} : { errorKind: result.errorKind }),
            logs: result.logs.length,
            truncated: result.truncated,
            elapsedMs: result.elapsedMs,
          },
        }
      },
    })
  })
  registrations.set(ctx, registration)
  return async () => {
    registrations.delete(ctx)
    await registration.dispose()
  }
}

// ---------------------------------------------------------------------------
// Mode enforcement (Task 4, acceptance criterion 4)
//
// Fail-closed design: every decision below is made in process from the
// INVOKING call's sessionID (never from global state), so session scoping is
// provable without relying on unproven host behavior. Host-side native denies
// are deliberately NOT applied yet — see MODE_ENFORCEMENT_FINDING.
// ---------------------------------------------------------------------------

/** Permission rule shape; structurally identical to @opencode/schema Permission.Rule. */
export interface PermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

/**
 * AWAITING HOST PROOF (recorded finding for review): the per-session payload
 * is type-proven — `ctx.session.update({ sessionID, permissions })` with
 * `permissions?: ReadonlyArray<{action, resource, effect}>`
 * (@opencode/client@2.0.19 dist/promise/generated/types.d.ts,
 * SessionUpdateInput) — and the v2 docs describe session-scoped rules
 * evaluated after agent rules (research §3.4). But NO running-host evidence
 * proves that a native write/edit/shell deny set this way isolates to the
 * target session. While that is unproven, NATIVE_DENY_GATE.proven stays false
 * and applyNativeSessionDenies() refuses to write host rules: the plugin
 * denies its own CodeMode surface in process instead of risking blanket
 * rules that could leak into other sessions. Flip the gate only WITH host
 * evidence (candidate: Task 12); both branches are covered by tests.
 */
export const MODE_ENFORCEMENT_FINDING =
  "session-scoped native denies via ctx.session.update: payload surface type-proven, runtime isolation unproven (research §3.4); fail-closed until a host proof exists."

/**
 * Mutable on purpose: flipped to true only once session-scoped native deny
 * isolation is proven in a running host. Tests exercise the true branch with
 * a try/finally restore.
 */
export const NATIVE_DENY_GATE: { proven: boolean } = { proven: false }

export interface ModeEnforcementDesign {
  /** What is enforced session-scoped and provable today. */
  readonly sessionScoped: readonly string[]
  /** What is deliberately not applied, and the fail-closed alternative. */
  readonly failClosed: readonly string[]
  readonly finding: string
}

export const MODE_ENFORCEMENT_DESIGN: ModeEnforcementDesign = {
  sessionScoped: [
    'execute.before blocks execute_tools when the invoking sessionID resolves to mode "off" (throw; the decision reads the call event, never global state).',
    "The registered tool re-checks the session mode before the guest runs (defense in depth).",
    'The permission evaluate hook downgrades CodeMode surface actions ("execute", "execute_tools") to deny only for invocations whose sessionID resolves to "off"; it never upgrades an effect and never touches native tool actions.',
  ],
  failClosed: [
    "Native write/edit/shell denies (Pi write-door matrix §2.8) are not registered while NATIVE_DENY_GATE.proven is false: the runtime isolation of ctx.session.update denies for native tools is unproven.",
    "Instead of blanket rules that could leak into other sessions, the plugin denies its own surface in process (above) — deny/disable rather than guess.",
  ],
  finding: MODE_ENFORCEMENT_FINDING,
}

/**
 * Pi's write-door matrix (research §2.8): in `on`, native write/edit and shell
 * are denied so effects route through CodeMode helpers; `yolo` keeps its own
 * (later) shell story; `off` imposes nothing from the plugin. Action names
 * ("edit", "shell") come from the documented v2 permission action list
 * (research §3.4).
 */
export function nativeSessionDenyRules(mode: Mode): readonly PermissionRule[] {
  if (mode === "on") {
    return [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ]
  }
  return []
}

/**
 * Writes the mode's native session rules through the per-session API — only
 * once the proof gate is flipped. While unproven this returns applied:false
 * and does not touch the host (fail closed).
 */
export async function applyNativeSessionDenies(
  ctx: Plugin.Context,
  sessionID: string,
  mode: Mode,
): Promise<{ readonly applied: boolean; readonly permissions: readonly PermissionRule[]; readonly reason: string }> {
  if (!NATIVE_DENY_GATE.proven) {
    return {
      applied: false,
      permissions: [],
      reason: "fail-closed: session-scoped native denies are not written until a host proof exists (see MODE_ENFORCEMENT_FINDING)",
    }
  }
  const permissions = nativeSessionDenyRules(mode)
  await ctx.session.update({ sessionID, permissions })
  return { applied: true, permissions, reason: "session-scoped rules written via ctx.session.update" }
}

/** Actions that denote the CodeMode-owned surface (docs permissions: denying "execute" removes Code Mode). */
function isCodemodeSurfaceAction(action: string): boolean {
  return action === "execute" || action === EXECUTE_TOOLS_NAME || action.startsWith(`${EXECUTE_TOOLS_NAME}_`)
}

export interface ModeEnforcementDeps {
  readonly sessions: SessionModeStore
  readonly getPolicy: () => Policy
}

const enforcementRegistrations = new WeakMap<object, { dispose: () => Promise<void> }>()

/**
 * Session-scoped, fail-closed enforcement for the CodeMode-owned surface:
 *   - permission evaluate hook: off sessions get the surface denied
 *     (allow/ask -> deny only; a configured deny is final per docs).
 *   - tool execute.before: off sessions are blocked before the tool runs.
 * Both decisions read the invocation's sessionID; nothing is written to the
 * host, so no other session can be affected.
 */
export async function registerModeEnforcement(ctx: Plugin.Context, deps: ModeEnforcementDeps): Promise<Plugin.Cleanup> {
  if (enforcementRegistrations.has(ctx)) return () => {}
  const isOffFor = (sessionID: unknown): boolean =>
    deps.sessions.effective(deps.getPolicy(), String(sessionID)) === "off"

  const permissionRegistration = await ctx.permission.hook("evaluate", (event) => {
    if (event.effect === "deny") return
    if (!isCodemodeSurfaceAction(event.action)) return
    if (!isOffFor(event.sessionID)) return
    event.effect = "deny"
    event.message = "CodeMode is off for this session (opencode-codemode policy). Run /codemode on to enable it."
  })

  const toolRegistration = await ctx.tool.hook("execute.before", (event) => {
    if (event.tool !== EXECUTE_TOOLS_NAME) return
    if (!isOffFor(event.sessionID)) return
    throw new Error(`[opencode-codemode] CodeMode is off for this session (${String(event.sessionID)}). Run /codemode on to enable it.`)
  })

  const registration = {
    dispose: async () => {
      await permissionRegistration.dispose()
      await toolRegistration.dispose()
    },
  }
  enforcementRegistrations.set(ctx, registration)
  return async () => {
    enforcementRegistrations.delete(ctx)
    await registration.dispose()
  }
}
