// tests/integration/policy.test.ts
// Task 11 integration acceptance: explicit `yolo` selection, the `/codemode
// yolo` trust warning and policy refusals, the updated `/codemode jev` status
// path, and the mode-transition matrix end to end (the `on` mode keeps its
// tighter behavior: no shell surface, group-check denial on the raw bridge).
//
//   criterion 1: yolo requires explicit selection; a project overlay can never
//   enable it under a global policy or lock that does not already allow it.
//   criterion 2: the shell capability is unavailable in `off` and `on`.
//   criterion 3: `/codemode yolo` surfaces a clear warning; the shell adapter
//   keeps the 50 KiB / timeout bounds (proven in tests/unit/yolo.test.ts).
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  JEV_NO_KEY_MESSAGE,
  JEV_SDK_MISSING_MESSAGE,
  jevStatusMessage,
} from "../../src/capabilities/jev"
import { resolvePolicy } from "../../src/config/load-policy"
import { DEFAULT_JEV, capabilitiesFor, defaultPolicy } from "../../src/config/policy"
import type { Mode, Policy } from "../../src/config/policy"
import { SessionModeStore, createCodemodeCommand } from "../../src/plugin/command"
import plugin from "../../src/index"

const root = mkdtempSync(join(tmpdir(), "codemode-policy-int-"))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Command-level harness (direct createCodemodeCommand; injectable jev status)
// ---------------------------------------------------------------------------
function makeCommandHarness(options: { policyMode?: Mode; jevStatus?: () => Promise<string> | string } = {}) {
  const sessions = new SessionModeStore()
  const replies: string[] = []
  const policy: Policy = { ...defaultPolicy(), mode: options.policyMode ?? "on" }
  const command = createCodemodeCommand({
    sessions,
    getPolicy: () => policy,
    refreshPolicy: () => policy,
    jevStatus: options.jevStatus,
    reply: (_sessionID, text) => {
      replies.push(text)
    },
  })
  return {
    sessions,
    replies,
    run: (text: string) => command.execute({ sessionID: "ses_cmd", prompt: { text } }),
  }
}

describe("/codemode yolo through the command (criterion 3)", () => {
  test("an allowed yolo selection warns that trust expands", async () => {
    const harness = makeCommandHarness({ policyMode: "yolo" })
    await harness.run("yolo")
    const reply = harness.replies[0]
    expect(reply).toContain('now "yolo"')
    expect(reply).toContain("WARNING")
    expect(reply).toContain("expands trust")
    expect(reply).toContain("shell escape hatch")
    expect(harness.sessions.get("ses_cmd")).toBe("yolo")
  })

  test("yolo is refused when the effective policy is on (explicit selection required)", async () => {
    const harness = makeCommandHarness({ policyMode: "on" })
    await harness.run("yolo")
    expect(harness.replies[0]).toContain("Refused")
    expect(harness.replies[0]).toContain('exceeds the effective policy mode "on"')
    expect(harness.replies[0]).not.toContain("WARNING")
    expect(harness.sessions.get("ses_cmd")).toBeUndefined()
  })

  test("yolo is refused when the effective policy is off", async () => {
    const harness = makeCommandHarness({ policyMode: "off" })
    await harness.run("yolo")
    expect(harness.replies[0]).toContain("Refused")
    expect(harness.replies[0]).toContain('exceeds the effective policy mode "off"')
    expect(harness.sessions.get("ses_cmd")).toBeUndefined()
  })
})

