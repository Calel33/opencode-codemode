// tests/unit/yolo.test.ts
// Task 11 acceptance: the explicit `yolo` shell escape hatch.
//
//   1. Explicit selection only: in `off` and `on` the shell capability is
//      denied at the dispatcher (group check) even on a raw bridge call; only
//      a yolo policy opens it. (Policy-selection proof lives in
//      tests/integration/policy.test.ts.)
//   2. The adapter spawns through the PLATFORM shell (`cmd.exe /d /s /c` on
//      win32, `/bin/sh -c` elsewhere) with an argv array (`shell:false`), cwd =
//      the canonical active root (fail closed when unknown), each stream capped
//      at 50 KiB with the explicit truncation marker, default timeout 30_000 ms
//      (the 120 s executor bound still caps the whole execution), kill on
//      timeout and on AbortSignal, and nonzero exit as data.
//   3. Real child processes only — no mocked spawns.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_CLI_STREAM_BYTES,
  MAX_SHELL_TIMEOUT_MS,
  SHELL_CAPABILITY_NAME,
  SHELL_GLOBAL_NAME,
  createShellCapabilities,
  platformShellArgv,
  runShellCommand,
} from "../../src/capabilities/cli"
import { createDispatcher, createHostCall } from "../../src/codemode/dispatch"
import { executeTools } from "../../src/codemode/execute-tools"
import { buildTypeDefs } from "../../src/codemode/globals"
import { capabilitiesFor, defaultPolicy } from "../../src/config/policy"
import type { Mode } from "../../src/config/policy"

const byteLength = (value: string): number => new TextEncoder().encode(value).length
const IS_WINDOWS = process.platform === "win32"
// cmd's `pause` blocks INSIDE the spawned shell on its stdin pipe; elsewhere
// sleep blocks as the only child of sh. No grandchildren to leak on kill.
const BLOCKING_COMMAND = IS_WINDOWS ? "pause" : "sleep 10"

function shellEnv(mode: Mode, overrides: { root?: string | undefined } = {}) {
  const root = "root" in overrides ? overrides.root : process.cwd()
  return { mode, capabilities: capabilitiesFor({ ...defaultPolicy(), mode }), root }
}

const truncationMarker = "[Output truncated, showing last 50 KiB.]"

// ---------------------------------------------------------------------------
// Platform shell argv (argv array; shell:false — no re-parsing of the command)
// ---------------------------------------------------------------------------
describe("platformShellArgv (platform shell, argv form)", () => {
  test("the command is the final literal argv element on every platform", () => {
    const invocation = platformShellArgv("echo hi")
    expect(invocation.argv[invocation.argv.length - 1]).toBe("echo hi")
  })

  test("win32 uses ComSpec (or cmd.exe) with /d /s /c; elsewhere /bin/sh -c", () => {
    const invocation = platformShellArgv("echo hi")
    if (IS_WINDOWS) {
      expect(invocation.executable.toLowerCase()).toMatch(/cmd(\.exe)?$/)
      expect(invocation.argv.slice(0, 3)).toEqual(["/d", "/s", "/c"])
    } else {
      expect(invocation.executable).toBe("/bin/sh")
      expect(invocation.argv).toEqual(["-c", "echo hi"])
    }
  })
})

