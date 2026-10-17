// src/capabilities/mcp.ts
// TASK 7 — plugin-owned MCP bridge + `codemode.*` discovery + `mcp.<ns>.<tool>`.
//
// DESIGN DEVIATION (recorded, acceptance criterion 4; see also
// src/host/opencode.ts TASK7_BRIDGE_DEVIATION):
//   "host provides no invocation surface; plugin owns the bridge
//    (research §5.1b)".
// The installed @opencode/plugin@2.0.19 contract exposes tool REGISTRATION and
// MCP CONFIG management only (ToolDomain = transform|reload|list|hook;
// MCPDomain = transform|reload|list) — there is no documented plugin-side way
// to invoke a registered host tool or a host-connected MCP tool. Per the
// workflow's own stop condition the plugin therefore re-implements the bridge
// INSIDE the plugin (research §5.1 option b, mirrored from Pi's self-contained
// client): a local-stdio MCP client + tool catalog owned by this plugin, and a
// runtime `mcp.<namespace>.<tool>` guest surface fed through the SAME
// validated dispatcher as every other capability. No ctx.tool.list() item's
// execute() is ever called and no host-private endpoint is used anywhere.
//
// Client path choice (evidence-recorded):
//   - `@modelcontextprotocol/client@2.3.1` (exact pin; Pi mirrored the same
//     package at ^2.0.0). Verified on this stack BEFORE adoption: npm view
//     (engines node>=20, ESM+CJS) plus a real-stdio smoke under BOTH
//     node 24.18.0 and bun 1.4.3 (spawn -> initialize -> tools/list ->
//     tools/call -> isError -> close) — see the Task 7 report. The default
//     connection factory below is that SDK's StdioClientTransport; tests
//     inject a fake at this seam only.
//   - Remote (HTTP/SSE) servers are deliberately NOT connected in this slice:
//     they need auth/oauth handling beyond scope. Selection records a bounded
//     note and the namespace stays absent — local stdio only, rather than a
//     half-implemented remote path.
//
// Bounds (all counts/sizes bounded, no unbounded polling):
//   - list_tools: limit clamped 1..100, default 50 (Pi parity, research §2.10)
//   - search_tools: default 25, max 50 (Pi default 25)
//   - per-server tool catalog capped at MCP_MAX_TOOLS_PER_SERVER; servers at
//     MCP_MAX_SERVERS; descriptions at MCP_MAX_DESCRIPTION_CHARS; call results
//     at MCP_MAX_RESULT_BYTES (50 KiB, Pi semantics); errors at
//     MCP_MAX_ERROR_CHARS.
//   - connect/list/call timeouts are per-operation (defaults 30 s/30 s/120 s);
//     a timed-out call CLOSES the connection (the child is killed).
//   - freshness: catalog TTL 30 s on use + explicit refresh (the /codemode
//     refresh command) + a bounded re-list when a lookup misses or the cache
//     is stale. Never a polling loop.
// Logging: capability name + duration + status only (never tool args).
import type { CliAllowlist } from "../config/policy.js"
import { dispatchError } from "../codemode/dispatch.js"
import type { DispatchCapability, DispatchEnvironment, DispatchOutcome } from "../codemode/dispatch.js"
import { CLI_TOOLS, cliSurface } from "./cli.js"

// ---------------------------------------------------------------------------
// Constants (documented bounds)
// ---------------------------------------------------------------------------

export const MCP_SEARCH_DEFAULT_LIMIT = 25
export const MCP_SEARCH_MAX_LIMIT = 50
export const MCP_LIST_DEFAULT_LIMIT = 50
export const MCP_LIST_MAX_LIMIT = 100
export const MCP_MAX_TOOLS_PER_SERVER = 200
export const MCP_MAX_SERVERS = 16
export const MCP_MAX_RESULT_BYTES = 50 * 1024
export const MCP_MAX_SCHEMA_PARAMS = 40
export const MCP_MAX_DESCRIPTION_CHARS = 300
export const MCP_MAX_ERROR_CHARS = 400
export const MCP_CATALOG_TTL_MS = 30_000
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 30_000
export const DEFAULT_MCP_LIST_TIMEOUT_MS = 30_000
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 120_000

const VALIDATION_DEPTH_CAP = 6

// ---------------------------------------------------------------------------
// Namespace / tool-name sanitization (Pi toNamespace parity, research §2.11)
// ---------------------------------------------------------------------------

/** Server name -> guest namespace: strip a trailing `-mcp`/`mcp`, map illegal characters to `_`, keep the member a valid identifier. */
export function sanitizeNamespace(serverName: string): string {
  let ns = serverName.replace(/-?mcp$/i, "").replace(/[^a-zA-Z0-9_$]/g, "_")
  if (!ns) ns = "mcp"
  return /^[0-9]/.test(ns) ? `_${ns}` : ns
}

/** Tool name -> guest member: same mapping, no mcp stripping. */
export function sanitizeToolName(toolName: string): string {
  const sanitized = toolName.replace(/[^a-zA-Z0-9_$]/g, "_")
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized : `_${sanitized}`
}

// ---------------------------------------------------------------------------
// Server selection from host config (ctx.mcp.list() entries)
// ---------------------------------------------------------------------------

export interface McpLocalServerConfig {
  readonly type: "local"
  readonly command: readonly string[]
  readonly cwd?: string
  readonly environment?: Readonly<Record<string, string>>
}

