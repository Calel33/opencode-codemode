// tests/unit/cli.test.ts
// Task 6 acceptance: allowlisted typed CLI capabilities.
//   1. Each call matches a declared executable and operation allowlist; no
//      arbitrary command is accepted.
//   2. Each stream is capped at 50 KiB, the CLI op timeout defaults to
//      30000 ms (reconciliation: the todo's 120000 ms is the EXECUTOR
//      timeout; research §2.9 pins the CLI op default at 30_000 ms), and
//      truncation is explicit (per-stream booleans + marker).
//   3. Nonzero exit returns stdout, stderr, exit code, and truncation
//      metadata without throwing.
//   4. `off` blocks CLI calls; `on` allows only the effective allowlist.
//
// This file covers the pure policy/planning surface (allowlist gate, env
// filtering, argv construction) plus the spawn executor against REAL child
// processes (process.execPath), never mocked spawns. Guest-facing coverage
// through execute_tools lives in tests/integration/cli.test.ts.
import { describe, expect, test } from "bun:test"
import { cliAllowlistAllows, hostCommandEnv } from "../../src/security/allowlist"
import {
  CLI_TOOLS,
  DEFAULT_CLI_TIMEOUT_MS,
  MAX_CLI_STREAM_BYTES,
  buildCliInvocation,
  cliSurface,
  createCliCapabilities,
  spawnCli,
} from "../../src/capabilities/cli"
import { createDispatcher, createHostCall } from "../../src/codemode/dispatch"
import { capabilitiesFor, defaultPolicy } from "../../src/config/policy"
import type { CliAllowlist } from "../../src/config/policy"

const byteLength = (value: string): number => new TextEncoder().encode(value).length
const sleepScript = "setInterval(() => {}, 1000)"

function cliEnv(allowlist: CliAllowlist, overrides: { mode?: "on" | "off"; root?: string | undefined } = {}) {
  const mode = overrides.mode ?? "on"
  return {
    mode,
    capabilities: capabilitiesFor({ ...defaultPolicy(), mode, cli: allowlist }),
    root: "root" in overrides ? overrides.root : process.cwd(),
  }
}

