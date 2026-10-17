// tests/integration/npm-scripts.test.ts
// Task 8 integration acceptance: safe npm script decomposition THROUGH
// execute_tools (checkpoint rule: capabilities are proven via the pipeline,
// not only via helper functions), against a REAL temp project:
//   - a real git repository (the zero-side-effect oracle: `git status
//     --porcelain` must stay empty after every planning/refusal case, and the
//     file a refused script WOULD have created must not exist);
//   - real fixture executables on PATH (tsc/vitest/oxfmt .cmd shims, the same
//     "minimal real child process" precedent as the Task 7 MCP fixture
//     server). The tsc/oxfmt shims record every spawn in a marker file, so
//     "planning never spawns" and "running really spawns" are asserted from
//     real process evidence, not from mocks.
//
// Acceptance criteria covered here:
//   1. planning returns explicit executable+argv steps with no side effects;
//   2. running executes only the surfaced plan and rechecks the allowlist at
//      execution time (a narrowed allowlist refuses before anything runs);
//   3. pipes/redirection/substitution/chaining stay rejected (Pi's narrow
//      `&&` case aside) with the original package's refusal messages.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { executeTools } from "../../src/codemode/execute-tools"
import { capabilitiesFor, defaultPolicy } from "../../src/config/policy"
import type { CliAllowlist, Mode } from "../../src/config/policy"
import { registerExecuteTools } from "../../src/plugin/register"

// ---------------------------------------------------------------------------
// Real project + real git repo + real fixture executables
// ---------------------------------------------------------------------------

const projectRoot = mkdtempSync(join(tmpdir(), "codemode-npm-proj-"))
const binDir = mkdtempSync(join(tmpdir(), "codemode-npm-bin-"))
const markerPath = join(binDir, "spawned.marker")
const injectedPath = join(projectRoot, "INJECTED.txt")

writeFileSync(
  join(projectRoot, "package.json"),
  JSON.stringify(
    {
      scripts: {
        build: "tsc",
        dev: "tsc --watch",
        check: "npm run build && vitest run",
        checkfail: "tsc --watch && vitest run",
        fmt: "oxfmt . --write",
        evil: "node evil.js",
        pipe: "tsc | tee out.log",
        broken: "vp fmt . --write",
      },
    },
    null,
    2,
  ),
)
// The file the `evil` script WOULD create if its raw command ever ran.
writeFileSync(join(projectRoot, "evil.js"), 'require("fs").writeFileSync("INJECTED.txt", "x")\n')
writeFileSync(join(projectRoot, "tracked.txt"), "keep me\n")

const gitInit = spawnSync("git", ["init", "-q"], { cwd: projectRoot, encoding: "utf8" })
if (gitInit.status !== 0) {
  throw new Error(`git is required for the npm-scripts integration tests: git init exited ${gitInit.status} (${gitInit.stderr})`)
}
const gitAdd = spawnSync("git", ["add", "-A"], { cwd: projectRoot, encoding: "utf8" })
if (gitAdd.status !== 0) throw new Error(`git add failed: ${gitAdd.stderr}`)
// Baseline commit (explicit identity; no reliance on global git config) so
// `git status --porcelain` is a clean oracle for "no side effects": before
// the first commit an unborn branch lists every staged file as "A ".
const gitCommit = spawnSync(
  "git",
  ["-c", "user.email=codemode-test@example.invalid", "-c", "user.name=codemode-test", "commit", "-q", "-m", "init"],
  { cwd: projectRoot, encoding: "utf8" },
)
if (gitCommit.status !== 0) throw new Error(`git commit failed: ${gitCommit.stderr}`)

function gitPorcelain(): string {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" })
  return status.stdout.trim()
}

const cmd = (lines: string[]): string => `${lines.join("\r\n")}\r\n`
writeFileSync(
  join(binDir, "tsc.cmd"),
  cmd([
    "@echo off",
    'echo ran>"%~dp0spawned.marker"',
    'if "%~1"=="--watch" (',
    "echo tsc-watch-failed",
    "exit /b 3",
    ")",
    "echo tsc-fixture-ok",
    "exit /b 0",
  ]),
)
writeFileSync(join(binDir, "vitest.cmd"), cmd(["@echo off", "echo vitest-fixture-ok", "exit /b 0"]))
writeFileSync(
  join(binDir, "oxfmt.cmd"),
  cmd(["@echo off", 'echo ran>"%~dp0spawned.marker"', "echo oxfmt-fixture-ok", "exit /b 0"]),
)

