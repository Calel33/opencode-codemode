// src/codemode/sandbox.ts
// The QuickJS guest sandbox for one execution. Extracted from the Task 2
// pipeline so the entry (execute-tools.ts) reads as: typecheck -> sandbox ->
// bounded result.
//
// Isolation is by construction: the guest context gets exactly the globals
// declared in globals.ts (print, the host-mediated file helpers, and the
// allowlisted cli surface — each a thin wrapper over the validated dispatcher
// bridge). QuickJS exposes no process,
// require, filesystem, environment, network, or subprocess surface unless the
// host injects one, and nothing here does.
//
// Bounds (preserved from the original package):
//   - 120000 ms default timeout: a setInterruptHandler deadline stops
//     synchronous loops, and a host-side timer race stops guests that never
//     settle an awaited promise;
//   - 64 MiB default heap (runtime.setMemoryLimit);
//   - AbortSignal cancellation: abort is observed at the pre-flight checks and
//     while the guest promise is pending, then rejected as "Execution cancelled".
import ts from "typescript"
import releaseSyncVariant from "@jitl/quickjs-singlefile-mjs-release-sync"
import { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } from "quickjs-emscripten-core"
import type { QuickJSContext, QuickJSHandle } from "quickjs-emscripten-core"
import { clearGuestGlobals, formatDump, installGuestGlobals } from "./globals.js"
import type { GuestMcpEnvironment } from "./globals.js"
import type { CliAllowlist } from "../config/policy.js"
import type { HostCall } from "./dispatch.js"

export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024

export interface SandboxOptions {
  /** Max guest execution time in ms (default 120000). */
  readonly timeoutMs?: number
  /** QuickJS heap limit in bytes (default 64 MiB). */
  readonly memoryLimitBytes?: number
  /** Host cancellation signal, propagated from the OpenCode ToolContext. */
  readonly signal?: AbortSignal
  /** Per-line sink for guest print(...) output (defaults to a no-op). */
  readonly onPrint?: (line: string) => void
  /** Async guest->host bridge for the file helpers (Task 5; see globals.ts). */
  readonly hostCall?: HostCall
  /** Effective CLI allowlist; narrows the guest `cli` surface (Task 6; see globals.ts). */
  readonly cli?: CliAllowlist
  /** Task 7 MCP surface: codemode.* discovery + mcp.<namespace>.<tool> (see globals.ts). */
  readonly mcp?: GuestMcpEnvironment
  /** Task 8 npm surface: the codemode plan/run helpers (see globals.ts). */
  readonly npm?: boolean
  /** Task 9 string constants: installed as the `π` guest global (see globals.ts). */
  readonly strings?: Readonly<Record<string, string>>
  /** Task 10 optional Jev surface: installs the `jev` guest global (see globals.ts). */
  readonly jev?: boolean
  /** Task 11 yolo shell escape hatch: installs the `shell.run` guest global (see globals.ts). */
  readonly shell?: boolean
}

export type SandboxErrorKind = "runtime" | "timeout" | "cancelled"

export interface SandboxError {
  readonly kind: SandboxErrorKind
  readonly message: string
}

export interface SandboxResult {
  /** The guest body's return value (undefined when it returned nothing or failed). */
  readonly value: unknown
  /** Present when the guest failed, timed out, or was cancelled. */
  readonly error?: SandboxError
}

type QuickJSModule = Awaited<ReturnType<typeof newQuickJSWASMModuleFromVariant>>

let quickJsPromise: Promise<QuickJSModule> | undefined

function getQuickJS(): Promise<QuickJSModule> {
  quickJsPromise ??= newQuickJSWASMModuleFromVariant(releaseSyncVariant)
  return quickJsPromise
}