export interface McpServerSelection {
  readonly name: string
  readonly namespace: string
  readonly config: McpLocalServerConfig
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boundText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...[truncated]` : text
}

/**
 * Selects the MCP servers this plugin will own a connection to. Included:
 * local stdio servers that are not `disabled` and not `codemode: false`
 * (OpenCode's codemode flag defaults to true = expose through Code Mode).
 * Everything else produces a bounded note — nothing fails loudly.
 */
export function selectMcpServers(entries: unknown): { servers: McpServerSelection[]; notes: string[] } {
  const servers: McpServerSelection[] = []
  const notes: string[] = []
  const seen = new Set<string>()
  if (!Array.isArray(entries)) {
    return { servers, notes: ["mcp server config is not an array; no servers selected"] }
  }
  for (const entry of entries) {
    if (servers.length >= MCP_MAX_SERVERS) {
      notes.push(`more than ${MCP_MAX_SERVERS} MCP servers configured; the remainder are ignored`)
      break
    }
    if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] !== "string" || entry[0].length === 0) {
      notes.push("ignored a malformed MCP server entry (expected [name, config])")
      continue
    }
    const name = entry[0]
    const config = entry[1]
    if (!isPlainObject(config)) {
      notes.push(`mcp server "${name}" is not a supported config object; skipped`)
      continue
    }
    if (config.disabled === true) {
      notes.push(`mcp server "${name}" is disabled; skipped`)
      continue
    }
    if (config.codemode === false) {
      notes.push(`mcp server "${name}" sets codemode: false (exposed directly, not through codemode); skipped`)
      continue
    }
    if (config.type === "remote") {
      notes.push(`mcp server "${name}" is remote (type: "remote"); remote MCP servers are not supported in this slice (local stdio only)`)
      continue
    }
    if (config.type !== "local") {
      notes.push(`mcp server "${name}" has an unknown type; skipped`)
      continue
    }
    const command = config.command
    if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0)) {
      notes.push(`mcp server "${name}" has no usable command array; skipped`)
      continue
    }
    const cwd = typeof config.cwd === "string" && config.cwd.length > 0 ? config.cwd : undefined
    let environment: Record<string, string> | undefined
    if (isPlainObject(config.environment)) {
      environment = {}
      for (const [key, value] of Object.entries(config.environment)) {
        if (typeof value === "string") environment[key] = value
      }
    }
    const namespace = sanitizeNamespace(name)
    if (seen.has(namespace)) {
      notes.push(`mcp server "${name}" maps to namespace "${namespace}" already used; skipped`)
      continue
    }
    seen.add(namespace)
    servers.push({
      name,
      namespace,
      config: {
        type: "local",
        command: command as string[],
        ...(cwd === undefined ? {} : { cwd }),
        ...(environment === undefined ? {} : { environment }),
      },
    })
  }
  return { servers, notes }
}

// ---------------------------------------------------------------------------
// Bounded input-schema validation subset (hand-rolled; no Ajv dependency —
// repo precedent from capabilities/cli.ts). Recognized keywords: type
// (object/array/string/number/integer/boolean/null), required, properties,
// additionalProperties: false, enum, items; recursion is depth-capped. Schema
// features outside the subset are IGNORED (never trusted to widen the call):
// the argument object shape is still enforced.
// ---------------------------------------------------------------------------

export type ArgValidation = { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly message: string }

export function validateToolArgs(schema: unknown, args: unknown): ArgValidation {
  const usable =
    isPlainObject(schema) &&
    (schema.type === "object" ||
      (schema.type === undefined && (isPlainObject(schema.properties) || Array.isArray(schema.required))))
  if (!usable) {
    if (args === undefined) return { ok: true, value: {} }
    if (isPlainObject(args)) return { ok: true, value: args }
    return { ok: false, message: "tool arguments must be an object" }
  }
  const value = args === undefined ? {} : args
  if (!isPlainObject(value)) return { ok: false, message: "tool arguments must be an object" }
  const checked = checkObject(schema, value, 0)
  if (!checked.ok) return checked
  return { ok: true, value }
}

function checkObject(schema: Record<string, unknown>, value: Record<string, unknown>, depth: number): { ok: true } | { ok: false; message: string } {
  const properties = isPlainObject(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === "string") : []
  for (const key of required) {
    if (!(key in value) || value[key] === undefined) {
      return { ok: false, message: `missing required property "${key}"` }
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    const propSchema = properties[key]
    if (propSchema === undefined) {
      if (schema.additionalProperties === false) {
        return { ok: false, message: `unexpected property "${key}"` }
      }
      continue
    }
    const checked = checkValue(propSchema, entry, depth + 1)
    if (!checked.ok) return { ok: false, message: `property "${key}": ${checked.message}` }
  }
  return { ok: true }
}

function checkValue(schema: unknown, value: unknown, depth: number): { ok: true } | { ok: false; message: string } {
  if (depth > VALIDATION_DEPTH_CAP) return { ok: true } // documented bound: stop descending
  if (!isPlainObject(schema)) return { ok: true }
  const type = typeof schema.type === "string" ? schema.type : undefined
  if (type !== undefined && matchType(type, value) === false) {
    return { ok: false, message: `expected ${type}` }
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && !schema.enum.some((candidate) => candidate === value)) {
    return { ok: false, message: `expected one of ${schema.enum.map(String).join(", ")}` }
  }
  if (isPlainObject(value) && (type === "object" || (type === undefined && isPlainObject(schema.properties)))) {
    return checkObject(schema, value, depth)
  }
  if (type === "array" && Array.isArray(value) && isPlainObject(schema.items)) {
    for (let index = 0; index < value.length; index++) {
      const item = checkValue(schema.items, value[index], depth + 1)
      if (!item.ok) return { ok: false, message: `[${index}]: ${item.message}` }
    }
  }
  return { ok: true }
}

function matchType(type: string, value: unknown): boolean | undefined {
  switch (type) {
    case "string":
      return typeof value === "string"
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "boolean":
      return typeof value === "boolean"
    case "array":
      return Array.isArray(value)
    case "object":
      return isPlainObject(value)
    case "null":
      return value === null
    default:
      return undefined // unknown type keyword: not checked (documented subset)
  }
}

// ---------------------------------------------------------------------------
// Connection seam (the SDK stdio transport by default; fakes in unit tests)
// ---------------------------------------------------------------------------

export interface McpToolInfo {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: unknown
}

export interface McpToolResult {
  readonly content: unknown
  readonly isError: boolean
  readonly truncated: boolean
}

export interface McpConnection {
  listTools(): Promise<readonly McpToolInfo[]>
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>
  close(): Promise<void>
}

export interface McpConnectionTimeouts {
  readonly connectMs: number
  readonly listMs: number
  readonly callMs: number
}

export interface McpConnectionFactory {
  (config: McpLocalServerConfig, timeouts: McpConnectionTimeouts): Promise<McpConnection>
}

class McpTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`)
  }
}

class McpCancelledError extends Error {
  constructor() {
    super("Execution cancelled")
  }
}

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
  onTimeout: () => void,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortHandler: (() => void) | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout()
      } catch {
        // timeout handling must never mask the rejection
      }
      reject(new McpTimeoutError(label, ms))
    }, ms)
  })
  const cancelled = new Promise<never>((_, reject) => {
    if (!signal) return
    abortHandler = () => {
      try {
        onTimeout()
      } catch {
        // cancellation cleanup must not mask the cancellation
      }
      reject(new McpCancelledError())
    }
    if (signal.aborted) abortHandler()
    else signal.addEventListener("abort", abortHandler, { once: true })
  })
  try {
    return await Promise.race([work, deadline, cancelled])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abortHandler !== undefined) signal?.removeEventListener("abort", abortHandler)
  }
}