const originalPath = process.env.PATH
process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`

afterAll(() => {
  process.env.PATH = originalPath
  rmSync(projectRoot, { recursive: true, force: true })
  rmSync(binDir, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(markerPath, { force: true })
})

// ---------------------------------------------------------------------------
// Host environments + guest helpers
// ---------------------------------------------------------------------------

const PLAN_ALLOW: CliAllowlist = { tsc: ["build"], vitest: ["run"], oxfmt: ["write"] }

function hostFor(allowlist: CliAllowlist, root: string | undefined = projectRoot, mode: Mode = "on") {
  return {
    mode,
    capabilities: capabilitiesFor({ ...defaultPolicy(), mode, cli: allowlist }),
    root,
    cli: allowlist,
  }
}

async function runGuest(
  code: string,
  allowlist: CliAllowlist = PLAN_ALLOW,
  options: { root?: string | undefined; mode?: Mode } = {},
) {
  const root = "root" in options ? options.root : projectRoot
  return executeTools(code, { host: hostFor(allowlist, root, options.mode ?? "on"), timeoutMs: 30_000 })
}

// ---------------------------------------------------------------------------
// Planning through execute_tools (criterion 1: explicit steps, zero spawns)
// ---------------------------------------------------------------------------

describe("plan_npm_script through execute_tools (real project, zero spawns)", () => {
  test("planning surfaces the explicit executable+argv plan and spawns NOTHING", async () => {
    const result = await runGuest(`
      const p = await codemode.plan_npm_script({ script: "check" })
      return p
    `)
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toEqual({
      script: "check",
      steps: [
        { tool: "tsc", operation: "build", args: {}, executable: "tsc", argv: [], status: "ready" },
        { tool: "vitest", operation: "run", args: {}, executable: "vitest", argv: ["run"], status: "ready" },
      ],
    })
    // Real-process evidence: the shims were resolvable on PATH, so a spawn
    // WOULD have left the marker; planning left none.
    expect(existsSync(markerPath)).toBe(false)
    expect(gitPorcelain()).toBe("")
  }, 30_000)

  test("planning a write-capable script changes no file (git oracle)", async () => {
    const result = await runGuest(`
      const p = await codemode.plan_npm_script({ script: "fmt" })
      return p.steps
    `)
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toEqual([
      { tool: "oxfmt", operation: "write", args: { paths: ["."] }, executable: "oxfmt", argv: ["--write", "--", "."], status: "ready" },
    ])
    expect(existsSync(markerPath)).toBe(false)
    expect(gitPorcelain()).toBe("")
  }, 30_000)

  test("steps outside the effective allowlist are surfaced blocked, not dropped", async () => {
    const result = await runGuest(
      `
      const p = await codemode.plan_npm_script({ script: "check" })
      return p.steps
      `,
      { git: ["status"] },
    )
    expect(result.errorKind).toBeUndefined()
    const steps = result.result as Array<{ status: string; reason?: string }>
    expect(steps.map((step) => step.status)).toEqual(["blocked", "blocked"])
    expect(steps[0]?.reason).toContain("not in the effective CLI allowlist")
    expect(existsSync(markerPath)).toBe(false)
  }, 30_000)

  test("unsafe scripts are refused before execution and create no side effect", async () => {
    const evil = await runGuest(`await codemode.plan_npm_script({ script: "evil" })`)
    expect(evil.errorKind).toBe("runtime")
    expect(evil.error ?? "").toContain("command 'node' is denied")

    const pipe = await runGuest(`await codemode.plan_npm_script({ script: "pipe" })`)
    expect(pipe.errorKind).toBe("runtime")
    expect(pipe.error ?? "").toContain("unsupported shell construct '|'")

    const broken = await runGuest(`await codemode.plan_npm_script({ script: "broken" })`)
    expect(broken.errorKind).toBe("runtime")
    expect(broken.error ?? "").toContain("unsupported command 'vp'")

    expect(existsSync(injectedPath)).toBe(false)
    expect(existsSync(markerPath)).toBe(false)
    expect(gitPorcelain()).toBe("")
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Running through execute_tools (criterion 2: only the surfaced plan)
// ---------------------------------------------------------------------------

describe("run_npm_script through execute_tools (real spawns)", () => {
  test("an allowlisted plan executes for real and returns per-step exit data", async () => {
    const result = await runGuest(`
      const r = await codemode.run_npm_script({ script: "check" })
      return r
    `)
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toEqual({
      script: "check",
      results: [
        { tool: "tsc", operation: "build", args: {}, outcome: "ok", exitCode: 0 },
        { tool: "vitest", operation: "run", args: {}, outcome: "ok", exitCode: 0 },
      ],
    })
    // Real spawns happened (the tsc shim wrote the marker).
    expect(existsSync(markerPath)).toBe(true)
    expect(gitPorcelain()).toBe("")
  }, 30_000)

  test("verbose includes successful-step output from the real child", async () => {
    const result = await runGuest(`
      const r = await codemode.run_npm_script({ script: "check", verbose: true })
      return r
    `)
    expect(result.errorKind).toBeUndefined()
    const data = result.result as { results: Array<{ outcome: string; stdout?: string; exitCode?: number }> }
    expect(data.results[0]?.outcome).toBe("ok")
    expect(data.results[0]?.stdout ?? "").toContain("tsc-fixture-ok")
    expect(data.results[1]?.stdout ?? "").toContain("vitest-fixture-ok")
  }, 30_000)

  test("a nonzero exit is data: it stops the run and the remaining step is skipped", async () => {
    const result = await runGuest(`
      const r = await codemode.run_npm_script({ script: "checkfail" })
      return r
    `)
    expect(result.errorKind).toBeUndefined()
    const data = result.result as { results: Array<{ outcome: string; exitCode?: number; stdout?: string }> }
    expect(data.results[0]?.outcome).toBe("nonzero-exit")
    expect(data.results[0]?.exitCode).toBe(3)
    expect(data.results[0]?.stdout ?? "").toContain("tsc-watch-failed")
    expect(data.results[1]?.outcome).toBe("skipped")
  }, 30_000)

  test("policy recheck: an allowlist narrowed after planning refuses the run before anything runs", async () => {
    const planned = await runGuest(`
      const p = await codemode.plan_npm_script({ script: "check" })
      return p.steps.map((step) => step.status)
    `)
    expect(planned.errorKind).toBeUndefined()
    expect(planned.result).toEqual(["ready", "ready"])

    const narrowed = await runGuest(`await codemode.run_npm_script({ script: "check" })`, { git: ["status"] })
    expect(narrowed.errorKind).toBe("runtime")
    expect(narrowed.error ?? "").toContain("run refused")
    expect(narrowed.error ?? "").toContain("cli.tsc.build")
    expect(existsSync(markerPath)).toBe(false) // nothing spawned
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Closed surfaces + raw bridge bounds
// ---------------------------------------------------------------------------

const RAW_PROBE = `
  const g = globalThis as any
  const probe = async (capability: string, input: unknown) =>
    JSON.parse(await g["__codemodeHostCall"](JSON.stringify({ capability, input })))
  const outcome = await probe("codemode.plan_npm_script", { script: "check" })
  return outcome.error.kind
