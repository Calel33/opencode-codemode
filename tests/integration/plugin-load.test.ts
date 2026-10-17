// tests/integration/plugin-load.test.ts
// Task 1 acceptance: the plugin definition loads in a V2-shaped context and its
// returned cleanup runs without error; OpenCode 2.0.29 additionally loads the
// built package from a disposable project config (real host load).
//
// Fake-ctx harness pattern from the config workspace:
//   tests/enforcement.test.ts and
//   .opencode/playbooks/port-opencode-plugins-v1-to-v2/scripts/proof-harness/runtime.test.ts
import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import plugin from "../../src/index"

// Minimal V2-shaped context. Covers only the fields this entry touches:
// app, location, options, tool, command, permission, storage (see
// @opencode/plugin@2.0.19 dist/promise/plugin.d.ts; command/permission added
// in Task 4 when the entry began registering /codemode + mode enforcement).
function makeCtx() {
  return {
    app: { name: "opencode", version: "2.0.29", channel: "latest" },
    location: {
      directory: "C:/tmp/opencode-codemode-test",
      project: {
        id: "p1",
        directory: "C:/tmp/opencode-codemode-test",
        canonical: "C:/tmp/opencode-codemode-test",
      },
    },
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
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({}),
    },
  } as any
}

describe("opencode-codemode plugin entry (fake-ctx load)", () => {
  test("default export is a Plugin.define result with the stable id", () => {
    expect(plugin).toBeDefined()
    expect(plugin.id).toBe("opencode-codemode")
    expect(typeof plugin.setup).toBe("function")
  })

  test("setup resolves against a V2-shaped context", async () => {
    const cleanup = await plugin.setup(makeCtx())
    expect(cleanup === undefined || typeof cleanup === "function").toBe(true)
  })

  test("returned cleanup runs without throwing", async () => {
    const cleanup = await plugin.setup(makeCtx())
    expect(typeof cleanup).toBe("function")
    if (typeof cleanup === "function") await cleanup()
  })
})

// ---------------------------------------------------------------------------
// Real host load — verified working 2026-10-16 (opencode 2.0.29, Windows),
// cwd = disposable project:
//
//   $ opencode api --standalone --print-logs GET /api/config
//   ... msg="loading plugin" id="D:\Dev\opencode-codemode"
//       entrypoint=file:///D:/Dev/opencode-codemode/index.js
//
// The CLI boots a private server for the disposable location; a configured
// plugin directory resolves via index.ts || index.js at its root (the repo
// root index.js re-exports the built dist/index.js). No mock: this runs the
// real loader against the built package.
// ---------------------------------------------------------------------------
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

describe("opencode-codemode plugin load (real OpenCode host)", () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]+$/, "")
  const cli = Bun.which("opencode")
  const skipReason = !cli
    ? "opencode CLI not on PATH"
    : !existsSync(join(repoRoot, "dist", "index.js"))
      ? "dist/index.js missing (run `bun run build` first)"
      : process.env.OPENCODE_SKIP_HOST_LOAD
        ? "OPENCODE_SKIP_HOST_LOAD is set"
        : null
  const projectDir = skipReason ? null : mkdtempSync(join(tmpdir(), "opencode-codemode-load-"))

  afterAll(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true })
  })

  if (skipReason) {
    test.skip(`loads the local package without a load error (environment blocked: ${skipReason})`, () => {})
  } else {
    test(
      "opencode api --standalone loads the local package without a load error",
      () => {
        writeFileSync(
          join(projectDir!, "opencode.json"),
          JSON.stringify({ plugins: [pathToFileURL(repoRoot).href] }, null, 2),
          "utf8",
        )
        const result = spawnSync(cli!, ["api", "--standalone", "--print-logs", "GET", "/api/config"], {
          cwd: projectDir!,
          encoding: "utf8",
          timeout: 120_000,
        })
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
        // The loader log escapes backslashes (double), so collapse before matching.
        const normalized = output.replaceAll("\\\\", "\\")
        const loading = new RegExp(
          `msg="loading plugin"[\\s\\S]{0,400}?id="${escapeRegExp(repoRoot)}"[\\s\\S]{0,400}?entrypoint=${escapeRegExp(pathToFileURL(join(repoRoot, "index.js")).href)}`,
        )
        expect(result.status).toBe(0)
        expect(normalized).toMatch(loading)
        expect(normalized).not.toContain("PluginModule.LoadError")
      },
      130_000,
    )
  }
})

