// tests/unit/host-contract.test.ts
// Task 2 GATE 1: asserts the recorded host capability model for the installed
// @opencode/plugin@2.0.19 contract. Every blocked capability must carry its
// evidence pointer; the inspection helper must match the adapter-shaped
// ToolDomain (dist/promise/adapter.js:330-359: reload | list | transform | hook).
import { describe, expect, test } from "bun:test"
import { HOST_CAPABILITIES, collectHostProbe, inspectToolDomain } from "../../src/host/opencode"

describe("recorded host capability model (Task 2 GATE 1)", () => {
  test("tool registration is the only supported tool surface", () => {
    expect(HOST_CAPABILITIES.registerTools.supported).toBe(true)
    expect(HOST_CAPABILITIES.invokeRegisteredTools.supported).toBe(false)
    expect(HOST_CAPABILITIES.invokeMcpTools.supported).toBe(false)
    expect(HOST_CAPABILITIES.hostCodeModeRuntime.supported).toBe(false)
  })

  test("blocked capabilities carry concrete evidence and supported ones cite the contract", () => {
    for (const capability of Object.values(HOST_CAPABILITIES)) {
      expect(capability.evidence.length).toBeGreaterThan(20)
    }
    expect(HOST_CAPABILITIES.invokeRegisteredTools.evidence).toContain("ToolDomain")
    expect(HOST_CAPABILITIES.hostCodeModeRuntime.evidence).toContain("adapter.js")
  })

  test("inspectToolDomain reports the adapter ToolDomain methods and no invoke surface", () => {
    const adapterShaped = {
      reload: async () => {},
      list: async () => [],
      transform: async () => ({ dispose: async () => {} }),
      hook: async () => ({ dispose: async () => {} }),
    }
    const inspection = inspectToolDomain(adapterShaped)
    expect(inspection.methods).toEqual(["hook", "list", "reload", "transform"])
    expect(inspection.hasInvokeSurface).toBe(false)
  })

  test("inspectToolDomain flags a hypothetical invoke surface", () => {
    const withInvoke = { reload: () => {}, list: () => [], transform: () => {}, hook: () => {}, invoke: () => {} }
    expect(inspectToolDomain(withInvoke).hasInvokeSurface).toBe(true)
    expect(inspectToolDomain(withInvoke).methods).toEqual(["hook", "invoke", "list", "reload", "transform"])
  })

  test("collectHostProbe captures the domain surface and the live tool catalog", async () => {
    const ctx = {
      app: { name: "opencode", version: "2.0.29", channel: "latest" },
      tool: {
        reload: () => {},
        list: async () => [
          { id: "execute_tools", name: "execute_tools", execute: async () => ({}), options: { codemode: true } },
          { id: "execute", name: "execute", execute: async () => ({}), options: {} },
        ],
        transform: () => {},
        hook: () => {},
      },
    } as any
    const probe = await collectHostProbe(ctx)
    expect(probe.app.version).toBe("2.0.29")
    expect(probe.toolMethods).toEqual(["hook", "list", "reload", "transform"])
    expect(probe.hasInvokeSurface).toBe(false)
    expect(probe.tools.length).toBe(2)
    expect(probe.tools[0]).toEqual({ id: "execute_tools", name: "execute_tools", hasExecute: true, codemode: true })
    expect(probe.executeToolInCatalog).toBe(true)
  })

  test("collectHostProbe survives a failing tool list", async () => {
    const ctx = {
      app: { name: "opencode", version: "2.0.29", channel: "latest" },
      tool: {
        reload: () => {},
        list: async () => {
          throw new Error("catalog unavailable")
        },
        transform: () => {},
        hook: () => {},
      },
    } as any
    const probe = await collectHostProbe(ctx)
    expect(probe.tools).toEqual([])
    expect(probe.executeToolInCatalog).toBe(false)
  })
})
