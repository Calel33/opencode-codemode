// scripts/quickjs-smoke.mjs — GATE 2 evidence harness (throwaway, not part of
// the package): tests the QuickJS candidate runtime on bun AND node before the
// runtime choice is recorded. Mirrors the original @boozedog/pi-codemode stack:
//   quickjs-emscripten-core + @jitl/quickjs-singlefile-mjs-release-sync
// Checks: newContext, setMemoryLimit (64 MiB), setInterruptHandler
// (shouldInterruptAfterDeadline), TS transpile via ts.transpileModule
// (ES2022/ESNext) wrapped as (async function(){...})(), print capture, dispose,
// cold/warm timing, ambient-global absence.
import ts from "typescript"
import releaseSyncVariant from "@jitl/quickjs-singlefile-mjs-release-sync"
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from "quickjs-emscripten-core"

const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`
const ev = (label, value) => console.log(`SMOKE [${runtime}] ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`)

const t0 = Date.now()
const QuickJS = await newQuickJSWASMModuleFromVariant(releaseSyncVariant)
ev("module_ready_ms (cold)", Date.now() - t0)

function formatDump(value) {
  if (value instanceof Error) return value.stack || value.message
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

async function run(code, timeoutMs) {
  const vm = QuickJS.newContext()
  const guestRuntime = vm.runtime
  guestRuntime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs))
  guestRuntime.setMemoryLimit(64 * 1024 * 1024)
  const logs = []
  const print = vm.newFunction("print", (...args) => {
    logs.push(args.map((arg) => formatDump(vm.dump(arg))).join(" "))
  })
  vm.setProp(vm.global, "print", print)
  print.dispose()

  const js = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText

  const start = Date.now()
  let out
  try {
    const evalResult = vm.evalCode(`(async function() {\n${js}\n})()`, "smoke.js")
    if (evalResult.error) {
      out = { error: formatDump(vm.dump(evalResult.error)) }
      evalResult.error.dispose()
    } else {
      const promiseHandle = evalResult.value
      const resolving = vm.resolvePromise(promiseHandle)
      let done = false
      void resolving.finally(() => {
        done = true
      })
      while (!done) {
        await guestRuntime.executePendingJobs()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      const settled = await resolving
      promiseHandle.dispose()
      if (settled.error) {
        out = { error: formatDump(vm.dump(settled.error)) }
        settled.error.dispose()
      } else {
        out = { value: vm.dump(settled.value) }
        settled.value.dispose()
      }
    }
  } catch (error) {
    out = { hostError: formatDump(error) }
  } finally {
    vm.dispose()
  }
  return { ...out, logs, elapsedMs: Date.now() - start }
}

// warm context: typed TS body, print + return value
const r0 = await run(`print("warm", 1 + 1); return "ok"`, 5000)
ev("run0_warm", r0)

const r1 = await run(
  `const n: number = 40 + 2
   const inc: (x: number) => number = (x) => x + 1
   print("typed", n, inc(n))
   return { n, doubled: n * 2 }`,
  5000,
)
ev("run1_typed", r1)

// ambient globals check
const r2 = await run(
  `print(typeof process, typeof require, typeof fetch, typeof globalThis.process, typeof Deno)`,
  5000,
)
ev("run2_ambient", r2)

// deadline interrupt: shouldInterruptAfterDeadline
const r3 = await run(`while (true) {}`, 300)
ev("run3_timeout", r3)

// memory limit: allocate far beyond 64 MiB
const r4 = await run(`const big = "x".repeat(256 * 1024 * 1024); return big.length`, 5000)
ev("run4_memory", r4)

ev("done", "true")