/**
 * Default factory: `@modelcontextprotocol/client@2.3.1` over real stdio.
 * cwd/env come from HOST config only (credentials never touch guest code);
 * env defaults to the SDK's safe inherited subset unless the host config
 * provides one. The structural client type keeps compile coupling to the
 * package's smallest stable surface (verified by the Task 7 smoke under node
 * and bun).
 */
interface SdkClientLike {
  connect(transport: unknown, options?: { timeout?: number }): Promise<void>
  listTools(): Promise<{ tools?: ReadonlyArray<{ name?: unknown; description?: unknown; inputSchema?: unknown }> }>
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{ content?: unknown; isError?: unknown }>
  close(): Promise<void>
}

async function sdkConnectionFactory(config: McpLocalServerConfig, timeouts: McpConnectionTimeouts): Promise<McpConnection> {
  const [{ Client }, { StdioClientTransport, getDefaultEnvironment }] = await Promise.all([
    import("@modelcontextprotocol/client"),
    import("@modelcontextprotocol/client/stdio"),
  ])
  const [executable, ...args] = config.command
  const transport = new StdioClientTransport({
    command: executable,
    args,
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    ...(config.environment === undefined ? {} : { env: { ...getDefaultEnvironment(), ...config.environment } }),
  })
  const client = new Client({ name: "opencode-codemode", version: "0.1.0" }) as unknown as SdkClientLike
  const closeQuietly = (): void => {
    try {
      void client.close().catch(() => {})
    } catch {
      // closing must never throw from a timeout path
    }
  }
  await withTimeout(client.connect(transport, { timeout: timeouts.connectMs }), timeouts.connectMs, `MCP connect (${executable})`, closeQuietly)
  return {
    async listTools(): Promise<readonly McpToolInfo[]> {
      const listed = await withTimeout(client.listTools(), timeouts.listMs, "MCP tools/list", closeQuietly)
      const tools = Array.isArray(listed?.tools) ? listed.tools : []
      return tools
        .filter((tool): tool is { name: string } & typeof tool => typeof tool?.name === "string" && tool.name.length > 0)
        .map((tool) => ({
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        }))
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
      const result = await withTimeout(client.callTool({ name, arguments: args }), timeouts.callMs, `MCP tools/call ${name}`, closeQuietly)
      return { content: result?.content, isError: result?.isError === true, truncated: false }
    },
    async close(): Promise<void> {
      closeQuietly()
    },
  }
}

// ---------------------------------------------------------------------------
// Catalog: connections + caches + bounds (freshness: TTL on use, explicit
// refresh, bounded re-list on a lookup miss)
// ---------------------------------------------------------------------------

export interface McpCatalogDeps {
  /** Host MCP config entries: ctx.mcp.list() shape ([name, ServerConfig][]; value or promise). */
  readonly servers: () => unknown
  /** Connection factory override (tests); defaults to the SDK stdio factory. */
  readonly connect?: McpConnectionFactory
  readonly log?: (line: string) => void
  readonly now?: () => number
  readonly catalogTtlMs?: number
  readonly connectTimeoutMs?: number
  readonly listTimeoutMs?: number
  readonly callTimeoutMs?: number
  readonly maxToolsPerServer?: number
  readonly maxServers?: number
}

export interface McpSurfaceEntry {
  readonly namespace: string
  readonly tool: string
}

export interface McpServerSummary {
  readonly name: string
  readonly namespace: string
  readonly status: "cold" | "ready" | "failed"
  readonly toolCount: number
}

export interface McpCachedToolRef {
  readonly namespace: string
  readonly name: string
  readonly guest: string
  readonly description?: string
  readonly inputSchema?: unknown
}

type ServerStatus = "cold" | "ready" | "failed"

interface ServerState {
  name: string
  namespace: string
  config: McpLocalServerConfig
  status: ServerStatus
  connection?: McpConnection
  tools: McpCachedToolRef[]
  listedAt?: number
  lastError?: string
  /** Connection opened while staging a refresh; never set on committed entries (discard identity check). */
  opened?: McpConnection
}

function sameConfig(a: McpLocalServerConfig, b: McpLocalServerConfig): boolean {
  return (
    a.command.join("\u0000") === b.command.join("\u0000") &&
    (a.cwd ?? "") === (b.cwd ?? "") &&
    JSON.stringify(a.environment ?? {}) === JSON.stringify(b.environment ?? {})
  )
}

export class McpCatalog {
  readonly #deps: McpCatalogDeps
  #state = new Map<string, ServerState>()
  #lastRefreshAt: number | undefined
  /** Latest-started refresh wins: only the most recently started refresh() may commit. */
  #refreshSeq = 0
  /** Bumped by every config-read failure; an in-flight refresh from before the failure can never commit. */
  #invalidationEpoch = 0
  /** Set by dispose(): no refresh may start, and no in-flight refresh may commit. */
  #disposed = false
  /** Refreshes still running; dispose() awaits them so their discard cleanup (closes) completes. */
  #activeRefreshes = new Set<Promise<void>>()

  constructor(deps: McpCatalogDeps) {
    this.#deps = deps
  }

