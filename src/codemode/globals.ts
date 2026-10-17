// src/codemode/globals.ts
// The guest global surface. Each definition is the single source of truth for
// BOTH uses:
//   runtime: `install` injects it into a fresh QuickJS context
//   types:   `declaration` feeds the typechecker via buildTypeDefs(), so the
//            guest is checked against exactly the globals it actually gets
// As of Task 5: print + read/write/edit. The file helpers are thin guest-side
// wrappers over ONE async host bridge global (HOST_CALL_GLOBAL): the bridge
// returns a guest promise that the host settles later (QuickJSDeferredPromise;
// the sandbox pump loop propagates it), carrying the JSON DispatchOutcome.
// Task 6 adds the `cli` surface: unlike the static file helpers it is DYNAMIC —
// the runtime installer and the typechecker declaration both derive from the
// same source (the effective CLI allowlist ∩ the declared catalog in
// capabilities/cli.ts), so the guest only ever sees reachable
// cli.<tool>.<operation> members. Runtime dispatch still re-validates every
// call; the declaration only narrows what can be NAMED.
// Task 7 adds the `mcp.<namespace>.<tool>` surface and the `codemode.*`
// discovery helpers, derived from the LIVE plugin-owned MCP catalog
// (capabilities/mcp.ts) — installer and declaration read the same entry list.
// Task 8 adds Pi's `codemode.plan_npm_script` / `codemode.run_npm_script`
// helpers (capabilities/npm-scripts.ts) to that same member-list driver,
// gated by the cli capability group (no CLI access → no npm planning).
// The host exposes no tool invocation surface, so the plugin owns the bridge
// (research §5.1b; host/opencode.ts TASK7_BRIDGE_DEVIATION).
// Task 9 adds the `π` string-constants global (strings.ts) to GUEST_GLOBALS:
// declaration and install stay in lockstep because both uses read the array.
// Task 10 adds the optional `jev` surface (capabilities/jev.ts): like cli/mcp
// it exists only when its capability group is on; the install + declaration
// pair comes from the same module.
// Task 11 adds the explicit yolo-only `shell` escape hatch (defined in
// capabilities/cli.ts): install + declaration from the same module, exactly
// when the shell capability group is on.
import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core"
import { SHELL_DECLARATION, SHELL_GLOBAL_NAME, cliSurface } from "../capabilities/cli.js"
import type { CliSurfaceEntry } from "../capabilities/cli.js"
import { JEV_DECLARATION, JEV_GLOBAL_NAME } from "../capabilities/jev.js"
import type { McpSurfaceEntry } from "../capabilities/mcp.js"
import type { CliAllowlist } from "../config/policy.js"
import type { HostCall } from "./dispatch.js"
import { STRINGS_DECLARATION, STRINGS_GLOBAL_NAME } from "./strings.js"

/** Host-side environment handed to guest global installers for one execution. */
export interface GuestEnvironment {
  /** Append one formatted print(...) line to the host's bounded log sink. */
  readonly log: (line: string) => void
  /** True after the sandbox begins teardown; late host results must not touch its VM. */
  readonly isClosed?: () => boolean
  /** Host calls that are still awaiting an async result when the VM closes. */
  readonly pendingHostCalls?: Set<() => void>
  /**
   * The validated guest->host bridge (JSON request in, JSON DispatchOutcome
   * out). Absent when no host environment was configured — the bridge then
   * resolves a structured "unavailable" outcome instead of failing silently.
   */
  readonly hostCall?: HostCall
  /**
   * Effective CLI allowlist (Task 6). The guest `cli` surface — runtime
   * global and typechecker declaration — is exactly allowlist ∩ declared
   * catalog; undefined/empty exposes no `cli` global at all (fail closed).
   */
  readonly cli?: CliAllowlist
  /**
   * Task 7 MCP surface (discovery helpers + mcp.<namespace>.<tool>). Absent
   * when the mcp capability group is off — then neither the `codemode` nor
   * the `mcp` global exists in the guest.
   */
  readonly mcp?: GuestMcpEnvironment
  /**
   * Task 8 npm surface: when true, the `codemode` global also carries Pi's
   * `plan_npm_script` / `run_npm_script`. Gated by the cli capability group:
   * no CLI access → no npm script planning.
   */
  readonly npm?: boolean
  /**
   * Task 9 string constants for this execution (validated by strings.ts at
   * the tool boundary). The `π` global always exists; absent values install
   * as {} (Pi-exact). Never persisted, never shared, never logged.
   */
  readonly strings?: Readonly<Record<string, string>>
  /**
   * Task 10 optional Jev surface: when true, the `jev.ask` global installs.
   * The flag is policy-derived (capability group); credential/SDK
   * availability is answered by the host adapter per call, and the guest
   * never receives the key — only this boolean.
   */
  readonly jev?: boolean
  /**
   * Task 11 explicit shell escape hatch: when true, the `shell.run` global
   * installs (yolo mode only). No ambient shell access — every call crosses
   * the validated dispatcher.
   */
  readonly shell?: boolean
}

