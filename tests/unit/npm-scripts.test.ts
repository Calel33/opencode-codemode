// tests/unit/npm-scripts.test.ts
// Task 8 acceptance: decompose safe npm scripts into explicit CLI plans.
//   1. Planning returns explicit executable+argument calls without side
//      effects: the step executor is injected and asserted UNUSED, and the
//      pure parser never touches the filesystem or a child process.
//   2. Running accepts only the surfaced validated plan and rechecks the
//      effective allowlist at execution time: a single blocked step refuses
//      the WHOLE run before anything executes.
//   3. Shell constructs, denied commands, and unsupported commands are
//      rejected with the original package's exact refusal messages; only the
//      narrow `&&` chain case and the exact recursive `npm run <script>`
//      (3 argv) / `npm test` (2 argv) forms are supported.
//
// The parser rules are ported from the original package's npm-scripts.ts
// (research §2.9); this file verifies every rule verbatim.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDispatcher } from "../../src/codemode/dispatch"
import type { DispatchEnvironment, DispatchOutcome } from "../../src/codemode/dispatch"
import { capabilitiesFor, defaultPolicy } from "../../src/config/policy"
import type { CliAllowlist, Mode } from "../../src/config/policy"
import {
  MAX_NPM_PLAN_STEPS,
  MAX_PACKAGE_JSON_BYTES,
  NPM_DENIED_COMMANDS,
  NPM_SHELL_CONSTRUCTS,
  createNpmScriptCapabilities,
  decomposeNpmScript,
} from "../../src/capabilities/npm-scripts"
import type { NpmStepExecutor } from "../../src/capabilities/npm-scripts"

// ---------------------------------------------------------------------------
// Temp projects (real filesystem; cleaned up in afterAll)
// ---------------------------------------------------------------------------

const tempDirs: string[] = []

function tempProject(packageJson: string): string {
  const dir = mkdtempSync(join(tmpdir(), "codemode-npm-unit-"))
  tempDirs.push(dir)
  writeFileSync(join(dir, "package.json"), packageJson)
  return dir
}

const projectRoot = tempProject(
  JSON.stringify({
    scripts: {
      build: "tsc",
      dev: "tsc --watch",
      check: "npm run build && vitest run",
      fmt: "oxfmt . --write",
      lint: "oxlint --deny warnings --vitest-plugin src",
      pipe: "tsc | tee out.log",
      evil: "node build.js",
      empty: "",
    },
  }),
)

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Dispatcher harness: the injected executor records every invocation
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly tool: string
  readonly operation: string
  readonly args: Record<string, unknown>
}

function npmDispatcher(
  allowlist: CliAllowlist,
  overrides: {
    mode?: Mode
    root?: string | undefined
    executeStep?: NpmStepExecutor
    signal?: AbortSignal
  } = {},
) {
  const mode = overrides.mode ?? "on"
  const calls: RecordedCall[] = []
  const defaultExecutor: NpmStepExecutor = async (tool, operation, args) => {
    calls.push({ tool, operation, args: { ...args } })
    return {
      ok: true,
      data: { stdout: `${tool}.${operation}-ok`, stderr: "", exitCode: 0, truncated: { stdout: false, stderr: false } },
    }
  }
  const executeStep = overrides.executeStep ?? defaultExecutor
  const env: DispatchEnvironment = {
    mode,
    capabilities: capabilitiesFor({ ...defaultPolicy(), mode, cli: allowlist }),
    root: "root" in overrides ? overrides.root : projectRoot,
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  }
  const dispatcher = createDispatcher(createNpmScriptCapabilities({ allowlist, executeStep }), env)
  return { dispatcher, calls }
}

async function dispatch(dispatcher: ReturnType<typeof npmDispatcher>["dispatcher"], capability: string, input: unknown) {
  const outcome = await dispatcher.dispatch({ capability, input })
  return outcome
}

// ---------------------------------------------------------------------------
// Parser: the original package's rules, verbatim (acceptance criterion 3)
// ---------------------------------------------------------------------------