  #now(): number {
    return this.#deps.now ? this.#deps.now() : Date.now()
  }

  #log(line: string): void {
    try {
      this.#deps.log?.(boundText(line, 240))
    } catch {
      // logging must never break the catalog
    }
  }

  #ttl(): number {
    return this.#deps.catalogTtlMs ?? MCP_CATALOG_TTL_MS
  }

  #timeouts(): McpConnectionTimeouts {
    return {
      connectMs: this.#deps.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS,
      listMs: this.#deps.listTimeoutMs ?? DEFAULT_MCP_LIST_TIMEOUT_MS,
      callMs: this.#deps.callTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS,
    }
  }

  #factory(): McpConnectionFactory {
    return this.#deps.connect ?? sdkConnectionFactory
  }

  async #closeServer(server: ServerState): Promise<void> {
    const connection = server.connection
    server.connection = undefined
    if (server.opened === connection) server.opened = undefined
    if (!connection) return
    try {
      await connection.close()
    } catch {
      // closing must never throw
    }
  }

  async #connectionFor(server: ServerState, signal?: AbortSignal, staged = false): Promise<McpConnection | undefined> {
    if (signal?.aborted) return undefined
    if (server.connection) return server.connection
    const started = this.#now()
    let stopped = false
    const stop = (): void => {
      stopped = true
      void this.#closeServer(server)
    }
    try {
      const pending = this.#factory()(server.config, this.#timeouts()).then(async (connection) => {
        if (
          stopped ||
          signal?.aborted ||
          this.#disposed ||
          (!staged && this.#state.get(server.namespace) !== server)
        ) {
          try {
            await connection.close()
          } catch {
            // A late or detached connection must not outlive the catalog.
          }
          return undefined
        }
        server.connection = connection
        if (staged) server.opened = connection
        this.#log(`mcp: connected "${server.namespace}" in ${this.#now() - started}ms`)
        return connection
      })
      return await withTimeout(pending, this.#timeouts().connectMs, `MCP connect (${server.config.command[0]})`, stop, signal)
    } catch (error) {
      if (error instanceof McpCancelledError) return undefined
      server.status = "failed"
      server.lastError = boundText(errorMessage(error), MCP_MAX_ERROR_CHARS)
      this.#log(`mcp: connect failed for "${server.name}": ${server.lastError}`)
      return undefined
    }
  }

  /** Bounded re-list of one server's tools. Never throws; on failure the previous cache is kept. */
  async #listTools(server: ServerState, signal?: AbortSignal, staged = false): Promise<{ relisted: boolean }> {
    const connection = await this.#connectionFor(server, signal, staged)
    if (!connection || signal?.aborted) return { relisted: true }
    const started = this.#now()
    try {
      const listed = await withTimeout(connection.listTools(), this.#timeouts().listMs, `MCP tools/list (${server.namespace})`, () => {
        void this.#closeServer(server)
      }, signal)
      const cap = this.#deps.maxToolsPerServer ?? MCP_MAX_TOOLS_PER_SERVER
      const tools: McpCachedToolRef[] = []
      const seenGuest = new Set<string>()
      for (const tool of listed) {
        if (tools.length >= cap) break
        const guest = sanitizeToolName(tool.name)
        if (guest.length === 0 || seenGuest.has(guest)) continue
        seenGuest.add(guest)
        tools.push({
          namespace: server.namespace,
          name: tool.name,
          guest,
          ...(tool.description === undefined || tool.description.length === 0
            ? {}
            : { description: boundText(tool.description, MCP_MAX_DESCRIPTION_CHARS) }),
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        })
      }
      tools.sort((a, b) => (a.guest < b.guest ? -1 : a.guest > b.guest ? 1 : 0))
      server.tools = tools
      server.status = "ready"
      server.listedAt = this.#now()
      server.lastError = undefined
      this.#log(`mcp: "${server.namespace}" listed ${tools.length} tool(s) in ${this.#now() - started}ms`)
      return { relisted: true }
    } catch (error) {
      if (error instanceof McpCancelledError) return { relisted: true }
      server.status = "failed"
      server.lastError = boundText(errorMessage(error), MCP_MAX_ERROR_CHARS)
      this.#log(`mcp: tools/list failed for "${server.name}": ${server.lastError}`)
      return { relisted: true }
    }
  }

  /** TTL-based freshness for one server; re-lists iff cold or stale. */
  async #ensureTools(server: ServerState, signal?: AbortSignal): Promise<{ relisted: boolean }> {
    if (signal?.aborted) return { relisted: true }
    if (server.connection && server.status === "ready" && server.listedAt !== undefined && this.#now() - server.listedAt < this.#ttl()) {
      return { relisted: false }
    }
    return this.#listTools(server, signal)
  }

  /** Re-reads ctx.mcp.list(), connects/refreshes every included server (parallel, each bounded). Never throws. */
  refresh(): Promise<void> {
    if (this.#disposed) {
      this.#log("mcp: refresh ignored after dispose")
      return Promise.resolve()
    }
    // #runRefresh() increments #refreshSeq synchronously (before its first
    // await), preserving latest-started-wins; registering the run before
    // returning lets dispose() await its cleanup.
    const run = this.#runRefresh()
    this.#activeRefreshes.add(run)
    const tracked = run.finally(() => {
      this.#activeRefreshes.delete(run)
    })
    // The caller may ignore the returned promise; this handler keeps that from
    // becoming an unhandled rejection.
    tracked.catch(() => {})
    return tracked
  }

  async #runRefresh(): Promise<void> {
    const refreshSeq = ++this.#refreshSeq
    const invalidationEpoch = this.#invalidationEpoch
    let entries: unknown
    try {
      // The host config read is the only unbounded await on this path: a
      // never-settling ctx.mcp.list() would otherwise hang every caller,
      // including the execute_tools dispatch. Bound it like any other MCP
      // operation; on failure the cached catalog is invalidated (fail closed)
      // rather than kept.
      entries = await withTimeout(
        Promise.resolve(this.#deps.servers()),
        this.#timeouts().listMs,
        "MCP server config read",
        () => {},
      )
    } catch (error) {
      this.#log(`mcp: server config read failed: ${boundText(errorMessage(error), MCP_MAX_ERROR_CHARS)}`)
      // Latest-started-wins is symmetric across success and failure: only the
      // current (latest-started) refresh may invalidate the catalog. A failure
      // from a superseded refresh is a stale observation — a newer refresh has
      // already read the config and owns the catalog — so it is logged and
      // ignored: no epoch bump, no clear, no #lastRefreshAt reset.
      if (this.#refreshSeq !== refreshSeq) {
        this.#log("mcp: ignored a config-read failure from a superseded refresh")
        return
      }
      // Fail closed: an unreadable host config means the authorization of
      // every cached server/tool is unknown (it may have been disabled or
      // revoked). Drop the catalog and close all live connections so no stale
      // tool stays callable. Leave #lastRefreshAt unset so the next
      // ensureFresh() retries the read instead of trusting the old deadline.
      // Bump the epoch and clear synchronously BEFORE awaiting the closes: an
      // overlapping refresh still in flight (e.g. awaiting closeServer()) must
      // never commit its older snapshot after this invalidation.
      this.#invalidationEpoch += 1
      const stale = [...this.#state.values()]
      this.#state = new Map()
      this.#lastRefreshAt = undefined
      await Promise.all(stale.map((server) => this.#closeServer(server)))
      return
    }
    const { servers, notes } = selectMcpServers(entries)
    for (const note of notes) this.#log(`mcp: ${note}`)
    // Stage: build a refresh-local snapshot from committed values plus reused
    // connection handles. No object reachable from #state is mutated here, so
    // an older refresh that is still in flight cannot touch the live catalog.
    const staged = new Map<string, ServerState>()
    for (const selection of servers) {
      const existing = this.#state.get(selection.namespace)
      if (existing && sameConfig(existing.config, selection.config)) {
        staged.set(selection.namespace, {
          name: selection.name,
          namespace: selection.namespace,
          config: selection.config,
          status: existing.status,
          ...(existing.connection === undefined ? {} : { connection: existing.connection }),
          tools: [...existing.tools],
          ...(existing.listedAt === undefined ? {} : { listedAt: existing.listedAt }),
          ...(existing.lastError === undefined ? {} : { lastError: existing.lastError }),
        })
      } else {
        staged.set(selection.namespace, {
          name: selection.name,
          namespace: selection.namespace,
          config: selection.config,
          status: "cold",
          tools: [],
        })
      }
    }
    const valid = (): boolean => this.#invalidationEpoch === invalidationEpoch && this.#refreshSeq === refreshSeq
    if (!valid()) {
      this.#log("mcp: discarded a refresh invalidated by a newer refresh outcome (before commit)")
      await this.#discard(staged)
      return
    }
    // First swap: publish the staged server set (identities + reused
    // connection handles) atomically. The re-list below fills refresh-local
    // metadata; the final swap publishes it. No await separates either guard
    // check from its assignment, and committed entries are snapshot clones, so
    // the re-list never mutates metadata reachable from #state.
    const previous = this.#state
    this.#state = this.#toCommitted(staged)
    await this.#closeUnreferenced(previous)
    if (!valid()) {
      this.#log("mcp: discarded a refresh invalidated by a newer refresh outcome (before re-list)")
      await this.#discard(staged)
      return
    }
    await Promise.all([...staged.values()].map((server) => this.#listTools(server, undefined, true)))
    // The re-list awaited too (bounded connects/lists): re-check before
    // publishing the staged metadata and advancing #lastRefreshAt so an
    // invalidation that landed mid-list keeps authority, discarding (and
    // closing) whatever this refresh reconnected.
    if (!valid()) {
      this.#log("mcp: discarded a refresh invalidated by a newer refresh outcome (during re-list)")
      await this.#discard(staged)
      return
    }
    this.#state = this.#toCommitted(staged)
    this.#lastRefreshAt = this.#now()
  }

  /**
   * Snapshot for the committed catalog: fresh entry objects and fresh tools
   * arrays, so later staging work can never mutate committed metadata.
   * Connection handles are shared by design: they are the live transport, not
   * catalog metadata.
   */
  #toCommitted(staged: Map<string, ServerState>): Map<string, ServerState> {
    const state = new Map<string, ServerState>()
    for (const [namespace, server] of staged) {
      state.set(namespace, {
        name: server.name,
        namespace: server.namespace,
        config: server.config,
        status: server.status,
        ...(server.connection === undefined ? {} : { connection: server.connection }),
        tools: [...server.tools],
        ...(server.listedAt === undefined ? {} : { listedAt: server.listedAt }),
        ...(server.lastError === undefined ? {} : { lastError: server.lastError }),
      })
    }
    return state
  }

  #referencedConnections(): Set<McpConnection> {
    const referenced = new Set<McpConnection>()
    for (const server of this.#state.values()) {
      if (server.connection) referenced.add(server.connection)
    }
    return referenced
  }

  /** Closes a connection a dispatch resolved but the committed snapshot no longer references. */
  async #releaseUnreferenced(connection: McpConnection): Promise<void> {
    if (this.#referencedConnections().has(connection)) return
    try {
      await connection.close()
    } catch {
      // closing must never throw
    }
  }

  /** After a commit: close connections the previous snapshot held that the new one does not reference. */
  async #closeUnreferenced(previous: Map<string, ServerState>): Promise<void> {
    const referenced = this.#referencedConnections()
    await Promise.all(
      [...previous.values()]
        .filter((server) => server.connection !== undefined && !referenced.has(server.connection))
        .map((server) => this.#closeServer(server)),
    )
  }

  /**
   * Closes only the connections THIS refresh opened that the committed
   * snapshot does not reference (identity-checked). Inherited connections are
   * owned by the committed lineage and are never touched here, so a discarded
   * refresh cannot double-close a shared connection or mutate committed tools.
   */
  async #discard(staged: Map<string, ServerState>): Promise<void> {
    const referenced = this.#referencedConnections()
    await Promise.all(
      [...staged.values()].map(async (server) => {
        const opened = server.opened
        if (!opened || referenced.has(opened)) return
        if (server.connection === opened) server.connection = undefined
        server.opened = undefined
        try {
          await opened.close()
        } catch {
          // closing must never throw
        }
      }),
    )
  }

  /** Refresh only when the catalog TTL expired (no polling: called on use + explicit refresh). */
  async ensureFresh(): Promise<void> {
    if (this.#lastRefreshAt === undefined || this.#now() - this.#lastRefreshAt >= this.#ttl()) {
      await this.refresh()
    }
  }

  surface(): readonly McpSurfaceEntry[] {
    const entries: McpSurfaceEntry[] = []
    for (const server of this.#state.values()) {
      for (const tool of server.tools) entries.push({ namespace: server.namespace, tool: tool.guest })
    }
    return entries
  }

  cachedTools(): readonly McpCachedToolRef[] {
    const tools: McpCachedToolRef[] = []
    for (const server of this.#state.values()) tools.push(...server.tools)
    return tools
  }

  summaries(): readonly McpServerSummary[] {
    return [...this.#state.values()].map((server) => ({
      name: server.name,
      namespace: server.namespace,
      status: server.status,
      toolCount: server.tools.length,
    }))
  }

  stats(): { servers: number; tools: number; ready: number } {
    let tools = 0
    let ready = 0
    for (const server of this.#state.values()) {
      tools += server.tools.length
      if (server.status === "ready") ready += 1
    }
    return { servers: this.#state.size, tools, ready }
  }

  /** Fresh tools for a namespace (TTL re-list), or a bounded failure descriptor. */
  async toolsForNamespace(
    namespace: string,
    signal?: AbortSignal,
  ): Promise<{ readonly ok: true; readonly status: ServerStatus; readonly tools: readonly McpCachedToolRef[]; readonly relisted: boolean } | { readonly ok: false; readonly reason: "unknown" | "unavailable"; readonly message: string }> {
    const server = this.#state.get(namespace)
    if (!server) {
      const available = [...this.#state.keys()].join(", ")
      return { ok: false, reason: "unknown", message: `unknown MCP namespace "${namespace}"${available ? ` (available: ${available})` : ""}` }
    }
    const listing = await this.#ensureTools(server, signal)
    if (signal?.aborted) return { ok: false, reason: "unavailable", message: "Execution cancelled" }
    if (server.connection === undefined && server.tools.length === 0) {
      return {
        ok: false,
        reason: "unavailable",
        message: `MCP server "${server.name}" is unavailable${server.lastError ? `: ${server.lastError}` : ""}`,
      }
    }
    return { ok: true, status: server.status, tools: server.tools, relisted: listing.relisted }
  }

  /**
   * The `mcp.<namespace>.<tool>` adapter core. Every check is repeated here at
   * dispatch time (defense in depth): the namespace and tool must exist in the
   * CURRENT catalog, args must validate against the tool's preserved input
   * schema, and the call is bounded by the per-call timeout. Outcomes are
   * bounded dispatch errors; a hung call closes the connection.
   */
  async callTool(namespace: string, guestTool: string, input: unknown, env: DispatchEnvironment): Promise<DispatchOutcome> {
    if (env.signal?.aborted) return dispatchError("cancelled", "Execution cancelled")
    const info = await this.toolsForNamespace(namespace, env.signal)
    if (env.signal?.aborted) return dispatchError("cancelled", "Execution cancelled")
    if (!info.ok) return dispatchError(info.reason === "unknown" ? "not-found" : "unavailable", info.message)
    const server = this.#state.get(namespace)
    if (!server) return dispatchError("not-found", `unknown MCP namespace "${namespace}"`)

    const find = (tools: readonly McpCachedToolRef[]): McpCachedToolRef | undefined =>
      tools.find((tool) => tool.guest === guestTool) ?? tools.find((tool) => tool.name === guestTool)
    let tool = find(info.tools)
    if (!tool && !info.relisted) {
      // Bounded re-list on a dispatch miss (stale-metadata path): once.
      await this.#listTools(server, env.signal)
      if (env.signal?.aborted) return dispatchError("cancelled", "Execution cancelled")
      tool = find(server.tools)
    }
    if (!tool) {
      return dispatchError("not-found", `tool "${guestTool}" is not present in the current catalog of MCP server "${server.name}"`)
    }

    const validated = validateToolArgs(tool.inputSchema, input)
    if (!validated.ok) return dispatchError("input", validated.message)

    const connection = await this.#connectionFor(server, env.signal)
    if (env.signal?.aborted) return dispatchError("cancelled", "Execution cancelled")
    if (!connection) {
      return dispatchError("unavailable", `MCP server "${server.name}" is unavailable${server.lastError ? `: ${server.lastError}` : ""}`)
    }

    // Revalidate AFTER every await against the CURRENT committed snapshot. A
    // TTL re-list (or the miss re-list above) can return a listing built from
    // a snapshot that a newer refresh has since replaced; accepting its tool
    // would dispatch a tool the catalog no longer authorizes. The tool, its
    // schema, and the connection must all come from the committed snapshot.
    const committed = this.#state.get(namespace)
    const committedTool = committed ? find(committed.tools) : undefined
    if (!committed || !committedTool) {
      await this.#releaseUnreferenced(connection)
      return dispatchError("not-found", `tool "${guestTool}" is not present in the current catalog of MCP server "${committed?.name ?? namespace}"`)
    }
    if (committed.connection !== connection) {
      // A newer refresh replaced the transport: this call resolved against a
      // snapshot that is no longer committed. Fail closed rather than dispatch
      // on a connection the catalog no longer owns.
      await this.#releaseUnreferenced(connection)
      return dispatchError("unavailable", `MCP server "${namespace}" changed while dispatching; retry the call`)
    }
    const committedValidation = validateToolArgs(committedTool.inputSchema, input)
    if (!committedValidation.ok) return dispatchError("input", committedValidation.message)
    const label = `mcp.${namespace}.${committedTool.name}`
    const started = this.#now()
    try {
      const result = await withTimeout(connection.callTool(committedTool.name, committedValidation.value), this.#timeouts().callMs, label, () => {
        void this.#closeServer(server)
      }, env.signal)
      this.#log(`mcp: call ${label} ok in ${this.#now() - started}ms`)
      const bounded = boundContent(result.content)
      return { ok: true, data: { content: bounded.content, isError: result.isError, truncated: result.truncated || bounded.truncated } }
    } catch (error) {
      this.#log(`mcp: call ${label} failed in ${this.#now() - started}ms`)
      if (error instanceof McpCancelledError || env.signal?.aborted) {
        return dispatchError("cancelled", "Execution cancelled")
      }
      if (error instanceof McpTimeoutError) {
        return dispatchError("limit", `MCP tool call timed out after ${this.#timeouts().callMs}ms: ${label}`)
      }
      return dispatchError("io", `MCP tool call failed (${label}): ${boundText(errorMessage(error), MCP_MAX_ERROR_CHARS)}`)
    }
  }

  async dispose(): Promise<void> {
    // (a) Invalidate synchronously: #invalidationEpoch is part of every
    // refresh's commit guard, so an in-flight refresh can no longer commit,
    // even if its final check already ran. (b) #disposed blocks refreshes
    // from starting (see refresh()).
    this.#disposed = true
    this.#invalidationEpoch += 1
    this.#lastRefreshAt = undefined
    // (c) Await in-flight refreshes BEFORE clearing/closing: a discarded
    // refresh closes the connections it opened through its own identity-
    // checked #discard() path, so awaiting them here is what guarantees no
    // MCP transport outlives disposal (and no connection is double-closed).
    await Promise.all([...this.#activeRefreshes])
    const servers = [...this.#state.values()]
    this.#state = new Map()
    await Promise.all(servers.map((server) => this.#closeServer(server)))
  }
}

function boundContent(content: unknown): { content: unknown; truncated: boolean } {
  let serialized: string
  try {
    serialized = JSON.stringify(content) ?? String(content)
  } catch {
    return { content: "<unserializable result>", truncated: false }
  }
  if (byteLength(serialized) <= MCP_MAX_RESULT_BYTES) return { content, truncated: false }
  const marker = `[result truncated at ${MCP_MAX_RESULT_BYTES / 1024} KiB]`
  const budget = Math.max(MCP_MAX_RESULT_BYTES - byteLength(marker) - 2, 0)
  return { content: `${truncateToBytes(serialized, budget)}${marker}`, truncated: true }
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

// ---------------------------------------------------------------------------
// Discovery helpers (codemode.search_tools / list_mcp_servers / list_tools /
// describe_tools) — Pi parity names (research §2.10), structured bounded
// results (adaptation: Pi rendered text; the port returns data the guest can
// inspect, which the typechecker declaration below mirrors exactly).
// ---------------------------------------------------------------------------

export interface McpDiscoveryContext {
  readonly catalog: McpCatalog
  readonly cli?: CliAllowlist
  /** Files capability group: gates the read/write/edit discovery entries. */
  readonly files: boolean
}

interface ParamInfo {
  readonly name: string
  readonly type: string
  readonly required: boolean
  readonly description?: string
  readonly enum?: readonly string[]
}

interface DiscoveryEntry {
  readonly namespace: string
  readonly name: string
  readonly call: string
  readonly description?: string
  readonly params?: readonly ParamInfo[]
  readonly schema?: unknown
}

function boundedParams(params: readonly ParamInfo[]): readonly ParamInfo[] {
  return params.slice(0, MCP_MAX_SCHEMA_PARAMS)
}

function builtinEntries(files: boolean): DiscoveryEntry[] {
  const entries: DiscoveryEntry[] = []
  if (files) {
    entries.push({
      namespace: "codemode",
      name: "read",
      call: "read",
      description: "Read a file within the active project root (offset/limit are zero-based line bounds).",
      params: [
        { name: "path", type: "string", required: true },
        { name: "offset", type: "number", required: false },
        { name: "limit", type: "number", required: false },
      ],
    })
    entries.push({
      namespace: "codemode",
      name: "write",
      call: "write",
      description: "Write an entire file within the active project root.",
      params: [
        { name: "path", type: "string", required: true },
        { name: "content", type: "string", required: true },
      ],
    })
    entries.push({
      namespace: "codemode",
      name: "edit",
      call: "edit",
      description: "Apply exact, unique text replacements to a file within the active project root.",
      params: [
        { name: "path", type: "string", required: true },
        { name: "edits", type: "array", required: true },
      ],
    })
  }
  entries.push({
    namespace: "codemode",
    name: "search_tools",
    call: "codemode.search_tools",
    description: "Search the tool catalog by name or description; returns bounded matches.",
    params: [
      { name: "query", type: "string", required: true },
      { name: "limit", type: "number", required: false },
    ],
  })
  entries.push({
    namespace: "codemode",
    name: "list_mcp_servers",
    call: "codemode.list_mcp_servers",
    description: "List the MCP servers this plugin owns connections to, with status and tool counts.",
    params: [],
  })
  entries.push({
    namespace: "codemode",
    name: "list_tools",
    call: "codemode.list_tools",
    description: "List catalog tools for a namespace (codemode | cli | an MCP server namespace).",
    params: [
      { name: "namespace", type: "string", required: true },
      { name: "offset", type: "number", required: false },
      { name: "limit", type: "number", required: false },
    ],
  })
  entries.push({
    namespace: "codemode",
    name: "describe_tools",
    call: "codemode.describe_tools",
    description: "Describe bounded parameter signatures for tools in a namespace (optionally one tool).",
    params: [
      { name: "namespace", type: "string", required: true },
      { name: "tool", type: "string", required: false },
    ],
  })
  return entries
}

function cliEntries(cli: CliAllowlist | undefined): DiscoveryEntry[] {
  return cliSurface(cli).map(({ tool, operation }) => {
    const definition = CLI_TOOLS[tool]?.operations?.[operation]
    const params: ParamInfo[] = []
    if (definition) {
      for (const [name, spec] of Object.entries(definition.params)) {
        params.push({
          name,
          type: spec.type === "integer" ? "number" : spec.type === "string[]" ? "string[]" : spec.type,
          required: definition.required.includes(name),
          ...(spec.enum === undefined ? {} : { enum: spec.enum }),
        })
      }
    }
    return {
      namespace: "cli",
      name: `${tool}.${operation}`,
      call: `cli.${tool}.${operation}`,
      ...(definition === undefined ? {} : { description: definition.description }),
      params,
    }
  })
}

function mcpParams(schema: unknown): readonly ParamInfo[] {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return []
  const required = Array.isArray(schema.required) ? schema.required : []
  const params: ParamInfo[] = []
  for (const [name, propSchema] of Object.entries(schema.properties)) {
    if (params.length >= MCP_MAX_SCHEMA_PARAMS) break
    const prop = isPlainObject(propSchema) ? propSchema : {}
    params.push({
      name,
      type: typeof prop.type === "string" ? prop.type : "unknown",
      required: required.includes(name),
      ...(typeof prop.description === "string" && prop.description.length > 0
        ? { description: boundText(prop.description, MCP_MAX_DESCRIPTION_CHARS) }
        : {}),
    })
  }
  return params
}

function mcpEntries(catalog: McpCatalog): DiscoveryEntry[] {
  return catalog.cachedTools().map((tool) => ({
    namespace: tool.namespace,
    name: tool.guest,
    call: `mcp.${tool.namespace}.${tool.guest}`,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.inputSchema === undefined ? {} : { schema: tool.inputSchema }),
  }))
}

function toRef(entry: DiscoveryEntry): { namespace: string; name: string; call: string; description?: string } {
  return {
    namespace: entry.namespace,
    name: entry.name,
    call: entry.call,
    ...(entry.description === undefined ? {} : { description: entry.description }),
  }
}

interface SearchMatch {
  readonly entry: DiscoveryEntry
  readonly score: number
}

function searchEntries(entries: readonly DiscoveryEntry[], query: string, limit: number): {
  results: Array<{ namespace: string; name: string; call: string; description?: string }>
  total: number
  truncated: boolean
} {
  const lowered = query.toLowerCase()
  const tokens = lowered.split(/\s+/).filter(Boolean)
  const matches: SearchMatch[] = []
  for (const entry of entries) {
    const name = entry.name.toLowerCase()
    const call = entry.call.toLowerCase()
    const haystack = `${entry.namespace.toLowerCase()} ${name} ${call} ${(entry.description ?? "").toLowerCase()}`
    if (!tokens.every((token) => haystack.includes(token))) continue
    let score = 0
    if (name === lowered) score += 100
    else if (name.startsWith(lowered)) score += 60
    else if (name.includes(lowered)) score += 40
    else if (call.includes(lowered)) score += 30
    else score += 10
    for (const token of tokens) {
      if (name.includes(token)) score += 5
      else if (call.includes(token)) score += 3
      else score += 1
    }
    matches.push({ entry, score })
  }
  matches.sort((a, b) => (b.score - a.score !== 0 ? b.score - a.score : a.entry.call < b.entry.call ? -1 : 1))
  const results = matches.slice(0, limit).map((match) => toRef(match.entry))
  return { results, total: matches.length, truncated: matches.length > results.length }
}

function parseIntegerBound(
  value: unknown,
  name: string,
  fallback: number,
  max: number,
): { ok: true; value: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: fallback }
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, message: `${name} must be a number` }
  const integer = Math.trunc(value)
  if (integer < 1) return { ok: false, message: `${name} must be a positive integer` }
  return { ok: true, value: Math.min(integer, max) }
}

function parseOffset(value: unknown): { ok: true; value: number } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: 0 }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { ok: false, message: "offset must be a non-negative integer" }
  }
  return { ok: true, value }
}

function asInputRecord(input: unknown): Record<string, unknown> | undefined {
  return isPlainObject(input) ? input : undefined
}

async function runSearchTools(context: McpDiscoveryContext, input: unknown): Promise<DispatchOutcome> {
  const params = asInputRecord(input)
  const query = params?.query
  if (typeof query !== "string" || query.trim().length === 0) {
    return dispatchError("input", "search_tools requires { query: string }")
  }
  const limit = parseIntegerBound(params?.limit, "limit", MCP_SEARCH_DEFAULT_LIMIT, MCP_SEARCH_MAX_LIMIT)
  if (!limit.ok) return dispatchError("input", limit.message)
  const entries = [...builtinEntries(context.files), ...cliEntries(context.cli), ...mcpEntries(context.catalog)]
  return { ok: true, data: searchEntries(entries, query, limit.value) }
}

async function runListMcpServers(context: McpDiscoveryContext): Promise<DispatchOutcome> {
  return { ok: true, data: { servers: context.catalog.summaries(), truncated: false } }
}

async function resolveNamespaceEntries(
  context: McpDiscoveryContext,
  namespace: string,
): Promise<{ ok: true; entries: readonly DiscoveryEntry[] } | { ok: false; outcome: DispatchOutcome }> {
  if (namespace === "codemode") {
    return { ok: true, entries: builtinEntries(context.files) }
  }
  if (namespace === "cli") {
    return { ok: true, entries: cliEntries(context.cli) }
  }
  const info = await context.catalog.toolsForNamespace(namespace)
  if (!info.ok) {
    return {
      ok: false,
      outcome: dispatchError(info.reason === "unknown" ? "not-found" : "unavailable", info.message),
    }
  }
  const entries: DiscoveryEntry[] = info.tools.map((tool) => ({
    namespace: tool.namespace,
    name: tool.guest,
    call: `mcp.${tool.namespace}.${tool.guest}`,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.inputSchema === undefined ? {} : { schema: tool.inputSchema }),
  }))
  return { ok: true, entries }
}

