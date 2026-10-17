// tests/integration/execute-tools.test.ts
// Task 2 acceptance: the tool registers through ctx.tool.transform on the
// installed Tool.Info contract, a call reaches the plugin and returns bounded
// print output from the guest runtime, runtime errors are data, and the
// ToolContext.signal contract is honored.
//
// Fake-ctx harness pattern: config workspace tests/enforcement.test.ts +
// .opencode/playbooks/port-opencode-plugins-v1-to-v2/scripts/proof-harness/runtime.test.ts
// (record the editor passed to ctx.tool.transform, then drive the captured tool).
import { describe, expect, test } from "bun:test"
import { McpCatalog } from "../../src/capabilities/mcp"
import { MAX_OUTPUT_BYTES, executeTools } from "../../src/codemode/execute-tools"
import { EXECUTE_TOOLS_NAME, registerExecuteTools } from "../../src/plugin/register"
import plugin from "../../src/index"

type CapturedTool = {
  name: string
  description: string
  input: {
    type: string
    properties: Record<string, { type: string }>
    required: readonly string[]
    additionalProperties: boolean
  }
  options: { codemode?: boolean } | undefined
  execute: (input: unknown, context: unknown) => Promise<{ content?: string; metadata?: Record<string, unknown> }>
}

function makeHarness() {
  let captured: CapturedTool | undefined
  let transforms = 0
  const ctx = {
    app: { name: "opencode", version: "2.0.29", channel: "latest" },
    location: {
      directory: "C:/tmp/oc-codemode-integration",
      project: { id: "p1", directory: "C:/tmp/oc-codemode-integration", canonical: "C:/tmp/oc-codemode-integration" },
    },
    options: {},
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        transforms += 1
        const editor = {
          namespace: () => {},
          add: (tool: CapturedTool) => {
            captured = tool
          },
          update: () => {},
          remove: () => {},
          list: () => [],
          get: () => undefined,
        }
        callback(editor)
        return { dispose: async () => {} }
      },
      list: async () => [],
      reload: async () => {},
      hook: async () => ({ dispose: async () => {} }),
    },
    // Task 4 additions: the plugin entry registers the /codemode command
    // (ctx.command.transform) and fail-closed mode enforcement hooks
    // (ctx.permission.hook), so the fake ctx mirrors those v2 domains too.
    command: {
      transform: async (callback: (editor: { add: (definition: unknown) => void }) => void) => {
        callback({ add: () => {} })
        return { dispose: async () => {} }
      },
    },
    permission: {
      hook: async () => ({ dispose: async () => {} }),
    },
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({}),
    },
  } as any
  return {
    ctx,
    getCaptured: (): CapturedTool => {
      if (!captured) throw new Error("tool was not registered")
      return captured
    },
    getTransforms: () => transforms,
  }
}

function makeToolContext(signal?: AbortSignal) {
  return {
    sessionID: "ses_test",
    agent: "build",
    messageID: "msg_test",
    id: "call_test",
    signal: signal ?? new AbortController().signal,
    progress: async () => {},
  }
}

async function callTool(code: string, signal?: AbortSignal) {
  const harness = makeHarness()
  await registerExecuteTools(harness.ctx)
  return harness.getCaptured().execute({ code }, makeToolContext(signal))
}

describe("execute_tools registration (fake-ctx, installed Tool.Info contract)", () => {
  test("registers through ctx.tool.transform with the installed Tool.Info shape", async () => {
    const harness = makeHarness()
    await registerExecuteTools(harness.ctx)
    const tool = harness.getCaptured()
    expect(tool.name).toBe(EXECUTE_TOOLS_NAME)
    expect(typeof tool.execute).toBe("function")
    expect(tool.description.length).toBeGreaterThan(20)
    // Task 4 flipped the flag to `codemode: false` with recorded host evidence:
    // under `codemode: true` the tool was only reachable from inside the host
    // Code Mode runtime, not by a direct model call (see src/plugin/register.ts).
    expect(tool.options).toEqual({ codemode: false })
    expect(tool.input.type).toBe("object")
    expect(tool.input.required).toEqual(["code"])
    expect(tool.input.additionalProperties).toBe(false)
    expect(tool.input.properties.code.type).toBe("string")
    expect(tool.input.properties.strings.type).toBe("object")
  })

  test("registration is idempotent across repeated calls", async () => {
    const harness = makeHarness()
    await registerExecuteTools(harness.ctx)
    await registerExecuteTools(harness.ctx)
    expect(harness.getTransforms()).toBe(1)
  })

  test("plugin setup wires the registration and the cleanup disposes it", async () => {
    const harness = makeHarness()
    const cleanup = await plugin.setup(harness.ctx)
    expect(harness.getCaptured().name).toBe(EXECUTE_TOOLS_NAME)
    expect(typeof cleanup).toBe("function")
    await cleanup!()
  })
})

