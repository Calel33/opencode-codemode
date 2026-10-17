// tests/integration/cli.test.ts
// Task 6 integration acceptance: allowlisted typed CLI capabilities exercised
// THROUGH execute_tools (checkpoint-2 rule: capabilities are proven via the
// pipeline, not only via helper functions), against REAL child processes:
// git is available on this Windows host (context §8) and every op below runs
// the actual git executable from an argv array (shell: false). No mocked-spawn
// "integration" pass: the happy path asserts real exit codes and real output.
//
// Acceptance criteria covered here:
//   1. each call matches the declared executable + operation allowlist;
//      arbitrary commands are rejected (unknown-capability) and non-allowlisted
//      ops are denied even when the guest bypasses the typed declarations.
//   2. streams are capped at 50 KiB with explicit per-stream truncation.
//   3. nonzero exit returns stdout/stderr/exit code/truncation as DATA.
//   4. `off` blocks CLI calls; `on` allows only the effective allowlist.
//
// Injection safety: a `; touch`/`$()` payload must be passed as ONE literal
// argv element — the spawned git echoes it in its fatal stderr message and no
// file may be created.
import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createCliCapabilities, MAX_CLI_STREAM_BYTES } from "../../src/capabilities/cli"
import { createDispatcher, createHostCall } from "../../src/codemode/dispatch"
import { executeTools } from "../../src/codemode/execute-tools"
import { capabilitiesFor, defaultPolicy } from "../../src/config/policy"
import type { CliAllowlist, Mode } from "../../src/config/policy"
import { registerExecuteTools } from "../../src/plugin/register"

const byteLength = (value: string): number => new TextEncoder().encode(value).length

// Real git setup (raw spawnSync; test setup, not the capability under test).
const repoRoot = mkdtempSync(join(tmpdir(), "codemode-cli-repo-"))
const nonRepoRoot = mkdtempSync(join(tmpdir(), "codemode-cli-nonrepo-"))
const init = spawnSync("git", ["init", "-q"], { cwd: repoRoot, encoding: "utf-8" })
if (init.status !== 0) {
  throw new Error(`git is required for the CLI integration tests: git init exited ${init.status} (${init.stderr})`)
}
writeFileSync(join(repoRoot, "staged-big.txt"), "x".repeat(60 * 1024), "utf-8")
const added = spawnSync("git", ["add", "staged-big.txt"], { cwd: repoRoot, encoding: "utf-8" })
if (added.status !== 0) throw new Error(`git add failed: ${added.stderr}`)

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  rmSync(nonRepoRoot, { recursive: true, force: true })
})

const ALLOW: CliAllowlist = { git: ["status", "revParse", "diff", "log"] }

interface HostEnv {
  readonly mode: Mode
  readonly capabilities: ReturnType<typeof capabilitiesFor>
  readonly root: string | undefined
  readonly cli: CliAllowlist
}

function cliHost(allowlist: CliAllowlist = ALLOW, root: string | undefined = repoRoot, mode: Mode = "on"): HostEnv {
  return { mode, capabilities: capabilitiesFor({ ...defaultPolicy(), mode, cli: allowlist }), root, cli: allowlist }
}

async function runGuest(code: string, host: HostEnv = cliHost()) {
  return executeTools(code, { host, timeoutMs: 30_000 })
}

