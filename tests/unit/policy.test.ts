// tests/unit/policy.test.ts
// Task 4 acceptance (fast-workflow todo):
//   1. `off` disables CodeMode capabilities; `on` allows only policy-defined groups.
//   2. Project settings narrow global mode/CLI but cannot widen; `lock: true` ignores
//      project overrides.
//   3. `/codemode on|off|refresh` works through the verified command interface;
//      `yolo` requires an effective policy that allows it (Task 11) and `jev`
//      reports the optional TypeSafe status (Task 11).
//   4. Native tool restrictions are session scoped where supported and fail closed
//      when enforcement cannot be proven.
// Plus: defaults preserved from Pi (research §2.12: {mode:"on", quickjs, 120000}),
// malformed options fail closed, command arg parsing, and two sessions with
// different in-memory modes.
//
// Fake-ctx harness pattern: C:\Users\calvi\.config\opencode\tests\enforcement.test.ts
// and .opencode/playbooks/port-opencode-plugins-v1-to-v2 (records the editor passed
// to ctx.tool.transform / ctx.command.transform, then drives the captured objects).
import { describe, expect, test } from "bun:test"
import plugin from "../../src/index"
import {
  MODE_RANK,
  YOLO_AVAILABLE,
  capabilitiesFor,
  defaultPolicy,
  isModeAvailable,
  modeRank,
  validatePolicyInput,
} from "../../src/config/policy"
import { resolvePolicy } from "../../src/config/load-policy"
import { SessionModeStore, parseCodemodeArgs } from "../../src/plugin/command"
import {
  MODE_ENFORCEMENT_DESIGN,
  NATIVE_DENY_GATE,
  applyNativeSessionDenies,
  nativeSessionDenyRules,
} from "../../src/plugin/register"

// ---------------------------------------------------------------------------
// Fake ctx harness (V2-shaped; covers every field plugin.setup touches)
// ---------------------------------------------------------------------------
type CapturedTool = {
  name: string
  description: string
  options?: Record<string, unknown>
  execute: (input: unknown, context: unknown) => Promise<{ content?: string; metadata?: Record<string, unknown> }>
}
type CapturedCommand = {
  name: string
  description?: string
  execute: (input: unknown) => Promise<void>
}
type EvaluateEvent = { sessionID: string; action: string; resources: string[]; effect: string; message?: string }
type ToolBeforeEvent = { tool: string; sessionID: string }

function makeHarness(options: Record<string, unknown> = {}) {
  const state = {
    tools: [] as CapturedTool[],
    commands: [] as CapturedCommand[],
    toolHooks: {} as Record<string, (event: ToolBeforeEvent) => unknown>,
    permissionHooks: {} as Record<string, (event: EvaluateEvent) => unknown>,
    replies: [] as { sessionID: string; text: string }[],
    sessionUpdates: [] as unknown[],
    toolTransforms: 0,
    commandTransforms: 0,
    permissionRegistrations: 0,
    toolHookRegistrations: 0,
    disposes: 0,
  }
  const ctx = {
    app: { name: "opencode", version: "2.0.29", channel: "latest" },
    location: {
      directory: "C:/tmp/oc-codemode-policy",
      project: { id: "p1", directory: "C:/tmp/oc-codemode-policy", canonical: "C:/tmp/oc-codemode-policy" },
    },
    options,
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        state.toolTransforms += 1
        callback({
          namespace: () => {},
          add: (tool: CapturedTool) => state.tools.push(tool),
          update: () => {},
          remove: () => {},
          list: () => [],
          get: () => undefined,
        })
        return { dispose: async () => { state.disposes += 1 } }
      },
      list: async () => [],
      reload: async () => {},
      hook: async (name: string, cb: (event: ToolBeforeEvent) => unknown) => {
        state.toolHookRegistrations += 1
        state.toolHooks[name] = cb
        return { dispose: async () => { state.disposes += 1 } }
      },
    },
    command: {
      transform: async (callback: (editor: unknown) => void) => {
        state.commandTransforms += 1
        callback({ add: (definition: CapturedCommand) => state.commands.push(definition) })
        return { dispose: async () => { state.disposes += 1 } }
      },
      list: async () => [],
      reload: async () => {},
    },
    permission: {
      hook: async (name: string, cb: (event: EvaluateEvent) => unknown) => {
        state.permissionRegistrations += 1
        state.permissionHooks[name] = cb
        return { dispose: async () => { state.disposes += 1 } }
      },
      list: async () => [],
      get: async () => undefined,
      reply: async () => {},
    },
    session: {
      update: async (input: unknown) => {
        state.sessionUpdates.push(input)
      },
      synthetic: async (input: { sessionID: string; text: string }) => {
        state.replies.push({ sessionID: String(input.sessionID), text: String(input.text) })
      },
      hook: async () => ({ dispose: async () => {} }),
    },
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({}),
    },
  } as any
  return { ctx, state }
}

