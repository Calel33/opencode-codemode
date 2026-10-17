// tests/integration/security.test.ts
// Task 12 adversarial consolidation: ONE deterministic suite proving the
// release acceptance security boundary end to end:
//   1. the guest cannot bypass the validated dispatcher — raw
//      `__codemodeHostCall` probes with `(globalThis as any)` casts still hit
//      the dispatcher, which re-validates mode + capability groups;
//   2. denied actions leave ZERO side effects (marker-file / oracle checks);
//   3. type errors and boundary rejections precede every effect, at pipeline
//      level (no guest line runs, no write lands);
//   4. no secret, generated code, or π value reaches the host console or the
//      tool envelope (console spy incl. the Jev sentinel key/state);
//   5. session modes are isolated in process — an `off` session is denied by
//      both the registration gate and the enforcement hooks without touching
//      any other session or native tool action;
//   6. `shell.run` exists and is reachable only in `yolo`.
//
// The per-slice adversarial tests (files/cli/mcp/npm/jev/yolo) remain the
// detailed proof; this file consolidates the invariants for release review.
// Every guest-facing case runs through execute_tools -> QuickJS for real; no
// mocked spawn is called a real pass.
import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createFileCapabilities } from "../../src/capabilities/files"
import type { JevClient, JevEnvironment } from "../../src/capabilities/jev"
import { createDispatcher, createHostCall } from "../../src/codemode/dispatch"
import { executeTools, formatExecuteToolsResult } from "../../src/codemode/execute-tools"
import { DEFAULT_JEV, capabilitiesFor, defaultPolicy } from "../../src/config/policy"
import type { Capabilities, CliAllowlist, Mode } from "../../src/config/policy"
import plugin from "../../src/index"
import { SessionModeStore } from "../../src/plugin/command"
import { EXECUTE_TOOLS_NAME, registerExecuteTools, registerModeEnforcement } from "../../src/plugin/register"

const root = mkdtempSync(join(tmpdir(), "codemode-security-"))
const gitRoot = mkdtempSync(join(tmpdir(), "codemode-security-repo-"))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(gitRoot, { recursive: true, force: true })
})

const SENTINEL_KEY = "TST-SECURITY-KEY-4d0f7a11"
const SENTINEL_STATE = "TST-SECURITY-STATE-8c2e5b"
const CODE_MARKER = "GENERATED-CODE-MARKER-b7f2"
const PI_MARKER = "PI-VALUE-MARKER-3a9d"

interface HostEnv {
  readonly mode: Mode
  readonly capabilities: Capabilities
  readonly root: string | undefined
  readonly cli?: CliAllowlist
  readonly jev?: JevEnvironment
}

function hostWith(mode: Mode = "on", overrides: Partial<HostEnv> = {}): HostEnv {
  return { mode, capabilities: capabilitiesFor({ ...defaultPolicy(), mode }), root, ...overrides }
}

async function runGuest(code: string, host: HostEnv = hostWith()) {
  return executeTools(code, { host, timeoutMs: 30_000 })
}

// ---------------------------------------------------------------------------
// 1. Dispatcher bypass resistance (raw bridge, casts, denied capabilities)
// ---------------------------------------------------------------------------