// ---------------------------------------------------------------------------
// Task 12: object-entry `{ package, options }` fresh-project cases.
//
// Deterministic facts verified 2026-10-16/17 against opencode 2.0.29 on
// Windows (raw captures in the Task 12 report):
//   - the loader accepts the documented object entry
//     (opencode.ai/v2/docs/plugins; @opencode/schema config/plugin.d.ts:
//     Plugins = Array<string | { package, options }>) and logs the resolved
//     entrypoint for this repo;
//   - GET /api/config echoes the applied config documents, so the configured
//     options are visible in the response;
//   - plugin `setup()` execution is DEFERRED beyond this flow: a throwaway
//     probe plugin's setup side-effect file was never written and its console
//     output never appeared in `--print-logs`, so the setup-time policy log
//     line cannot be asserted from a config-only boot. Session-driven checks
//     require an authenticated model call and stay environment-blocked (see
//     the Task 12 report).
// ---------------------------------------------------------------------------
describe("opencode-codemode object-entry load (real OpenCode host, Task 12)", () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]+$/, "")
  const cli = Bun.which("opencode")
  const skipReason = !cli
    ? "opencode CLI not on PATH"
    : !existsSync(join(repoRoot, "dist", "index.js"))
      ? "dist/index.js missing (run `bun run build` first)"
      : process.env.OPENCODE_SKIP_HOST_LOAD
        ? "OPENCODE_SKIP_HOST_LOAD is set"
        : null
  const projectDir = skipReason ? null : mkdtempSync(join(tmpdir(), "opencode-codemode-options-"))

  afterAll(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true })
  })

  if (skipReason) {
    test.skip(`object entry with options loads without a load error (environment blocked: ${skipReason})`, () => {})
  } else {
    const runHost = (options: Record<string, unknown>) => {
      writeFileSync(
        join(projectDir!, "opencode.json"),
        JSON.stringify({ plugins: [{ package: pathToFileURL(repoRoot).href, options }] }, null, 2),
        "utf8",
      )
      const result = spawnSync(cli!, ["api", "--standalone", "--print-logs", "GET", "/api/config"], {
        cwd: projectDir!,
        encoding: "utf8",
        timeout: 120_000,
      })
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      return { status: result.status, normalized: output.replaceAll("\\\\", "\\") }
    }
    const loading = new RegExp(
      `msg="loading plugin"[\\s\\S]{0,400}?id="${escapeRegExp(repoRoot)}"[\\s\\S]{0,400}?entrypoint=${escapeRegExp(pathToFileURL(join(repoRoot, "index.js")).href)}`,
    )

    test(
      "a fresh project using the object entry with options { mode: 'off' } loads and the config echo carries the options",
      () => {
        const { status, normalized } = runHost({ mode: "off" })
        expect(status).toBe(0)
        expect(normalized).toMatch(loading)
        expect(normalized).not.toContain("PluginModule.LoadError")
        expect(normalized).toContain('"options":{"mode":"off"}')
      },
      130_000,
    )

    test(
      "a project overlay inside options ({ mode: 'on', project: { mode: 'off' } }) loads through a real host boot",
      () => {
        const { status, normalized } = runHost({ mode: "on", project: { mode: "off" } })
        expect(status).toBe(0)
        expect(normalized).toMatch(loading)
        expect(normalized).not.toContain("PluginModule.LoadError")
        expect(normalized).toContain('"options":{"mode":"on","project":{"mode":"off"}}')
      },
      130_000,
    )
  }
})