async function setupHarness(options: Record<string, unknown> = {}) {
  const harness = makeHarness(options)
  const cleanup = await plugin.setup(harness.ctx)
  return { ...harness, cleanup }
}

function tool(state: ReturnType<typeof makeHarness>["state"]): CapturedTool {
  const captured = state.tools[state.tools.length - 1]
  if (!captured) throw new Error("execute_tools was not registered")
  return captured
}

function command(state: ReturnType<typeof makeHarness>["state"]): CapturedCommand {
  const captured = state.commands[0]
  if (!captured) throw new Error("/codemode was not registered")
  return captured
}

async function runCommand(state: ReturnType<typeof makeHarness>["state"], sessionID: string, text: string) {
  await command(state).execute({ sessionID, prompt: { text }, delivery: {} })
}

function lastReply(state: ReturnType<typeof makeHarness>["state"]) {
  const reply = state.replies[state.replies.length - 1]
  if (!reply) throw new Error("no reply was sent")
  return reply
}

async function callTool(state: ReturnType<typeof makeHarness>["state"], sessionID: string, code: string) {
  return tool(state).execute(
    { code },
    { sessionID, agent: "build", messageID: "m1", id: "c1", signal: new AbortController().signal, progress: async () => {} },
  )
}

// ---------------------------------------------------------------------------
// Defaults preserved from the original Pi package (research §2.12)
// ---------------------------------------------------------------------------
describe("policy defaults (Pi parity: {mode:'on', quickjs, 120000})", () => {
  test("defaultPolicy matches the shipped Pi default config", () => {
    const policy = defaultPolicy()
    expect(policy.mode).toBe("on")
    expect(policy.executor).toEqual({ type: "quickjs", timeoutMs: 120_000 })
    expect(policy.cli).toEqual({})
    expect(policy.lock).toBe(false)
    expect(policy.source).toBe("default")
  })

  test("resolvePolicy(undefined) and resolvePolicy({}) resolve the default without errors", () => {
    for (const raw of [undefined, {}]) {
      const { policy, errors } = resolvePolicy(raw)
      expect(errors).toEqual([])
      expect(policy.mode).toBe("on")
      expect(policy.executor.timeoutMs).toBe(120_000)
      expect(policy.source).toBe("default")
    }
  })

  test("valid global options are applied verbatim", () => {
    const { policy, errors } = resolvePolicy({
      mode: "off",
      executor: { timeoutMs: 5000 },
      cli: { git: ["status", "log"] },
      lock: true,
    })
    expect(errors).toEqual([])
    expect(policy.mode).toBe("off")
    expect(policy.executor).toEqual({ type: "quickjs", timeoutMs: 5000 })
    expect(policy.cli).toEqual({ git: ["status", "log"] })
    expect(policy.lock).toBe(true)
    expect(policy.source).toBe("global")
  })

  test("mode ordering matches Pi permissiveness {off:0, on:1, yolo:2}", () => {
    expect(MODE_RANK).toEqual({ off: 0, on: 1, yolo: 2 })
    expect(modeRank("off")).toBeLessThan(modeRank("on"))
    expect(modeRank("on")).toBeLessThan(modeRank("yolo"))
  })
})