describe("/codemode jev status path (criterion 3)", () => {
  test("an injected status is surfaced verbatim (no-key and missing-SDK messages)", async () => {
    const noKey = makeCommandHarness({ jevStatus: () => JEV_NO_KEY_MESSAGE })
    await noKey.run("jev")
    expect(noKey.replies[0]).toBe(JEV_NO_KEY_MESSAGE)
    expect(noKey.replies[0]).toContain("TYPESAFE_API_KEY")

    const noSdk = makeCommandHarness({ jevStatus: () => JEV_SDK_MISSING_MESSAGE })
    await noSdk.run("jev")
    expect(noSdk.replies[0]).toBe(JEV_SDK_MISSING_MESSAGE)
    expect(noSdk.replies[0]).toContain("install @typesafe-ai/sdk")
  })

  test("the real status function reports the no-key path deterministically", async () => {
    const harness = makeCommandHarness({
      jevStatus: () => jevStatusMessage({ policy: DEFAULT_JEV, env: {}, clientFactory: async () => null }),
    })
    await harness.run("jev")
    expect(harness.replies[0]).toContain("TYPESAFE_API_KEY")
    expect(harness.replies[0]).toContain("optional")
  })

  test("the real status function reports the missing-SDK path", async () => {
    const harness = makeCommandHarness({
      jevStatus: () =>
        jevStatusMessage({
          policy: DEFAULT_JEV,
          env: { TYPESAFE_API_KEY: "TST-INTEGRATION-KEY-12345" },
          clientFactory: async () => null,
        }),
    })
    await harness.run("jev")
    expect(harness.replies[0]).toContain("@typesafe-ai/sdk")
  })

  test("without a status provider the reply stays actionable and never crashes", async () => {
    const harness = makeCommandHarness({})
    await harness.run("jev")
    expect(harness.replies[0]).toContain("optional")
    expect(harness.replies[0]).toContain("TYPESAFE_API_KEY")
  })
})

// ---------------------------------------------------------------------------
// Policy resolution: explicit selection + project overlay + lock (criterion 1)
// ---------------------------------------------------------------------------
describe("explicit yolo selection and the project overlay (criterion 1)", () => {
  test("a global yolo config is accepted and opens the shell group", () => {
    const { policy, notes } = resolvePolicy({ mode: "yolo" })
    expect(policy.mode).toBe("yolo")
    expect(policy.source).toBe("global")
    expect(capabilitiesFor(policy).shell).toBe(true)
    expect(notes.some((note) => note.includes("clamped"))).toBe(false)
  })

  test("a project overlay alone can never enable yolo", () => {
    const { policy, notes } = resolvePolicy({ project: { mode: "yolo" } })
    expect(policy.mode).toBe("on")
    expect(notes.some((note) => note.includes("widen"))).toBe(true)
    expect(capabilitiesFor(policy).shell).toBe(false)
  })

  test("a project overlay cannot widen an on global to yolo", () => {
    const { policy, notes } = resolvePolicy({ mode: "on", project: { mode: "yolo" } })
    expect(policy.mode).toBe("on")
    expect(notes.some((note) => note.includes("widen"))).toBe(true)
  })

  test("a project overlay may narrow yolo down but never back up", () => {
    expect(resolvePolicy({ mode: "yolo", project: { mode: "on" } }).policy.mode).toBe("on")
    expect(resolvePolicy({ mode: "yolo", project: { mode: "off" } }).policy.mode).toBe("off")
    expect(resolvePolicy({ mode: "on", project: { mode: "yolo" } }).policy.mode).toBe("on")
  })

  test("lock: true ignores project yolo attempts in both directions", () => {
    const locked = resolvePolicy({ mode: "yolo", lock: true, project: { mode: "off" } })
    expect(locked.policy.mode).toBe("yolo")
    expect(locked.notes.some((note) => note.includes("lock"))).toBe(true)

    const lockedOn = resolvePolicy({ mode: "on", lock: true, project: { mode: "yolo" } })
    expect(lockedOn.policy.mode).toBe("on")
  })
})

// ---------------------------------------------------------------------------
// End to end through the plugin entry (fake V2 ctx harness, real tmp root)
// ---------------------------------------------------------------------------
type CapturedTool = {
  name: string
  description: string
  execute: (input: unknown, context: unknown) => Promise<{ content?: string; metadata?: Record<string, unknown> }>
}
type CapturedCommand = {
  name: string
  execute: (input: unknown) => Promise<void>
}