export interface GuestGlobal {
  /** Property name on the guest's globalThis. */
  readonly name: string
  /** TypeScript declaration injected into the virtual typecheck source. */
  readonly declaration: string
  /** Injects the global into a fresh guest context (host side). */
  readonly install: (vm: QuickJSContext, env: GuestEnvironment) => void
}

const PRINT: GuestGlobal = {
  name: "print",
  declaration: "declare function print(...args: unknown[]): void;",
  install(vm, env) {
    const print = vm.newFunction("print", (...args: QuickJSHandle[]) => {
      env.log(args.map((arg) => formatDump(vm.dump(arg))).join(" "))
    })
    vm.setProp(vm.global, "print", print)
    print.dispose()
  },
}

/** Guest-visible name of the single async host-call bridge function. */
export const HOST_CALL_GLOBAL = "__codemodeHostCall"

/**
 * Installs the async host-call bridge. The host function returns a guest
 * promise that is settled later, from the host event loop, with the
 * JSON-encoded DispatchOutcome. Ownership notes (quickjs-emscripten-core
 * @0.32.0): the returned deferred.handle transfers to the guest; the value
 * handle passed to resolve is disposed by us after the call. Sandbox teardown
 * settles pending deferreds before disposing the VM; late host results are
 * ignored by the closed-state guard.
 */
function installHostCall(vm: QuickJSContext, env: GuestEnvironment): void {
  const hostCall = env.hostCall
  const unavailable = JSON.stringify({
    ok: false,
    error: { kind: "unavailable", message: "Host capabilities are unavailable in this execution." },
  })
  const bridge = vm.newFunction(HOST_CALL_GLOBAL, (requestHandle: QuickJSHandle) => {
    const requestJson = vm.getString(requestHandle)
    const deferred = vm.newPromise()
    let settled = false
    let cancelPending: () => void
    const settle = (payload: string): void => {
      if (settled || env.isClosed?.() === true || !deferred.alive) {
        env.pendingHostCalls?.delete(cancelPending)
        return
      }
      settled = true
      env.pendingHostCalls?.delete(cancelPending)
      const value = vm.newString(payload)
      deferred.resolve(value)
      value.dispose()
    }
    cancelPending = () => {
      if (settled || !deferred.alive) return
      settled = true
      env.pendingHostCalls?.delete(cancelPending)
      const value = vm.newString(
        JSON.stringify({ ok: false, error: { kind: "cancelled", message: "Execution cancelled" } }),
      )
      deferred.resolve(value)
      value.dispose()
    }
    env.pendingHostCalls?.add(cancelPending)
    const work = hostCall ? hostCall(requestJson) : Promise.resolve(unavailable)
    void work.then(settle, (error: unknown) => {
      settle(
        JSON.stringify({
          ok: false,
          error: { kind: "internal", message: error instanceof Error ? error.message : String(error) },
        }),
      )
    })
    return deferred.handle
  })
  vm.setProp(vm.global, HOST_CALL_GLOBAL, bridge)
  bridge.dispose()
}