describe("the validated dispatcher is the only guest->host path", () => {
  test("malformed raw bridge envelopes are bounded input errors, never effects", async () => {
    const hostCall = createHostCall(
      createDispatcher(createFileCapabilities(), { mode: "on", capabilities: capabilitiesFor(defaultPolicy()), root }),
    )
    for (const bad of ["not json {", "[]", "null", '{"capability":""}', '{"capability":42}']) {
      const response = JSON.parse(await hostCall(bad))
      expect(response.ok).toBe(false)
      expect(response.error.kind).toBe("input")
    }
  })

  test("a guest that casts the typed surface away still hits validated dispatch (denied capabilities stay denied)", async () => {
    const result = await runGuest(`
      const g = globalThis as any
      const probe = async (capability: string, input: unknown) =>
        JSON.parse(await g["__codemodeHostCall"](JSON.stringify({ capability, input })))
      const unknown = await probe("evil.capability", {})
      const shellInOn = await probe("shell.run", { command: "echo x" })
      const cliWithoutAllowlist = await probe("cli.git.status", {})
      const mcpWithoutCatalog = await probe("mcp.anything.echo", {})
      return {
        unknown: unknown.error.kind,
        shellInOn: shellInOn.error.kind,
        cliWithoutAllowlist: cliWithoutAllowlist.error.kind,
        mcpWithoutCatalog: mcpWithoutCatalog.error.kind,
      }
    `)
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toEqual({
      unknown: "unknown-capability",
      shellInOn: "mode",
      cliWithoutAllowlist: "mode",
      mcpWithoutCatalog: "unknown-capability",
    })
  }, 30_000)

  test("the guest runtime exposes no ambient process, require, fetch, Deno, or XHR", async () => {
    const result = await runGuest(
      `const g = globalThis as any
      return {
        process: typeof g.process,
        require: typeof g.require,
        fetch: typeof g.fetch,
        Deno: typeof g.Deno,
        xmlHttpRequest: typeof g.XMLHttpRequest,
        buffer: typeof g.Buffer,
      }`,
    )
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toEqual({
      process: "undefined",
      require: "undefined",
      fetch: "undefined",
      Deno: "undefined",
      xmlHttpRequest: "undefined",
      buffer: "undefined",
    })
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 2. Denied actions leave zero side effects (marker-file / oracle)
// ---------------------------------------------------------------------------

describe("denied actions have no side effects", () => {
  test("positive control then denials: traversal and policy-protected writes land nothing", async () => {
    const control = await runGuest(`await write({ path: "control.txt", content: "control" })`)
    expect(control.errorKind).toBeUndefined()
    expect(existsSync(join(root, "control.txt"))).toBe(true)

    const denials = await runGuest(`
      const messages: string[] = []
      try { await write({ path: "../codemode-escape-marker.txt", content: "x" }); messages.push("escaped-allowed") }
      catch (e) { messages.push((e as Error).message) }
      try { await write({ path: ".mcp.json", content: "{}" }); messages.push("mcp-allowed") }
      catch (e) { messages.push((e as Error).message) }
      try { await write({ path: ".pi/marker.json", content: "{}" }); messages.push("pi-allowed") }
      catch (e) { messages.push((e as Error).message) }
      return messages
    `)
    expect(denials.errorKind).toBeUndefined()
    const messages = denials.result as string[]
    expect(messages).toHaveLength(3)
    expect(messages[0]).toContain("outside the project root")
    expect(messages[1]).toContain("policy-protected")
    expect(messages[2]).toContain("policy-protected")
    expect(existsSync(join(root, "..", "codemode-escape-marker.txt"))).toBe(false)
    expect(existsSync(join(root, ".mcp.json"))).toBe(false)
    expect(existsSync(join(root, ".pi"))).toBe(false)
  }, 30_000)

  test("mode off denies a raw write probe and the marker never exists", async () => {
    const result = await runGuest(
      `const g = globalThis as any
      const probe = JSON.parse(await g["__codemodeHostCall"](JSON.stringify({ capability: "write", input: { path: "off-marker.txt", content: "x" } })))
      return probe.error.kind`,
      hostWith("off"),
    )
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toBe("mode")
    expect(existsSync(join(root, "off-marker.txt"))).toBe(false)
  }, 30_000)

  test("an unknown root fails closed and writes nothing", async () => {
    const result = await runGuest(`await write({ path: "ghost-marker.txt", content: "x" })`, hostWith("on", { root: undefined }))
    expect(result.errorKind).toBe("runtime")
    expect(result.error ?? "").toMatch(/root is unknown/i)
    expect(existsSync(join(root, "ghost-marker.txt"))).toBe(false)
  }, 30_000)

  test("a denied CLI op creates no commit (oracle: the branch stays unborn)", async () => {
    const init = spawnSync("git", ["init", "-q"], { cwd: gitRoot, encoding: "utf-8" })
    if (init.status !== 0) throw new Error(`git is required for this security test: git init exited ${init.status}`)
    const allowlist: CliAllowlist = { git: ["status"] }
    const result = await runGuest(
      `const g = globalThis as any
      const probe = JSON.parse(await g["__codemodeHostCall"](JSON.stringify({ capability: "cli.git.commit", input: { message: "owned" } })))
      return probe.error.kind`,
      { mode: "on", capabilities: capabilitiesFor({ ...defaultPolicy(), cli: allowlist }), root: gitRoot, cli: allowlist },
    )
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toBe("mode")
    const log = spawnSync("git", ["log", "--oneline"], { cwd: gitRoot, encoding: "utf-8" })
    expect(log.status).not.toBe(0) // unborn branch: the denied commit never ran
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 3. Type errors and boundary rejections precede every effect
// ---------------------------------------------------------------------------

describe("typecheck-before-effects at pipeline level", () => {
  test("a type error stops the pipeline before any guest line or write runs", async () => {
    const result = await runGuest(
      `print("SIDE-EFFECT-RAN")
await write({ path: "type-marker.txt", content: "x" })
const n: number = "not a number"`,
    )
    expect(result.errorKind).toBe("type")
    expect(result.logs).toEqual([])
    expect(formatExecuteToolsResult(result)).toContain("Type errors (code was NOT executed)")
    expect(result.diagnostics?.length ?? 0).toBeGreaterThan(0)
    expect(existsSync(join(root, "type-marker.txt"))).toBe(false)
  }, 30_000)

  test("an invalid strings payload is rejected at the boundary before execution", async () => {
    const result = await executeTools(`await write({ path: "strings-marker.txt", content: "x" })`, {
      host: hostWith(),
      strings: { bad: 42 },
      timeoutMs: 30_000,
    })
    expect(result.errorKind).toBe("input")
    expect(result.error ?? "").toContain("strings")
    expect(result.logs).toEqual([])
    expect(existsSync(join(root, "strings-marker.txt"))).toBe(false)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// 4. No secrets or generated code in logs or the tool envelope
// ---------------------------------------------------------------------------

function makeSetupCtx() {
  return {
    app: { name: "opencode", version: "2.0.29", channel: "latest" },
    location: { directory: root, project: { id: "p1", directory: root, canonical: root } },
    options: {},
    tool: {
      transform: async () => ({ dispose: async () => {} }),
      list: async () => [],
      reload: async () => {},
      hook: async () => ({ dispose: async () => {} }),
    },
    command: {
      transform: async () => ({ dispose: async () => {} }),
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
      synthetic: async () => {},
      hook: async () => ({ dispose: async () => {} }),
    },
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({}),
    },
    mcp: { list: async () => [] },
  } as any
}

describe("log and envelope hygiene", () => {
  test("no secret, generated code, or π value reaches the console or the tool envelope", async () => {
    const calls: string[] = []
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
    const record = (...args: unknown[]) => {
      calls.push(args.map((arg) => String(arg)).join(" "))
    }
    const originalKey = process.env.TYPESAFE_API_KEY
    console.log = record
    console.info = record
    console.warn = record
    console.error = record
    console.debug = record
    try {
      process.env.TYPESAFE_API_KEY = SENTINEL_KEY

      // The setup path reports credential PRESENCE only, never the value.
      await plugin.setup(makeSetupCtx())

      // The execution path: a failing Jev client echoes the sentinel key and
      // state; the adapter must redact both. The same execution carries a
      // generated-code marker and a π value that must never surface.
      const client: JevClient = {
        systemOne: () => {
          throw new Error(`auth failed for ${SENTINEL_KEY} while classifying ${SENTINEL_STATE}`)
        },
      }
      const jev: JevEnvironment = {
        policy: DEFAULT_JEV,
        env: { TYPESAFE_API_KEY: SENTINEL_KEY },
        clientFactory: async () => client,
      }
      const result = await executeTools(
        `
      const generated = "${CODE_MARKER}"
      let message = "unexpected-success"
      try { await jev.ask(${JSON.stringify(SENTINEL_STATE)}, [{ type: "noul", instructions: "q" }]) }
      catch (e) { message = (e as Error).message }
      return { message, markerLength: generated.length, piLength: π.secret.length }
      `,
        { host: hostWith("on", { jev }), strings: { secret: PI_MARKER }, timeoutMs: 30_000 },
      )
      expect(result.errorKind).toBeUndefined()
      expect((result.result as { message: string }).message).toContain("[redacted]")

      const written = calls.join("\n")
      const envelope = JSON.stringify({
        content: formatExecuteToolsResult(result),
        logs: result.logs,
        result: result.result,
      })
      for (const secret of [SENTINEL_KEY, SENTINEL_STATE, CODE_MARKER, PI_MARKER]) {
        expect(written).not.toContain(secret)
        expect(envelope).not.toContain(secret)
      }
      expect(written).toContain("key=present")
    } finally {
      console.log = original.log
      console.info = original.info
      console.warn = original.warn
      console.error = original.error
      console.debug = original.debug
      if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY
      else process.env.TYPESAFE_API_KEY = originalKey
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// 5. Mode isolation between sessions (in-process, per invocation sessionID)
// ---------------------------------------------------------------------------

type CapturedTool = {
  execute: (input: unknown, context: unknown) => Promise<{ content?: string; metadata?: Record<string, unknown> }>
}

function makeGateHarness() {
  let captured: CapturedTool | undefined
  const ctx = {
    tool: {
      transform: async (callback: (editor: { add: (tool: unknown) => void }) => void) => {
        callback({ add: (tool: unknown) => { captured = tool as CapturedTool } })
        return { dispose: async () => {} }
      },
    },
  } as any
  return {
    ctx,
    call: async (sessionID: string, code: string) => {
      if (!captured) throw new Error("tool was not registered")
      return captured.execute(
        { code },
        { sessionID, agent: "build", messageID: "m", id: "c", signal: new AbortController().signal, progress: async () => {} },
      )
    },
  }
}

describe("mode isolation between sessions", () => {
  test("an off session is blocked while an on session runs — in both directions, with no leakage", async () => {
    const harness = makeGateHarness()
    await registerExecuteTools(harness.ctx, {
      modeForSession: (sessionID) => (sessionID === "ses_off" ? "off" : "on"),
      capabilitiesForSession: (sessionID) =>
        capabilitiesFor({ ...defaultPolicy(), mode: sessionID === "ses_off" ? "off" : "on" }),
      activeRoot: root,
    })

    const onFirst = await harness.call("ses_on", `print("on-first")
return "ok"`)
    expect(onFirst.content).toContain("on-first")

    const off = await harness.call("ses_off", `print("never")
return "no"`)
    expect(off.metadata?.errorKind).toBe("mode")
    expect(off.content ?? "").toMatch(/off for this session/)
    expect(off.content ?? "").not.toContain("never")

    const onAgain = await harness.call("ses_on", `print("on-again")
return "ok"`)
    expect(onAgain.content).toContain("on-again")
  }, 60_000)

  test("enforcement hooks deny only the off session and never rewrite native tool actions", async () => {
    const permissionCallbacks: Array<(event: any) => void> = []
    const toolCallbacks: Array<(event: any) => void> = []
    const ctx = {
      permission: { hook: async (_name: string, callback: (event: any) => void) => { permissionCallbacks.push(callback); return { dispose: async () => {} } } },
      tool: { hook: async (_name: string, callback: (event: any) => void) => { toolCallbacks.push(callback); return { dispose: async () => {} } } },
    } as any
    const sessions = new SessionModeStore()
    sessions.set("ses_off", "off")
    await registerModeEnforcement(ctx, { sessions, getPolicy: () => defaultPolicy() })

    const permissionHook = permissionCallbacks[0]
    const toolHook = toolCallbacks[0]
    expect(typeof permissionHook).toBe("function")
    expect(typeof toolHook).toBe("function")

    // The off session's CodeMode surface action is downgraded to deny.
    const offEvent = { sessionID: "ses_off", agent: "build", action: EXECUTE_TOOLS_NAME, resources: [], effect: "allow" as string }
    permissionHook(offEvent)
    expect(offEvent.effect).toBe("deny")

    // Another (on) session is untouched.
    const onEvent = { sessionID: "ses_on", agent: "build", action: EXECUTE_TOOLS_NAME, resources: [], effect: "allow" as string }
    permissionHook(onEvent)
    expect(onEvent.effect).toBe("allow")

    // Native actions are never rewritten (fail-closed gate: no host writes).
    const nativeEvent = { sessionID: "ses_off", agent: "build", action: "bash", resources: [], effect: "allow" as string }
    permissionHook(nativeEvent)
    expect(nativeEvent.effect).toBe("allow")

    // execute.before blocks the off session and passes the on session.
    const baseToolEvent = { tool: EXECUTE_TOOLS_NAME, agent: "build", messageID: "m", id: "c", input: {} }
    expect(() => toolHook({ ...baseToolEvent, sessionID: "ses_off" })).toThrow(/off for this session/)
    expect(() => toolHook({ ...baseToolEvent, sessionID: "ses_on" })).not.toThrow()
    // Non-CodeMode tools pass even for the off session (the plugin owns only
    // its surface; native denies stay with the host while unproven).
    expect(() => toolHook({ ...baseToolEvent, tool: "read", sessionID: "ses_off" })).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 6. The shell escape hatch exists only in `yolo`
// ---------------------------------------------------------------------------

describe("shell.run is yolo-only", () => {
  test("shell is absent and denied in off and on; it really runs only in yolo", async () => {
    for (const mode of ["off", "on"] as const) {
      const presence = await runGuest(`return "shell" in globalThis`, hostWith(mode))
      expect(presence.errorKind).toBeUndefined()
      expect(presence.result).toBe(false)

      const raw = await runGuest(
        `const g = globalThis as any
        const probe = JSON.parse(await g["__codemodeHostCall"](JSON.stringify({ capability: "shell.run", input: { command: "echo x" } })))
        return probe.error.kind`,
        hostWith(mode),
      )
      expect(raw.errorKind).toBeUndefined()
      expect(raw.result).toBe("mode")
    }

    // Naming the absent global is a type error before execution.
    const typed = await runGuest(`return await shell.run({ command: "echo x" })`, hostWith("on"))
    expect(typed.errorKind).toBe("type")

    // In yolo the same call runs a real child through the platform shell.
    const yolo = await runGuest(
      `const r = await shell.run({ command: "echo security-yolo" })
      return { exit: r.exitCode, stdout: r.stdout }`,
      hostWith("yolo"),
    )
    expect(yolo.errorKind).toBeUndefined()
    const data = yolo.result as { exit: number; stdout: string }
    expect(data.exit).toBe(0)
    expect(data.stdout).toContain("security-yolo")
  }, 60_000)
})