// ---------------------------------------------------------------------------
// Criterion 2: narrow-only project overlay + lock
// ---------------------------------------------------------------------------
describe("narrow-only project overlay (criterion 2)", () => {
  test("project can narrow the global mode", () => {
    const { policy } = resolvePolicy({ mode: "on", project: { mode: "off" } })
    expect(policy.mode).toBe("off")
    expect(policy.source).toBe("project")
  })

  test("project cannot widen the global mode", () => {
    const { policy, notes } = resolvePolicy({ mode: "off", project: { mode: "on" } })
    expect(policy.mode).toBe("off")
    expect(notes.some((note) => note.includes("widen"))).toBe(true)
  })

  test("project narrows the CLI allowlist by per-tool intersection", () => {
    const { policy } = resolvePolicy({
      mode: "on",
      cli: { git: ["status", "log"], gh: ["issue"] },
      project: { cli: { git: ["status"] } },
    })
    expect(policy.cli).toEqual({ git: ["status"], gh: ["issue"] })
  })

  test("project cannot add CLI tools or operations that global does not grant", () => {
    const { policy, notes } = resolvePolicy({
      mode: "on",
      cli: { git: ["status"] },
      project: { cli: { npm: ["test"], git: ["status", "push"] } },
    })
    expect(policy.cli).toEqual({ git: ["status"] })
    expect(notes.some((note) => note.includes("npm"))).toBe(true)
  })

  test("project can remove a CLI tool entirely with an empty operation list", () => {
    const { policy } = resolvePolicy({
      mode: "on",
      cli: { git: ["status"] },
      project: { cli: { git: [] } },
    })
    expect(policy.cli).toEqual({})
  })

  test("lock: true ignores project mode and CLI overrides (executor still merges, Pi §2.12)", () => {
    const { policy, notes } = resolvePolicy({
      mode: "on",
      lock: true,
      cli: { git: ["status"] },
      project: { mode: "off", cli: { git: [] }, executor: { timeoutMs: 1000 } },
    })
    expect(policy.mode).toBe("on")
    expect(policy.cli).toEqual({ git: ["status"] })
    expect(policy.executor.timeoutMs).toBe(1000)
    expect(notes.some((note) => note.includes("lock"))).toBe(true)
  })

  test("yolo in config is the explicit administrator selection (available since Task 11)", () => {
    expect(YOLO_AVAILABLE).toBe(true)
    expect(isModeAvailable("yolo")).toBe(true)
    expect(isModeAvailable("on")).toBe(true)
    const { policy, notes } = resolvePolicy({ mode: "yolo" })
    expect(policy.mode).toBe("yolo")
    expect(policy.source).toBe("global")
    expect(notes.some((note) => note.includes("clamped"))).toBe(false)
  })

  test("a project may narrow a configured yolo down (narrow-only)", () => {
    const narrowed = resolvePolicy({ mode: "yolo", project: { mode: "off" } })
    expect(narrowed.policy.mode).toBe("off")
    const toOn = resolvePolicy({ mode: "yolo", project: { mode: "on" } })
    expect(toOn.policy.mode).toBe("on")
  })
})