// ---------------------------------------------------------------------------
// Dispatcher gating: off/on deny at the group check; yolo allows
// ---------------------------------------------------------------------------
describe("shell capability gating at the dispatcher (criterion 1)", () => {
  test("off denies with the session-off message; on denies with the group check", async () => {
    const off = createHostCall(createDispatcher(createShellCapabilities(), shellEnv("off")))
    const offResponse = JSON.parse(
      await off(JSON.stringify({ capability: SHELL_CAPABILITY_NAME, input: { command: "echo nope" } })),
    )
    expect(offResponse.ok).toBe(false)
    expect(offResponse.error.kind).toBe("mode")
    expect(offResponse.error.message).toMatch(/off for this session/)

    const on = createHostCall(createDispatcher(createShellCapabilities(), shellEnv("on")))
    const onResponse = JSON.parse(
      await on(JSON.stringify({ capability: SHELL_CAPABILITY_NAME, input: { command: "echo nope" } })),
    )
    expect(onResponse.ok).toBe(false)
    expect(onResponse.error.kind).toBe("mode")
    expect(onResponse.error.message).toContain("not enabled by the effective policy")
  })

  test("yolo allows the same raw bridge call", async () => {
    const hostCall = createHostCall(createDispatcher(createShellCapabilities(), shellEnv("yolo")))
    const response = JSON.parse(
      await hostCall(JSON.stringify({ capability: SHELL_CAPABILITY_NAME, input: { command: "echo yolo-bridge" } })),
    )
    expect(response.ok).toBe(true)
    expect(response.data.exitCode).toBe(0)
    expect(response.data.stdout).toContain("yolo-bridge")
  }, 20_000)

  test("the adapter itself re-checks the group (defense in depth)", async () => {
    const outcome = await runShellCommand({ command: "echo hi" }, shellEnv("on"))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe("mode")
  })
})

// ---------------------------------------------------------------------------
// runShellCommand: real spawns through the platform shell
// ---------------------------------------------------------------------------
describe("runShellCommand (real spawns)", () => {
  test("documented bounds: 30 s default op timeout, 120 s ceiling, stable names", () => {
    expect(DEFAULT_SHELL_TIMEOUT_MS).toBe(30_000)
    expect(MAX_SHELL_TIMEOUT_MS).toBe(120_000)
    expect(SHELL_CAPABILITY_NAME).toBe("shell.run")
    expect(SHELL_GLOBAL_NAME).toBe("shell")
  })

  test("a real command runs through the platform shell and returns exit data", async () => {
    const outcome = await runShellCommand({ command: "echo codemode-yolo" }, shellEnv("yolo"))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const data = outcome.data as {
      stdout: string
      stderr: string
      exitCode: number
      truncated: { stdout: boolean; stderr: boolean }
    }
    expect(data.exitCode).toBe(0)
    expect(data.stdout.trim()).toBe("codemode-yolo")
    expect(data.truncated).toEqual({ stdout: false, stderr: false })
  }, 20_000)

  test("a nonzero exit is returned as data, never thrown", async () => {
    const outcome = await runShellCommand({ command: "exit 3" }, shellEnv("yolo"))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect((outcome.data as { exitCode: number }).exitCode).toBe(3)
  }, 20_000)

  test("an unknown root fails closed before any spawn", async () => {
    const outcome = await runShellCommand({ command: "echo hi" }, shellEnv("yolo", { root: undefined }))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("root")
      expect(outcome.error.message).toMatch(/root is unknown/i)
    }
  })

  test("malformed inputs are bounded input errors, never spawns", async () => {
    const cases: unknown[] = [
      undefined,
      null,
      "nope",
      [],
      {},
      { command: "" },
      { command: 7 },
      { command: "echo x", timeoutMs: 0 },
      { command: "echo x", timeoutMs: 1.5 },
      { command: "echo x", timeoutMs: MAX_SHELL_TIMEOUT_MS + 1 },
      { command: "echo x", extra: true },
    ]
    for (const input of cases) {
      const outcome = await runShellCommand(input, shellEnv("yolo"))
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error.kind).toBe("input")
    }
  })

  test("a short timeout kills the shell and reports a limit outcome", async () => {
    const started = Date.now()
    const outcome = await runShellCommand({ command: BLOCKING_COMMAND, timeoutMs: 300 }, shellEnv("yolo"))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("limit")
      expect(outcome.error.message).toContain("timed out after 300ms")
      expect(outcome.error.message).toContain(SHELL_CAPABILITY_NAME)
    }
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)

  test("an AbortSignal kills the shell and reports cancelled", async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = runShellCommand(
      { command: BLOCKING_COMMAND, timeoutMs: 60_000 },
      { ...shellEnv("yolo"), signal: controller.signal },
    )
    setTimeout(() => controller.abort(), 150)
    const outcome = await pending
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("cancelled")
      expect(outcome.error.message).toBe("Execution cancelled")
    }
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)

  test("each stream is capped at 50 KiB with the explicit marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "codemode-yolo-trunc-"))
    try {
      writeFileSync(join(root, "big.txt"), "x".repeat(60 * 1024), "utf-8")
      const command = IS_WINDOWS ? "type big.txt & type big.txt 1>&2" : "cat big.txt; cat big.txt 1>&2"
      const outcome = await runShellCommand({ command }, shellEnv("yolo", { root }))
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      const data = outcome.data as {
        stdout: string
        stderr: string
        exitCode: number
        truncated: { stdout: boolean; stderr: boolean }
      }
      expect(data.exitCode).toBe(0)
      expect(data.truncated).toEqual({ stdout: true, stderr: true })
      expect(byteLength(data.stdout)).toBeLessThanOrEqual(MAX_CLI_STREAM_BYTES)
      expect(byteLength(data.stderr)).toBeLessThanOrEqual(MAX_CLI_STREAM_BYTES)
      expect(data.stdout.endsWith(truncationMarker)).toBe(true)
      expect(data.stderr.endsWith(truncationMarker)).toBe(true)
      expect(data.stdout.startsWith("x")).toBe(true)
      expect(data.stderr.startsWith("x")).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})