describe("npm script decomposition (Pi rules preserved)", () => {
  test("the denylist, shell-construct list, and step cap match the original package", () => {
    expect([...NPM_DENIED_COMMANDS].sort()).toEqual(
      ["bash", "node", "npm", "npx", "python", "python3", "sh"].sort(),
    )
    expect(NPM_SHELL_CONSTRUCTS).toEqual(["|", ">", "<", "$", "`", "(", ")", ";", "||"])
    expect(MAX_NPM_PLAN_STEPS).toBe(32)
  })

  test("decomposes tsc build into a surfaced cli call", () => {
    expect(decomposeNpmScript({ build: "tsc" }, "build")).toEqual([
      { tool: "tsc", operation: "build", args: {} },
    ])
  })

  test("decomposes tsc --watch into an explicit watch argument", () => {
    expect(decomposeNpmScript({ dev: "tsc --watch" }, "dev")).toEqual([
      { tool: "tsc", operation: "build", args: { watch: true } },
    ])
  })

  test("recursively resolves npm run / npm test references in chain order", () => {
    const scripts = {
      check: "npm run build && npm test",
      build: "tsc",
      test: "vitest run",
    }
    expect(decomposeNpmScript(scripts, "check")).toEqual([
      { tool: "tsc", operation: "build", args: {} },
      { tool: "vitest", operation: "run", args: {} },
    ])
  })

  test("decomposes a check-style chain into ordered calls (format/lint/build/test)", () => {
    const scripts = {
      check: "npm run format:check && npm run lint && npm run build && npm test",
      "format:check": "oxfmt . --check",
      lint: "oxlint --deny warnings --vitest-plugin src",
      build: "tsc",
      test: "vitest run",
    }
    expect(decomposeNpmScript(scripts, "check")).toEqual([
      { tool: "oxfmt", operation: "check", args: { paths: ["."] } },
      { tool: "oxlint", operation: "run", args: { deny: "warnings", vitestPlugin: true, paths: ["src"] } },
      { tool: "tsc", operation: "build", args: {} },
      { tool: "vitest", operation: "run", args: {} },
    ])
  })

  test("splits only on && and trims empty segments", () => {
    expect(decomposeNpmScript({ check: "tsc &&   && vitest run" }, "check")).toEqual([
      { tool: "tsc", operation: "build", args: {} },
      { tool: "vitest", operation: "run", args: {} },
    ])
  })

  test("an empty command decomposes to zero calls", () => {
    expect(decomposeNpmScript({ empty: "" }, "empty")).toEqual([])
  })

  test("rejects unsupported commands", () => {
    expect(() => decomposeNpmScript({ format: "vp fmt . --write" }, "format")).toThrow(
      "unsupported command 'vp'",
    )
  })

  test("denied commands fail loudly with the script chain (Pi message)", () => {
    expect(() =>
      decomposeNpmScript({ build: "npm run inner", inner: "node scripts/build.js" }, "build"),
    ).toThrow(
      "Refusing to decompose npm script 'inner' (chain: build -> inner): command 'node' is denied. Use surfaced cli.* tools instead.",
    )
  })

  test("every denied command is refused in a plain invocation", () => {
    for (const command of ["node", "npm", "npx", "bash", "sh", "python", "python3"]) {
      expect(() => decomposeNpmScript({ build: `${command} some-arg` }, "build")).toThrow(
        `command '${command}' is denied`,
      )
    }
  })

  test("recursive npm forms are allowed only with their exact argv shapes", () => {
    const scripts = { build: "npm run inner", inner: "tsc", test: "vitest run" }
    expect(decomposeNpmScript(scripts, "build")).toEqual([{ tool: "tsc", operation: "build", args: {} }])
    expect(decomposeNpmScript(scripts, "test")).toEqual([{ tool: "vitest", operation: "run", args: {} }])

    for (const bad of ["npm install", "npm run", "npm run inner extra", "npm test extra", "npm --version"]) {
      expect(() => decomposeNpmScript({ build: bad, inner: "tsc" }, "build")).toThrow("command 'npm' is denied")
    }
  })

  test("rejects every shell construct on the list before tokenizing", () => {
    const cases: Array<[string, string]> = [
      ["tsc | tee out.log", "|"],
      ["tsc > out.log", ">"],
      ["tsc < in.txt", "<"],
      ["git tag v$npm_package_version", "$"],
      ["tsc `x`", "`"],
      ["tsc && (vitest run)", "("],
      ["tsc )", ")"],
      ["tsc; rm -rf x", ";"],
      ["tsc || x", "|"], // Pi reports the first matching construct: '|' precedes '||'
    ]
    for (const [command, construct] of cases) {
      expect(() => decomposeNpmScript({ build: command }, "build")).toThrow(
        `unsupported shell construct '${construct}'`,
      )
    }
  })

  test("rejects env expansion before execution (publish-style scripts)", () => {
    expect(() =>
      decomposeNpmScript(
        {
          "publish:tag": "npm run check && npm pack --dry-run && git tag v$npm_package_version",
          check: "tsc",
        },
        "publish:tag",
      ),
    ).toThrow("unsupported shell construct '$'")
  })

  test("detects recursive npm script cycles", () => {
    expect(() => decomposeNpmScript({ a: "npm run b", b: "npm run a" }, "a")).toThrow(
      "cycle detected while resolving npm scripts: a -> b -> a",
    )
  })

  test("undefined and non-string scripts are not resolvable", () => {
    expect(() => decomposeNpmScript({ build: "tsc" }, "missing")).toThrow(
      "npm script 'missing' is not defined",
    )
    expect(() => decomposeNpmScript({ build: 42 } as unknown as Record<string, string>, "build")).toThrow(
      "npm script 'build' is not defined",
    )
  })

  test("tsc arguments outside the supported subset are refused", () => {
    expect(() => decomposeNpmScript({ build: "tsc --build" }, "build")).toThrow(
      "unsupported tsc arguments: --build",
    )
    expect(() => decomposeNpmScript({ build: "tsc --watch extra" }, "build")).toThrow(
      "unsupported tsc arguments: --watch extra",
    )
  })

  test("oxfmt supports exactly <path> --check / <path> --write", () => {
    expect(decomposeNpmScript({ fmt: "oxfmt src --check" }, "fmt")).toEqual([
      { tool: "oxfmt", operation: "check", args: { paths: ["src"] } },
    ])
    expect(decomposeNpmScript({ fmt: "oxfmt src --write" }, "fmt")).toEqual([
      { tool: "oxfmt", operation: "write", args: { paths: ["src"] } },
    ])
    expect(() => decomposeNpmScript({ fmt: "oxfmt src" }, "fmt")).toThrow(
      "unsupported oxfmt arguments: src",
    )
    expect(() => decomposeNpmScript({ fmt: "oxfmt . --fix" }, "fmt")).toThrow(
      "unsupported oxfmt arguments: . --fix",
    )
  })

  test("oxlint supports exactly the documented flag subset", () => {
    expect(decomposeNpmScript({ lint: "oxlint --deny warnings --vitest-plugin src" }, "lint")).toEqual([
      { tool: "oxlint", operation: "run", args: { deny: "warnings", vitestPlugin: true, paths: ["src"] } },
    ])
    expect(() => decomposeNpmScript({ lint: "oxlint src" }, "lint")).toThrow(
      "unsupported oxlint arguments: src",
    )
  })

  test("vitest supports exactly `vitest run`", () => {
    expect(decomposeNpmScript({ test: "vitest run" }, "test")).toEqual([
      { tool: "vitest", operation: "run", args: {} },
    ])
    expect(() => decomposeNpmScript({ test: "vitest" }, "test")).toThrow("unsupported command 'vitest'")
    expect(() => decomposeNpmScript({ test: "vitest run --watch" }, "test")).toThrow(
      "unsupported command 'vitest'",
    )
  })

  test("expansion is bounded: at exactly the cap it plans, one step beyond it refuses", () => {
    const doubling: Record<string, string> = { level1: "tsc" }
    for (let level = 2; level <= 6; level++) {
      doubling[`level${level}`] = `npm run level${level - 1} && npm run level${level - 1}`
    }
    expect(decomposeNpmScript(doubling, "level6").length).toBe(MAX_NPM_PLAN_STEPS)

    const beyond = { ...doubling, level7: "npm run level6 && npm run level6" }
    expect(() => decomposeNpmScript(beyond, "level7")).toThrow(
      `decomposition exceeds ${MAX_NPM_PLAN_STEPS} steps (bounded)`,
    )
  })
})