export async function executeInSandbox(code: string, options: SandboxOptions = {}): Promise<SandboxResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES
  const onPrint = options.onPrint ?? ((): void => {})
  const signal = options.signal

  const cancelledError: SandboxError = { kind: "cancelled", message: "Execution cancelled" }
  if (signal?.aborted) return { value: undefined, error: cancelledError }

  let vm: QuickJSContext | undefined
  let promiseHandle: QuickJSHandle | undefined
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let abortHandler: (() => void) | undefined
  let closed = false
  let timedOut = false
  let cancelled = false
  const pendingHostCalls = new Set<() => void>()

  try {
    const QuickJS = await getQuickJS()
    vm = QuickJS.newContext()
    const runtime = vm.runtime
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs))
    runtime.setMemoryLimit(memoryLimitBytes)
    installGuestGlobals(vm, {
      log: onPrint,
      isClosed: () => closed,
      pendingHostCalls,
      hostCall: options.hostCall,
      cli: options.cli,
      mcp: options.mcp,
      npm: options.npm,
      strings: options.strings,
      jev: options.jev,
      shell: options.shell,
    })

    // Yield once so an abort that was already dispatched is observed before any
    // guest code runs.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (signal?.aborted) return { value: undefined, error: cancelledError }

    const js = ts.transpileModule(code, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText

    const evalResult = vm.evalCode(`(async function() {\n${js}\n})()`, "execute_tools.js")
    if (evalResult.error) {
      const dumped = formatDump(vm.dump(evalResult.error))
      evalResult.error.dispose()
      return { value: undefined, error: normalizeRuntimeError(dumped, timeoutMs, signal) }
    }

    promiseHandle = evalResult.value
    const pump = resolveGuestPromise(vm, promiseHandle, () => closed)
    const deadline = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true
        reject(new Error(`Execution timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })
    const cancellation = new Promise<never>((_, reject) => {
      abortHandler = () => {
        cancelled = true
        reject(new Error("Execution cancelled"))
      }
      signal?.addEventListener("abort", abortHandler, { once: true })
    })

    let settled: { error?: QuickJSHandle; value?: QuickJSHandle }
    try {
      settled = (await Promise.race([pump, deadline, cancellation])) as {
        error?: QuickJSHandle
        value?: QuickJSHandle
      }
    } catch (raceError) {
      // The guest promise was still pending when the deadline or the abort won.
      if (cancelled) return { value: undefined, error: cancelledError }
      if (timedOut) {
        return { value: undefined, error: { kind: "timeout", message: `Execution timed out after ${timeoutMs}ms` } }
      }
      return { value: undefined, error: { kind: "runtime", message: formatDump(raceError) } }
    }

    if (settled.error) {
      const dumped = formatDump(vm.dump(settled.error))
      settled.error.dispose()
      return { value: undefined, error: normalizeRuntimeError(dumped, timeoutMs, signal) }
    }
    const value = settled.value === undefined ? undefined : vm.dump(settled.value)
    settled.value?.dispose()
    return { value }
  } catch (error) {
    if (cancelled) return { value: undefined, error: cancelledError }
    return { value: undefined, error: { kind: "runtime", message: formatDump(error) } }
  } finally {
    closed = true
    for (const cancelPending of pendingHostCalls) {
      try {
        cancelPending()
      } catch {
        // pending host calls must not prevent guest VM cleanup
      }
    }
    pendingHostCalls.clear()
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    if (abortHandler) signal?.removeEventListener("abort", abortHandler)
    try {
      if (promiseHandle) promiseHandle.dispose()
    } catch {
      // cleanup must never mask the execution result
    }
    try {
      if (vm) {
        clearGuestGlobals(vm)
        vm.dispose()
      }
    } catch {
      // cleanup must never mask the execution result
    }
  }
}

/**
 * Pumps the QuickJS job queue until the guest promise settles (or the sandbox
 * closes — a timed-out/cancelled promise is abandoned, never awaited).
 */
async function resolveGuestPromise(
  vm: QuickJSContext,
  promiseHandle: QuickJSHandle,
  isClosed: () => boolean,
): Promise<{ error?: QuickJSHandle; value?: QuickJSHandle }> {
  const settled = vm.resolvePromise(promiseHandle)
  let done = false
  void settled.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  while (!done && !isClosed()) {
    try {
      vm.runtime.executePendingJobs()
    } catch {
      break
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return settled
}

function normalizeRuntimeError(message: string, timeoutMs: number, signal: AbortSignal | undefined): SandboxError {
  // QuickJS reports an interrupt as InternalError/"interrupted" (verified on
  // bun 1.4.3 and node 24.18.0 with 0.32.0); surface the deadline instead.
  if (/"name":"InternalError"/.test(message) && /"message":"interrupted"/.test(message)) {
    if (signal?.aborted) return { kind: "cancelled", message: "Execution cancelled" }
    return { kind: "timeout", message: `Execution timed out after ${timeoutMs}ms` }
  }
  return { kind: "runtime", message }
}
