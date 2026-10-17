// tests/unit/mcp.test.ts
// Task 7 unit acceptance: the plugin-owned MCP bridge (research §5.1b
// fallback — the host exposes no invocation surface, HOST_CAPABILITIES
// records it) plus the `codemode.*` discovery helpers and the dynamic
// `mcp.<ns>.<tool>` guest surface, all exercised through the REAL dispatcher
// and the REAL guest pipeline with an injected in-memory connection factory.
// No child processes here (those live in tests/integration/mcp.test.ts): the
// unit size class stays I/O-free while still proving the dispatch wiring.
//
// Acceptance criteria covered here:
//   1. search_tools/list_mcp_servers/list_tools/describe_tools return
//      current, bounded metadata (limits, counts, truncation flags).
//   2. calls are reachable only for tools in the current catalog and only
//      with args valid against the tool's preserved input schema.
//   3. unknown tools, stale metadata, denied tools, and server errors return
//      bounded dispatch outcomes (not-found/unavailable/input/mode/limit).
//   4. the recorded host-capability mismatch + design deviation stay put.
import { describe, expect, test } from "bun:test"

import { createDispatcher, createHostCall } from "../../src/codemode/dispatch"
import type { DispatchCapability } from "../../src/codemode/dispatch"
import { executeTools } from "../../src/codemode/execute-tools"
import { capabilitiesFor, defaultPolicy } from "../../src/config/policy"
import type { Capabilities, CliAllowlist } from "../../src/config/policy"
import { HOST_CAPABILITIES, TASK7_BRIDGE_DEVIATION } from "../../src/host/opencode"
import {
  MCP_CATALOG_TTL_MS,
  MCP_LIST_DEFAULT_LIMIT,
  MCP_LIST_MAX_LIMIT,
  MCP_MAX_RESULT_BYTES,
  MCP_MAX_TOOLS_PER_SERVER,
  MCP_SEARCH_DEFAULT_LIMIT,
  MCP_SEARCH_MAX_LIMIT,
  McpCatalog,
  createMcpCapabilities,
  sanitizeNamespace,
  sanitizeToolName,
  selectMcpServers,
  validateToolArgs,
} from "../../src/capabilities/mcp"
import type { McpConnection, McpConnectionFactory, McpToolInfo, McpToolResult } from "../../src/capabilities/mcp"

const byteLength = (value: string): number => new TextEncoder().encode(value).length

// ---------------------------------------------------------------------------
// Namespace / tool-name sanitization (Pi parity, research §2.11)
// ---------------------------------------------------------------------------

describe("namespace sanitization (Pi toNamespace parity)", () => {
  test("strips a trailing -mcp/mcp segment, then maps illegal characters to _", () => {
    expect(sanitizeNamespace("fixture")).toBe("fixture")
    expect(sanitizeNamespace("a-b-mcp")).toBe("a_b")
    expect(sanitizeNamespace("my-tool.mcp")).toBe("my_tool_")
    expect(sanitizeNamespace("Fixture Name")).toBe("Fixture_Name")
    expect(sanitizeNamespace("MCP")).toBe("mcp")
    expect(sanitizeNamespace("mcp")).toBe("mcp")
    expect(sanitizeNamespace("")).toBe("mcp")
  })

  test("a leading digit is prefixed so the guest member is a valid identifier", () => {
    expect(sanitizeNamespace("123")).toBe("_123")
    expect(sanitizeNamespace("9lives")).toBe("_9lives")
  })

  test("tool names keep [A-Za-z0-9_$] and gain a _ prefix on a leading digit", () => {
    expect(sanitizeToolName("echo")).toBe("echo")
    expect(sanitizeToolName("my-tool")).toBe("my_tool")
    expect(sanitizeToolName("9x")).toBe("_9x")
    expect(sanitizeToolName("get.issue")).toBe("get_issue")
  })
})

// ---------------------------------------------------------------------------
// Server selection from host config (ctx.mcp.list() shape)
// ---------------------------------------------------------------------------

describe("selectMcpServers (host config -> included servers)", () => {
  test("includes local servers, sanitizes names, skips disabled/codemode:false and notes remote", () => {
    const { servers, notes } = selectMcpServers([
      ["alpha", { type: "local", command: ["fake-mcp", "alpha"] }],
      ["off", { type: "local", command: ["fake-mcp", "off"], disabled: true }],
      ["direct", { type: "local", command: ["fake-mcp", "direct"], codemode: false }],
      ["remote", { type: "remote", url: "https://example.invalid/mcp" }],
      ["a.b", { type: "local", command: ["fake-mcp", "one"] }],
      ["a_b", { type: "local", command: ["fake-mcp", "two"] }],
      ["bad", { type: "local", command: [] }],
      ["junk", 42],
    ])
    expect(servers.map((server) => server.namespace)).toEqual(["alpha", "a_b"])
    expect(notes.some((note) => note.includes("disabled"))).toBe(true)
    expect(notes.some((note) => note.includes("codemode: false"))).toBe(true)
    expect(notes.some((note) => note.includes("remote"))).toBe(true)
    expect(notes.some((note) => note.includes('"a_b"'))).toBe(true)
    expect(notes.some((note) => note.includes("command"))).toBe(true)
    expect(notes.length).toBeGreaterThanOrEqual(6)
  })
})

// ---------------------------------------------------------------------------
// Bounded input-schema validation subset
// ---------------------------------------------------------------------------