function makeHarness(options: Record<string, unknown> = {}) {
  const state = {
    tools: [] as CapturedTool[],
    commands: [] as CapturedCommand[],
    replies: [] as { sessionID: string; text: string }[],
  }
  const ctx = {
    app: { name: "opencode", version: "2.0.29", channel: "latest" },
    location: {
      directory: root,
      project: { id: "p1", directory: root, canonical: root },
    },
    options,
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          namespace: () => {},
          add: (tool: CapturedTool) => state.tools.push(tool),
          update: () => {},
          remove: () => {},
          list: () => [],
          get: () => undefined,
        })
        return { dispose: async () => {} }
      },
      list: async () => [],
      reload: async () => {},
      hook: async () => ({ dispose: async () => {} }),
    },
    command: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: (definition: CapturedCommand) => state.commands.push(definition) })
        return { dispose: async () => {} }
      },
      list: async () => [],
      reload: async () => {},
    },
    permission: {
      hook: async () => ({ dispose: async () => {} }),
      list: async () => [],
      get: async () => undefined,
      reply: async () => {},
    },
    session: {
      update: async () => {},
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
  await plugin.setup(harness.ctx)
  return harness
}

function lastReply(state: ReturnType<typeof makeHarness>["state"]) {
  const reply = state.replies[state.replies.length - 1]
  if (!reply) throw new Error("no reply was sent")
  return reply
}

async function runCommand(state: ReturnType<typeof makeHarness>["state"], sessionID: string, text: string) {
  const command = state.commands[0]
  if (!command) throw new Error("/codemode was not registered")
  await command.execute({ sessionID, prompt: { text }, delivery: {} })
}

async function callTool(state: ReturnType<typeof makeHarness>["state"], sessionID: string, code: string) {
  const tool = state.tools[state.tools.length - 1]
  if (!tool) throw new Error("execute_tools was not registered")
  return tool.execute(
    { code },
    { sessionID, agent: "build", messageID: "m1", id: "c1", signal: new AbortController().signal, progress: async () => {} },
  )
}

describe("end to end through the plugin entry", () => {
  test("on: the shell global is absent, naming it is a type error, and the raw bridge is denied", async () => {
    const { state } = await setupHarness({})

    const absent = await callTool(state, "ses_A", `return "shell" in globalThis`)
    expect(absent.content).toBe("false")

    const typed = await callTool(state, "ses_A", `return await shell.run({ command: "echo x" })`)
    expect(typed.metadata?.errorKind).toBe("type")

    const raw = await callTool(
      state,
      "ses_A",
      `const g = globalThis as any
      const r = JSON.parse(await g["__codemodeHostCall"](JSON.stringify({ capability: "shell.run", input: { command: "echo x" } })))
      return r.error.kind + ":" + r.error.message`,
    )
    expect(String(raw.content)).toContain("mode:")
    expect(String(raw.content)).toContain("not enabled by the effective policy")
  }, 90_000)

  test("yolo: /codemode yolo warns and the guest then runs a real command", async () => {
    const { state } = await setupHarness({ mode: "yolo" })
    await runCommand(state, "ses_A", "yolo")
    expect(lastReply(state).text).toContain("expands trust")
    expect(lastReply(state).text).toContain("shell escape hatch")

    const run = await callTool(
      state,
      "ses_A",
      `const r = await shell.run({ command: "echo plugin-yolo-ok" })\nreturn { exit: r.exitCode, stdout: r.stdout }`,
    )
    expect(run.metadata?.errorKind).toBeUndefined()
    const content = run.content ?? ""
    expect(content).toContain("plugin-yolo-ok")
    expect(content).toContain("exit")
  }, 90_000)

  test("a project-only yolo overlay is refused end to end; off denies the guest", async () => {
    const overlay = await setupHarness({ project: { mode: "yolo" } })
    await runCommand(overlay.state, "ses_A", "yolo")
    expect(lastReply(overlay.state).text).toContain("Refused")

    const off = await setupHarness({})
    await runCommand(off.state, "ses_A", "off")
    const refused = await callTool(off.state, "ses_A", `return 1`)
    expect(refused.content).toContain("off for this session")
    expect(refused.metadata?.errorKind).toBe("mode")
  }, 90_000)
})