async function runListTools(context: McpDiscoveryContext, input: unknown): Promise<DispatchOutcome> {
  const params = asInputRecord(input)
  const namespace = params?.namespace
  if (typeof namespace !== "string" || namespace.length === 0) {
    return dispatchError("input", "list_tools requires { namespace: string }")
  }
  const offset = parseOffset(params?.offset)
  if (!offset.ok) return dispatchError("input", offset.message)
  const limit = parseIntegerBound(params?.limit, "limit", MCP_LIST_DEFAULT_LIMIT, MCP_LIST_MAX_LIMIT)
  if (!limit.ok) return dispatchError("input", limit.message)

  const resolved = await resolveNamespaceEntries(context, namespace)
  if (!resolved.ok) return resolved.outcome
  const total = resolved.entries.length
  const page = resolved.entries.slice(offset.value, offset.value + limit.value)
  return {
    ok: true,
    data: {
      namespace,
      offset: offset.value,
      limit: limit.value,
      total,
      tools: page.map((entry) => toRef(entry)),
      truncated: offset.value + limit.value < total,
    },
  }
}

async function runDescribeTools(context: McpDiscoveryContext, input: unknown): Promise<DispatchOutcome> {
  const params = asInputRecord(input)
  const namespace = params?.namespace
  if (typeof namespace !== "string" || namespace.length === 0) {
    return dispatchError("input", "describe_tools requires { namespace: string }")
  }
  const tool = params?.tool
  if (tool !== undefined && (typeof tool !== "string" || tool.length === 0)) {
    return dispatchError("input", "tool must be a non-empty string when provided")
  }
  const resolved = await resolveNamespaceEntries(context, namespace)
  if (!resolved.ok) return resolved.outcome

  const describeOne = (entry: DiscoveryEntry) => ({
    namespace: entry.namespace,
    name: entry.name,
    call: entry.call,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    params: boundedParams(entry.params ?? mcpParams(entry.schema)),
  })

  if (tool !== undefined) {
    const entry = resolved.entries.find((candidate) => candidate.name === tool || candidate.call === tool)
    if (!entry) {
      return dispatchError("not-found", `tool "${tool}" is not in the current catalog for namespace "${namespace}"`)
    }
    return { ok: true, data: { namespace, tools: [describeOne(entry)], truncated: false } }
  }
  const page = resolved.entries.slice(0, MCP_LIST_DEFAULT_LIMIT)
  return {
    ok: true,
    data: { namespace, tools: page.map(describeOne), truncated: resolved.entries.length > page.length },
  }
}

