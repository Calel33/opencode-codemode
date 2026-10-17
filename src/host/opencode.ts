// src/host/opencode.ts
// Host capability model for the installed @opencode/plugin@2.0.19 contract.
//
// Task 2 GATE 1 finding (recorded with evidence, verified in the running
// 2.0.29 host): plugin code can REGISTER tools, but there is no documented
// surface to INVOKE a registered tool (including the built-in Code Mode
// `execute` tool) and no plugin-side Code Mode runtime. The fallback design is
// to re-implement the MCP client + tool catalog inside the plugin (Task 7).
import type { Plugin } from "@opencode/plugin"

export interface HostCapability {
  readonly supported: boolean
  readonly evidence: string
}

/**
 * Task 7 design deviation (recorded for review, acceptance criterion 4):
 * "host provides no invocation surface; plugin owns the bridge
 * (research §5.1b)". The v2 host exposes NO tool/MCP invocation surface to
 * plugins (invokeRegisteredTools / invokeMcpTools below are false), so per
 * the workflow's own stop condition — no private or guessed call is added —
 * the plugin re-implements the bridge inside itself: a plugin-owned
 * local-stdio MCP client + tool catalog (src/capabilities/mcp.ts). Nothing in
 * this plugin calls a ctx.tool.list() item's execute(); the only host call
 * used is the documented MCP CONFIG read ctx.mcp.list().
 */
export const TASK7_BRIDGE_DEVIATION =
  "host provides no invocation surface; plugin owns the bridge (research §5.1b): local-stdio MCP client + tool catalog in src/capabilities/mcp.ts; no ctx.tool.list() item execute() call and no host-private endpoint is used."

export const HOST_CAPABILITIES: Readonly<Record<string, HostCapability>> = {
  registerTools: {
    supported: true,
    evidence:
      "ToolDomain.transform + ToolEditor.add — @opencode/plugin@2.0.19 dist/promise/tool.d.ts:53-60, dist/promise/adapter.js:333-357",
  },
  invokeRegisteredTools: {
    supported: false,
    evidence:
      "ToolDomain = transform|reload|list|hook; no invoke/call method (dist/promise/tool.d.ts:53-60; adapter.js:330-359). Host HTTP API has no tool endpoint: GET /api/tool -> HTTP 404 on opencode 2.0.29. list() items carry a wrapped execute but with no documented invocation contract (adapter.js:332-337).",
  },
  invokeMcpTools: {
    supported: false,
    evidence:
      "MCPDomain = transform|reload|list (dist/promise/mcp.d.ts:5-15) — server config management only; no MCP tool invocation surface.",
  },
  pluginOwnedMcpBridge: {
    supported: true,
    evidence: `${TASK7_BRIDGE_DEVIATION} Client path verified before adoption: @modelcontextprotocol/client@2.3.1 (exact pin) real-stdio smoke under node 24.18.0 and bun 1.4.3 (spawn -> initialize -> tools/list -> tools/call -> isError -> close).`,
  },
  hostCodeModeRuntime: {
    supported: false,
    evidence:
      "Built-in Code Mode is the model-facing `execute` tool (docs build/plugins). The promise plugin context built in dist/promise/adapter.js:200-436 exposes no execute/codemode handle, and no ClientApi endpoint group covers tools.",
  },
}

export interface ToolDomainInspection {
  readonly methods: readonly string[]
  readonly hasInvokeSurface: boolean
}

const INVOKE_METHOD_NAMES = ["invoke", "call", "execute"]

/** Enumerates the runtime surface of the plugin's ToolDomain (adapter object). */
export function inspectToolDomain(tool: unknown): ToolDomainInspection {
  if (typeof tool !== "object" || tool === null) return { methods: [], hasInvokeSurface: false }
  const methods = Object.keys(tool).sort()
  return {
    methods,
    hasInvokeSurface: methods.some((method) => INVOKE_METHOD_NAMES.includes(method)),
  }
}

export type HostProbeTool = {
  readonly id: string
  readonly name: string
  readonly hasExecute: boolean
  readonly codemode: boolean
}

export type HostProbeSnapshot = {
  readonly app: { readonly name: string; readonly version: string }
  readonly toolMethods: readonly string[]
  readonly hasInvokeSurface: boolean
  readonly tools: readonly HostProbeTool[]
  readonly executeToolInCatalog: boolean
  readonly capturedAt: string
}

/**
 * Captures the live host surface for the GATE 1 evidence record: the runtime
 * ToolDomain shape, the registered tool catalog, and whether the built-in
 * `execute` (Code Mode) tool appears as a catalog entry.
 */
export async function collectHostProbe(ctx: Plugin.Context): Promise<HostProbeSnapshot> {
  const inspection = inspectToolDomain(ctx.tool)
  let tools: HostProbeTool[] = []
  try {
    const listed = await ctx.tool.list()
    tools = listed.map((tool) => ({
      id: String(tool.id),
      name: tool.name,
      hasExecute: typeof tool.execute === "function",
      codemode: tool.options?.codemode === true,
    }))
  } catch {
    tools = []
  }
  return {
    app: { name: ctx.app.name, version: ctx.app.version },
    toolMethods: inspection.methods,
    hasInvokeSurface: inspection.hasInvokeSurface,
    tools,
    executeToolInCatalog: tools.some((tool) => tool.name === "execute" || tool.id === "execute"),
    capturedAt: new Date().toISOString(),
  }
}