describe("validateToolArgs (bounded JSON-schema subset)", () => {
  const echoSchema = {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  }

  test("accepts conforming args and rejects missing required / wrong type / unknown key", () => {
    expect(validateToolArgs(echoSchema, { message: "hi" }).ok).toBe(true)
    expect(validateToolArgs(echoSchema, {}).ok).toBe(false)
    expect(validateToolArgs(echoSchema, { message: 42 }).ok).toBe(false)
    const extra = validateToolArgs(echoSchema, { message: "hi", boom: true })
    expect(extra.ok).toBe(false)
    if (!extra.ok) expect(extra.message).toContain("boom")
  })

  test("handles integers, enums, arrays, and nested objects with a depth cap", () => {
    const schema = {
      type: "object",
      properties: {
        n: { type: "integer" },
        mode: { type: "string", enum: ["a", "b"] },
        tags: { type: "array", items: { type: "string" } },
        cfg: {
          type: "object",
          properties: { inner: { type: "integer" } },
          required: ["inner"],
          additionalProperties: false,
        },
      },
      required: ["n"],
      additionalProperties: false,
    }
    expect(validateToolArgs(schema, { n: 3, mode: "a", tags: ["x"], cfg: { inner: 1 } }).ok).toBe(true)
    expect(validateToolArgs(schema, { n: 3.5 }).ok).toBe(false)
    expect(validateToolArgs(schema, { n: 1, mode: "c" }).ok).toBe(false)
    expect(validateToolArgs(schema, { n: 1, tags: [7] }).ok).toBe(false)
    expect(validateToolArgs(schema, { n: 1, cfg: { inner: "x" } }).ok).toBe(false)
    expect(validateToolArgs(schema, { n: 1, cfg: { inner: 1, oops: 2 } }).ok).toBe(false)
  })

  test("non-object args fail against an object schema; absent args become {}", () => {
    expect(validateToolArgs(echoSchema, undefined).ok).toBe(false)
    expect(validateToolArgs(echoSchema, "nope").ok).toBe(false)
    expect(validateToolArgs(echoSchema, [1]).ok).toBe(false)
    expect(validateToolArgs({ type: "object", properties: {} }, undefined).ok).toBe(true)
  })

  test("an unusable schema degrades to an object-shape check only", () => {
    expect(validateToolArgs(undefined, { anything: 1 }).ok).toBe(true)
    expect(validateToolArgs(undefined, "nope").ok).toBe(false)
    expect(validateToolArgs("not-a-schema", { anything: 1 }).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Fake connection factory (in-memory; the real-stdio factory lives in the
// integration suite). This is a fake at the TRANSPORT seam only — catalog,
// adapters, dispatcher, and guest pipeline under test are real.
// ---------------------------------------------------------------------------

interface FakeServerState {
  tools: McpToolInfo[]
  listCalls: number
  calls: Array<{ name: string; args: Record<string, unknown> }>
  closed: boolean
  resultOverride?: (name: string, args: Record<string, unknown>) => McpToolResult | Promise<McpToolResult> | undefined
}

function makeFakeFactory(fakes: Map<string, FakeServerState>): McpConnectionFactory {
  return async (config) => {
    const label = String(config.command[1] ?? config.command[0])
    const state = fakes.get(label)
    if (!state) throw new Error(`no fake server for ${label}`)
    const connection: McpConnection = {
      listTools: async () => {
        state.listCalls += 1
        return [...state.tools]
      },
      callTool: async (name, args) => {
        state.calls.push({ name, args })
        const override = state.resultOverride?.(name, args)
        if (override) return override
        if (name === "fail") return { content: [{ type: "text", text: "boom" }], isError: true, truncated: false }
        if (name === "explode") throw new Error("fake transport failure")
        return { content: [{ type: "text", text: `ok:${name}` }], isError: false, truncated: false }
      },
      close: async () => {
        state.closed = true
      },
    }
    return connection
  }
}

const echoTool: McpToolInfo = {
  name: "echo",
  description: "Echo a message back.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
}

const noArgsTool: McpToolInfo = { name: "ping", description: "Ping.", inputSchema: { type: "object", properties: {} } }
const failTool: McpToolInfo = { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } }
const explodeTool: McpToolInfo = { name: "explode", description: "Transport failure.", inputSchema: { type: "object", properties: {} } }
const bigTool: McpToolInfo = { name: "big", description: "Large payload.", inputSchema: { type: "object", properties: {} } }

function fakeState(tools: McpToolInfo[] = [echoTool, noArgsTool]): FakeServerState {
  return { tools: [...tools], listCalls: 0, calls: [], closed: false }
}

function localEntry(name: string, label: string): [string, unknown] {
  return [name, { type: "local", command: ["fake-mcp", label] }]
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// Counting transport for the concurrency regressions: every connection open and
// close is tallied per fake label so a leak shows up as opens !== closes. The
// optional hooks return a promise to hold a close/connect until the test
// releases it, making the overlap windows deterministic.
interface CountingState {
  tools: McpToolInfo[]
  opens: number
  closes: number
  listCalls: number
  calls: Array<{ name: string; args: Record<string, unknown> }>
}

function countingState(): CountingState {
  return {
    tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }],
    opens: 0,
    closes: 0,
    listCalls: 0,
    calls: [],
  }
}

function countingTransport(
  states: Map<string, CountingState>,
  hooks: {
    onConnect?: (label: string) => Promise<void> | undefined
    onClose?: (label: string) => Promise<void> | undefined
    onList?: (label: string) => Promise<void> | undefined
  } = {},
): McpConnectionFactory {
  return async (config) => {
    const label = String(config.command[1] ?? config.command[0])
    const state = states.get(label)
    if (!state) throw new Error(`no counting fake for ${label}`)
    const connectGate = hooks.onConnect?.(label)
    if (connectGate) await connectGate
    state.opens += 1
    return {
      listTools: async () => {
        const listGate = hooks.onList?.(label)
        if (listGate) await listGate
        state.listCalls += 1
        return [...state.tools]
      },
      callTool: async (name, args) => {
        state.calls.push({ name, args })
        return { content: [{ type: "text", text: "ok" }], isError: false, truncated: false }
      },
      close: async () => {
        state.closes += 1
        const closeGate = hooks.onClose?.(label)
        if (closeGate) await closeGate
      },
    }
  }
}

function makeCatalog(
  fakes: Map<string, FakeServerState>,
  entries: ReadonlyArray<readonly [string, unknown]>,
  extra: Record<string, unknown> = {},
  now: () => number = () => 0,
): McpCatalog {
  return new McpCatalog({
    servers: () => entries,
    connect: makeFakeFactory(fakes),
    now,
    catalogTtlMs: 1000,
    connectTimeoutMs: 5000,
    listTimeoutMs: 5000,
    callTimeoutMs: 5000,
    ...extra,
  })
}

async function dispatchJson(
  capabilities: readonly DispatchCapability[],
  request: { capability: string; input: unknown },
  mode: "off" | "on" = "on",
  caps: Capabilities = capabilitiesFor(defaultPolicy()),
): Promise<{ ok: boolean; data?: unknown; error?: { kind: string; message: string } }> {
  const hostCall = createHostCall(
    createDispatcher(capabilities, { mode, capabilities: caps, root: undefined }),
  )
  return JSON.parse(await hostCall(JSON.stringify(request)))
}

// ---------------------------------------------------------------------------
// Catalog: refresh, freshness, bounded metadata
// ---------------------------------------------------------------------------

describe("McpCatalog refresh + freshness", () => {
  test("refresh lists tools once per server and builds a sanitized surface", async () => {
    const fakes = new Map([["alpha", fakeState()]])
    const catalog = makeCatalog(fakes, [localEntry("alpha", "alpha")])
    await catalog.refresh()
    expect(catalog.surface()).toEqual([
      { namespace: "alpha", tool: "echo" },
      { namespace: "alpha", tool: "ping" },
    ])
    expect(catalog.stats()).toEqual({ servers: 1, tools: 2, ready: 1 })
    expect(fakes.get("alpha")!.listCalls).toBe(1)
  })

  test("ensureFresh re-lists only after the TTL expires", async () => {
    let nowMs = 10_000
    const fakes = new Map([["alpha", fakeState()]])
    const catalog = makeCatalog(fakes, [localEntry("alpha", "alpha")], {}, () => nowMs)
    await catalog.refresh()
    expect(fakes.get("alpha")!.listCalls).toBe(1)

    nowMs += 999 // makeCatalog configures catalogTtlMs: 1000
    await catalog.ensureFresh()
    expect(fakes.get("alpha")!.listCalls).toBe(1)

    nowMs += 2
    await catalog.ensureFresh()
    expect(fakes.get("alpha")!.listCalls).toBe(2)
  })

  test("a hung host config read is bounded (ensureFresh resolves, never hangs)", async () => {
    const logs: string[] = []
    const catalog = new McpCatalog({
      servers: () => new Promise<never>(() => {}),
      listTimeoutMs: 25,
      log: (line: string) => logs.push(line),
    })
    await catalog.ensureFresh()
    expect(catalog.stats()).toEqual({ servers: 0, tools: 0, ready: 0 })
    expect(logs.some((line) => line.includes("config read failed") && line.includes("timed out"))).toBe(true)
  })

  test("a config-read timeout after a successful refresh invalidates the stale catalog and closes connections", async () => {
    const logs: string[] = []
    const state = fakeState()
    const fakes = new Map([["alpha", state]])
    let hang = false
    const catalog = new McpCatalog({
      servers: () => (hang ? new Promise<never>(() => {}) : [localEntry("alpha", "alpha")]),
      connect: makeFakeFactory(fakes),
      now: () => 0,
      catalogTtlMs: 1000,
      connectTimeoutMs: 5000,
      listTimeoutMs: 25,
      callTimeoutMs: 5000,
      log: (line: string) => logs.push(line),
    })
    await catalog.refresh()
    expect(catalog.surface()).toEqual([
      { namespace: "alpha", tool: "echo" },
      { namespace: "alpha", tool: "ping" },
    ])
    const staleCapabilities = createMcpCapabilities({ catalog, cli: {}, files: true })

    hang = true
    await catalog.refresh()
    expect(state.closed).toBe(true)
    expect(catalog.surface()).toEqual([])
    expect(catalog.stats()).toEqual({ servers: 0, tools: 0, ready: 0 })
    expect(logs.some((line) => line.includes("config read failed") && line.includes("timed out"))).toBe(true)

    // A capability list captured before the failure must not reach the server.
    const staleCall = await dispatchJson(staleCapabilities, {
      capability: "mcp.alpha.echo",
      input: { message: "stale" },
    })
    expect(staleCall.ok).toBe(false)
    expect(["not-found", "unavailable"]).toContain(staleCall.error!.kind)
    expect(state.calls.length).toBe(0)

    // A fresh execution (the real path) sees no MCP surface at all.
    const deniedCapabilities = createMcpCapabilities({ catalog, cli: {}, files: true })
    const denied = await dispatchJson(deniedCapabilities, {
      capability: "mcp.alpha.echo",
      input: { message: "stale" },
    })
    expect(denied.ok).toBe(false)
    expect(denied.error!.kind).toBe("unknown-capability")
    const listed = await dispatchJson(deniedCapabilities, {
      capability: "codemode.list_tools",
      input: { namespace: "alpha" },
    })
    expect(listed.ok).toBe(false)
    expect(listed.error!.kind).toBe("not-found")

    // A later successful refresh restores availability on the next use.
    state.closed = false
    hang = false
    await catalog.ensureFresh()
    expect(catalog.surface()).toEqual([
      { namespace: "alpha", tool: "echo" },
      { namespace: "alpha", tool: "ping" },
    ])
    const recovered = createMcpCapabilities({ catalog, cli: {}, files: true })
    const call = await dispatchJson(recovered, { capability: "mcp.alpha.echo", input: { message: "back" } })
    expect(call.ok).toBe(true)
    expect(state.calls).toEqual([{ name: "echo", args: { message: "back" } }])
  })

  test("an overlapping refresh cannot resurrect the catalog after a newer config-read timeout (fail closed)", async () => {
    const states = new Map([
      ["a1", countingState()],
      ["b1", countingState()],
    ])
    const closeReached = deferred()
    const closeRelease = deferred()
    let pauseClose = true
    let entries: unknown = [
      ["alpha", { type: "local", command: ["counting-mcp", "a1"] }],
      ["beta", { type: "local", command: ["counting-mcp", "b1"] }],
    ]
    let hang = false
    const catalog = new McpCatalog({
      servers: () => (hang ? new Promise<never>(() => {}) : entries),
      connect: countingTransport(states, {
        onClose: (label) => {
          if (label !== "a1" || !pauseClose) return undefined
          pauseClose = false
          closeReached.resolve()
          return closeRelease.promise
        },
      }),
      now: () => 0,
      catalogTtlMs: 1000,
      connectTimeoutMs: 5000,
      listTimeoutMs: 25,
      callTimeoutMs: 5000,
    })
    await catalog.refresh()
    expect(catalog.surface()).toEqual([
      { namespace: "alpha", tool: "echo" },
      { namespace: "beta", tool: "echo" },
    ])
    const staleCapabilities = createMcpCapabilities({ catalog, cli: {}, files: true })

    // Refresh A drops alpha: committing it closes alpha's live connection, and
    // that close blocks until released, holding A mid-commit.
    entries = [["beta", { type: "local", command: ["counting-mcp", "b1"] }]]
    const refreshA = catalog.refresh()
    await closeReached.promise

    // While A is paused, a newer refresh times out on the config read and
    // invalidates the catalog (fail closed).
    hang = true
    await catalog.refresh()
    expect(catalog.surface()).toEqual([])

    // Resume A: its snapshot predates the invalidation, so it must be
    // discarded — no commit, no TTL deadline.
    closeRelease.resolve()
    await refreshA
    expect(catalog.surface()).toEqual([])
    expect(catalog.stats()).toEqual({ servers: 0, tools: 0, ready: 0 })

    // Pre-captured adapters are denied at dispatch; fresh capability sets
    // expose nothing at all; the server was never called.
    const staleCall = await dispatchJson(staleCapabilities, { capability: "mcp.beta.echo", input: {} })
    expect(staleCall.ok).toBe(false)
    expect(["not-found", "unavailable"]).toContain(staleCall.error!.kind)
    const freshCapabilities = createMcpCapabilities({ catalog, cli: {}, files: true })
    const freshCall = await dispatchJson(freshCapabilities, { capability: "mcp.beta.echo", input: {} })
    expect(freshCall.ok).toBe(false)
    expect(freshCall.error!.kind).toBe("unknown-capability")
    const freshList = await dispatchJson(freshCapabilities, { capability: "codemode.list_tools", input: { namespace: "beta" } })
    expect(freshList.ok).toBe(false)
    expect(freshList.error!.kind).toBe("not-found")
    expect(states.get("b1")!.calls.length).toBe(0)

    // The discarded refresh neither re-listed nor re-opened anything and every
    // connection is closed: no leak.
    expect(states.get("b1")!.listCalls).toBe(1)
    expect([...states.entries()].map(([label, state]) => `${label}:${state.opens}/${state.closes}`)).toEqual(["a1:1/1", "b1:1/1"])

    // Repeated timeouts keep failing closed.
    await catalog.refresh()
    await catalog.refresh()
    expect(catalog.surface()).toEqual([])
    const repeatedDenied = await dispatchJson(staleCapabilities, { capability: "mcp.beta.echo", input: {} })
    expect(repeatedDenied.ok).toBe(false)
    expect(["not-found", "unavailable"]).toContain(repeatedDenied.error!.kind)

    // A later successful refresh restores availability on the next use.
    hang = false
    entries = [
      ["alpha", { type: "local", command: ["counting-mcp", "a1"] }],
      ["beta", { type: "local", command: ["counting-mcp", "b1"] }],
    ]
    await catalog.ensureFresh()
    expect(catalog.surface()).toEqual([
      { namespace: "alpha", tool: "echo" },
      { namespace: "beta", tool: "echo" },
    ])
    const recovered = createMcpCapabilities({ catalog, cli: {}, files: true })
    const call = await dispatchJson(recovered, { capability: "mcp.beta.echo", input: {} })
    expect(call.ok).toBe(true)
    expect(states.get("b1")!.calls).toEqual([{ name: "echo", args: {} }])

    await catalog.dispose()
    expect([...states.entries()].map(([label, state]) => `${label}:${state.opens}/${state.closes}`)).toEqual(["a1:2/2", "b1:2/2"])
  })

  test("an invalidation during the commit re-list discards the refresh and closes its reconnected servers (no leak)", async () => {
    const states = new Map([
      ["a1", countingState()],
      ["b1", countingState()],
      ["b2", countingState()],
    ])
    const connectReached = deferred()
    const connectRelease = deferred()
    let pauseConnect = true
    let entries: unknown = [
      ["alpha", { type: "local", command: ["counting-mcp", "a1"] }],
      ["beta", { type: "local", command: ["counting-mcp", "b1"] }],
    ]
    let hang = false
    const catalog = new McpCatalog({
      servers: () => (hang ? new Promise<never>(() => {}) : entries),
      connect: countingTransport(states, {
        onConnect: (label) => {
          if (label !== "b2" || !pauseConnect) return undefined
          pauseConnect = false
          connectReached.resolve()
          return connectRelease.promise
        },
      }),
      now: () => 0,
      catalogTtlMs: 1000,
      connectTimeoutMs: 5000,
      listTimeoutMs: 25,
      callTimeoutMs: 5000,
    })
    await catalog.refresh()
    const staleCapabilities = createMcpCapabilities({ catalog, cli: {}, files: true })

    // Refresh A changes beta's config, so committing it reconnects and re-lists
    // beta under the new command; the reconnect blocks until released, holding
    // A inside the re-list phase (past its pre-commit check).
    entries = [
      ["alpha", { type: "local", command: ["counting-mcp", "a1"] }],
      ["beta", { type: "local", command: ["counting-mcp", "b2"] }],
    ]
    const refreshA = catalog.refresh()
    await connectReached.promise

    // The concurrent refresh times out while A is mid-commit.
    hang = true
    await catalog.refresh()

    // Resume A: the invalidation landed during its re-list, so A's freshly
    // opened connection must be closed, not leaked — and the TTL deadline
    // must not be advanced.
    connectRelease.resolve()
    await refreshA

    expect(catalog.surface()).toEqual([])
    expect(catalog.stats()).toEqual({ servers: 0, tools: 0, ready: 0 })
    expect([...states.entries()].map(([label, state]) => `${label}:${state.opens}/${state.closes}`)).toEqual([
      "a1:1/1",
      "b1:1/1",
      "b2:1/1",
    ])
    const staleCall = await dispatchJson(staleCapabilities, { capability: "mcp.beta.echo", input: {} })
    expect(staleCall.ok).toBe(false)
    expect(["not-found", "unavailable"]).toContain(staleCall.error!.kind)

    // The deadline was not advanced: with the config readable again, the very
    // next ensureFresh() retries and restores availability.
    hang = false
    entries = [
      ["alpha", { type: "local", command: ["counting-mcp", "a1"] }],
      ["beta", { type: "local", command: ["counting-mcp", "b1"] }],
    ]
    await catalog.ensureFresh()
    expect(catalog.surface()).toEqual([
      { namespace: "alpha", tool: "echo" },
      { namespace: "beta", tool: "echo" },
    ])
    const call = await dispatchJson(createMcpCapabilities({ catalog, cli: {}, files: true }), {
      capability: "mcp.beta.echo",
      input: {},
    })
    expect(call.ok).toBe(true)

    await catalog.dispose()
    expect([...states.entries()].map(([label, state]) => `${label}:${state.opens}/${state.closes}`)).toEqual([
      "a1:2/2",
      "b1:2/2",
      "b2:1/1",
    ])
  })

  test("a superseded refresh's late tool list cannot overwrite the newer committed catalog", async () => {
    const listReached = deferred()
    const listRelease = deferred()
    let opens = 0
    let closes = 0
    let lists = 0
    const calls: string[] = []
    const catalog = new McpCatalog({
      servers: () => [["beta", { type: "local", command: ["gated-mcp", "beta"] }]],
      connect: async () => {
        opens += 1
        return {
          listTools: async () => {
            lists += 1
            if (lists === 1) return [{ name: "beta_seed" }]
            if (lists === 2) {
              // Refresh A's tool list: hold it open until after refresh B
              // (same config, newer result set) has committed.
              listReached.resolve()
              await listRelease.promise
              return [{ name: "beta_stale" }]
            }
            return [{ name: "beta_fresh" }]
          },
          callTool: async (name) => {
            calls.push(name)
            return { content: [{ type: "text", text: `ok:${name}` }], isError: false, truncated: false }
          },
          close: async () => {
            closes += 1
          },
        }
      },
      now: () => 0,
      catalogTtlMs: 1000,
      connectTimeoutMs: 5000,
      listTimeoutMs: 5000,
      callTimeoutMs: 5000,
    })
    await catalog.refresh()
    expect(catalog.surface()).toEqual([{ namespace: "beta", tool: "beta_seed" }])

    // A and B share the same config (and therefore the same live connection),
    // but A's list resolves LAST with an older result set.
    const refreshA = catalog.refresh()
    await listReached.promise
    await catalog.refresh()
    expect(catalog.surface()).toEqual([{ namespace: "beta", tool: "beta_fresh" }])

    listRelease.resolve()
    await refreshA

    // Finding 1: the obsolete list may only touch refresh-local state. The
    // committed surface stays B's, and the stale tool is not dispatchable.
    expect(catalog.surface()).toEqual([{ namespace: "beta", tool: "beta_fresh" }])
    const capabilities = createMcpCapabilities({ catalog, cli: {}, files: true })
    const stale = await dispatchJson(capabilities, { capability: "mcp.beta.beta_stale", input: {} })
    expect(stale.ok).toBe(false)
    expect(["unknown-capability", "not-found", "unavailable"]).toContain(stale.error!.kind)
    const fresh = await dispatchJson(capabilities, { capability: "mcp.beta.beta_fresh", input: {} })
    expect(fresh.ok).toBe(true)
    expect(calls).toEqual(["beta_fresh"])

    // A inherited the committed connection, so it must neither reopen nor
    // close it; the shared connection is closed exactly once on dispose.
    expect(opens).toBe(1)
    expect(closes).toBe(0)
    expect(lists).toBe(3)
    await catalog.dispose()
    expect(closes).toBe(1)
  })

  test("an obsolete config-read failure cannot erase a newer refresh's committed catalog", async () => {
    let nowMs = 1_000
    let reads = 0
    const state = countingState()
    const catalog = new McpCatalog({
      servers: () => {
        reads += 1
        if (reads === 1) return new Promise<never>(() => {})
        return [["beta", { type: "local", command: ["counting-mcp", "b1"] }]]
      },
      connect: countingTransport(new Map([["b1", state]])),
      now: () => nowMs,
      catalogTtlMs: 1000,
      connectTimeoutMs: 5000,
      listTimeoutMs: 100,
      callTimeoutMs: 5000,
    })

    // A starts first and hangs on the config read; B starts later, reads the
    // config, and commits. A then times out — after B's commit.
    const obsolete = catalog.refresh()
    await catalog.refresh()
    const committedAt = nowMs
    expect(catalog.surface()).toEqual([{ namespace: "beta", tool: "echo" }])
    await obsolete

    // Finding 2: the obsolete failure is ignored, so B's catalog and deadline
    // survive; a subsequent ensureFresh() within TTL does not re-read config.
    expect(catalog.surface()).toEqual([{ namespace: "beta", tool: "echo" }])
    expect(catalog.stats()).toEqual({ servers: 1, tools: 1, ready: 1 })
    nowMs = committedAt + 999
    const readsBefore = reads
    await catalog.ensureFresh()
    expect(reads).toBe(readsBefore)
    expect(catalog.surface()).toEqual([{ namespace: "beta", tool: "echo" }])

    const capabilities = createMcpCapabilities({ catalog, cli: {}, files: true })
    const call = await dispatchJson(capabilities, { capability: "mcp.beta.echo", input: {} })
    expect(call.ok).toBe(true)
    expect(state.calls).toEqual([{ name: "echo", args: {} }])
  })

  test("a TTL relist resolving after a newer refresh removed its tool is denied at dispatch (no transport call)", async () => {
    const listReached = deferred()
    const listRelease = deferred()
    let nowMs = 0
    let lists = 0
    let opens = 0
    let closes = 0
    const calls: string[] = []
    const catalog = new McpCatalog({
      servers: () => [["beta", { type: "local", command: ["gated-mcp", "beta"] }]],
      connect: async () => {
        opens += 1
        return {
          listTools: async () => {
            lists += 1
            if (lists === 2) {
              // The deferred TTL re-list: it observes the pre-refresh server
              // snapshot and resolves only after the newer refresh committed.
              listReached.resolve()
              await listRelease.promise
              return [{ name: "keep" }, { name: "stale" }]
            }
            if (lists === 3) return [{ name: "keep" }]
            return [{ name: "keep" }, { name: "stale" }]
          },
          callTool: async (name) => {
            calls.push(name)
            return { content: [{ type: "text", text: `ok:${name}` }], isError: false, truncated: false }
          },
          close: async () => {
            closes += 1
          },
        }
      },
      now: () => nowMs,
      catalogTtlMs: 1000,
      connectTimeoutMs: 5000,
      listTimeoutMs: 5000,
      callTimeoutMs: 5000,
    })
    await catalog.refresh()
    expect(catalog.surface()).toEqual([
      { namespace: "beta", tool: "keep" },
      { namespace: "beta", tool: "stale" },
    ])

    // Expire the TTL so the call below re-lists; hold that list inside the
    // transport until a newer refresh has committed without "stale".
    nowMs = 1001
    const staleCall = catalog.callTool("beta", "stale", {}, {
      mode: "on",
      capabilities: capabilitiesFor(defaultPolicy()),
      root: undefined,
    })
    await listReached.promise
    await catalog.refresh()
    expect(catalog.surface()).toEqual([{ namespace: "beta", tool: "keep" }])
    listRelease.resolve()

    // The in-flight listing still reports "stale", but the committed snapshot
    // no longer does: dispatch must be denied without touching the transport.
    const outcome = await staleCall
    expect({
      ok: outcome.ok,
      kind: outcome.ok ? undefined : outcome.error.kind,
      calls,
      surface: catalog.surface(),
    }).toEqual({ ok: false, kind: "not-found", calls: [], surface: [{ namespace: "beta", tool: "keep" }] })

    // Positive control: a tool still present in the committed snapshot
    // dispatches (against that snapshot's connection).
    const keepCall = await catalog.callTool("beta", "keep", {}, {
      mode: "on",
      capabilities: capabilitiesFor(defaultPolicy()),
      root: undefined,
    })
    expect(keepCall.ok).toBe(true)
    expect(calls).toEqual(["keep"])

    expect(opens).toBe(1)
    expect(closes).toBe(0)
    await catalog.dispose()
    expect(closes).toBe(1)
  })

  test("dispose while a refresh is listing invalidates it, closes its connection, and blocks later refreshes", async () => {
    const states = new Map([["b1", countingState()]])
    const listReached = deferred()
    const listRelease = deferred()
    let pauseList = true
    const catalog = new McpCatalog({
      servers: () => [["beta", { type: "local", command: ["counting-mcp", "b1"] }]],
      connect: countingTransport(states, {
        onList: (label) => {
          if (label !== "b1" || !pauseList) return undefined
          pauseList = false
          listReached.resolve()
          return listRelease.promise
        },
      }),
      now: () => 0,
      catalogTtlMs: 1000,
      connectTimeoutMs: 5000,
      listTimeoutMs: 5000,
      callTimeoutMs: 5000,
    })

    // The refresh has opened its connection and is paused inside #listTools().
    const refreshA = catalog.refresh()
    await listReached.promise
    expect(states.get("b1")!.opens).toBe(1)

    const disposing = catalog.dispose()
    listRelease.resolve()
    await disposing
    await refreshA

    // No repopulation after dispose, and the connection the discarded refresh
    // opened is closed exactly once (opens/closes balanced): no leak.
    expect({
      surface: catalog.surface(),
      stats: catalog.stats(),
      opens: states.get("b1")!.opens,
      closes: states.get("b1")!.closes,
    }).toEqual({ surface: [], stats: { servers: 0, tools: 0, ready: 0 }, opens: 1, closes: 1 })

    // Refreshes may not start after disposal, and none of them touch the host.
    await catalog.refresh()
    await catalog.ensureFresh()
    expect(catalog.surface()).toEqual([])
    expect(states.get("b1")!.listCalls).toBe(1)
    expect(states.get("b1")!.opens).toBe(1)
    expect(states.get("b1")!.closes).toBe(1)
  })

  test("dispose closes a connection that finishes opening for an in-flight tool call", async () => {
    const connectReached = deferred()
    let releaseConnect!: (connection: McpConnection) => void
    let attempts = 0
    let closes = 0
    const catalog = new McpCatalog({
      servers: () => [["beta", { type: "local", command: ["gated-mcp"] }]],
      connect: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("initial connect fails")
        connectReached.resolve()
        return await new Promise<McpConnection>((resolve) => {
          releaseConnect = resolve
        })
      },
      connectTimeoutMs: 5000,
      listTimeoutMs: 5000,
      callTimeoutMs: 5000,
    })

    // The first connection attempt leaves a committed but unavailable server.
    await catalog.refresh()
    expect(catalog.summaries()[0]?.status).toBe("failed")

    // A dispatch retries the connection. Disposal happens while the factory
    // is still pending, before it has returned a handle that can be closed.
    const call = catalog.callTool("beta", "echo", {}, {
      mode: "on",
      capabilities: capabilitiesFor(defaultPolicy()),
      root: undefined,
    })
    await connectReached.promise
    await catalog.dispose()

    const calls: string[] = []
    releaseConnect({
      listTools: async () => [{ name: "echo" }],
      callTool: async (name) => {
        calls.push(name)
        return { content: [], isError: false, truncated: false }
      },
      close: async () => {
        closes += 1
      },
    })

    const outcome = await call
    expect(outcome.ok).toBe(false)
    expect(catalog.surface()).toEqual([])
    expect(calls).toEqual([])
    expect({ attempts, closes }).toEqual({ attempts: 2, closes: 1 })
  })

  test("a failing server is recorded as failed, bounded, and never throws", async () => {
    const fakes = new Map([["alpha", fakeState()]]) // no fake for "broken"
    const logs: string[] = []
    const catalog = makeCatalog(fakes, [localEntry("alpha", "alpha"), localEntry("broken", "broken")], {
      log: (line: string) => logs.push(line),
    })
    await catalog.refresh()
    const summaries = catalog.summaries()
    expect(summaries.find((server) => server.namespace === "broken")!.status).toBe("failed")
    expect(catalog.surface().every((entry) => entry.namespace === "alpha")).toBe(true)
    expect(logs.some((line) => line.includes("broken"))).toBe(true)
  })

  test("tool count per server is capped", async () => {
    const many = Array.from({ length: MCP_MAX_TOOLS_PER_SERVER + 25 }, (_, index) => ({
      name: `tool_${index}`,
      description: "d",
      inputSchema: { type: "object", properties: {} },
    }))
    const fakes = new Map([["alpha", fakeState(many)]])
    const catalog = makeCatalog(fakes, [localEntry("alpha", "alpha")])
    await catalog.refresh()
    expect(catalog.surface().length).toBe(MCP_MAX_TOOLS_PER_SERVER)
  })
})

// ---------------------------------------------------------------------------
// Discovery: search / list / describe / list_mcp_servers
// ---------------------------------------------------------------------------

async function discoveryContext(fakes: Map<string, FakeServerState>, cli: CliAllowlist = { git: ["status"] }) {
  const catalog = makeCatalog(fakes, [localEntry("alpha", "alpha")])
  await catalog.refresh()
  return { catalog, cli, files: true }
}

describe("codemode discovery helpers (via the real dispatcher)", () => {
  test("search_tools ranks by name, bounds results, and reports totals", async () => {
    const context = await discoveryContext(new Map([["alpha", fakeState()]]))
    const capabilities = createMcpCapabilities(context)

    const found = await dispatchJson(capabilities, { capability: "codemode.search_tools", input: { query: "echo" } })
    expect(found.ok).toBe(true)
    const data = found.data as { results: Array<{ call: string }>; total: number; truncated: boolean }
    expect(data.results[0].call).toBe("mcp.alpha.echo")
    expect(data.total).toBeGreaterThanOrEqual(1)
    expect(data.truncated).toBe(false)

    const limited = await dispatchJson(capabilities, {
      capability: "codemode.search_tools",
      input: { query: "e", limit: 1 },
    })
    const limitedData = limited.data as { results: unknown[]; total: number; truncated: boolean }
    expect(limitedData.results.length).toBe(1)
    expect(limitedData.total).toBeGreaterThan(1)
    expect(limitedData.truncated).toBe(true)

    const bad = await dispatchJson(capabilities, { capability: "codemode.search_tools", input: { query: 42 } })
    expect(bad.ok).toBe(false)
    expect(bad.error!.kind).toBe("input")
  })

  test("search_tools covers the built-in and cli namespaces too", async () => {
    const context = await discoveryContext(new Map([["alpha", fakeState()]]), { git: ["status"] })
    const capabilities = createMcpCapabilities(context)
    const builtin = await dispatchJson(capabilities, { capability: "codemode.search_tools", input: { query: "read" } })
    const builtinCalls = (builtin.data as { results: Array<{ call: string }> }).results.map((entry) => entry.call)
    expect(builtinCalls).toContain("read")

    const cliSearch = await dispatchJson(capabilities, {
      capability: "codemode.search_tools",
      input: { query: "git.status" },
    })
    const cliCalls = (cliSearch.data as { results: Array<{ call: string }> }).results.map((entry) => entry.call)
    expect(cliCalls).toContain("cli.git.status")
  })

  test("list_tools clamps the limit to 1..100 (default 50) and validates offset", async () => {
    const context = await discoveryContext(new Map([["alpha", fakeState()]]))
    const capabilities = createMcpCapabilities(context)

    const page = await dispatchJson(capabilities, {
      capability: "codemode.list_tools",
      input: { namespace: "alpha" },
    })
    expect(page.ok).toBe(true)
    const pageData = page.data as { limit: number; total: number; tools: Array<{ name: string; call: string }> }
    expect(pageData.limit).toBe(MCP_LIST_DEFAULT_LIMIT)
    expect(pageData.total).toBe(2)

    const clamped = await dispatchJson(capabilities, {
      capability: "codemode.list_tools",
      input: { namespace: "alpha", limit: 1000 },
    })
    expect((clamped.data as { limit: number }).limit).toBe(MCP_LIST_MAX_LIMIT)

    const badOffset = await dispatchJson(capabilities, {
      capability: "codemode.list_tools",
      input: { namespace: "alpha", offset: -1 },
    })
    expect(badOffset.ok).toBe(false)
    expect(badOffset.error!.kind).toBe("input")

    const unknown = await dispatchJson(capabilities, {
      capability: "codemode.list_tools",
      input: { namespace: "nope" },
    })
    expect(unknown.ok).toBe(false)
    expect(unknown.error!.kind).toBe("not-found")
  })

  test("describe_tools returns bounded param signatures for built-ins, cli, and mcp tools", async () => {
    const context = await discoveryContext(new Map([["alpha", fakeState()]]))
    const capabilities = createMcpCapabilities(context)

    const read = await dispatchJson(capabilities, {
      capability: "codemode.describe_tools",
      input: { namespace: "codemode", tool: "read" },
    })
    const readData = read.data as { tools: Array<{ params: Array<{ name: string; required: boolean }> }> }
    const readParams = readData.tools[0].params.map((param) => param.name)
    expect(readParams).toEqual(["path", "offset", "limit"])
    expect(readData.tools[0].params.find((param) => param.name === "path")!.required).toBe(true)

    const echo = await dispatchJson(capabilities, {
      capability: "codemode.describe_tools",
      input: { namespace: "alpha", tool: "echo" },
    })
    const echoParams = (echo.data as { tools: Array<{ params: Array<{ name: string; type: string; required: boolean }> }> })
      .tools[0].params
    expect(echoParams).toEqual([{ name: "message", type: "string", required: true }])

    const cli = await dispatchJson(capabilities, {
      capability: "codemode.describe_tools",
      input: { namespace: "cli", tool: "git.status" },
    })
    const cliParams = (cli.data as { tools: Array<{ params: Array<{ name: string }> }> }).tools[0].params
    expect(cliParams.map((param) => param.name)).toContain("short")

    const missing = await dispatchJson(capabilities, {
      capability: "codemode.describe_tools",
      input: { namespace: "alpha", tool: "gone" },
    })
    expect(missing.ok).toBe(false)
    expect(missing.error!.kind).toBe("not-found")
  })

  test("list_mcp_servers reports status and tool counts", async () => {
    const fakes = new Map([["alpha", fakeState()]])
    const context = await discoveryContext(fakes)
    const capabilities = createMcpCapabilities(context)
    const listed = await dispatchJson(capabilities, { capability: "codemode.list_mcp_servers", input: {} })
    const data = listed.data as { servers: Array<{ name: string; namespace: string; status: string; toolCount: number }> }
    expect(data.servers).toEqual([{ name: "alpha", namespace: "alpha", status: "ready", toolCount: 2 }])
  })
})

// ---------------------------------------------------------------------------
// mcp.<ns>.<tool> calls: schema validation, stale metadata, errors, bounds
// ---------------------------------------------------------------------------

describe("mcp.<ns>.<tool> dispatch outcomes", () => {
  test("a schema-valid call reaches the server and returns bounded data", async () => {
    const fakes = new Map([["alpha", fakeState()]])
    const context = await discoveryContext(fakes)
    const capabilities = createMcpCapabilities(context)
    const call = await dispatchJson(capabilities, {
      capability: "mcp.alpha.echo",
      input: { message: "hi" },
    })
    expect(call.ok).toBe(true)
    expect(fakes.get("alpha")!.calls).toEqual([{ name: "echo", args: { message: "hi" } }])
    const data = call.data as { content: unknown; isError: boolean }
    expect(data.isError).toBe(false)
    expect(JSON.stringify(data.content)).toContain("ok:echo")
  })

  test("schema-invalid args are refused before any server call", async () => {
    const fakes = new Map([["alpha", fakeState()]])
    const context = await discoveryContext(fakes)
    const capabilities = createMcpCapabilities(context)
    const call = await dispatchJson(capabilities, {
      capability: "mcp.alpha.echo",
      input: { message: 42 },
    })
    expect(call.ok).toBe(false)
    expect(call.error!.kind).toBe("input")
    expect(call.error!.message).toContain("message")
    expect(fakes.get("alpha")!.calls.length).toBe(0)
  })

  test("stale metadata: an expired cache re-lists before dispatch and reports not-found", async () => {
    let nowMs = 0
    const state = fakeState([echoTool, noArgsTool])
    const fakes = new Map([["alpha", state]])
    const catalog = makeCatalog(fakes, [localEntry("alpha", "alpha")], {}, () => nowMs)
    await catalog.refresh()
    const capabilities = createMcpCapabilities({ catalog, cli: {}, files: true })

    // The server drops its tools AFTER the catalog cached them, and the
    // catalog TTL expires before the call.
    state.tools = []
    nowMs += MCP_CATALOG_TTL_MS + 1
    const call = await dispatchJson(capabilities, { capability: "mcp.alpha.ping", input: {} })
    expect(call.ok).toBe(false)
    expect(call.error!.kind).toBe("not-found")
    expect(call.error!.message).toContain("ping")
    expect(state.listCalls).toBe(2) // one refresh + one staleness re-list
    expect(state.calls.length).toBe(0) // the tool call itself was never sent
  })

  test("isError results are DATA (isError: true), transport failures are bounded io errors", async () => {
    const fakes = new Map([["alpha", fakeState([echoTool, noArgsTool, failTool, explodeTool])]])
    const context = await discoveryContext(fakes)
    const capabilities = createMcpCapabilities(context)

    const failed = await dispatchJson(capabilities, { capability: "mcp.alpha.fail", input: {} })
    expect(failed.ok).toBe(true)
    expect((failed.data as { isError: boolean }).isError).toBe(true)

    const exploded = await dispatchJson(capabilities, { capability: "mcp.alpha.explode", input: {} })
    expect(exploded.ok).toBe(false)
    expect(exploded.error!.kind).toBe("io")
    expect(exploded.error!.message.length).toBeLessThanOrEqual(2000)
  })

  test("an oversized server result is bounded with a truncation flag", async () => {
    const state = fakeState([echoTool, noArgsTool, bigTool])
    state.resultOverride = (name) =>
      name === "big" ? { content: [{ type: "text", text: "x".repeat(80 * 1024) }], isError: false, truncated: false } : undefined
    const fakes = new Map([["alpha", state]])
    const context = await discoveryContext(fakes)
    const capabilities = createMcpCapabilities(context)
    const call = await dispatchJson(capabilities, { capability: "mcp.alpha.big", input: {} })
    expect(call.ok).toBe(true)
    const data = call.data as { content: unknown; truncated: boolean }
    expect(data.truncated).toBe(true)
    expect(byteLength(String(data.content))).toBeLessThanOrEqual(MCP_MAX_RESULT_BYTES)
  })

  test("a hung call is bounded by the call timeout and the connection is closed", async () => {
    const state = fakeState()
    state.resultOverride = () => new Promise<McpToolResult>(() => {})
    const fakes = new Map([["alpha", state]])
    const catalog = makeCatalog(fakes, [localEntry("alpha", "alpha")], { callTimeoutMs: 100 })
    await catalog.refresh()
    const capabilities = createMcpCapabilities({ catalog, cli: {}, files: true })
    const call = await dispatchJson(capabilities, { capability: "mcp.alpha.echo", input: { message: "x" } })
    expect(call.ok).toBe(false)
    expect(call.error!.kind).toBe("limit")
    expect(call.error!.message).toContain("timed out")
    expect(state.closed).toBe(true)
  })

  test("caller cancellation closes the connection and stops an in-flight MCP call", async () => {
    const state = fakeState()
    state.resultOverride = () => new Promise<McpToolResult>(() => {})
    const fakes = new Map([["alpha", state]])
    const catalog = makeCatalog(fakes, [localEntry("alpha", "alpha")], { callTimeoutMs: 500 })
    await catalog.refresh()
    const controller = new AbortController()
    const call = catalog.callTool("alpha", "echo", { message: "x" }, {
      mode: "on",
      capabilities: capabilitiesFor(defaultPolicy()),
      root: undefined,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 10)

    const outcome = await call
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe("cancelled")
    expect(state.closed).toBe(true)
  })

  test("unknown namespaces and unknown capabilities are bounded not-found results", async () => {
    const context = await discoveryContext(new Map([["alpha", fakeState()]]))
    const capabilities = createMcpCapabilities(context)
    const unknownNs = await dispatchJson(capabilities, { capability: "mcp.nope.echo", input: {} })
    expect(unknownNs.ok).toBe(false)
    expect(unknownNs.error!.kind).toBe("unknown-capability")

    const raw = await dispatchJson(capabilities, { capability: "mcp.alpha.gone", input: {} })
    expect(raw.ok).toBe(false)
    expect(raw.error!.kind).toBe("unknown-capability")
  })

  test("mode off and a closed capability group keep every adapters closed (denied tools)", async () => {
    const context = await discoveryContext(new Map([["alpha", fakeState()]]))
    const capabilities = createMcpCapabilities(context)
    const offCaps = capabilitiesFor({ ...defaultPolicy(), mode: "off" })

    const off = await dispatchJson(capabilities, { capability: "mcp.alpha.echo", input: { message: "x" } }, "off", offCaps)
    expect(off.ok).toBe(false)
    expect(off.error!.kind).toBe("mode")

    const closedGroup = await dispatchJson(
      capabilities,
      { capability: "codemode.list_mcp_servers", input: {} },
      "on",
      { executeTools: true, files: true, cli: false, shell: false, mcp: false, jev: false },
    )
    expect(closedGroup.ok).toBe(false)
    expect(closedGroup.error!.kind).toBe("mode")
  })
})

// ---------------------------------------------------------------------------
// Guest pipeline: codemode + mcp globals through execute_tools (no I/O)
// ---------------------------------------------------------------------------

describe("guest surface through execute_tools (fake transport, real pipeline)", () => {
  async function hostWithCatalog() {
    const fakes = new Map([["alpha", fakeState()]])
    const catalog = makeCatalog(fakes, [localEntry("alpha", "alpha")])
    await catalog.refresh()
    return {
      fakes,
      host: {
        mode: "on" as const,
        capabilities: capabilitiesFor(defaultPolicy()),
        root: undefined,
        cli: {} as CliAllowlist,
        mcp: catalog,
      },
    }
  }

  test("discovery helpers and a typed mcp call work end to end inside the guest", async () => {
    const { host, fakes } = await hostWithCatalog()
    const result = await executeTools(
      `
      const found = await codemode.search_tools({ query: "echo" })
      const listed = await codemode.list_tools({ namespace: "alpha" })
      const described = await codemode.describe_tools({ namespace: "alpha", tool: "echo" })
      const servers = await codemode.list_mcp_servers()
      const call = await mcp.alpha.echo({ message: "hi" })
      return {
        found: found.results.map((entry) => entry.call),
        total: found.total,
        listed: listed.tools.map((entry) => entry.call),
        params: described.tools[0].params.map((param) => param.name),
        servers: servers.servers.map((server) => server.namespace + ":" + server.status),
        call,
      }
      `,
      { host, timeoutMs: 20_000 },
    )
    expect(result.errorKind).toBeUndefined()
    const data = result.result as {
      found: string[]
      total: number
      listed: string[]
      params: string[]
      servers: string[]
      call: { content: unknown; isError: boolean }
    }
    expect(data.found).toContain("mcp.alpha.echo")
    expect(data.total).toBeGreaterThanOrEqual(1)
    expect(data.listed).toEqual(["mcp.alpha.echo", "mcp.alpha.ping"])
    expect(data.params).toEqual(["message"])
    expect(data.servers).toEqual(["alpha:ready"])
    expect(data.call.isError).toBe(false)
    expect(fakes.get("alpha")!.calls).toEqual([{ name: "echo", args: { message: "hi" } }])
  })

  test("guest-visible failures are catchable and bounded (schema rejection)", async () => {
    const { host, fakes } = await hostWithCatalog()
    const result = await executeTools(
      `
      const messages = []
      try { await mcp.alpha.echo({ message: 42 }) } catch (error) { messages.push((error as Error).message) }
      try { await mcp.alpha.echo({}) } catch (error) { messages.push((error as Error).message) }
      return messages
      `,
      { host, timeoutMs: 20_000 },
    )
    expect(result.errorKind).toBeUndefined()
    const messages = result.result as string[]
    expect(messages.length).toBe(2)
    expect(messages[0]).toContain("message")
    expect(messages[1]).toContain("message")
    expect(fakes.get("alpha")!.calls.length).toBe(0)
  })

  test("the typed surface is exact: unknown members and closed groups are type errors before execution", async () => {
    const { host } = await hostWithCatalog()
    const unknownTool = await executeTools(`await mcp.alpha.gone({})`, { host, timeoutMs: 20_000 })
    expect(unknownTool.errorKind).toBe("type")

    const closedHost = {
      mode: "on" as const,
      capabilities: { executeTools: true, files: true, cli: false, shell: false, mcp: false, jev: false },
      root: undefined,
      cli: {} as CliAllowlist,
      mcp: undefined,
    }
    const closed = await executeTools(`await codemode.list_mcp_servers()`, { host: closedHost, timeoutMs: 20_000 })
    expect(closed.errorKind).toBe("type")

    const closedMcp = await executeTools(`await mcp.alpha.echo({ message: "x" })`, { host: closedHost, timeoutMs: 20_000 })
    expect(closedMcp.errorKind).toBe("type")
  })

  test("an oversized call result stays bounded inside the guest", async () => {
    const { host, fakes } = await hostWithCatalog()
    fakes.get("alpha")!.resultOverride = (name) =>
      name === "echo"
        ? { content: [{ type: "text", text: "y".repeat(80 * 1024) }], isError: false, truncated: false }
        : undefined
    const result = await executeTools(
      `const r = await mcp.alpha.echo({ message: "x" }); const c = r.content as string; return { truncated: r.truncated, size: c.length }`,
      { host, timeoutMs: 20_000 },
    )
    expect(result.errorKind).toBeUndefined()
    const data = result.result as { truncated: boolean; size: number }
    expect(data.truncated).toBe(true)
    expect(data.size).toBeLessThanOrEqual(MCP_MAX_RESULT_BYTES)
  })
})

// ---------------------------------------------------------------------------
// Recorded deviation: no host invocation surface, plugin owns the bridge
// ---------------------------------------------------------------------------

describe("recorded capability mismatch + Task 7 fallback (acceptance criterion 4)", () => {
  test("the host model still records no tool/MCP invocation surface", () => {
    expect(HOST_CAPABILITIES.invokeRegisteredTools.supported).toBe(false)
    expect(HOST_CAPABILITIES.invokeMcpTools.supported).toBe(false)
    expect(HOST_CAPABILITIES.pluginOwnedMcpBridge.supported).toBe(true)
  })

  test("the design deviation is recorded with the research pointer (no private/guessed host call)", () => {
    expect(TASK7_BRIDGE_DEVIATION).toContain("no invocation surface")
    expect(TASK7_BRIDGE_DEVIATION).toContain("research §5.1b")
    expect(TASK7_BRIDGE_DEVIATION).toContain("no ctx.tool.list()")
  })
})

// Keep the search/list constants visible to future changes (no silent drift).
test("documented v1 bounds stay at their Pi-parity values", () => {
  expect(MCP_SEARCH_DEFAULT_LIMIT).toBe(25)
  expect(MCP_SEARCH_MAX_LIMIT).toBe(50)
  expect(MCP_LIST_DEFAULT_LIMIT).toBe(50)
  expect(MCP_LIST_MAX_LIMIT).toBe(100)
})