// ---------------------------------------------------------------------------
// Dispatch adapters: the codemode.* discovery surface + one adapter per
// current `mcp.<namespace>.<tool>` surface entry (group "mcp").
// ---------------------------------------------------------------------------

export function createMcpCapabilities(context: McpDiscoveryContext): readonly DispatchCapability[] {
  const guard = (env: DispatchEnvironment): DispatchOutcome | undefined => {
    if (env.mode === "off") {
      return dispatchError("mode", "CodeMode is off for this session; the codemode/mcp surface is disabled.")
    }
    if (!env.capabilities.mcp) {
      return dispatchError("mode", "the codemode/mcp surface is not enabled by the effective policy")
    }
    return undefined
  }
  const guarded = (
    env: DispatchEnvironment,
    work: () => Promise<DispatchOutcome>,
  ): Promise<DispatchOutcome> => {
    const denied = guard(env)
    return denied === undefined ? work() : Promise.resolve(denied)
  }

  const capabilities: DispatchCapability[] = [
    {
      name: "codemode.search_tools",
      group: "mcp",
      run: (input, env) => guarded(env, () => runSearchTools(context, input)),
    },
    {
      name: "codemode.list_mcp_servers",
      group: "mcp",
      run: (_input, env) => guarded(env, () => runListMcpServers(context)),
    },
    {
      name: "codemode.list_tools",
      group: "mcp",
      run: (input, env) => guarded(env, () => runListTools(context, input)),
    },
    {
      name: "codemode.describe_tools",
      group: "mcp",
      run: (input, env) => guarded(env, () => runDescribeTools(context, input)),
    },
  ]
  for (const entry of context.catalog.surface()) {
    capabilities.push({
      name: `mcp.${entry.namespace}.${entry.tool}`,
      group: "mcp",
      run: (input, env) => {
        const denied = guard(env)
        return denied === undefined
          ? context.catalog.callTool(entry.namespace, entry.tool, input, env)
          : Promise.resolve(denied)
      },
    })
  }
  return capabilities
}