// ---------------------------------------------------------------------------
// Malformed options fail closed
// ---------------------------------------------------------------------------
describe("malformed options fail closed", () => {
  const cases: Array<[string, unknown]> = [
    ["non-object options", "not-an-object"],
    ["invalid mode", { mode: "sometimes" }],
    ["invalid executor type", { executor: { type: "deno" } }],
    ["non-positive timeout", { executor: { timeoutMs: -1 } }],
    ["non-integer timeout", { executor: { timeoutMs: 1.5 } }],
    ["malformed cli value", { cli: { git: "status" } }],
    ["malformed cli op entry", { cli: { git: [42] } }],
    ["non-boolean lock", { lock: "yes" }],
    ["non-object project", { project: "narrow-me" }],
    ["invalid project mode", { project: { mode: 42 } }],
    ["unknown project key", { project: { modee: "off" } }],
  ]

  test("every malformed shape resolves a fail-closed policy with recorded errors", () => {
    for (const [label, raw] of cases) {
      const { policy, errors } = resolvePolicy(raw)
      if (errors.length === 0) throw new Error(`case "${label}" produced no errors`)
      if (policy.mode !== "off") throw new Error(`case "${label}" did not fail closed: mode=${policy.mode}`)
      expect(policy.lock).toBe(true)
      expect(policy.cli).toEqual({})
      expect(policy.source).toBe("fail-closed")
    }
  })

  test("unknown top-level keys are recorded, not fatal (host-owned namespace, e.g. hostProbe)", () => {
    const validation = validatePolicyInput({ mode: "on", hostProbe: true })
    expect(validation.ok).toBe(true)
    if (validation.ok) {
      expect(validation.parsed.ignoredKeys).toContain("hostProbe")
      expect(validation.parsed.global.mode).toBe("on")
    }
    const { policy, errors, ignoredKeys } = resolvePolicy({ hostProbe: true })
    expect(errors).toEqual([])
    expect(policy.mode).toBe("on")
    expect(ignoredKeys).toContain("hostProbe")
  })
})