// ---------------------------------------------------------------------------
// Happy path + nonzero-exit-as-data through the guest (criteria 1 and 3)
// ---------------------------------------------------------------------------
describe("cli.git through execute_tools (real spawns)", () => {
  test("an allowlisted op runs for real and returns exit data in the guest", async () => {
    const result = await runGuest(`
      const r = await cli.git.status({ short: true })
      return { exit: r.exitCode, truncated: r.truncated, stdout: r.stdout }
    `)
    expect(result.errorKind).toBeUndefined()
    const data = result.result as {
      exit: number
      truncated: { stdout: boolean; stderr: boolean }
      stdout: string
    }
    expect(data.exit).toBe(0)
    expect(data.truncated).toEqual({ stdout: false, stderr: false })
    expect(data.stdout).toContain("staged-big.txt")
  }, 30_000)

  test("nonzero exit is guest-visible data (non-repo dir), never a thrown error", async () => {
    const result = await runGuest(
      `
      const r = await cli.git.status({ short: true })
      return { exit: r.exitCode, stderr: r.stderr, truncated: r.truncated }
    `,
      cliHost(ALLOW, nonRepoRoot),
    )
    expect(result.errorKind).toBeUndefined()
    const data = result.result as { exit: number; stderr: string; truncated: { stdout: boolean; stderr: boolean } }
    expect(data.exit).not.toBe(0)
    expect(data.stderr).toContain("not a git repository")
    expect(data.truncated).toEqual({ stdout: false, stderr: false })
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Allowlist enforcement (criteria 1 and 4)
// ---------------------------------------------------------------------------
describe("allowlist enforcement through execute_tools", () => {
  test("ops outside the effective allowlist are type-invisible to the guest (bounded declaration)", async () => {
    const deniedOp = await runGuest(`await cli.git.commit({ message: "x" })`)
    expect(deniedOp.errorKind).toBe("type")
    expect(deniedOp.diagnostics?.length ?? 0).toBeGreaterThan(0)

    const deniedTool = await runGuest(`await cli.rg.search({ pattern: "x" })`)
    expect(deniedTool.errorKind).toBe("type")

    // No side effect: nothing has been committed anywhere by these attempts.
    const log = spawnSync("git", ["log", "--oneline"], { cwd: repoRoot, encoding: "utf-8" })
    expect(log.status).not.toBe(0) // still an unborn branch: no commit exists
  }, 30_000)

  test("runtime dispatch denies a bypassing guest even when the typed surface is cast away", async () => {
    const result = await runGuest(`
      const g = globalThis as any
      const probe = async (capability: string, input: unknown) =>
        JSON.parse(await g["__codemodeHostCall"](JSON.stringify({ capability, input })))
      const deniedOp = await probe("cli.git.commit", { message: "x" })
      const deniedTool = await probe("cli.rg.search", { pattern: "x" })
      const unknownOp = await probe("cli.git.frobnicate", {})
      const unknownTool = await probe("cli.evil.rm", {})
      return {
        deniedOp: deniedOp.error.kind,
        deniedTool: deniedTool.error.kind,
        unknownOp: unknownOp.error.kind,
        unknownTool: unknownTool.error.kind,
      }
    `)
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toEqual({
      deniedOp: "mode",
      deniedTool: "mode",
      unknownOp: "unknown-capability",
      unknownTool: "unknown-capability",
    })
  }, 30_000)

  test("off blocks cli calls inside execute_tools", async () => {
    const result = await runGuest(`await cli.git.status({})`, cliHost(ALLOW, repoRoot, "off"))
    expect(result.errorKind).toBe("runtime")
    expect(result.error ?? "").toMatch(/CodeMode is off/)
  }, 30_000)

  test("on with an empty allowlist exposes no cli surface and keeps dispatch closed", async () => {
    const empty: CliAllowlist = {}
    const result = await runGuest(`await cli.git.status({})`, cliHost(empty, repoRoot))
    expect(result.errorKind).toBe("type") // `cli` is not declared: fail closed before execution

    // Adapter boundary: even a direct bridge call is refused while the group is closed.
    const disposition = await (async () => {
      const hostCall = createHostCall(
        createDispatcher(createCliCapabilities(empty), {
          mode: "on",
          capabilities: capabilitiesFor(defaultPolicy()),
          root: repoRoot,
        }),
      )
      return JSON.parse(await hostCall(JSON.stringify({ capability: "cli.git.status", input: {} })))
    })()
    expect(disposition.ok).toBe(false)
    expect(disposition.error.kind).toBe("mode")
    expect(disposition.error.message).toContain("not enabled by the effective policy")
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Injection safety (criterion 1)
// ---------------------------------------------------------------------------
describe("injection payloads stay literal data", () => {
  test("shell metacharacter strings reach git as one argv element and execute nothing", async () => {
    const result = await runGuest(
      `
      const a = await cli.git.revParse({ ref: "; touch INJECTED_A" })
      const b = await cli.git.revParse({ ref: "$(touch INJECTED_B)" })
      return {
        aExit: a.exitCode,
        aEcho: a.stderr.includes("; touch INJECTED_A"),
        bExit: b.exitCode,
        bEcho: b.stderr.includes("$(touch INJECTED_B)"),
      }
    `,
      cliHost({ git: ["revParse"] }, repoRoot),
    )
    expect(result.errorKind).toBeUndefined()
    const data = result.result as { aExit: number; aEcho: boolean; bExit: number; bEcho: boolean }
    expect(data.aExit).not.toBe(0)
    expect(data.aEcho).toBe(true) // git echoed the payload: it arrived literal, unparsed
    expect(data.bExit).not.toBe(0)
    expect(data.bEcho).toBe(true)
    expect(existsSync(join(repoRoot, "INJECTED_A"))).toBe(false)
    expect(existsSync(join(repoRoot, "INJECTED_B"))).toBe(false)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Per-stream truncation (criterion 2)
// ---------------------------------------------------------------------------
describe("50 KiB per-stream truncation", () => {
  test("a real git diff above 50 KiB is capped with the explicit marker (adapter boundary)", async () => {
    const allowlist: CliAllowlist = { git: ["diff"] }
    const hostCall = createHostCall(
      createDispatcher(createCliCapabilities(allowlist), {
        mode: "on",
        capabilities: capabilitiesFor({ ...defaultPolicy(), cli: allowlist }),
        root: repoRoot,
      }),
    )
    const response = JSON.parse(
      await hostCall(JSON.stringify({ capability: "cli.git.diff", input: { staged: true } })),
    )
    expect(response.ok).toBe(true)
    const data = response.data as { stdout: string; stderr: string; exitCode: number; truncated: { stdout: boolean; stderr: boolean } }
    expect(data.exitCode).toBe(0)
    expect(data.truncated.stdout).toBe(true)
    expect(data.truncated.stderr).toBe(false)
    expect(byteLength(data.stdout)).toBeLessThanOrEqual(MAX_CLI_STREAM_BYTES)
    expect(data.stdout.endsWith("[Output truncated, showing last 50 KiB.]")).toBe(true)
  }, 30_000)

  test("the guest sees the same bounded stream with truncation metadata", async () => {
    const result = await runGuest(
      `
      const r = await cli.git.diff({ staged: true })
      return {
        exit: r.exitCode,
        truncated: r.truncated.stdout,
        marker: r.stdout.endsWith("[Output truncated, showing last 50 KiB.]"),
        length: r.stdout.length,
      }
    `,
      cliHost({ git: ["diff"] }, repoRoot),
    )
    expect(result.errorKind).toBeUndefined()
    const data = result.result as { exit: number; truncated: boolean; marker: boolean; length: number }
    expect(data.exit).toBe(0)
    expect(data.truncated).toBe(true)
    expect(data.marker).toBe(true)
    expect(data.length).toBeLessThanOrEqual(MAX_CLI_STREAM_BYTES)
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Register-level wiring: the gate threads mode + allowlist into execute_tools
// ---------------------------------------------------------------------------
describe("registerExecuteTools gate threads the CLI allowlist", () => {
  function makeToolHarness() {
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
    return {
      ctx,
      call: async (code: string) => {
        if (!captured) throw new Error("tool was not registered")
        return captured.execute({ code }, { sessionID: "ses_task6", signal: new AbortController().signal, progress: async () => {} })
      },
    }
  }

  test("an allowlisted session runs a real CLI op end to end", async () => {
    const harness = makeToolHarness()
    const allowlist: CliAllowlist = { git: ["status"] }
    await registerExecuteTools(harness.ctx, {
      modeForSession: () => "on",
      // Consistent wiring (mirrors src/index.ts): capability groups and the
      // CLI allowlist derive from the same effective policy.
      capabilitiesForSession: () => capabilitiesFor({ ...defaultPolicy(), cli: allowlist }),
      activeRoot: repoRoot,
      cliAllowlistForSession: () => allowlist,
    })
    const result = await harness.call(`const r = await cli.git.status({ short: true }); print("exit", r.exitCode)`)
    expect(result.content ?? "").toContain("exit 0")
  }, 30_000)

  test("an off session is refused before the guest runs, even with a configured allowlist", async () => {
    const harness = makeToolHarness()
    await registerExecuteTools(harness.ctx, {
      modeForSession: () => "off",
      activeRoot: repoRoot,
      cliAllowlistForSession: () => ({ git: ["status"] }),
    })
    const result = await harness.call(`await cli.git.status({})`)
    expect(result.content ?? "").toContain("off for this session")
    expect(result.metadata?.errorKind).toBe("mode")
  }, 30_000)
})
