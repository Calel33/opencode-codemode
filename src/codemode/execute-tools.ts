// src/codemode/execute-tools.ts
// The Code Mode pipeline for one execute_tools call:
//   0. validate the `strings` input at the boundary (Task 9) — an invalid
//      payload returns a bounded "input" error before anything else runs;
//   1. typecheck the wrapped TypeScript body FIRST — a type error returns
//      before any guest execution and before any host side effect;
//   2. run the body in the QuickJS guest sandbox (sandbox.ts + globals.ts
//      surface only — print, the host-mediated read/write/edit helpers (Task
//      5), the allowlisted cli.<tool>.<operation> ops (Task 6), the Task 7
//      codemode.* discovery + mcp.<namespace>.<tool> surface of the
//      plugin-owned catalog, the Task 8 npm plan/run helpers, the Task 9
//      π string constants, the Task 10 optional jev.ask surface, and the Task
//      11 yolo-only shell.run escape hatch — all but π cross the validated
//      dispatcher in dispatch.ts; no ambient host access by construction);
//   3. return a bounded, structured result (logs, value, errors, timing).
//
// Runtime choice (Task 2 GATE 2, recorded with evidence): the built-in OpenCode
// Code Mode runtime is model-facing only — @opencode/plugin@2.0.19 exposes no
// plugin-side execution surface (dist/promise/adapter.js:200-436 constructs no
// execute/codemode handle; ToolDomain has no invoke). The guest runtime is
// therefore QuickJS pinned to the original package's stack
// (quickjs-emscripten-core + @jitl/quickjs-singlefile-mjs-release-sync, 0.32.0).
import { createDispatcher, createHostCall } from "./dispatch.js"
import type { DispatchCapability } from "./dispatch.js"
import { createCliCapabilities, createShellCapabilities } from "../capabilities/cli.js"
import { createFileCapabilities } from "../capabilities/files.js"
import { createJevCapabilities } from "../capabilities/jev.js"
import type { JevEnvironment } from "../capabilities/jev.js"
import { createMcpCapabilities } from "../capabilities/mcp.js"
import type { McpCatalog } from "../capabilities/mcp.js"
import { createNpmScriptCapabilities } from "../capabilities/npm-scripts.js"
import type { Capabilities, CliAllowlist, Mode } from "../config/policy.js"
import { buildTypeDefs, formatDump } from "./globals.js"
import { executeInSandbox } from "./sandbox.js"
import { validateStrings } from "./strings.js"
import { typeCheck } from "./typecheck.js"
import type { TypeDiagnostic } from "./typecheck.js"

export { DEFAULT_MEMORY_LIMIT_BYTES, DEFAULT_TIMEOUT_MS } from "./sandbox.js"

/** Per-call output bound (preserved from the original package): 50 KiB. */
export const MAX_OUTPUT_BYTES = 50 * 1024

export interface ExecuteToolsOptions {
  /** Max guest execution time in ms (default 120000, preserved from the original package). */
  readonly timeoutMs?: number
  /** QuickJS heap limit in bytes (default 64 MiB, preserved from the original package). */
  readonly memoryLimitBytes?: number
  /** Host cancellation signal, propagated from the OpenCode ToolContext. */
  readonly signal?: AbortSignal
  /** Host capability environment for the guest helpers (Task 5). */
  readonly host?: ExecuteToolsHostEnvironment
  /**
   * Task 9: the `strings` tool input exactly as received. Validated HERE at
   * the pipeline boundary before the typechecker and before any guest
   * execution; an invalid payload returns a bounded "input" error and the
   * guest never runs. Absent = no constants (π installs as {}).
   */
  readonly strings?: unknown
}

/** What the guest's host helpers may reach (Task 5; CLI added in Task 6; MCP/discovery in Task 7). */
export interface ExecuteToolsHostEnvironment {
  /** Effective session mode; "off" is refused defensively at dispatch time. */
  readonly mode: Mode
  /** Capability groups from capabilitiesFor(); `files` gates read/write/edit. */
  readonly capabilities: Capabilities
  /** Canonical active checkout root; undefined = unknown → helpers fail closed. */
  readonly root: string | undefined
  /**
   * Effective CLI allowlist (Task 6): gates reachable cli.<tool>.<operation>
   * calls AND narrows the guest `cli` declaration. Also gates the Task 8
   * `codemode.plan_npm_script` / `run_npm_script` helpers (npm-scripts.ts) and
   * their dispatcher adapters. Defaults to no CLI access.
   */
  readonly cli?: CliAllowlist
  /**
   * Plugin-owned MCP catalog (Task 7): feeds the codemode.* discovery helpers,
   * the dynamic mcp.<namespace>.<tool> guest surface, and one dispatcher
   * adapter per current catalog tool. Absent = no codemode/mcp surface.
   */
  readonly mcp?: McpCatalog
  /**
   * Task 10 optional Jev environment: present when the jev capability group
   * is on. Supplies the effective JevPolicy plus (test-injectable) key source
   * and client factory; the credential itself never leaves the host module.
   */
  readonly jev?: JevEnvironment
}

