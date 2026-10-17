// tests/unit/execute-tools.test.ts
// Task 3 acceptance: typed execution and isolated guest evaluation.
// - A type error is returned BEFORE guest execution and before any host side
//   effect (the guest's print sink is the observable side effect here).
// - The guest has no ambient process, require, module, filesystem, environment,
//   network, or subprocess access (denied by construction: only `print` is
//   installed, and bare ambient names are rejected by the typechecker).
// - The timeout (default 120000 ms, overridable) is enforced for both sync
//   loops and never-settling promises; AbortSignal cancellation is propagated.
// - Results and thrown errors are bounded and structured.
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { MAX_OUTPUT_BYTES, executeTools, formatExecuteToolsResult } from "../../src/codemode/execute-tools"
import { resolveTypeScriptLibDir, typeCheck } from "../../src/codemode/typecheck"
import { GUEST_GLOBALS, buildTypeDefs } from "../../src/codemode/globals"

const byteLength = (value: string) => new TextEncoder().encode(value).length

describe("typecheck before effects", () => {
  test("a type error is returned before guest execution and before any host side effect", async () => {
    const result = await executeTools(`print("SIDE-EFFECT-RAN")\nconst n: number = "not a number"`)
    expect(result.errorKind).toBe("type")
    expect(result.logs).toEqual([])
    expect(result.result).toBeUndefined()
    const text = formatExecuteToolsResult(result)
    expect(text).toContain("Type errors (code was NOT executed)")
    expect(text).toContain("Line 2")
    expect(text).not.toContain("SIDE-EFFECT-RAN")
  }, 15_000)

  test("diagnostics are structured as file/line/col/message", async () => {
    const result = await executeTools(`const n: number = "no"`)
    expect(result.errorKind).toBe("type")
    expect(result.diagnostics?.length).toBe(1)
    const diagnostic = result.diagnostics![0]!
    expect(diagnostic.file).toBe("execute_tools.ts")
    expect(diagnostic.line).toBe(1)
    expect(diagnostic.col).toBeGreaterThan(0)
    expect(diagnostic.message).toContain("not assignable")
  }, 15_000)

  test("bare ambient host names are type-rejected before execution", async () => {
    const attempts = [
      "process.exit(0)",
      "require('fs')",
      "module.exports",
      "window.location",
      "fetch('https://example.com')",
      "new XMLHttpRequest()",
      "Bun.version",
      "Deno.exit(0)",
    ]
    for (const attempt of attempts) {
      const result = await executeTools(attempt)
      expect(result.errorKind).toBe("type")
      expect(result.logs).toEqual([])
    }
  }, 30_000)

  test("valid typed guest code still passes the typechecker", async () => {
    const result = await executeTools(
      `const n: number = 41\nconst inc: (x: number) => number = (x) => x + 1\nprint("typed", n)\nreturn inc(n)`,
    )
    expect(result.errorKind).toBeUndefined()
    expect(result.logs).toEqual(["typed 41"])
    expect(result.result).toBe(42)
  }, 15_000)
})

describe("typecheck mechanics", () => {
  test("resolves the installed typescript lib dir with lib.es2022.d.ts present", () => {
    const dir = resolveTypeScriptLibDir()
    expect(dir).toContain("typescript")
    expect(existsSync(join(dir, "lib.es2022.d.ts"))).toBe(true)
  })

  test("valid code produces no diagnostics and reported lines map back to user code", () => {
    expect(typeCheck(`const n: number = 1\nprint(n)`).diagnostics).toEqual([])
    const offByWrapper = typeCheck(`\n\nconst n: number = "no"`)
    expect(offByWrapper.diagnostics[0]?.line).toBe(3)
  })

  test("the guest global declarations are generated from the same registry as the runtime", () => {
    expect(GUEST_GLOBALS.map((global) => global.name)).toEqual(["print", "read", "write", "edit", "π"])
    expect(buildTypeDefs()).toContain("declare function print")
    expect(buildTypeDefs()).toContain("declare function read")
    expect(buildTypeDefs()).toContain("declare function edit")
  })
})

describe("guest isolation (adversarial ambient access)", () => {
  test("no ambient process/require/module/globalThis.process/window/fetch/XMLHttpRequest/Bun/Deno", async () => {
    const result = await executeTools(`
      const g = globalThis as any
      return {
        process: typeof g.process,
        require: typeof g.require,
        module: typeof g.module,
        globalThisProcess: typeof g.globalThis.process,
        window: typeof g.window,
        fetch: typeof g.fetch,
        xmlHttpRequest: typeof g.XMLHttpRequest,
        bun: typeof g.Bun,
        deno: typeof g.Deno,
      }
    `)
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toEqual({
      process: "undefined",
      require: "undefined",
      module: "undefined",
      globalThisProcess: "undefined",
      window: "undefined",
      fetch: "undefined",
      xmlHttpRequest: "undefined",
      bun: "undefined",
      deno: "undefined",
    })
  }, 15_000)

  test("Function-constructor escape still surfaces no host globals", async () => {
    const result = await executeTools(`
      const g = Function("return this")() as any
      print(typeof g.process, typeof g.require, typeof g.fetch)
    `)
    expect(result.errorKind).toBeUndefined()
    expect(result.logs).toEqual(["undefined undefined undefined"])
  }, 15_000)

  test("typeof bare ambient names is rejected by the typechecker (not silently undefined)", async () => {
    const result = await executeTools(`print(typeof process)`)
    expect(result.errorKind).toBe("type")
    expect(result.diagnostics?.[0]?.message).toContain("Cannot find name 'process'")
  }, 15_000)
})

