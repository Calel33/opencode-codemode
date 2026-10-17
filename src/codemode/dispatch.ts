// src/codemode/dispatch.ts
// THE guest -> host bridge (plan §Module boundaries): every guest capability
// request in the QuickJS sandbox crosses here. The dispatcher validates the
// request envelope, applies mode + capability-group gating, then runs the
// registered adapter — errors are DATA (DispatchOutcome), never exceptions
// thrown across the boundary.
//
// Stable extension points for later slices:
//   - Task 6 (CLI): add DispatchCapability entries with group "cli" and pass
//     them to createDispatcher() alongside createFileCapabilities().
//   - Task 7 (MCP/discovery): DELIVERED through this same pattern — group
//     "mcp" in Capabilities (policy.ts), adapters in capabilities/mcp.ts.
//     The host exposes no invocation surface, so the PLUGIN owns the MCP
//     bridge (capabilities/mcp.ts header + host/opencode.ts
//     TASK7_BRIDGE_DEVIATION; research §5.1b).
//   - Guest protocol (createHostCall): request JSON = { capability, input },
//     response JSON = DispatchOutcome. The QuickJS side of this protocol is
//     the single bridge global in globals.ts.
//   - capabilityNames pins the adapter surface for tests and diagnostics.
import type { Capabilities, Mode } from "../config/policy.js"

export type DispatchErrorKind =
  | "mode"
  | "root"
  | "input"
  | "path"
  | "limit"
  | "not-found"
  | "io"
  | "cancelled"
  | "unknown-capability"
  | "unavailable"
  | "internal"

export interface DispatchError {
  readonly kind: DispatchErrorKind
  readonly message: string
}

export type DispatchOutcome =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: DispatchError }

export interface DispatchEnvironment {
  /** Effective session mode; anything reaching dispatch with "off" is denied. */
  readonly mode: Mode
  /** Capability groups from capabilitiesFor(); the group flag gates adapters. */
  readonly capabilities: Capabilities
  /** Canonical active checkout root; undefined = unknown → rooted adapters fail closed. */
  readonly root: string | undefined
  readonly signal?: AbortSignal
}

export interface DispatchCapability {
  /** Adapter name; also the guest capability name in the bridge protocol. */
  readonly name: string
  /** Capability group gating this adapter (Capabilities key from policy.ts). */
  readonly group: keyof Capabilities
  readonly run: (input: unknown, env: DispatchEnvironment) => DispatchOutcome | Promise<DispatchOutcome>
}

export interface DispatchRequest {
  readonly capability: string
  readonly input: unknown
}

export interface Dispatcher {
  readonly capabilityNames: readonly string[]
  dispatch(request: unknown): Promise<DispatchOutcome>
}

/** Error outcome helper for adapters and the dispatcher itself. */
export function dispatchError(kind: DispatchErrorKind, message: string): DispatchOutcome {
  return { ok: false, error: { kind, message } }
}

const MAX_ERROR_CHARS = 2_000

function bounded(message: string): string {
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}...[truncated]` : message
}

function parseRequest(request: unknown): { ok: true; value: DispatchRequest } | { ok: false; outcome: DispatchOutcome } {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return { ok: false, outcome: dispatchError("input", "dispatch request must be an object { capability, input }") }
  }
  const candidate = request as { capability?: unknown; input?: unknown }
  if (typeof candidate.capability !== "string" || candidate.capability.length === 0) {
    return { ok: false, outcome: dispatchError("input", "dispatch request capability must be a non-empty string") }
  }
  return { ok: true, value: { capability: candidate.capability, input: candidate.input } }
}

export function createDispatcher(capabilities: readonly DispatchCapability[], env: DispatchEnvironment): Dispatcher {
  const byName = new Map(capabilities.map((capability) => [capability.name, capability]))
  return {
    capabilityNames: [...byName.keys()],
    async dispatch(request: unknown): Promise<DispatchOutcome> {
      if (env.signal?.aborted) return dispatchError("cancelled", "Execution cancelled")
      const parsed = parseRequest(request)
      if (!parsed.ok) return parsed.outcome
      const capability = byName.get(parsed.value.capability)
      if (!capability) return dispatchError("unknown-capability", `unknown capability: ${parsed.value.capability}`)
      // Defensive re-check at dispatch time: the mode and the capability group
      // are validated here even when an earlier layer already refused — the
      // dispatcher never trusts its caller (acceptance criterion 1).
      if (env.mode === "off") {
        return dispatchError("mode", `CodeMode is off for this session; capability "${capability.name}" is disabled.`)
      }
      if (!env.capabilities[capability.group]) {
        return dispatchError("mode", `capability "${capability.name}" is not enabled by the effective policy`)
      }
      try {
        return await capability.run(parsed.value.input, env)
      } catch (error) {
        return dispatchError("internal", bounded(error instanceof Error ? error.message : String(error)))
      }
    },
  }
}

/** The JSON string-in/string-out transport the QuickJS bridge invokes. */
export type HostCall = (requestJson: string) => Promise<string>

export function createHostCall(dispatcher: Dispatcher): HostCall {
  return async (requestJson: string): Promise<string> => {
    let request: unknown
    try {
      request = JSON.parse(requestJson)
    } catch {
      return JSON.stringify(dispatchError("input", "dispatch request is not valid JSON"))
    }
    return JSON.stringify(await dispatcher.dispatch(request))
  }
}