export interface ExecuteToolsResult {
  /** The guest body's return value (undefined when the guest returned nothing). */
  result?: unknown
  /** Captured print(...) lines, bounded to MAX_OUTPUT_BYTES in total. */
  logs: string[]
  /** "input" for an invalid `strings` payload (rejected before execution); "type" when the code was rejected before execution; "runtime" for guest failures. */
  errorKind?: "input" | "type" | "runtime"
  /** Bounded error text (formatted diagnostics, or the guest error/`cancelled`/timeout message). */
  error?: string
  /** Structured type diagnostics (present when errorKind is "type"). */
  diagnostics?: TypeDiagnostic[]
  /** True when logs, the result, or the error text were truncated at the output bound. */
  truncated: boolean
  elapsedMs: number
}

export async function executeTools(code: string, options: ExecuteToolsOptions = {}): Promise<ExecuteToolsResult> {
  const started = Date.now()
  const logs: string[] = []
  let truncated = false

  // Task 9: validate `strings` at the boundary BEFORE the typechecker and
  // before any guest execution. Invalid payloads return a bounded input
  // error as data — nothing runs, nothing is logged.
  const strings = validateStrings(options.strings)
  if (!strings.ok) {
    return {
      logs,
      errorKind: "input",
      error: strings.reason,
      truncated: false,
      elapsedMs: Date.now() - started,
    }
  }

  // Task 7: the guest-visible MCP surface comes from the live catalog cache.
  // The typechecker declaration and the runtime installer must agree on
  // exactly these entries, so it is computed once, up front.
  const host = options.host
  const mcpGuest =
    host !== undefined && host.capabilities.mcp && host.mcp !== undefined
      ? { discovery: true, surface: host.mcp.surface() }
      : undefined
  // Task 8: the npm script helpers ride the cli capability group (no CLI
  // access → no npm planning surface). Execution goes through the validated
  // dispatcher; the adapters re-check the allowlist for every step.
  const npmGuest = host !== undefined && host.capabilities.cli ? true : undefined
  // Task 10: the optional jev.ask surface, policy-gated like every other
  // group. Credential/SDK availability is answered per call by the host
  // adapter (capabilities/jev.ts) as a bounded, actionable outcome.
  const jevGuest = host !== undefined && host.capabilities.jev && host.jev !== undefined ? true : undefined
  // Task 11: the explicit shell escape hatch (yolo only). In off/on neither
  // the guest global nor the declaration exists; the dispatcher's group check
  // still denies a raw bridge call (the adapter is registered unconditionally).
  const shellGuest = host !== undefined && host.capabilities.shell ? true : undefined

  // 1. Typecheck first: on invalid code, nothing has run yet — no guest
  //    execution, no print capture, no host side effect of any kind.
  const { diagnostics } = typeCheck(
    code,
    buildTypeDefs({ cli: host?.cli, mcp: mcpGuest, npm: npmGuest, jev: jevGuest, shell: shellGuest }),
  )
  if (diagnostics.length > 0) {
    const bounded = boundText(formatTypeDiagnostics(diagnostics))
    return {
      logs,
      errorKind: "type",
      error: bounded.text,
      diagnostics,
      truncated: bounded.truncated,
      elapsedMs: Date.now() - started,
    }
  }

  // 2. Run the body in the isolated guest. The host surface is print(...),
  //    the guest file helpers, the allowlisted CLI ops, and the Task 7
  //    codemode.* / mcp.<namespace>.<tool> surface — all crossing ONE
  //    validated dispatcher per execution (dispatch.ts). Without a host
  //    environment the bridge resolves a structured "unavailable" outcome —
  //    helpers never fail silently.
  const hostCapabilities: DispatchCapability[] = [
    ...createFileCapabilities(),
    ...createCliCapabilities(host?.cli ?? {}),
    ...createShellCapabilities(),
    ...createNpmScriptCapabilities({ allowlist: host?.cli ?? {} }),
  ]
  if (host !== undefined && host.capabilities.mcp && host.mcp !== undefined) {
    hostCapabilities.push(
      ...createMcpCapabilities({ catalog: host.mcp, cli: host.cli ?? {}, files: host.capabilities.files }),
    )
  }
  if (host !== undefined && host.capabilities.jev && host.jev !== undefined) {
    hostCapabilities.push(...createJevCapabilities(host.jev))
  }
  const hostCall =
    host === undefined
      ? undefined
      : createHostCall(
          createDispatcher(hostCapabilities, {
            mode: host.mode,
            capabilities: host.capabilities,
            root: host.root,
            signal: options.signal,
          }),
        )

  const sandbox = await executeInSandbox(code, {
    timeoutMs: options.timeoutMs,
    memoryLimitBytes: options.memoryLimitBytes,
    signal: options.signal,
    hostCall,
    cli: options.host?.cli,
    mcp: mcpGuest,
    npm: npmGuest,
    strings: strings.strings,
    jev: jevGuest,
    shell: shellGuest,
    onPrint: (line) => {
      if (truncated) return
      truncated = appendBounded(logs, line)
    },
  })

  if (sandbox.error) {
    const bounded = boundText(sandbox.error.message)
    return {
      logs,
      errorKind: "runtime",
      error: bounded.text,
      truncated: truncated || bounded.truncated,
      elapsedMs: Date.now() - started,
    }
  }

  const boundedResult = boundResult(sandbox.value)
  return {
    result: boundedResult.value,
    logs,
    truncated: truncated || boundedResult.truncated,
    elapsedMs: Date.now() - started,
  }
}