describe("timeout and cancellation", () => {
  test("a synchronous infinite loop is interrupted at the deadline", async () => {
    const result = await executeTools(`while (true) {}`, { timeoutMs: 300 })
    expect(result.errorKind).toBe("runtime")
    expect(result.error ?? "").toMatch(/timed out after 300ms/i)
  }, 15_000)

  test("an async hang on a never-settling promise times out", async () => {
    const result = await executeTools(`await new Promise(() => {})`, { timeoutMs: 400 })
    expect(result.errorKind).toBe("runtime")
    expect(result.error ?? "").toMatch(/timed out after 400ms/i)
  }, 15_000)

  test("a pre-aborted signal cancels before guest execution", async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await executeTools(`print("never")`, { signal: controller.signal })
    expect(result.errorKind).toBe("runtime")
    expect(result.error).toBe("Execution cancelled")
    expect(result.logs).toEqual([])
  }, 15_000)

  test("an abort during an async wait cancels promptly with a structured error", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const started = Date.now()
    const result = await executeTools(`await new Promise(() => {})`, {
      signal: controller.signal,
      timeoutMs: 60_000,
    })
    expect(result.errorKind).toBe("runtime")
    expect(result.error).toBe("Execution cancelled")
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 15_000)

  test("the QuickJS memory limit stops runaway allocation", async () => {
    const result = await executeTools(
      `const chunks: string[] = []; while (true) { chunks.push("x".repeat(100_000)) }`,
      { timeoutMs: 30_000 },
    )
    expect(result.errorKind).toBe("runtime")
    expect(result.error ?? "").toMatch(/out of memory/i)
  }, 30_000)
})

describe("Promise concurrency", () => {
  test("Promise.all of awaited jobs resolves with every value and ordered prints", async () => {
    const result = await executeTools(`
      const jobs = [1, 2, 3].map(async (n) => { print("job", n); return n * 2 })
      return await Promise.all(jobs)
    `)
    expect(result.errorKind).toBeUndefined()
    expect(result.logs).toEqual(["job 1", "job 2", "job 3"])
    expect(result.result).toEqual([2, 4, 6])
  }, 15_000)

  test("awaited values chain across microtasks", async () => {
    const result = await executeTools(`
      const step = async (n: number): Promise<number> => n + 1
      const a = await step(1)
      const b = await step(a)
      print("done", a, b)
      return b
    `)
    expect(result.errorKind).toBeUndefined()
    expect(result.logs).toEqual(["done 2 3"])
    expect(result.result).toBe(3)
  }, 15_000)
})

describe("structured, bounded results and errors", () => {
  test("thrown guest errors are structured data with earlier logs preserved", async () => {
    const result = await executeTools(`print("before"); throw new Error("boom")`)
    expect(result.errorKind).toBe("runtime")
    expect(result.error).toContain("boom")
    expect(result.logs).toEqual(["before"])
    expect(result.truncated).toBe(false)
    expect(formatExecuteToolsResult(result)).toContain("Runtime error:")
  }, 15_000)

  test("thrown non-Error values are structured, not crashes", async () => {
    const result = await executeTools(`throw "just a string"`)
    expect(result.errorKind).toBe("runtime")
    expect(result.error).toContain("just a string")
  }, 15_000)

  test("a huge thrown error is bounded", async () => {
    const result = await executeTools(`throw new Error("x".repeat(200 * 1024))`)
    expect(result.errorKind).toBe("runtime")
    expect(byteLength(result.error ?? "")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 100)
    expect(result.truncated).toBe(true)
  }, 15_000)

  test("print output is bounded at the output cap with an explicit marker", async () => {
    const result = await executeTools(`print("x".repeat(200 * 1024))`)
    expect(result.errorKind).toBeUndefined()
    expect(result.truncated).toBe(true)
    expect(byteLength(result.logs.join("\n"))).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 100)
    expect(result.logs.join("\n")).toContain("truncated")
  }, 15_000)

  test("an oversized returned value is bounded", async () => {
    const result = await executeTools(`return "y".repeat(200 * 1024)`)
    expect(result.errorKind).toBeUndefined()
    expect(result.truncated).toBe(true)
    expect(typeof result.result).toBe("string")
    expect(result.result as string).toContain("truncated")
    expect((result.result as string).length).toBeLessThan(200 * 1024)
  }, 15_000)
})