// ---------------------------------------------------------------------------
// Guest surface through the real pipeline (execute_tools -> QuickJS)
// ---------------------------------------------------------------------------
describe("shell guest surface through execute_tools", () => {
  test("in yolo the guest can run a real command", async () => {
    const result = await executeTools(
      `const r = await shell.run({ command: "echo guest-yolo" })\nreturn { exit: r.exitCode, stdout: r.stdout }`,
      { host: shellEnv("yolo"), timeoutMs: 20_000 },
    )
    expect(result.errorKind).toBeUndefined()
    const data = result.result as { exit: number; stdout: string }
    expect(data.exit).toBe(0)
    expect(data.stdout).toContain("guest-yolo")
  }, 30_000)

  test("in on the shell global is absent and naming it is a type error before execution", async () => {
    const absent = await executeTools(`return "shell" in globalThis`, { host: shellEnv("on"), timeoutMs: 20_000 })
    expect(absent.errorKind).toBeUndefined()
    expect(absent.result).toBe(false)

    const typed = await executeTools(`return await shell.run({ command: "echo x" })`, {
      host: shellEnv("on"),
      timeoutMs: 20_000,
    })
    expect(typed.errorKind).toBe("type")
    expect(typed.error ?? "").toContain("shell")
  }, 30_000)

  test("in on a raw bridge call is denied by the group check inside the guest", async () => {
    const result = await executeTools(
      `const g = globalThis as any
      const probe = JSON.parse(await g["__codemodeHostCall"](JSON.stringify({ capability: "shell.run", input: { command: "echo x" } })))
      return probe.error.kind`,
      { host: shellEnv("on"), timeoutMs: 20_000 },
    )
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toBe("mode")
  }, 30_000)

  test("in yolo with an unknown root the guest call fails closed as bounded data", async () => {
    const result = await executeTools(`return await shell.run({ command: "echo hi" })`, {
      host: shellEnv("yolo", { root: undefined }),
      timeoutMs: 20_000,
    })
    expect(result.errorKind).toBe("runtime")
    expect(result.error ?? "").toContain("root is unknown")
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Declaration pairing: one module drives install and typechecker input
// ---------------------------------------------------------------------------
describe("guest declaration pairing", () => {
  test("buildTypeDefs declares shell only when the group is on", () => {
    const withShell = buildTypeDefs({ shell: true })
    expect(withShell).toContain("declare const shell:")
    expect(withShell).toContain("run(params: { command: string; timeoutMs?: number })")
    expect(buildTypeDefs({ shell: false })).not.toContain("declare const shell:")
    expect(buildTypeDefs()).not.toContain("declare const shell:")
  })
})
