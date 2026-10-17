// tests/integration/mcp.test.ts
// Task 7 integration acceptance: the plugin-owned MCP bridge against a REAL
// child process over REAL stdio, through the REAL pipeline (execute_tools ->
// typecheck -> QuickJS guest -> validated dispatcher -> catalog -> SDK stdio
// transport). The fixture server (tests/fixtures/mcp-fixture-server.mjs) is a
// minimal deterministic MCP implementation; driving the production client
// path against it over a real transport IS a real integration test for the
// client path. No mocks anywhere in this file.
//
// Acceptance criteria covered here:
//   1. discovery helpers return current, bounded metadata (limits/counts).
//   2. calls reach only tools in the live catalog, with schema-validated args.
//   3. unknown tools, stale metadata, denied servers, and server errors
//      return clear bounded results.
//   4. the recorded deviation holds: no host invocation surface exists; the
//      plugin-owned bridge works without it (asserted via the recorded
//      constants + the fact that these tests pass with no host at all).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { McpCatalog } from "../../src/capabilities/mcp"
import { executeTools } from "../../src/codemode/execute-tools"
import { capabilitiesFor, defaultPolicy } from "../../src/config/policy"
import type { Mode } from "../../src/config/policy"
import { HOST_CAPABILITIES, TASK7_BRIDGE_DEVIATION } from "../../src/host/opencode"
import { registerExecuteTools } from "../../src/plugin/register"

const fixturePath = join(import.meta.dir, "..", "fixtures", "mcp-fixture-server.mjs")
const fixtureEntry = (name: string): [string, unknown] => [
  name,
  { type: "local", command: [process.execPath, fixturePath] },
]

function makeCatalog(entries: ReadonlyArray<readonly [string, unknown]>, extra: Record<string, unknown> = {}) {
  const logs: string[] = []
  const catalog = new McpCatalog({
    servers: () => entries,
    log: (line: string) => logs.push(line),
    ...extra,
  })
  return { catalog, logs }
}

function hostFor(catalog: McpCatalog, mode: Mode = "on") {
  return {
    mode,
    capabilities: capabilitiesFor({ ...defaultPolicy(), mode }),
    root: undefined,
    cli: {},
    mcp: catalog,
  }
}

async function runGuest(code: string, catalog: McpCatalog, mode: Mode = "on") {
  return executeTools(code, { host: hostFor(catalog, mode), timeoutMs: 30_000 })
}

// ---------------------------------------------------------------------------
// Live catalog: discovery + calls through execute_tools (real child process)
// ---------------------------------------------------------------------------