`

describe("closed surfaces and raw bridge bounds", () => {
  test("mode off makes the npm surface type-invisible and the raw bridge denies", async () => {
    const typed = await runGuest(`await codemode.plan_npm_script({ script: "check" })`, PLAN_ALLOW, { mode: "off" })
    expect(typed.errorKind).toBe("type")

    const raw = await runGuest(RAW_PROBE, PLAN_ALLOW, { mode: "off" })
    expect(raw.errorKind).toBeUndefined()
    expect(raw.result).toBe("mode")
  }, 30_000)

  test("an empty allowlist keeps the npm surface type-invisible and dispatch closed", async () => {
    const typed = await runGuest(`await codemode.plan_npm_script({ script: "check" })`, {})
    expect(typed.errorKind).toBe("type")

    const raw = await runGuest(RAW_PROBE, {})
    expect(raw.errorKind).toBeUndefined()
    expect(raw.result).toBe("mode")
  }, 30_000)

  test("malformed and unknown raw calls stay bounded", async () => {
    const result = await runGuest(`
      const g = globalThis as any
      const probe = async (capability: string, input: unknown) =>
        JSON.parse(await g["__codemodeHostCall"](JSON.stringify({ capability, input })))
      const missing = await probe("codemode.plan_npm_script", {})
      const unknown = await probe("codemode.plan_npm_script_x", { script: "check" })
      return { missing: missing.error.kind, unknown: unknown.error.kind }
    `)
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toEqual({ missing: "input", unknown: "unknown-capability" })
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Register-level wiring: the gate threads the allowlist into the npm surface
// ---------------------------------------------------------------------------

describe("registerExecuteTools gate threads the npm surface", () => {
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
        return captured.execute({ code }, { sessionID: "ses_task8", signal: new AbortController().signal, progress: async () => {} })
      },
    }
  }

  test("an allowlisted session plans npm scripts end to end through the registered tool", async () => {
    const harness = makeToolHarness()
    const allowlist: CliAllowlist = { tsc: ["build"], vitest: ["run"] }
    await registerExecuteTools(harness.ctx, {
      modeForSession: () => "on",
      capabilitiesForSession: () => capabilitiesFor({ ...defaultPolicy(), cli: allowlist }),
      activeRoot: projectRoot,
      cliAllowlistForSession: () => allowlist,
    })
    const result = await harness.call(
      `const p = await codemode.plan_npm_script({ script: "check" }); print(p.steps.length, p.steps[0].status, p.steps[0].executable)`,
    )
    expect(result.content ?? "").toContain("2 ready tsc")
    expect(existsSync(markerPath)).toBe(false) // planning through the gate still spawns nothing
  }, 30_000)
})