/**
 * Defines one file helper as a guest-side wrapper over the bridge. The wrapper
 * parses the JSON outcome and throws a guest-side Error on failure, so guest
 * `await read(...)` behaves like the original package: host failures reject
 * the guest promise, and execute-tools.ts turns an uncaught rejection into a
 * structured runtime error (never a crash).
 */
function fileHelperGlobal(name: string, declaration: string): GuestGlobal {
  return {
    name,
    declaration,
    install(vm: QuickJSContext) {
      const source =
        `globalThis[${JSON.stringify(name)}] = async function (params) {\n` +
        `  const outcome = JSON.parse(await globalThis[${JSON.stringify(HOST_CALL_GLOBAL)}](JSON.stringify({ capability: ${JSON.stringify(name)}, input: params })))\n` +
        `  if (!outcome || outcome.ok !== true) {\n` +
        `    throw new Error(outcome && outcome.error && outcome.error.message ? outcome.error.message : "code mode host call failed")\n` +
        `  }\n` +
        `  return outcome.data\n` +
        `}\n`
      const result = vm.evalCode(source, "codemode-file-helpers.js")
      if (result.error) {
        const message = formatDump(vm.dump(result.error))
        result.error.dispose()
        throw new Error(`failed to install guest helper "${name}": ${message}`)
      }
      result.value.dispose()
    },
  }
}

const READ: GuestGlobal = fileHelperGlobal(
  "read",
  "declare function read(params: { path: string; offset?: number; limit?: number }): Promise<string>;",
)
const WRITE: GuestGlobal = fileHelperGlobal(
  "write",
  "declare function write(params: { path: string; content: string }): Promise<void>;",
)
const EDIT: GuestGlobal = fileHelperGlobal(
  "edit",
  "declare function edit(params: { path: string; edits: Array<{ oldText: string; newText: string }> }): Promise<string>;",
)

// ---------------------------------------------------------------------------
// Dynamic CLI surface (Task 6): allowlist ∩ declared catalog
// ---------------------------------------------------------------------------

/** Guest-visible name of the dynamic CLI surface global. */
export const CLI_GLOBAL_NAME = "cli"