/** Human/model-readable rendering of an execution result for Tool.Result.content. */
export function formatExecuteToolsResult(result: ExecuteToolsResult): string {
  const parts: string[] = []
  if (result.logs.length > 0) parts.push(result.logs.join("\n"))
  if (result.error !== undefined) {
    parts.push(
      result.errorKind === "type"
        ? `Type errors (code was NOT executed):\n${result.error}\n\nFix the type errors and try again.`
        : result.errorKind === "input"
          ? `Input error: ${result.error}`
          : `Runtime error: ${result.error}`,
    )
  } else if (result.result !== undefined) {
    parts.push(formatDump(result.result))
  }
  if (parts.length === 0) parts.push("(no output)")
  return parts.join("\n")
}

function formatTypeDiagnostics(diagnostics: TypeDiagnostic[]): string {
  return diagnostics
    .map((diagnostic) => (diagnostic.line > 0 ? `Line ${diagnostic.line}: ${diagnostic.message}` : diagnostic.message))
    .join("\n")
}

function appendBounded(logs: string[], line: string): boolean {
  const capKib = MAX_OUTPUT_BYTES / 1024
  const used = logs.reduce((total, entry) => total + byteLength(entry) + 1, 0)
  const remaining = MAX_OUTPUT_BYTES - used
  if (remaining <= 0) return true
  if (byteLength(line) <= remaining) {
    logs.push(line)
    return false
  }
  const marker = `[output truncated at ${capKib} KiB]`
  logs.push(truncateToBytes(line, Math.max(remaining - byteLength(marker) - 1, 0)), marker)
  return true
}

function boundResult(value: unknown): { value: unknown; truncated: boolean } {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    serialized = undefined
  }
  if (serialized === undefined) return { value, truncated: false }
  if (byteLength(serialized) <= MAX_OUTPUT_BYTES) return { value, truncated: false }
  return {
    value: `${truncateToBytes(serialized, MAX_OUTPUT_BYTES)}[result truncated at ${MAX_OUTPUT_BYTES / 1024} KiB]`,
    truncated: true,
  }
}

function boundText(text: string): { text: string; truncated: boolean } {
  if (byteLength(text) <= MAX_OUTPUT_BYTES) return { text, truncated: false }
  const marker = `[error truncated at ${MAX_OUTPUT_BYTES / 1024} KiB]`
  return {
    text: `${truncateToBytes(text, Math.max(MAX_OUTPUT_BYTES - byteLength(marker) - 1, 0))}${marker}`,
    truncated: true,
  }
}

function truncateToBytes(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length <= maxBytes) return value
  return new TextDecoder().decode(bytes.subarray(0, maxBytes))
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}