// ---------------------------------------------------------------------------
// Criterion 1: capability gating per mode
// ---------------------------------------------------------------------------
describe("capability gating (criterion 1)", () => {
  test("off disables every capability group", () => {
    expect(capabilitiesFor({ ...defaultPolicy(), mode: "off" })).toEqual({
      executeTools: false,
      files: false,
      cli: false,
      shell: false,
      mcp: false,
      jev: false,
    })
  })

  test("on allows exactly the policy-defined groups", () => {
    expect(capabilitiesFor(defaultPolicy())).toEqual({ executeTools: true, files: true, cli: false, shell: false, mcp: true, jev: true })
    expect(capabilitiesFor({ ...defaultPolicy(), cli: { git: ["status"] } }).cli).toBe(true)
    expect(capabilitiesFor({ ...defaultPolicy(), cli: { git: [] } }).cli).toBe(false)
  })

  test("yolo opens the shell group (Task 11); on/off keep it closed", () => {
    const yoloPolicy = { ...defaultPolicy(), mode: "yolo" as const }
    expect(capabilitiesFor(yoloPolicy)).toEqual({ executeTools: true, files: true, cli: false, shell: true, mcp: true, jev: true })
    expect(capabilitiesFor(defaultPolicy()).shell).toBe(false)
    expect(capabilitiesFor({ ...defaultPolicy(), mode: "off" }).shell).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Criterion 3: /codemode arg parsing
// ---------------------------------------------------------------------------
describe("command argument parsing (Pi §2.3 parity)", () => {
  test("bare and blank invocations toggle", () => {
    expect(parseCodemodeArgs("").action).toBe("toggle")
    expect(parseCodemodeArgs("   ").action).toBe("toggle")
  })

  test("explicit actions parse case-insensitively", () => {
    expect(parseCodemodeArgs("on").action).toBe("on")
    expect(parseCodemodeArgs("OFF").action).toBe("off")
    expect(parseCodemodeArgs("refresh").action).toBe("refresh")
    expect(parseCodemodeArgs("yolo").action).toBe("yolo")
    expect(parseCodemodeArgs("jev").action).toBe("jev")
  })

  test("Pi's reload maps to refresh", () => {
    expect(parseCodemodeArgs("reload").action).toBe("refresh")
  })

  test("unknown arguments are surfaced as unknown", () => {
    expect(parseCodemodeArgs("banana").action).toBe("unknown")
  })

  test("tolerates a leading /codemode token when the host echoes the command", () => {
    expect(parseCodemodeArgs("/codemode on").action).toBe("on")
    expect(parseCodemodeArgs("/codemode").action).toBe("toggle")
  })
})

// ---------------------------------------------------------------------------
// Session-scoped in-memory mode state
// ---------------------------------------------------------------------------
describe("session mode state", () => {
  test("modes are isolated per session and fall back to the policy", () => {
    const store = new SessionModeStore()
    const policy = defaultPolicy()
    expect(store.effective(policy, "ses_A")).toBe("on")
    store.set("ses_A", "off")
    expect(store.effective(policy, "ses_A")).toBe("off")
    expect(store.effective(policy, "ses_B")).toBe("on")
  })

  test("stored modes can never read wider than the effective policy (defensive clamp)", () => {
    const store = new SessionModeStore()
    store.set("ses_A", "yolo")
    const offPolicy = { ...defaultPolicy(), mode: "off" as const }
    expect(store.effective(offPolicy, "ses_A")).toBe("off")
  })

  test("reconcile clamps sessions above the new policy and purges redundant entries", () => {
    const store = new SessionModeStore()
    store.set("ses_A", "on")
    store.set("ses_B", "off")
    const offPolicy = { ...defaultPolicy(), mode: "off" as const }
    const { adjusted, purged } = store.reconcile(offPolicy)
    expect(adjusted).toEqual(["ses_A"])
    expect(purged).toEqual(["ses_B"])
    expect(store.get("ses_A")).toBe("off")
    expect(store.get("ses_B")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Criterion 3: /codemode through the registered command interface
// ---------------------------------------------------------------------------
describe("/codemode through the registered command (criterion 3)", () => {
  test("registers on ctx.command.transform with the verified name", async () => {
    const { state } = await setupHarness({})
    expect(command(state).name).toBe("codemode")
    expect(command(state).description ?? "").toContain("on")
  })

  test("bare invocation toggles off then on (Pi parity)", async () => {
    const { state } = await setupHarness({})
    await runCommand(state, "ses_A", "")
    expect(lastReply(state).text).toContain('now "off"')
    await runCommand(state, "ses_A", "")
    expect(lastReply(state).text).toContain('now "on"')
  })

  test("explicit on/off switch the session mode", async () => {
    const { state } = await setupHarness({})
    await runCommand(state, "ses_A", "off")
    expect(lastReply(state).text).toContain('now "off"')
    await runCommand(state, "ses_A", "on")
    expect(lastReply(state).text).toContain('now "on"')
  })

  test("a session cannot widen past an off policy", async () => {
    const { state } = await setupHarness({ mode: "off" })
    await runCommand(state, "ses_A", "on")
    expect(lastReply(state).text).toContain("Refused")
    const result = await callTool(state, "ses_A", `print("nope")`)
    expect(result.content).toContain("off for this session")
  })

  test("locked policy warns but still allows narrowing", async () => {
    const { state } = await setupHarness({ mode: "on", lock: true })
    await runCommand(state, "ses_A", "off")
    const reply = lastReply(state)
    expect(reply.text).toContain('now "off"')
    expect(reply.text).toContain("locked")
  })

  test("yolo is refused by the effective policy (default on) and changes nothing", async () => {
    const { state } = await setupHarness({})
    await runCommand(state, "ses_A", "yolo")
    const reply = lastReply(state)
    expect(reply.text).toContain("Refused")
    expect(reply.text).toContain('exceeds the effective policy mode "on"')
    const result = await callTool(state, "ses_A", `print("ran")`)
    expect(result.content).toContain("ran")
  })

  test("yolo is refused under an off policy too", async () => {
    const { state } = await setupHarness({ mode: "off" })
    await runCommand(state, "ses_A", "yolo")
    expect(lastReply(state).text).toContain('exceeds the effective policy mode "off"')
  })

  test("jev reports the real optional-feature status from the wired adapter", async () => {
    const { state } = await setupHarness({})
    await runCommand(state, "ses_A", "jev")
    const reply = lastReply(state)
    // The host probe reports one of: no key, missing SDK, or ready — all name
    // the credential variable; never the stale "not available yet" text.
    expect(reply.text).toContain("TYPESAFE_API_KEY")
    expect(reply.text).not.toContain("not available yet")
  })

  test("unknown arguments print usage", async () => {
    const { state } = await setupHarness({})
    await runCommand(state, "ses_A", "banana")
    expect(lastReply(state).text).toContain("Usage")
  })

  test("refresh re-resolves the policy and never widens session modes", async () => {
    const harness = await setupHarness({})
    await runCommand(harness.state, "ses_A", "on")
    harness.ctx.options.project = { mode: "off" }
    await runCommand(harness.state, "ses_A", "refresh")
    const reply = lastReply(harness.state)
    expect(reply.text).toContain('mode "off"')
    expect(reply.text).toContain('source "project"')
    expect(reply.text).toContain("1 adjusted")
    const result = await callTool(harness.state, "ses_A", `print("nope")`)
    expect(result.content).toContain("off for this session")
  })

  test("reload behaves as refresh (Pi parity)", async () => {
    const { state } = await setupHarness({})
    await runCommand(state, "ses_A", "reload")
    expect(lastReply(state).text).toContain("Policy refreshed")
  })
})

// ---------------------------------------------------------------------------
// Criterion 1 + 4: the tool gate is session scoped
// ---------------------------------------------------------------------------
describe("execute_tools session gate (criterion 1)", () => {
  test("off session is refused before the guest runs", async () => {
    const { state } = await setupHarness({})
    await runCommand(state, "ses_A", "off")
    const result = await callTool(state, "ses_A", `print("never")`)
    expect(result.content).toContain("off for this session")
    expect(result.content).not.toContain("never")
    expect(result.metadata?.errorKind).toBe("mode")
  })

  test("two sessions keep different modes; the on session still executes", async () => {
    const { state } = await setupHarness({})
    await runCommand(state, "ses_A", "off")
    const off = await callTool(state, "ses_A", `print("nope")`)
    expect(off.content).toContain("off for this session")
    const on = await callTool(state, "ses_B", `print("guest ran")`)
    expect(on.content).toContain("guest ran")
  }, 15_000)

  test("the registered tool is exposed directly (options.codemode flipped to false)", async () => {
    // Orchestrator change: with codemode:true the tool was reachable ONLY from
    // inside the host's Code Mode runtime (Task 2 evidence); Pi parity wants
    // direct top-level model exposure.
    const { state } = await setupHarness({})
    expect(tool(state).options).toEqual({ codemode: false })
  })
})

// ---------------------------------------------------------------------------
// Criterion 4: enforcement design, fail closed where unproven
// ---------------------------------------------------------------------------
describe("mode enforcement (criterion 4)", () => {
  test("permission evaluate hook denies the CodeMode surface for off sessions only", async () => {
    const { state } = await setupHarness({})
    await runCommand(state, "ses_A", "off")
    const evaluate = state.permissionHooks["evaluate"]

    const offEvent: EvaluateEvent = { sessionID: "ses_A", action: "execute", resources: ["*"], effect: "allow" }
    evaluate(offEvent)
    expect(offEvent.effect).toBe("deny")
    expect(String(offEvent.message)).toContain("off for this session")

    const onEvent: EvaluateEvent = { sessionID: "ses_B", action: "execute", resources: ["*"], effect: "allow" }
    evaluate(onEvent)
    expect(onEvent.effect).toBe("allow")
  })

  test("evaluate hook also denies the registered tool name for off sessions", async () => {
    const { state } = await setupHarness({})
    await runCommand(state, "ses_A", "off")
    const evaluate = state.permissionHooks["evaluate"]
    const event: EvaluateEvent = { sessionID: "ses_A", action: "execute_tools", resources: ["*"], effect: "allow" }
    evaluate(event)
    expect(event.effect).toBe("deny")
  })

  test("evaluate hook never upgrades an effect and never touches native tool actions", async () => {
    const { state } = await setupHarness({})
    await runCommand(state, "ses_A", "off")
    const evaluate = state.permissionHooks["evaluate"]

    const denied: EvaluateEvent = { sessionID: "ses_A", action: "execute", resources: ["*"], effect: "deny" }
    evaluate(denied)
    expect(denied.effect).toBe("deny")
    expect(denied.message).toBeUndefined()

    // Native write/edit/shell denies are NOT registered in this slice
    // (fail-closed finding below); the hook must leave them alone.
    const native: EvaluateEvent = { sessionID: "ses_A", action: "edit", resources: ["*"], effect: "allow" }
    evaluate(native)
    expect(native.effect).toBe("allow")
  })

  test("execute.before blocks execute_tools for off sessions and passes others through", async () => {
    const { state } = await setupHarness({})
    await runCommand(state, "ses_A", "off")
    const before = state.toolHooks["execute.before"]

    expect(() => before({ tool: "execute_tools", sessionID: "ses_A" })).toThrow("off for this session")
    expect(() => before({ tool: "execute_tools", sessionID: "ses_B" })).not.toThrow()
  })

  test("the recorded enforcement design documents what is proven and what fails closed", () => {
    expect(MODE_ENFORCEMENT_DESIGN.sessionScoped.length).toBeGreaterThan(0)
    expect(MODE_ENFORCEMENT_DESIGN.failClosed.length).toBeGreaterThan(0)
    expect(MODE_ENFORCEMENT_DESIGN.finding).toContain("session.update")
    expect(MODE_ENFORCEMENT_DESIGN.finding).toContain("unproven")
  })

  test("nativeSessionDenyRules maps the on-mode write door (Pi §2.8) and nothing else", () => {
    expect(nativeSessionDenyRules("on")).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ])
    expect(nativeSessionDenyRules("off")).toEqual([])
    expect(nativeSessionDenyRules("yolo")).toEqual([])
  })

  test("fail-closed default: no host-side session rules are written while isolation is unproven", async () => {
    const { ctx, state } = await setupHarness({})
    expect(NATIVE_DENY_GATE.proven).toBe(false)
    const result = await applyNativeSessionDenies(ctx, "ses_A", "on")
    expect(result.applied).toBe(false)
    expect(result.reason).toContain("fail-closed")
    expect(state.sessionUpdates).toEqual([])
  })

  test("with the proof gate flipped, denies are written session-scoped via ctx.session.update", async () => {
    const { ctx, state } = await setupHarness({})
    NATIVE_DENY_GATE.proven = true
    try {
      const applied = await applyNativeSessionDenies(ctx, "ses_A", "on")
      expect(applied.applied).toBe(true)
      expect(state.sessionUpdates).toEqual([
        {
          sessionID: "ses_A",
          permissions: [
            { action: "edit", resource: "*", effect: "deny" },
            { action: "shell", resource: "*", effect: "deny" },
          ],
        },
      ])
      await applyNativeSessionDenies(ctx, "ses_B", "off")
      expect(state.sessionUpdates[1]).toEqual({ sessionID: "ses_B", permissions: [] })
    } finally {
      NATIVE_DENY_GATE.proven = false
    }
  })
})

// ---------------------------------------------------------------------------
// Setup wiring: idempotent registrations + cleanup
// ---------------------------------------------------------------------------
describe("plugin setup wiring", () => {
  test("setup is idempotent per context and its cleanup disposes every registration", async () => {
    const { ctx, state } = makeHarness({})
    const cleanup1 = await plugin.setup(ctx)
    const cleanup2 = await plugin.setup(ctx)
    expect(state.toolTransforms).toBe(1)
    expect(state.commandTransforms).toBe(1)
    expect(state.permissionRegistrations).toBe(1)
    expect(state.toolHookRegistrations).toBe(1)
    expect(typeof cleanup1).toBe("function")
    expect(typeof cleanup2).toBe("function")
    await cleanup1!()
    expect(state.disposes).toBe(4) // tool transform + command transform + 2 enforcement hooks
    await cleanup2!()
    expect(state.disposes).toBe(4)
  })
})