describe("execute_tools end to end (fake ctx -> guest runtime -> bounded print output)", () => {
  test("returns the guest's print output and returned value", async () => {
    const result = await callTool(`print("hello from guest"); return 6 * 7`)
    expect(result.content).toContain("hello from guest")
    expect(result.content).toContain("42")
    expect(result.metadata?.errorKind).toBeUndefined()
  }, 15_000)

  // Host defect reproduced on opencode 2.0.29 (e2e run 5, differential probe):
  // a tool result whose metadata has an own property with value `undefined`
  // makes the host's `session.tool.success` event encode fail, so the part is
  // never stored, the model receives "Tool result missing", and the call never
  // resolves. Success metadata therefore omits `errorKind` entirely.
  test("success metadata never carries undefined-valued keys", async () => {
    const result = await callTool(`return 41 + 1`)
    expect(result.content).toBe("42")
    expect(Object.hasOwn(result.metadata ?? {}, "errorKind")).toBe(false)
    expect(Object.values(result.metadata ?? {}).every((value) => value !== undefined)).toBe(true)
  }, 15_000)

  test("a hung host MCP config read cannot block the tool result", async () => {
    const harness = makeHarness()
    const catalog = new McpCatalog({
      servers: () => new Promise<never>(() => {}),
      listTimeoutMs: 25,
    })
    await registerExecuteTools(harness.ctx, {
      capabilitiesForSession: () => ({ executeTools: true, files: false, cli: false, shell: false, mcp: true, jev: false }),
      mcpCatalog: catalog,
    })
    const result = await harness.getCaptured().execute({ code: "return 7 * 6" }, makeToolContext())
    expect(result.content).toBe("42")
    expect(Object.hasOwn(result.metadata ?? {}, "errorKind")).toBe(false)
  }, 15_000)

  test("transpiles a typed TypeScript body (ES2022) before the guest runs it", async () => {
    const result = await callTool(
      `const n: number = 41\nconst inc: (x: number) => number = (x) => x + 1\nprint("typed", n)\nreturn inc(n)`,
    )
    expect(result.content).toContain("typed 41")
    expect(result.content).toContain("42")
  }, 15_000)

  // Bare ambient names (`typeof process`, ...) are now rejected by the
  // typechecker before execution (Task 3), so the runtime proof goes through an
  // `any` cast — it bypasses the type-only guard and still proves the guest
  // runtime exposes nothing.
  test("guest has no ambient process, require, fetch, or Deno", async () => {
    const result = await callTool(
      `const g = globalThis as any\nprint(typeof g.process, typeof g.require, typeof g.fetch, typeof g.globalThis.process, typeof g.Deno)`,
    )
    expect(result.content).toContain("undefined undefined undefined undefined undefined")
  }, 15_000)

  test("guest runtime errors are returned as bounded data, not thrown", async () => {
    const result = await callTool(`print("before"); throw new Error("boom")`)
    expect(result.content).toContain("boom")
    expect(result.content).toContain("before")
    expect(result.metadata?.errorKind).toBe("runtime")
  }, 15_000)

  test("a type error is returned before guest execution (no print side effect)", async () => {
    const result = await callTool(`print("SIDE-EFFECT-RAN")\nconst n: number = "no"`)
    expect(result.metadata?.errorKind).toBe("type")
    expect(result.content).toContain("Type errors (code was NOT executed)")
    expect(result.content).not.toContain("SIDE-EFFECT-RAN")
  }, 15_000)

  test("print output is bounded at 50 KiB with an explicit truncation marker", async () => {
    const result = await callTool(`print("x".repeat(200 * 1024))`)
    expect(result.metadata?.truncated).toBe(true)
    expect(result.content!.length).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 200)
  }, 15_000)

  test("pre-aborted ToolContext.signal cancels before guest execution", async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await callTool(`print("never")`, controller.signal)
    expect(result.metadata?.errorKind).toBe("runtime")
    expect(result.content).toContain("Execution cancelled")
    expect(result.content).not.toContain("never")
  }, 15_000)

  test("enforces the execution deadline inside the guest", async () => {
    const result = await executeTools(`while (true) {}`, { timeoutMs: 400 })
    expect(result.errorKind).toBe("runtime")
    expect(result.error ?? "").toMatch(/timed out/i)
  }, 15_000)

  test("the registered tool enforces the effective executor timeout policy", async () => {
    const harness = makeHarness()
    const catalog = new McpCatalog({
      servers: () => [["test", { type: "local", command: ["test"] }]],
      connect: async () => ({
        listTools: async () => [{ name: "wait" }],
        callTool: async () => new Promise(() => {}),
        close: async () => {},
      }),
      callTimeoutMs: 700,
    })
    await registerExecuteTools(harness.ctx, {
      executorTimeoutMsForSession: () => 100,
      capabilitiesForSession: () => ({ executeTools: true, files: true, cli: false, shell: false, mcp: true, jev: false }),
      mcpCatalog: catalog,
    })
    const controller = new AbortController()
    const safetyAbort = setTimeout(() => controller.abort(), 500)
    const result = await harness.getCaptured().execute(
      { code: "await mcp.test.wait({}); return 'finished'" },
      makeToolContext(controller.signal),
    )
    clearTimeout(safetyAbort)
    await catalog.dispose()

    expect(result.content ?? "").toContain("Execution timed out after 100ms")
    expect(result.metadata?.errorKind).toBe("runtime")
  }, 5_000)

  test("submit sequential calls in parallel", async () => {
    const [a, b] = await Promise.all([callTool(`return "a"`), callTool(`return "b"`)])
    expect(a.content).toBe("a")
    expect(b.content).toBe("b")
  }, 15_000)
})