// ---------------------------------------------------------------------------
// Plan capability: explicit calls, zero execution (acceptance criterion 1)
// ---------------------------------------------------------------------------

describe("codemode.plan_npm_script (no effects)", () => {
  test("returns explicit executable+argv steps and invokes the executor ZERO times", async () => {
    const { dispatcher, calls } = npmDispatcher({ tsc: ["build"], vitest: ["run"] })
    const outcome = await dispatch(dispatcher, "codemode.plan_npm_script", { script: "check" })
    expect(outcome).toEqual({
      ok: true,
      data: {
        script: "check",
        steps: [
          { tool: "tsc", operation: "build", args: {}, executable: "tsc", argv: [], status: "ready" },
          { tool: "vitest", operation: "run", args: {}, executable: "vitest", argv: ["run"], status: "ready" },
        ],
      },
    })
    expect(calls).toEqual([]) // planning never spawns / never executes
  })

  test("an allowlisted oxfmt write plan surfaces the exact argv without executing", async () => {
    const { dispatcher, calls } = npmDispatcher({ oxfmt: ["write"] })
    const outcome = await dispatch(dispatcher, "codemode.plan_npm_script", { script: "fmt" })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data).toEqual({
      script: "fmt",
      steps: [
        {
          tool: "oxfmt",
          operation: "write",
          args: { paths: ["."] },
          executable: "oxfmt",
          argv: ["--write", "--", "."],
          status: "ready",
        },
      ],
    })
    expect(calls).toEqual([])
  })

  test("steps outside the effective allowlist are surfaced as blocked data, never dropped", async () => {
    const { dispatcher, calls } = npmDispatcher({ git: ["status"] })
    const outcome = await dispatch(dispatcher, "codemode.plan_npm_script", { script: "check" })
    expect(outcome).toEqual({
      ok: true,
      data: {
        script: "check",
        steps: [
          {
            tool: "tsc",
            operation: "build",
            args: {},
            executable: "tsc",
            argv: [],
            status: "blocked",
            reason: "cli.tsc.build is not in the effective CLI allowlist",
          },
          {
            tool: "vitest",
            operation: "run",
            args: {},
            executable: "vitest",
            argv: ["run"],
            status: "blocked",
            reason: "cli.vitest.run is not in the effective CLI allowlist",
          },
        ],
      },
    })
    expect(calls).toEqual([])
  })

  test("unsafe scripts are refused before any executor call", async () => {
    const { dispatcher, calls } = npmDispatcher({ tsc: ["build"] })
    const outcome = await dispatch(dispatcher, "codemode.plan_npm_script", { script: "pipe" })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("input")
      expect(outcome.error.message).toBe(
        "Refusing to decompose npm script 'pipe' (chain: pipe): unsupported shell construct '|'",
      )
    }
    expect(calls).toEqual([])
  })

  test("an unknown root fails closed before any read", async () => {
    const { dispatcher } = npmDispatcher({ tsc: ["build"] }, { root: undefined })
    const outcome = await dispatch(dispatcher, "codemode.plan_npm_script", { script: "build" })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("root")
      expect(outcome.error.message).toMatch(/root is unknown/i)
    }
  })

  test("package.json failures are bounded outcomes: missing, invalid JSON, oversized, bad scripts", async () => {
    const missing = tempProjectWithoutPackageJson()
    const invalid = tempProject("{ not json")
    const oversized = tempProject(" ".repeat(MAX_PACKAGE_JSON_BYTES + 1))
    const badScripts = tempProject('{"scripts": []}')

    const cases: Array<[string, string]> = [
      [missing, "not-found"],
      [invalid, "input"],
      [oversized, "limit"],
      [badScripts, "input"],
    ]
    for (const [root, kind] of cases) {
      const { dispatcher, calls } = npmDispatcher({ tsc: ["build"] }, { root })
      const outcome = await dispatch(dispatcher, "codemode.plan_npm_script", { script: "build" })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error.kind).toBe(kind)
      expect(calls).toEqual([])
    }

    const { dispatcher } = npmDispatcher({ tsc: ["build"] }, { root: invalid })
    const outcome = await dispatch(dispatcher, "codemode.plan_npm_script", { script: "build" })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error.message).toContain("not valid JSON")
  })

  test("an undefined script name is an input error with the Pi message", async () => {
    const { dispatcher } = npmDispatcher({ tsc: ["build"] })
    const outcome = await dispatch(dispatcher, "codemode.plan_npm_script", { script: "missing" })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("input")
      expect(outcome.error.message).toBe("npm script 'missing' is not defined")
    }
  })

  test("malformed inputs are bounded input errors", async () => {
    const { dispatcher } = npmDispatcher({ tsc: ["build"] })
    for (const input of [undefined, {}, { script: "" }, { script: 42 }]) {
      const outcome = await dispatch(dispatcher, "codemode.plan_npm_script", input)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error.kind).toBe("input")
    }
  })

  test("mode off and a closed cli group never reach the adapter", async () => {
    const off = npmDispatcher({ tsc: ["build"] }, { mode: "off" })
    const offOutcome = await dispatch(off.dispatcher, "codemode.plan_npm_script", { script: "build" })
    expect(offOutcome.ok).toBe(false)
    if (!offOutcome.ok) expect(offOutcome.error.kind).toBe("mode")

    const closed = npmDispatcher({})
    const closedOutcome = await dispatch(closed.dispatcher, "codemode.plan_npm_script", { script: "build" })
    expect(closedOutcome.ok).toBe(false)
    if (!closedOutcome.ok) {
      expect(closedOutcome.error.kind).toBe("mode")
      expect(closedOutcome.error.message).toContain("not enabled by the effective policy")
    }
  })

  test("a pre-aborted signal cancels before any work", async () => {
    const controller = new AbortController()
    controller.abort()
    const { dispatcher } = npmDispatcher({ tsc: ["build"] }, { signal: controller.signal })
    const outcome = await dispatch(dispatcher, "codemode.plan_npm_script", { script: "build" })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("cancelled")
      expect(outcome.error.message).toBe("Execution cancelled")
    }
  })
})