// ---------------------------------------------------------------------------
// Declared catalog + bounds (acceptance criteria 1 and 2)
// ---------------------------------------------------------------------------
describe("declared CLI catalog and bounds", () => {
  test("the CLI op timeout defaults to 30000 ms and streams cap at 50 KiB", () => {
    expect(DEFAULT_CLI_TIMEOUT_MS).toBe(30_000)
    expect(MAX_CLI_STREAM_BYTES).toBe(50 * 1024)
  })

  test("the built-in catalog declares the Pi operation set minus gh (recorded deferral)", () => {
    expect(Object.keys(CLI_TOOLS)).toEqual(["git", "rg", "find", "grep", "ls", "vitest", "tsc", "oxfmt", "oxlint"])
    expect(Object.keys(CLI_TOOLS.git.operations)).toEqual([
      "status",
      "branch",
      "diff",
      "log",
      "show",
      "remote",
      "revParse",
      "add",
      "commit",
      "push",
      "pull",
      "switch",
      "checkout",
      "restore",
      "reset",
      "stash",
      "tag",
    ])
    expect(CLI_TOOLS.git.executable).toBe("git")
  })

  test("cliSurface is allowlist ∩ catalog, in allowlist order, deduplicated", () => {
    const surface = cliSurface({ git: ["status", "status", "bogus"], rg: ["search"], nope: ["x"] } as CliAllowlist)
    expect(surface).toEqual([
      { tool: "git", operation: "status" },
      { tool: "rg", operation: "search" },
    ])
    expect(cliSurface(undefined)).toEqual([])
    expect(cliSurface({})).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Allowlist gate (acceptance criteria 1 and 4)
// ---------------------------------------------------------------------------
describe("cli allowlist gate (pure)", () => {
  const allowlist: CliAllowlist = { git: ["status", "log"] }

  test("allows only the tool+operation pairs the allowlist grants", () => {
    expect(cliAllowlistAllows(allowlist, "git", "status")).toBe(true)
    expect(cliAllowlistAllows(allowlist, "git", "log")).toBe(true)
    expect(cliAllowlistAllows(allowlist, "git", "commit")).toBe(false)
    expect(cliAllowlistAllows(allowlist, "rg", "search")).toBe(false)
    expect(cliAllowlistAllows({}, "git", "status")).toBe(false)
    expect(cliAllowlistAllows(undefined, "git", "status")).toBe(false)
  })

  test("malformed entries are denied defensively, never accepted", () => {
    expect(cliAllowlistAllows({ git: "status" } as any, "git", "status")).toBe(false)
    expect(cliAllowlistAllows({ git: [42] } as any, "git", "42")).toBe(false)
    expect(cliAllowlistAllows(allowlist, 7 as any, "status")).toBe(false)
    expect(cliAllowlistAllows(allowlist, "git", 7 as any)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Spawn environment allowlist (no secrets reach spawned tools)
// ---------------------------------------------------------------------------
describe("hostCommandEnv (env allowlist)", () => {
  const base = {
    PATH: "C:\\tools\\bin",
    HOME: "/home/user",
    XDG_CONFIG_HOME: "/home/user/.config",
    SECRET_MARKER: "s3cr3t-value",
    GH_TOKEN: "token-gh",
    GITHUB_TOKEN: "token-github",
    GITHUB_HOST: "github.example.test",
  }

  test("non-gh tools get exactly PATH, HOME, XDG_CONFIG_HOME", () => {
    const env = hostCommandEnv("git", base)
    expect(env).toEqual({
      PATH: "C:\\tools\\bin",
      HOME: "/home/user",
      XDG_CONFIG_HOME: "/home/user/.config",
    })
    expect(env).not.toHaveProperty("SECRET_MARKER")
    expect(JSON.stringify(env)).not.toContain("s3cr3t-value")
  })

  test("gh additionally gets its three documented token variables", () => {
    const env = hostCommandEnv("gh", base)
    expect(env).toEqual({
      PATH: "C:\\tools\\bin",
      HOME: "/home/user",
      XDG_CONFIG_HOME: "/home/user/.config",
      GH_TOKEN: "token-gh",
      GITHUB_TOKEN: "token-github",
      GITHUB_HOST: "github.example.test",
    })
    expect(env).not.toHaveProperty("SECRET_MARKER")
  })

  test("missing base variables stay undefined and are ignored by spawn (Pi parity)", () => {
    const env = hostCommandEnv("git", { PATH: "C:\\bin" })
    expect(env.PATH).toBe("C:\\bin")
    expect(env.HOME).toBeUndefined()
    expect(env.XDG_CONFIG_HOME).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Typed argv construction (acceptance criterion 1: no shell, argv only)
// ---------------------------------------------------------------------------
describe("buildCliInvocation (validated typed adapters)", () => {
  test("booleans map to flags in a fixed order", () => {
    expect(buildCliInvocation("git", "status", {})).toEqual({
      ok: true,
      invocation: { executable: "git", argv: ["status"] },
    })
    expect(buildCliInvocation("git", "status", { short: true, branch: true })).toEqual({
      ok: true,
      invocation: { executable: "git", argv: ["status", "--short", "--branch"] },
    })
  })

  test("injection payloads become single literal argv elements, never shell text", () => {
    const payload = "a; rm -rf b && echo $(whoami) || `id` | cat > out"
    const result = buildCliInvocation("git", "commit", { message: payload })
    expect(result).toEqual({
      ok: true,
      invocation: { executable: "git", argv: ["commit", `--message=${payload}`] },
    })
    const paths = buildCliInvocation("git", "log", { paths: ["; touch PWN", "$(x)", "`y`"] })
    expect(paths).toEqual({
      ok: true,
      invocation: { executable: "git", argv: ["log", "--", "; touch PWN", "$(x)", "`y`"] },
    })
  })

  test("operands that could be parsed as flags are rejected", () => {
    const paths = buildCliInvocation("git", "log", { paths: ["-rf"] })
    expect(paths.ok).toBe(false)
    if (!paths.ok) expect(paths.message).toContain("must not contain")
    const ref = buildCliInvocation("git", "revParse", { ref: "--help" })
    expect(ref.ok).toBe(false)
    if (!ref.ok) expect(ref.message).toContain("must not be empty or start with '-'")
  })

  test("unknown arguments, wrong types, enums, and required fields are input errors", () => {
    const cases: Array<[string, string, Record<string, unknown>, string]> = [
      ["git", "status", { nuke: 1 }, "Unknown CLI argument: nuke"],
      ["git", "status", { short: "yes" }, "short must be a boolean"],
      ["git", "reset", { mode: "medium" }, "mode must be one of soft, mixed, hard"],
      ["git", "log", { limit: 1.5 }, "limit must be an integer"],
      ["git", "log", { limit: "5" }, "limit must be an integer"],
    ]
    for (const [tool, operation, args, message] of cases) {
      const result = buildCliInvocation(tool, operation, args)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toBe(message)
    }
    const enumOk = buildCliInvocation("git", "reset", { mode: "hard" })
    expect(enumOk).toEqual({ ok: true, invocation: { executable: "git", argv: ["reset", "--hard"] } })

    const missing = buildCliInvocation("git", "commit", {})
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.message).toBe("message is required")

    const arrayType = buildCliInvocation("rg", "search", { pattern: "x", glob: "*.ts" })
    expect(arrayType.ok).toBe(false)
    if (!arrayType.ok) expect(arrayType.message).toBe("glob must be an array of strings")
  })

  test("non-object args and unknown tool/operation are input errors", () => {
    for (const args of ["nope", 42, []]) {
      const result = buildCliInvocation("git", "status", args)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.message).toContain("must be an object")
    }
    const tool = buildCliInvocation("nope", "x", {})
    expect(tool.ok).toBe(false)
    if (!tool.ok) expect(tool.message).toBe("Unknown CLI tool: nope")
    const operation = buildCliInvocation("git", "frobnicate", {})
    expect(operation.ok).toBe(false)
    if (!operation.ok) expect(operation.message).toBe("Unknown CLI operation: cli.git.frobnicate")
  })
})

// ---------------------------------------------------------------------------
// Dispatcher gating (acceptance criteria 1 and 4)
// ---------------------------------------------------------------------------
describe("dispatcher gating for cli capabilities", () => {
  const allowlist: CliAllowlist = { git: ["status"] }
  const dispatcher = () => createDispatcher(createCliCapabilities(allowlist), cliEnv(allowlist))

  test("capabilityNames expose the full declared catalog surface", () => {
    const names = dispatcher().capabilityNames
    expect(names).toContain("cli.git.status")
    expect(names).toContain("cli.rg.search")
    const total = Object.values(CLI_TOOLS).reduce((count, tool) => count + Object.keys(tool.operations).length, 0)
    expect(names.length).toBe(total)
    for (const name of names) expect(name.startsWith("cli.")).toBe(true)
  })

  test("a declared executable not in the allowlist is denied with kind mode", async () => {
    const outcome = await dispatcher().dispatch({ capability: "cli.rg.search", input: { pattern: "x" } })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("mode")
      expect(outcome.error.message).toContain("cli.rg.search")
      expect(outcome.error.message).toContain("allowlist")
    }
  })

  test("an allowlisted tool with a non-allowlisted operation is denied with kind mode", async () => {
    const outcome = await dispatcher().dispatch({ capability: "cli.git.commit", input: { message: "x" } })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("mode")
      expect(outcome.error.message).toContain("cli.git.commit")
    }
  })

  test("operations or tools outside the declared catalog are unknown-capability", async () => {
    const bogusOp = await dispatcher().dispatch({ capability: "cli.git.frobnicate", input: {} })
    expect(bogusOp.ok).toBe(false)
    if (!bogusOp.ok) expect(bogusOp.error.kind).toBe("unknown-capability")
    const bogusTool = await dispatcher().dispatch({ capability: "cli.evil.rm", input: {} })
    expect(bogusTool.ok).toBe(false)
    if (!bogusTool.ok) expect(bogusTool.error.kind).toBe("unknown-capability")
  })

  test("off blocks cli calls at the dispatcher", async () => {
    const dispatcherOff = createDispatcher(createCliCapabilities(allowlist), cliEnv(allowlist, { mode: "off" }))
    const outcome = await dispatcherOff.dispatch({ capability: "cli.git.status", input: {} })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.kind).toBe("mode")
  })

  test("on with an empty allowlist keeps the cli group closed", async () => {
    const empty: CliAllowlist = {}
    const dispatcherEmpty = createDispatcher(createCliCapabilities(empty), cliEnv(empty))
    const outcome = await dispatcherEmpty.dispatch({ capability: "cli.git.status", input: {} })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("mode")
      expect(outcome.error.message).toContain("not enabled by the effective policy")
    }
  })

  test("an unknown root fails closed before any spawn", async () => {
    const dispatcherNoRoot = createDispatcher(createCliCapabilities(allowlist), cliEnv(allowlist, { root: undefined }))
    const outcome = await dispatcherNoRoot.dispatch({ capability: "cli.git.status", input: {} })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("root")
      expect(outcome.error.message).toMatch(/root is unknown/i)
    }
  })

  test("malformed args are bounded input errors, never spawns", async () => {
    const notObject = await dispatcher().dispatch({ capability: "cli.git.status", input: "nope" })
    expect(notObject.ok).toBe(false)
    if (!notObject.ok) {
      expect(notObject.error.kind).toBe("input")
      expect(notObject.error.message).toContain("must be an object")
    }
    const wrongType = await dispatcher().dispatch({ capability: "cli.git.status", input: { branch: "yes" } })
    expect(wrongType.ok).toBe(false)
    if (!wrongType.ok) {
      expect(wrongType.error.kind).toBe("input")
      expect(wrongType.error.message).toBe("branch must be a boolean")
    }
  })

  test("createHostCall round-trips a denial through the JSON protocol", async () => {
    const hostCall = createHostCall(dispatcher())
    const response = JSON.parse(await hostCall(JSON.stringify({ capability: "cli.git.commit", input: { message: "x" } })))
    expect(response.ok).toBe(false)
    expect(response.error.kind).toBe("mode")
  })
})

// ---------------------------------------------------------------------------
// Spawn executor (acceptance criteria 2 and 3, real child processes)
// ---------------------------------------------------------------------------
describe("spawnCli (real child processes, no mocked spawn)", () => {
  const cwd = process.cwd()

  test("nonzero exit is returned as data, not an error", async () => {
    const outcome = await spawnCli({
      executable: process.execPath,
      argv: ["-e", 'process.stdout.write("out-data");process.stderr.write("err-data");process.exit(3)'],
      cwd,
      envTool: "git",
      timeoutMs: 15_000,
      label: "cli.test.exit",
    })
    expect(outcome).toEqual({
      ok: true,
      data: {
        stdout: "out-data",
        stderr: "err-data",
        exitCode: 3,
        truncated: { stdout: false, stderr: false },
      },
    })
  }, 20_000)

  test("each stream is capped at 50 KiB with an explicit marker and per-stream metadata", async () => {
    const outcome = await spawnCli({
      executable: process.execPath,
      argv: [
        "-e",
        'process.stdout.write("x".repeat(60 * 1024));process.stderr.write("y".repeat(60 * 1024))',
      ],
      cwd,
      envTool: "git",
      timeoutMs: 15_000,
      label: "cli.test.truncate",
    })
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
    expect(data.stdout.endsWith("[Output truncated, showing last 50 KiB.]")).toBe(true)
    expect(data.stderr.endsWith("[Output truncated, showing last 50 KiB.]")).toBe(true)
    expect(data.stdout.startsWith("x")).toBe(true)
    expect(data.stderr.startsWith("y")).toBe(true)
  }, 20_000)

  test("a short custom timeout kills the child and reports a limit outcome", async () => {
    const started = Date.now()
    const outcome = await spawnCli({
      executable: process.execPath,
      argv: ["-e", sleepScript],
      cwd,
      envTool: "git",
      timeoutMs: 300,
      label: "cli.test.timeout",
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("limit")
      expect(outcome.error.message).toContain("timed out after 300ms")
      expect(outcome.error.message).toContain("cli.test.timeout")
    }
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)

  test("an aborted signal kills the child and reports cancelled", async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = spawnCli({
      executable: process.execPath,
      argv: ["-e", sleepScript],
      cwd,
      envTool: "git",
      timeoutMs: 60_000,
      signal: controller.signal,
      label: "cli.test.abort",
    })
    setTimeout(() => controller.abort(), 100)
    const outcome = await pending
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("cancelled")
      expect(outcome.error.message).toBe("Execution cancelled")
    }
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)

  test("a missing executable is a bounded not-found outcome", async () => {
    const outcome = await spawnCli({
      executable: "codemode-missing-binary-xyz",
      argv: [],
      cwd,
      envTool: "git",
      timeoutMs: 15_000,
      label: "cli.missing.run",
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("not-found")
      expect(outcome.error.message).toContain("codemode-missing-binary-xyz")
    }
  }, 20_000)
})