describe("MCP through execute_tools (real fixture server over real stdio)", () => {
  const { catalog } = makeCatalog([fixtureEntry("fixture")])

  beforeAll(async () => {
    await catalog.refresh()
  })

  afterAll(async () => {
    await catalog.dispose()
  })

  test("a schema-valid mcp.<ns>.<tool> call runs against the real server", async () => {
    const result = await runGuest(
      `const r = await mcp.fixture.echo({ message: "hi" }); return r`,
      catalog,
    )
    expect(result.errorKind).toBeUndefined()
    const call = result.result as { content: Array<{ type: string; text: string }>; isError: boolean; truncated: boolean }
    expect(call.isError).toBe(false)
    expect(call.truncated).toBe(false)
    expect(call.content).toEqual([{ type: "text", text: "echo:hi" }])
  }, 30_000)

  test("discovery helpers return the live catalog with bounded metadata", async () => {
    const result = await runGuest(
      `
      const servers = await codemode.list_mcp_servers()
      const listed = await codemode.list_tools({ namespace: "fixture" })
      const paged = await codemode.list_tools({ namespace: "fixture", limit: 3 })
      const described = await codemode.describe_tools({ namespace: "fixture", tool: "echo" })
      const searched = await codemode.search_tools({ query: "add" })
      return {
        servers: servers.servers.map((server) => server.namespace + ":" + server.status),
        total: listed.total,
        calls: listed.tools.map((entry) => entry.call),
        pagedTotal: paged.total,
        pagedTruncated: paged.truncated,
        pagedCount: paged.tools.length,
        params: described.tools[0].params,
        searched: searched.results.map((entry) => entry.call),
      }
      `,
      catalog,
    )
    expect(result.errorKind).toBeUndefined()
    const data = result.result as {
      servers: string[]
      total: number
      calls: string[]
      pagedTotal: number
      pagedTruncated: boolean
      pagedCount: number
      params: Array<{ name: string; type: string; required: boolean }>
      searched: string[]
    }
    expect(data.servers).toEqual(["fixture:ready"])
    expect(data.total).toBe(8)
    expect(data.calls).toContain("mcp.fixture.echo")
    expect(data.pagedTotal).toBe(8)
    expect(data.pagedTruncated).toBe(true)
    expect(data.pagedCount).toBe(3)
    expect(data.params).toEqual([{ name: "message", type: "string", required: true }])
    expect(data.searched).toContain("mcp.fixture.add")
  }, 30_000)

  test("schema-invalid args fail before the wire; isError results are data", async () => {
    const rejected = await runGuest(
      `
      const messages: string[] = []
      try { await mcp.fixture.echo({ message: 42 }) } catch (error) { messages.push((error as Error).message) }
      return messages
      `,
      catalog,
    )
    expect(rejected.errorKind).toBeUndefined()
    expect((rejected.result as string[])[0]).toContain("message")

    const failed = await runGuest(
      `const r = await mcp.fixture.fail({}); return { isError: r.isError, content: r.content }`,
      catalog,
    )
    expect(failed.errorKind).toBeUndefined()
    expect((failed.result as { isError: boolean }).isError).toBe(true)
  }, 30_000)

  test("server errors are bounded guest-catchable results", async () => {
    const result = await runGuest(
      `
      const messages: string[] = []
      try { await mcp.fixture.boom({}) } catch (error) { messages.push((error as Error).message) }
      return messages
      `,
      catalog,
    )
    expect(result.errorKind).toBeUndefined()
    const messages = result.result as string[]
    expect(messages.length).toBe(1)
    expect(messages[0]).toContain("fixture internal error")
  }, 30_000)

  test("an oversized server payload arrives truncated and bounded", async () => {
    const result = await runGuest(
      `
      const r = await mcp.fixture.big({})
      const text = r.content as string
      return { truncated: r.truncated, length: text.length }
      `,
      catalog,
    )
    expect(result.errorKind).toBeUndefined()
    const data = result.result as { truncated: boolean; length: number }
    expect(data.truncated).toBe(true)
    expect(data.length).toBeLessThanOrEqual(50 * 1024)
  }, 30_000)

  test("unknown members are type-invisible; the raw bridge stays bounded too", async () => {
    const typed = await runGuest(`await mcp.fixture.gone({})`, catalog)
    expect(typed.errorKind).toBe("type")

    const raw = await runGuest(
      `
      const g = globalThis as any
      const unknownTool = JSON.parse(await g["__codemodeHostCall"](JSON.stringify({ capability: "mcp.fixture.gone", input: {} })))
      const unknownNs = JSON.parse(await g["__codemodeHostCall"](JSON.stringify({ capability: "mcp.nope.echo", input: {} })))
      return { tool: unknownTool.error.kind, ns: unknownNs.error.kind }
      `,
      catalog,
    )
    expect(raw.errorKind).toBeUndefined()
    expect(raw.result).toEqual({ tool: "unknown-capability", ns: "unknown-capability" })
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Stale metadata: the server mutates its own catalog (isolated fixture)
// ---------------------------------------------------------------------------

describe("stale metadata end to end (server mutates its tool list)", () => {
  const { catalog } = makeCatalog([fixtureEntry("fixture")])

  beforeAll(async () => {
    await catalog.refresh()
  })

  afterAll(async () => {
    await catalog.dispose()
  })

  test("a dropped tool fails bounded; an explicit refresh rebuilds the surface", async () => {
    expect(catalog.surface().some((entry) => entry.tool === "vanish")).toBe(true)

    const mutate = await runGuest(`const r = await mcp.fixture.mutate({}); return r.isError`, catalog)
    expect(mutate.errorKind).toBeUndefined()
    expect(mutate.result).toBe(false)

    // Within the TTL the cached name is still in the surface, so the call is
    // sent and the SERVER rejects it — a bounded, guest-catchable result.
    const staleCall = await runGuest(
      `
      const messages: string[] = []
      try { await mcp.fixture.vanish({}) } catch (error) { messages.push((error as Error).message) }
      return messages
      `,
      catalog,
    )
    expect(staleCall.errorKind).toBeUndefined()
    expect((staleCall.result as string[])[0]).toContain("vanish")

    // The explicit refresh path (the /codemode refresh wiring) rebuilds metadata.
    await catalog.refresh()
    expect(catalog.surface().some((entry) => entry.tool === "vanish")).toBe(false)

    const rawGone = await runGuest(
      `
      const g = globalThis as any
      const outcome = JSON.parse(await g["__codemodeHostCall"](JSON.stringify({ capability: "mcp.fixture.vanish", input: {} })))
      return outcome.error.kind
      `,
      catalog,
    )
    expect(rawGone.errorKind).toBeUndefined()
    expect(rawGone.result).toBe("unknown-capability")
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Selection outcomes: sanitized namespaces, denied servers, connect failures
// ---------------------------------------------------------------------------

describe("server selection outcomes", () => {
  const { catalog } = makeCatalog([
    fixtureEntry("Sanitizer-1"),
    ["off", { type: "local", command: [process.execPath, fixturePath], disabled: true }],
    ["direct", { type: "local", command: [process.execPath, fixturePath], codemode: false }],
    ["remote", { type: "remote", url: "https://example.invalid/mcp" }],
    ["broken", { type: "local", command: ["definitely-not-a-real-executable-xyz"] }],
  ])

  beforeAll(async () => {
    await catalog.refresh()
  })

  afterAll(async () => {
    await catalog.dispose()
  }, 30_000)

  test("sanitized namespaces are callable; denied/remote/broken servers are absent but reported", async () => {
    const result = await runGuest(
      `
      const servers = await codemode.list_mcp_servers()
      const call = await mcp.Sanitizer_1.echo({ message: "clean" })
      return { servers: servers.servers.map((server) => server.namespace + ":" + server.status), call: call.content }
      `,
      catalog,
    )
    expect(result.errorKind).toBeUndefined()
    const data = result.result as { servers: string[]; call: Array<{ text: string }> }
    expect(data.servers).toContain("Sanitizer_1:ready")
    expect(data.servers).toContain("broken:failed")
    expect(data.servers.some((entry) => entry.startsWith("off:"))).toBe(false)
    expect(data.servers.some((entry) => entry.startsWith("direct:"))).toBe(false)
    expect(data.servers.some((entry) => entry.startsWith("remote:"))).toBe(false)
    expect(data.call).toEqual([{ type: "text", text: "echo:clean" }])

    const broken = await runGuest(`await mcp.broken.echo({})`, catalog)
    expect(broken.errorKind).toBe("type") // never in the typed surface
  }, 30_000)

  test("mode off removes the whole codemode/mcp surface before execution", async () => {
    const result = await runGuest(`await codemode.list_mcp_servers()`, catalog, "off")
    expect(result.errorKind).toBe("type")
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Bounded call timeout (real hung server)
// ---------------------------------------------------------------------------

describe("bounded call timeout", () => {
  const { catalog } = makeCatalog([fixtureEntry("fixture")], { callTimeoutMs: 700 })

  beforeAll(async () => {
    await catalog.refresh()
  })

  afterAll(async () => {
    await catalog.dispose()
  })

  test("a hung tool call is killed and reported as a bounded runtime error", async () => {
    const result = await runGuest(`await mcp.fixture.hang({})`, catalog)
    expect(result.errorKind).toBe("runtime")
    expect(result.error ?? "").toContain("timed out")
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Register-level wiring: the gate refreshes the catalog on use
// ---------------------------------------------------------------------------

describe("registerExecuteTools gate wires the plugin-owned catalog", () => {
  test("a fresh catalog is loaded by the gate without a manual refresh", async () => {
    const { catalog } = makeCatalog([fixtureEntry("fixture")])
    let captured:
      | {
          execute: (
            input: unknown,
            context: unknown,
          ) => Promise<{ content?: string; metadata?: Record<string, unknown> }>
        }
      | undefined
    const ctx = {
      tool: {
        transform: async (callback: (editor: unknown) => void) => {
          const editor = { add: (tool: unknown) => { captured = tool as typeof captured } }
          callback(editor)
          return { dispose: async () => {} }
        },
      },
    } as any
    await registerExecuteTools(ctx, {
      modeForSession: () => "on",
      capabilitiesForSession: () => capabilitiesFor(defaultPolicy()),
      cliAllowlistForSession: () => ({}),
      mcpCatalog: catalog,
    })
    if (!captured) throw new Error("tool was not registered")
    const result = await captured.execute(
      { code: `const r = await mcp.fixture.echo({ message: "gate" }); print("content", JSON.stringify(r.content))` },
      { sessionID: "ses_task7", signal: new AbortController().signal, progress: async () => {} },
    )
    expect(result.content ?? "").toContain("echo:gate")
    await catalog.dispose()
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Recorded deviation (criterion 4): no host invocation surface was used
// ---------------------------------------------------------------------------

describe("recorded deviation holds for the integration path", () => {
  test("the host still exposes no invocation surface while the plugin bridge works", () => {
    expect(HOST_CAPABILITIES.invokeRegisteredTools.supported).toBe(false)
    expect(HOST_CAPABILITIES.invokeMcpTools.supported).toBe(false)
    expect(TASK7_BRIDGE_DEVIATION).toContain("plugin owns the bridge")
    // Everything above passed with no OpenCode host process involved at all —
    // the plugin-owned bridge is the only moving part.
  })
})