// ---------------------------------------------------------------------------
// Run capability: only the surfaced plan, rechecked at execution time
// ---------------------------------------------------------------------------

describe("codemode.run_npm_script (execution-time recheck)", () => {
  test("runs the ready steps in order and returns bounded per-step results", async () => {
    const { dispatcher, calls } = npmDispatcher({ tsc: ["build"], vitest: ["run"] })
    const outcome = await dispatch(dispatcher, "codemode.run_npm_script", { script: "check" })
    expect(outcome).toEqual({
      ok: true,
      data: {
        script: "check",
        results: [
          { tool: "tsc", operation: "build", args: {}, outcome: "ok", exitCode: 0 },
          { tool: "vitest", operation: "run", args: {}, outcome: "ok", exitCode: 0 },
        ],
      },
    })
    expect(calls).toEqual([
      { tool: "tsc", operation: "build", args: {} },
      { tool: "vitest", operation: "run", args: {} },
    ])
  })

  test("verbose includes stdout/stderr for successful steps", async () => {
    const { dispatcher } = npmDispatcher({ tsc: ["build"] })
    const outcome = await dispatch(dispatcher, "codemode.run_npm_script", { script: "build", verbose: true })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.data).toEqual({
      script: "build",
      results: [
        {
          tool: "tsc",
          operation: "build",
          args: {},
          outcome: "ok",
          exitCode: 0,
          stdout: "tsc.build-ok",
          stderr: "",
          truncated: { stdout: false, stderr: false },
        },
      ],
    })
  })

  test("a nonzero exit stops the run, includes the output, and marks the rest skipped", async () => {
    const calls: Array<{ tool: string; operation: string }> = []
    const executeStep: NpmStepExecutor = async (tool, operation) => {
      calls.push({ tool, operation })
      return tool === "tsc"
        ? { ok: true, data: { stdout: "first failed", stderr: "details", exitCode: 3, truncated: { stdout: false, stderr: false } } }
        : { ok: true, data: { stdout: "never", stderr: "", exitCode: 0, truncated: { stdout: false, stderr: false } } }
    }
    const { dispatcher } = npmDispatcher({ tsc: ["build"], vitest: ["run"] }, { executeStep })
    const outcome = await dispatch(dispatcher, "codemode.run_npm_script", { script: "check" })
    expect(outcome).toEqual({
      ok: true,
      data: {
        script: "check",
        results: [
          {
            tool: "tsc",
            operation: "build",
            args: {},
            outcome: "nonzero-exit",
            exitCode: 3,
            stdout: "first failed",
            stderr: "details",
            truncated: { stdout: false, stderr: false },
          },
          { tool: "vitest", operation: "run", args: {}, outcome: "skipped" },
        ],
      },
    })
    expect(calls).toEqual([{ tool: "tsc", operation: "build" }])
  })

  test("an executor failure stops the run and is surfaced as data", async () => {
    const executeStep: NpmStepExecutor = async () => ({ ok: false, error: { kind: "not-found", message: "missing binary" } })
    const { dispatcher } = npmDispatcher({ tsc: ["build"], vitest: ["run"] }, { executeStep })
    const outcome = await dispatch(dispatcher, "codemode.run_npm_script", { script: "check" })
    expect(outcome).toEqual({
      ok: true,
      data: {
        script: "check",
        results: [
          {
            tool: "tsc",
            operation: "build",
            args: {},
            outcome: "error",
            error: { kind: "not-found", message: "missing binary" },
          },
          { tool: "vitest", operation: "run", args: {}, outcome: "skipped" },
        ],
      },
    })
  })

  test("policy recheck: an allowlist narrowed after planning refuses the run before anything executes", async () => {
    // Plan at time A: the steps are surfaced ready.
    const planned = npmDispatcher({ tsc: ["build"], vitest: ["run"] })
    const plannedOutcome = await dispatch(planned.dispatcher, "codemode.plan_npm_script", { script: "check" })
    expect(plannedOutcome.ok).toBe(true)
    if (plannedOutcome.ok) {
      expect((plannedOutcome.data as { steps: Array<{ status: string }> }).steps.every((step) => step.status === "ready")).toBe(true)
    }

    // Run at time B: the effective allowlist no longer grants the plan.
    const narrowed = npmDispatcher({ git: ["status"] })
    const runOutcome = await dispatch(narrowed.dispatcher, "codemode.run_npm_script", { script: "check" })
    expect(runOutcome.ok).toBe(false)
    if (!runOutcome.ok) {
      expect(runOutcome.error.kind).toBe("mode")
      expect(runOutcome.error.message).toContain("run refused")
      expect(runOutcome.error.message).toContain("cli.tsc.build")
      expect(runOutcome.error.message).toContain("cli.vitest.run")
    }
    expect(narrowed.calls).toEqual([]) // nothing ran — not even the still-allowlisted prefix
  })

  test("a single blocked step refuses the WHOLE run (all-or-nothing)", async () => {
    const { dispatcher, calls } = npmDispatcher({ tsc: ["build"] })
    const outcome = await dispatch(dispatcher, "codemode.run_npm_script", { script: "check" })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("mode")
      expect(outcome.error.message).toContain("cli.vitest.run")
    }
    expect(calls).toEqual([]) // tsc (still allowlisted) did NOT execute
  })

  test("running an empty decomposition succeeds with zero results", async () => {
    const { dispatcher, calls } = npmDispatcher({ tsc: ["build"] })
    const outcome = await dispatch(dispatcher, "codemode.run_npm_script", { script: "empty" })
    expect(outcome).toEqual({ ok: true, data: { script: "empty", results: [] } })
    expect(calls).toEqual([])
  })

  test("malformed inputs are bounded input errors (script, verbose, root)", async () => {
    const { dispatcher } = npmDispatcher({ tsc: ["build"] })
    for (const input of [undefined, {}, { script: "" }]) {
      const outcome = await dispatch(dispatcher, "codemode.run_npm_script", input)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error.kind).toBe("input")
    }
    const verbose = await dispatch(dispatcher, "codemode.run_npm_script", { script: "build", verbose: "yes" })
    expect(verbose.ok).toBe(false)
    if (!verbose.ok) {
      expect(verbose.error.kind).toBe("input")
      expect(verbose.error.message).toContain("verbose must be a boolean")
    }
    const noRoot = npmDispatcher({ tsc: ["build"] }, { root: undefined })
    const rootOutcome = await dispatch(noRoot.dispatcher, "codemode.run_npm_script", { script: "build" })
    expect(rootOutcome.ok).toBe(false)
    if (!rootOutcome.ok) expect(rootOutcome.error.kind).toBe("root")
  })
})

function tempProjectWithoutPackageJson(): string {
  const dir = mkdtempSync(join(tmpdir(), "codemode-npm-unit-empty-"))
  tempDirs.push(dir)
  return dir
}