/** Groups the allowlist∩catalog surface by tool (declaration + install). */
function groupCliSurface(surface: readonly CliSurfaceEntry[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  for (const entry of surface) {
    const operations = grouped.get(entry.tool)
    if (operations) operations.push(entry.operation)
    else grouped.set(entry.tool, [entry.operation])
  }
  return grouped
}

/** TypeScript declaration for the allowlisted cli surface (empty = absent). */
function cliDeclaration(surface: readonly CliSurfaceEntry[]): string {
  if (surface.length === 0) return ""
  const grouped = groupCliSurface(surface)
  const lines = [
    "interface CliResult {",
    "  readonly stdout: string;",
    "  readonly stderr: string;",
    "  readonly exitCode: number;",
    "  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean };",
    "}",
    "declare const cli: {",
  ]
  for (const [tool, operations] of grouped) {
    const members = operations
      .map((operation) => `readonly ${operation}: (args?: Record<string, unknown>) => Promise<CliResult>;`)
      .join(" ")
    lines.push(`  readonly ${tool}: { ${members} };`)
  }
  lines.push("};")
  return lines.join("\n")
}

/**
 * Installs the allowlisted cli surface. Every member is a thin guest wrapper
 * over the host bridge with the same failure semantics as the file helpers: a
 * !ok DispatchOutcome throws a guest-side Error carrying the bounded dispatch
 * message (execute-tools turns an uncaught rejection into a structured
 * runtime error). The surface is built from allowlist ∩ catalog only, so no
 * unreachable member exists in the guest.
 */
function installCliGlobal(vm: QuickJSContext, surface: readonly CliSurfaceEntry[]): void {
  if (surface.length === 0) return
  const grouped = groupCliSurface(surface)
  const source: string[] = ["globalThis.cli = {}"]
  for (const tool of grouped.keys()) {
    source.push(`globalThis.cli[${JSON.stringify(tool)}] = {}`)
  }
  for (const entry of surface) {
    const capability = `cli.${entry.tool}.${entry.operation}`
    source.push(
      `globalThis.cli[${JSON.stringify(entry.tool)}][${JSON.stringify(entry.operation)}] = async function (args) {\n` +
        `  const outcome = JSON.parse(await globalThis[${JSON.stringify(HOST_CALL_GLOBAL)}](JSON.stringify({ capability: ${JSON.stringify(capability)}, input: args })))\n` +
        `  if (!outcome || outcome.ok !== true) {\n` +
        `    throw new Error(outcome && outcome.error && outcome.error.message ? outcome.error.message : "code mode host call failed")\n` +
        `  }\n` +
        `  return outcome.data\n` +
        `}\n`,
    )
  }
  const result = vm.evalCode(source.join("\n"), "codemode-cli.js")
  if (result.error) {
    const message = formatDump(vm.dump(result.error))
    result.error.dispose()
    throw new Error(`failed to install the guest cli surface: ${message}`)
  }
  result.value.dispose()
}

// ---------------------------------------------------------------------------
// Task 7 dynamic surfaces: `mcp.<namespace>.<tool>` + `codemode.*` discovery.
// Both derive from the live plugin-owned catalog cache (capabilities/mcp.ts):
// the installer and the typechecker declaration read the same entries, so the
// guest only ever names reachable members. Failure semantics match the CLI
// surface: a !ok DispatchOutcome throws a guest-side Error carrying the
// bounded dispatch message.
// ---------------------------------------------------------------------------

/** Guest-visible name of the dynamic MCP surface global. */
export const MCP_GLOBAL_NAME = "mcp"

/** Guest-visible name of the discovery helpers global. */
export const CODEMODE_GLOBAL_NAME = "codemode"

/** What the guest may see of the live MCP catalog for one execution. */
export interface GuestMcpEnvironment {
  /** Install the codemode.* discovery helpers (mcp capability group enabled). */
  readonly discovery: boolean
  /** Current mcp.<namespace>.<tool> surface (from the live catalog cache). */
  readonly surface: readonly McpSurfaceEntry[]
}

/** Emits one guest-side async wrapper over the host bridge. */
function bridgeMemberSource(target: string, capability: string, argList: string, inputExpr: string): string {
  return (
    `globalThis.${target} = async function (${argList}) {\n` +
    `  const outcome = JSON.parse(await globalThis[${JSON.stringify(HOST_CALL_GLOBAL)}](JSON.stringify({ capability: ${JSON.stringify(capability)}, input: ${inputExpr} })))\n` +
    `  if (!outcome || outcome.ok !== true) {\n` +
    `    throw new Error(outcome && outcome.error && outcome.error.message ? outcome.error.message : "code mode host call failed")\n` +
    `  }\n` +
    `  return outcome.data\n` +
    `}\n`
  )
}

/** Shared eval + install-error handling for the dynamic guest surfaces. */
function evalGuest(vm: QuickJSContext, source: string, label: string): void {
  const result = vm.evalCode(source, `${label}.js`)
  if (result.error) {
    const message = formatDump(vm.dump(result.error))
    result.error.dispose()
    throw new Error(`failed to install ${label}: ${message}`)
  }
  result.value.dispose()
}

/** TypeScript declaration for the live mcp surface (empty = absent). */
function mcpDeclaration(surface: readonly McpSurfaceEntry[]): string {
  if (surface.length === 0) return ""
  const grouped = new Map<string, string[]>()
  for (const entry of surface) {
    const tools = grouped.get(entry.namespace)
    if (tools) tools.push(entry.tool)
    else grouped.set(entry.namespace, [entry.tool])
  }
  const lines = [
    "interface McpToolResult {",
    "  readonly content: unknown;",
    "  readonly isError: boolean;",
    "  readonly truncated: boolean;",
    "}",
    "declare const mcp: {",
  ]
  for (const [namespace, tools] of grouped) {
    const members = tools
      .map((tool) => `readonly ${tool}: (args?: Record<string, unknown>) => Promise<McpToolResult>;`)
      .join(" ")
    lines.push(`  readonly ${namespace}: { ${members} };`)
  }
  lines.push("};")
  return lines.join("\n")
}

/** Installs the `mcp.<namespace>.<tool>` surface over the host bridge. */
function installMcpGlobal(vm: QuickJSContext, surface: readonly McpSurfaceEntry[]): void {
  if (surface.length === 0) return
  const source: string[] = ["globalThis.mcp = {}"]
  const namespaces = new Set(surface.map((entry) => entry.namespace))
  for (const namespace of namespaces) {
    source.push(`globalThis.mcp[${JSON.stringify(namespace)}] = {}`)
  }
  for (const entry of surface) {
    const target = `mcp[${JSON.stringify(entry.namespace)}][${JSON.stringify(entry.tool)}]`
    source.push(bridgeMemberSource(target, `mcp.${entry.namespace}.${entry.tool}`, "args", "args"))
  }
  evalGuest(vm, source.join("\n"), "mcp-surface")
}

/** One `codemode.*` guest member: name, bridge capability, and declaration line. */
interface CodemodeMember {
  readonly name: string
  readonly capability: string
  readonly argList: string
  readonly inputExpr: string
  readonly declaration: string
}

/** Task 7 members: the discovery helpers (live plugin-owned MCP catalog). */
const CODEMODE_DISCOVERY_MEMBERS: readonly CodemodeMember[] = [
  {
    name: "search_tools",
    capability: "codemode.search_tools",
    argList: "params",
    inputExpr: "params",
    declaration:
      "search_tools(params: { query: string; limit?: number }): Promise<{ results: CodemodeToolRef[]; total: number; truncated: boolean }>;",
  },
  {
    name: "list_mcp_servers",
    capability: "codemode.list_mcp_servers",
    argList: "",
    inputExpr: "undefined",
    declaration: "list_mcp_servers(): Promise<{ servers: CodemodeMcpServer[]; truncated: boolean }>;",
  },
  {
    name: "list_tools",
    capability: "codemode.list_tools",
    argList: "params",
    inputExpr: "params",
    declaration:
      "list_tools(params: { namespace: string; offset?: number; limit?: number }): Promise<{ namespace: string; offset: number; limit: number; total: number; tools: CodemodeToolRef[]; truncated: boolean }>;",
  },
  {
    name: "describe_tools",
    capability: "codemode.describe_tools",
    argList: "params",
    inputExpr: "params",
    declaration:
      "describe_tools(params: { namespace: string; tool?: string }): Promise<{ namespace: string; tools: CodemodeToolDetail[]; truncated: boolean }>;",
  },
]

/** Task 8 members: Pi's npm script helpers (capabilities/npm-scripts.ts). */
const CODEMODE_NPM_MEMBERS: readonly CodemodeMember[] = [
  {
    name: "plan_npm_script",
    capability: "codemode.plan_npm_script",
    argList: "params",
    inputExpr: "params",
    declaration: "plan_npm_script(params: { script: string }): Promise<NpmScriptPlan>;",
  },
  {
    name: "run_npm_script",
    capability: "codemode.run_npm_script",
    argList: "params",
    inputExpr: "params",
    declaration: "run_npm_script(params: { script: string; verbose?: boolean }): Promise<NpmScriptRunResult>;",
  },
]

/** Shared type declarations for every codemode.* member (Task 7 + Task 8). */
const CODEMODE_INTERFACES = [
  "interface CodemodeToolRef {",
  "  readonly namespace: string;",
  "  readonly name: string;",
  "  readonly call: string;",
  "  readonly description?: string;",
  "}",
  "interface CodemodeMcpServer {",
  "  readonly name: string;",
  "  readonly namespace: string;",
  "  readonly status: string;",
  "  readonly toolCount: number;",
  "}",
  "interface CodemodeParam {",
  "  readonly name: string;",
  "  readonly type: string;",
  "  readonly required: boolean;",
  "  readonly description?: string;",
  "}",
  "interface CodemodeToolDetail {",
  "  readonly namespace: string;",
  "  readonly name: string;",
  "  readonly call: string;",
  "  readonly description?: string;",
  "  readonly params: CodemodeParam[];",
  "}",
  "interface NpmScriptStep {",
  "  readonly tool: string;",
  "  readonly operation: string;",
  "  readonly args: Record<string, unknown>;",
  "  readonly executable?: string;",
  "  readonly argv?: string[];",
  '  readonly status: "ready" | "blocked";',
  "  readonly reason?: string;",
  "}",
  "interface NpmScriptPlan {",
  "  readonly script: string;",
  "  readonly steps: NpmScriptStep[];",
  "}",
  "interface NpmScriptStepResult {",
  "  readonly tool: string;",
  "  readonly operation: string;",
  "  readonly args: Record<string, unknown>;",
  '  readonly outcome: "ok" | "nonzero-exit" | "error" | "skipped";',
  "  readonly exitCode?: number;",
  "  readonly stdout?: string;",
  "  readonly stderr?: string;",
  "  readonly truncated?: { readonly stdout: boolean; readonly stderr: boolean };",
  "  readonly error?: { readonly kind: string; readonly message: string };",
  "}",
  "interface NpmScriptRunResult {",
  "  readonly script: string;",
  "  readonly results: NpmScriptStepResult[];",
  "}",
].join("\n")

/** The enabled members for one context; ONE list drives declaration + install. */
function codemodeMembers(discovery: boolean, npm: boolean): readonly CodemodeMember[] {
  return [
    ...(discovery ? CODEMODE_DISCOVERY_MEMBERS : []),
    ...(npm ? CODEMODE_NPM_MEMBERS : []),
  ]
}

/** TypeScript declaration for the enabled codemode.* members. */
function codemodeDeclaration(discovery: boolean, npm: boolean): string {
  const members = codemodeMembers(discovery, npm)
  if (members.length === 0) return ""
  return [
    CODEMODE_INTERFACES,
    "declare const codemode: {",
    ...members.map((member) => `  ${member.declaration}`),
    "};",
  ].join("\n")
}

/** Installs the enabled codemode.* members over the host bridge. */
function installCodemodeGlobal(vm: QuickJSContext, members: readonly CodemodeMember[]): void {
  if (members.length === 0) return
  const source = [
    "globalThis.codemode = {}",
    ...members.map((member) =>
      bridgeMemberSource(`codemode.${member.name}`, member.capability, member.argList, member.inputExpr),
    ),
  ]
  evalGuest(vm, source.join("\n"), "codemode-surface")
}

/**
 * Task 9: Pi's `π` string constants. Pi-exact (quickjs-executor.ts:134-136):
 * the global ALWAYS exists — absent values install as {} — as a JSON
 * round-tripped plain object, so a missing key is a plain property read
 * returning undefined. Values live only in this fresh guest context and are
 * nulled by clearGuestGlobals() before vm.dispose().
 */
const PI: GuestGlobal = {
  name: STRINGS_GLOBAL_NAME,
  declaration: STRINGS_DECLARATION,
  install(vm, env) {
    const json = JSON.stringify(env.strings ?? {})
    evalGuest(vm, `globalThis[${JSON.stringify(STRINGS_GLOBAL_NAME)}] = JSON.parse(${JSON.stringify(json)})`, "strings")
  },
}

/**
 * Task 10: the optional TypeSafe `jev` classifier global. Installed only when
 * the jev capability group is on; the wrapper crosses the validated bridge as
 * capability `jev.ask` with `{ state, questions }`, so the host adapter owns
 * every credential/bounds decision. A !ok outcome throws a guest-side Error
 * carrying the bounded, actionable dispatch message (same failure semantics
 * as the cli/mcp surfaces).
 */
function installJevGlobal(vm: QuickJSContext): void {
  evalGuest(
    vm,
    [
      "globalThis.jev = {}",
      bridgeMemberSource("jev.ask", "jev.ask", "state, questions", "{ state: state, questions: questions }"),
    ].join("\n"),
    "jev-surface",
  )
}

/**
 * Task 11: the explicit yolo-only shell escape hatch. The wrapper crosses the
 * validated bridge as capability `shell.run`; the dispatcher's group check
 * (and the adapter's own re-check) deny it in every mode but yolo.
 */
function installShellGlobal(vm: QuickJSContext): void {
  evalGuest(
    vm,
    ["globalThis.shell = {}", bridgeMemberSource("shell.run", "shell.run", "params", "params")].join("\n"),
    "shell-surface",
  )
}

/** Every guest global; extended by later capability slices. */
export const GUEST_GLOBALS: readonly GuestGlobal[] = [PRINT, READ, WRITE, EDIT, PI]

export interface GuestTypeDefsOptions {
  /** Effective CLI allowlist; narrows the declared `cli` surface (Task 6). */
  readonly cli?: CliAllowlist
  /** Task 7 MCP surface; installs the declared `codemode`/`mcp` globals. */
  readonly mcp?: GuestMcpEnvironment
  /** Task 8 npm surface; adds the codemode plan/run helpers (cli group gated). */
  readonly npm?: boolean
  /** Task 10 optional Jev surface; adds the declared `jev` global. */
  readonly jev?: boolean
  /** Task 11 yolo shell escape hatch; adds the declared `shell` global. */
  readonly shell?: boolean
}

/** TypeScript declarations for the guest globals (typechecker input). */
export function buildTypeDefs(options: GuestTypeDefsOptions = {}): string {
  const declarations = GUEST_GLOBALS.map((global) => global.declaration)
  const cli = cliDeclaration(cliSurface(options.cli))
  if (cli.length > 0) declarations.push(cli)
  const codemode = codemodeDeclaration(options.mcp?.discovery === true, options.npm === true)
  if (codemode.length > 0) declarations.push(codemode)
  const mcp = mcpDeclaration(options.mcp?.surface ?? [])
  if (mcp.length > 0) declarations.push(mcp)
  if (options.jev === true) declarations.push(JEV_DECLARATION)
  if (options.shell === true) declarations.push(SHELL_DECLARATION)
  return declarations.join("\n")
}

/** Installs the host-call bridge and every declared guest global into a fresh context. */
export function installGuestGlobals(vm: QuickJSContext, env: GuestEnvironment): void {
  installHostCall(vm, env)
  for (const global of GUEST_GLOBALS) global.install(vm, env)
  installCliGlobal(vm, cliSurface(env.cli))
  const members = codemodeMembers(env.mcp?.discovery === true, env.npm === true)
  if (members.length > 0) installCodemodeGlobal(vm, members)
  installMcpGlobal(vm, env.mcp?.surface ?? [])
  if (env.jev === true) installJevGlobal(vm)
  if (env.shell === true) installShellGlobal(vm)
}

/** Nulls out the bridge and every guest global (cleanup step before vm.dispose()). */
export function clearGuestGlobals(vm: QuickJSContext): void {
  vm.setProp(vm.global, HOST_CALL_GLOBAL, vm.undefined)
  for (const global of GUEST_GLOBALS) vm.setProp(vm.global, global.name, vm.undefined)
  vm.setProp(vm.global, CLI_GLOBAL_NAME, vm.undefined)
  vm.setProp(vm.global, CODEMODE_GLOBAL_NAME, vm.undefined)
  vm.setProp(vm.global, MCP_GLOBAL_NAME, vm.undefined)
  vm.setProp(vm.global, JEV_GLOBAL_NAME, vm.undefined)
  vm.setProp(vm.global, SHELL_GLOBAL_NAME, vm.undefined)
}

/** Host-side rendering of a dumped guest value (print args, error dumps). */
export function formatDump(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
