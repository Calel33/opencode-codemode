// src/capabilities/cli.ts
// Host-side CLI capability adapters behind the dispatcher (guest
// `cli.<tool>.<operation>` surface). Ported behaviorally from the original
// package's cli.ts/cli-operations.ts (research §2.9), adapted to this
// codebase's dispatcher pattern:
//   - the built-in catalog declares a fixed set of typed operations; each
//     operation validates its typed input and builds an ARGV ARRAY. Arguments
//     are never concatenated into shell text and spawn runs with shell:false,
//     so a payload like "; rm -rf" is inert literal data;
//   - the effective allowlist (policy.cli) gates reachability at dispatch
//     time: a declared-but-not-allowlisted call is a bounded "mode" denial,
//     and a tool/operation outside the declared catalog is unknown-capability
//     (no arbitrary command can be expressed);
//   - spawn env is the hostCommandEnv allowlist (security/allowlist.ts); cwd
//     is the canonical active root and an unknown root fails closed (or the
//     signal is already aborted → "cancelled");
//   - each stream is capped at 50 KiB with Pi's explicit marker and per-stream
//     truncation metadata; a NONZERO EXIT IS DATA
//     (stdout/stderr/exitCode/truncated), never a thrown error;
//   - the CLI op timeout defaults to 30_000 ms (research §2.9: "Default op
//     timeout 30_000 ms, overridable"). RECONCILED DEVIATION: the todo's
//     "timeout defaults to 120000 ms" is the EXECUTOR timeout
//     (sandbox.ts DEFAULT_TIMEOUT_MS, unchanged); the per-operation CLI
//     timeout is 30 s per the original package and the orchestrator
//     instruction.
// Port deviations (recorded for review):
//   - the `gh` tool group (17 ops incl. the bespoke blocked-by REST flow) is
//     deferred from this slice; hostCommandEnv already carries its token
//     surface, so a later slice can add adapters without touching the
//     executor;
//   - argument validation is hand-rolled per operation (no Ajv dependency);
//   - `find.files`, `grep.search` and `ls.list` are host-implemented IN-PROCESS
//     (capabilities/enumerate.ts): they never consult PATH and never spawn.
//     Windows ships no usable `grep`, no `ls` binary (PowerShell alias only),
//     and an unrelated `find.exe` (Find String Utility), so spawning was wrong
//     there; one Node-fs implementation stays OS-independent. The catalog
//     entries below remain the single source of truth for the allowlist,
//     validation, and the guest surface — only these three skip the
//     argv/spawn path.
// Logging: nothing here logs; results carry only stdout/stderr the spawned
// tool itself produced.
import { spawn } from "node:child_process"
import { dispatchError } from "../codemode/dispatch.js"
import type { DispatchCapability, DispatchEnvironment, DispatchOutcome } from "../codemode/dispatch.js"
import type { CliAllowlist } from "../config/policy.js"
import { cliAllowlistAllows, hostCommandEnv } from "../security/allowlist.js"
import { isEnumeratedOperation, runEnumeratedOperation } from "./enumerate.js"

/** Per-stream output cap: preserved from the original package (50 KiB). */
export const MAX_CLI_STREAM_BYTES = 50 * 1024
/** Default per-operation CLI timeout: preserved from the original package (30 s). */
export const DEFAULT_CLI_TIMEOUT_MS = 30_000

interface CliParamSpec {
  readonly type: "boolean" | "string" | "integer" | "string[]"
  readonly enum?: readonly string[]
}

interface CliOperationDefinition {
  readonly description: string
  readonly params: Readonly<Record<string, CliParamSpec>>
  readonly required: readonly string[]
  /** Builds the argv array from VALIDATED args (defensive re-checks included). */
  readonly toArgv: (args: Record<string, unknown>) => string[]
}

interface CliToolDefinition {
  /** Spawned executable; absent for host-implemented (in-process) operations. */
  readonly executable?: string
  readonly operations: Readonly<Record<string, CliOperationDefinition>>
}

const b = (): CliParamSpec => ({ type: "boolean" })
const s = (values?: readonly string[]): CliParamSpec =>
  values === undefined ? { type: "string" } : { type: "string", enum: values }
const i = (): CliParamSpec => ({ type: "integer" })
const sa = (): CliParamSpec => ({ type: "string[]" })

// ---------------------------------------------------------------------------
// argv builders (values arrive typed; operand guards cover positionals)
// ---------------------------------------------------------------------------

function flag(value: unknown, name: string): string[] {
  return value === true ? [name] : []
}

function intFlag(value: unknown, name: string): string[] {
  return value === undefined ? [] : [name, String(value)]
}

function stringEqualsFlag(value: unknown, name: string): string[] {
  return value === undefined ? [] : [`${name}=${value}`]
}

/** Operand safety: positionals must not be empty or parse as flags. */
function operand(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("-")) {
    throw new Error(`${key} must not be empty or start with '-'`)
  }
  return value
}

function optionalOperand(value: unknown, key: string): string[] {
  return value === undefined ? [] : [operand(value, key)]
}

function positionals(values: ReadonlyArray<[unknown, string]>): string[] {
  const operands = values.flatMap(([value, key]) => optionalOperand(value, key))
  return operands.length === 0 ? [] : ["--", ...operands]
}

function pathspec(value: unknown): string[] {
  if (value === undefined) return []
  const paths = (value as string[]).map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.startsWith("-")) {
      // Pi parity (cli-operations.ts safeOperandArray message).
      throw new Error("paths must not contain empty operands or operands starting with '-'")
    }
    return entry
  })
  return paths.length === 0 ? [] : ["--", ...paths]
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`)
  return value
}

/** Non-empty string guard for flag payloads (Pi parity: `--glob=` values). */
function nonEmptyString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must not be empty`)
  return value
}

// ---------------------------------------------------------------------------
// The declared catalog (built-in typed adapters; Pi's documented op set minus
// the deferred gh group — see the header). The catalog is the SINGLE SOURCE
// OF TRUTH for capability registration, the guest surface, and its
// typechecker declaration.
// ---------------------------------------------------------------------------

export const CLI_TOOLS: Readonly<Record<string, CliToolDefinition>> = {
  git: {
    executable: "git",
    operations: {
      status: {
        description: "Show working tree status.",
        params: { short: b(), branch: b() },
        required: [],
        toArgv: (args) => ["status", ...flag(args.short, "--short"), ...flag(args.branch, "--branch")],
      },
      branch: {
        description: "List branches or show the current branch.",
        params: { showCurrent: b() },
        required: [],
        toArgv: (args) => ["branch", ...flag(args.showCurrent, "--show-current")],
      },
      diff: {
        description: "Show changes in the working tree or index.",
        params: { staged: b(), stat: b(), nameOnly: b(), ref: s(), paths: sa() },
        required: [],
        toArgv: (args) => [
          "diff",
          ...flag(args.staged, "--cached"),
          ...flag(args.stat, "--stat"),
          ...flag(args.nameOnly, "--name-only"),
          ...optionalOperand(args.ref, "ref"),
          ...pathspec(args.paths),
        ],
      },
      log: {
        description: "Show commit history.",
        params: { limit: i(), oneline: b(), stat: b(), paths: sa() },
        required: [],
        toArgv: (args) => [
          "log",
          ...intFlag(args.limit, "--max-count"),
          ...flag(args.oneline, "--oneline"),
          ...flag(args.stat, "--stat"),
          ...pathspec(args.paths),
        ],
      },
      show: {
        description: "Show an object such as a commit.",
        params: { ref: s(), stat: b(), nameOnly: b() },
        required: [],
        toArgv: (args) => [
          "show",
          ...flag(args.stat, "--stat"),
          ...flag(args.nameOnly, "--name-only"),
          ...optionalOperand(args.ref, "ref"),
        ],
      },
      remote: {
        description: "List configured remotes.",
        params: { verbose: b() },
        required: [],
        toArgv: (args) => ["remote", ...flag(args.verbose, "-v")],
      },
      revParse: {
        description: "Resolve revisions and repository paths.",
        params: { ref: s(), showTopLevel: b(), isInsideWorkTree: b() },
        required: [],
        toArgv: (args) => [
          "rev-parse",
          ...flag(args.showTopLevel, "--show-toplevel"),
          ...flag(args.isInsideWorkTree, "--is-inside-work-tree"),
          ...optionalOperand(args.ref, "ref"),
        ],
      },
      add: {
        description: "Stage file contents for the next commit.",
        params: { paths: sa(), all: b(), patch: b() },
        required: [],
        toArgv: (args) => ["add", ...flag(args.all, "--all"), ...flag(args.patch, "--patch"), ...pathspec(args.paths)],
      },
      commit: {
        description: "Record staged changes in the repository.",
        params: { message: s(), all: b(), amend: b() },
        required: ["message"],
        toArgv: (args) => [
          "commit",
          ...flag(args.all, "--all"),
          ...flag(args.amend, "--amend"),
          `--message=${requiredString(args.message, "message")}`,
        ],
      },
      push: {
        description: "Update remote refs using local refs.",
        params: { remote: s(), branch: s(), setUpstream: b(), tags: b() },
        required: [],
        toArgv: (args) => [
          "push",
          ...flag(args.setUpstream, "--set-upstream"),
          ...flag(args.tags, "--tags"),
          ...positionals([
            [args.remote, "remote"],
            [args.branch, "branch"],
          ]),
        ],
      },
      pull: {
        description: "Fetch from and integrate with another repository or branch.",
        params: { remote: s(), branch: s(), rebase: b(), ffOnly: b() },
        required: [],
        toArgv: (args) => [
          "pull",
          ...flag(args.rebase, "--rebase"),
          ...flag(args.ffOnly, "--ff-only"),
          ...positionals([
            [args.remote, "remote"],
            [args.branch, "branch"],
          ]),
        ],
      },
      switch: {
        description: "Switch branches.",
        params: { branch: s(), create: b(), detach: b() },
        required: ["branch"],
        toArgv: (args) => {
          const branch = operand(args.branch, "branch")
          return [
            "switch",
            ...(args.create === true ? [`--create=${branch}`] : []),
            ...flag(args.detach, "--detach"),
            ...(args.create === true ? [] : ["--", branch]),
          ]
        },
      },
      checkout: {
        description: "Switch branches or restore working tree paths.",
        params: { branch: s(), paths: sa() },
        required: [],
        toArgv: (args) => ["checkout", ...optionalOperand(args.branch, "branch"), ...pathspec(args.paths)],
      },
      restore: {
        description: "Restore working tree files.",
        params: { paths: sa(), staged: b(), source: s() },
        required: [],
        toArgv: (args) => [
          "restore",
          ...flag(args.staged, "--staged"),
          ...stringEqualsFlag(args.source, "--source"),
          ...pathspec(args.paths),
        ],
      },
      reset: {
        description: "Reset current HEAD to a state.",
        params: { mode: s(["soft", "mixed", "hard"]), ref: s(), paths: sa() },
        required: [],
        toArgv: (args) => [
          "reset",
          ...(args.mode === undefined ? [] : [`--${String(args.mode)}`]),
          ...optionalOperand(args.ref, "ref"),
          ...pathspec(args.paths),
        ],
      },
      stash: {
        description: "Stash, list, apply, pop, drop, or clear working tree changes.",
        params: {
          command: s(["push", "pop", "apply", "list", "drop", "clear"]),
          message: s(),
          stash: s(),
          includeUntracked: b(),
        },
        required: [],
        toArgv: (args) => [
          "stash",
          ...(args.command === undefined ? [] : [String(args.command)]),
          ...flag(args.includeUntracked, "--include-untracked"),
          ...stringEqualsFlag(args.message, "--message"),
          ...optionalOperand(args.stash, "stash"),
        ],
      },
      tag: {
        description: "Create, list, delete, or verify tags.",
        params: { name: s(), message: s(), delete: b(), list: b() },
        required: [],
        toArgv: (args) => [
          "tag",
          ...flag(args.delete, "--delete"),
          ...flag(args.list, "--list"),
          ...(args.message === undefined ? [] : ["-a"]),
          ...stringEqualsFlag(args.message, "--message"),
          ...positionals([[args.name, "name"]]),
        ],
      },
    },
  },
  rg: {
    executable: "rg",
    operations: {
      search: {
        description: "Search file contents by pattern using ripgrep.",
        params: {
          pattern: s(),
          paths: sa(),
          glob: sa(),
          ignoreCase: b(),
          lineNumber: b(),
          hidden: b(),
          maxCount: i(),
        },
        required: ["pattern"],
        toArgv: (args) => [
          ...flag(args.ignoreCase, "--ignore-case"),
          ...flag(args.lineNumber, "--line-number"),
          ...flag(args.hidden, "--hidden"),
          ...intFlag(args.maxCount, "--max-count"),
          ...(args.glob === undefined
            ? []
            : (args.glob as string[]).map((entry) => `--glob=${nonEmptyString(entry, "glob")}`)),
          "-e",
          requiredString(args.pattern, "pattern"),
          ...pathspec(args.paths),
        ],
      },
    },
  },
  find: {
    // Host-implemented in-process (enumerate.ts): no PATH lookup, no spawn —
    // Windows `find.exe` is an unrelated string-search utility.
    operations: {
      files: {
        description: "Search for files by path, name, max depth, or type.",
        params: { path: s(), name: s(), maxDepth: i(), type: s(["file", "directory"]) },
        required: [],
        toArgv: (args) => [
          "--",
          args.path === undefined ? "." : operand(args.path, "path"),
          ...intFlag(args.maxDepth, "-maxdepth"),
          ...(args.name === undefined ? [] : ["-name", operand(args.name, "name")]),
          ...(args.type === "file" ? ["-type", "f"] : args.type === "directory" ? ["-type", "d"] : []),
        ],
      },
    },
  },
  grep: {
    // Host-implemented in-process (enumerate.ts): stock Windows has no `grep`.
    operations: {
      search: {
        description: "Search file contents by pattern using grep.",
        params: { pattern: s(), paths: sa(), recursive: b(), ignoreCase: b() },
        required: ["pattern"],
        toArgv: (args) => [
          ...flag(args.recursive, "-R"),
          ...flag(args.ignoreCase, "-i"),
          "-e",
          requiredString(args.pattern, "pattern"),
          ...pathspec(args.paths),
        ],
      },
    },
  },
  ls: {
    // Host-implemented in-process (enumerate.ts): `ls` is a PowerShell alias
    // on Windows (not a binary), so a spawn resolves to nothing.
    operations: {
      list: {
        description: "List directory contents.",
        params: { path: s(), all: b(), long: b() },
        required: [],
        toArgv: (args) => [
          ...flag(args.all, "-a"),
          ...flag(args.long, "-l"),
          ...(args.path === undefined ? [] : ["--", operand(args.path, "path")]),
        ],
      },
    },
  },
  vitest: {
    executable: "vitest",
    operations: {
      run: {
        description: "Run Vitest tests once, optionally updating snapshots.",
        params: { paths: sa(), update: b(), reporter: s(["default", "verbose", "dot", "json", "junit"]) },
        required: [],
        toArgv: (args) => [
          "run",
          ...flag(args.update, "--update"),
          ...(args.reporter === undefined ? [] : [`--reporter=${String(args.reporter)}`]),
          ...pathspec(args.paths),
        ],
      },
    },
  },
  tsc: {
    executable: "tsc",
    operations: {
      build: {
        description: "Compile the project with TypeScript.",
        params: { watch: b() },
        required: [],
        toArgv: (args) => flag(args.watch, "--watch"),
      },
    },
  },
  oxfmt: {
    executable: "oxfmt",
    operations: {
      check: {
        description: "Check formatting with oxfmt without writing changes.",
        params: { paths: sa() },
        required: [],
        toArgv: (args) => ["--check", ...pathspec(args.paths)],
      },
      write: {
        description: "Format files in place with oxfmt.",
        params: { paths: sa() },
        required: [],
        toArgv: (args) => ["--write", ...pathspec(args.paths)],
      },
    },
  },
  oxlint: {
    executable: "oxlint",
    operations: {
      run: {
        description: "Run oxlint checks.",
        params: { deny: s(["warnings"]), vitestPlugin: b(), paths: sa() },
        required: [],
        toArgv: (args) => [
          ...stringEqualsFlag(args.deny, "--deny"),
          ...flag(args.vitestPlugin, "--vitest-plugin"),
          ...pathspec(args.paths),
        ],
      },
    },
  },
}

export interface CliSurfaceEntry {
  readonly tool: string
  readonly operation: string
}

/**
 * The reachable guest surface: allowlist ∩ declared catalog, in allowlist
 * order, deduplicated. Allowlisted names without a declared adapter are
 * unreachable (no capability exists for them) and are skipped here too, so
 * the guest surface never advertises a call that cannot execute.
 */
export function cliSurface(allowlist: CliAllowlist | undefined): readonly CliSurfaceEntry[] {
  if (allowlist === undefined || allowlist === null || typeof allowlist !== "object") return []
  const surface: CliSurfaceEntry[] = []
  const seen = new Set<string>()
  for (const [tool, operations] of Object.entries(allowlist)) {
    const toolDef = CLI_TOOLS[tool] as CliToolDefinition | undefined
    if (toolDef === undefined || !Array.isArray(operations)) continue
    for (const operation of operations) {
      if (typeof operation !== "string") continue
      if ((toolDef.operations as Record<string, CliOperationDefinition | undefined>)[operation] === undefined) continue
      const name = `${tool}.${operation}`
      if (seen.has(name)) continue
      seen.add(name)
      surface.push({ tool, operation })
    }
  }
  return surface
}

export interface CliInvocation {
  readonly executable: string
  readonly argv: readonly string[]
}

/** Declared-operation lookup shared by the spawn plan and the in-process branch. */
function resolveDeclaredOperation(
  tool: string,
  operation: string,
): { readonly ok: true; readonly operationDef: CliOperationDefinition; readonly executable: string | undefined } | { readonly ok: false; readonly message: string } {
  const toolDef = CLI_TOOLS[tool] as CliToolDefinition | undefined
  if (toolDef === undefined) return { ok: false, message: `Unknown CLI tool: ${tool}` }
  const operationDef = (toolDef.operations as Record<string, CliOperationDefinition | undefined>)[operation]
  if (operationDef === undefined) return { ok: false, message: `Unknown CLI operation: cli.${tool}.${operation}` }
  return { ok: true, operationDef, executable: toolDef.executable }
}

/** Typed-arg validation for a declared operation, without building an argv. */
function validateDeclaredArgs(
  tool: string,
  operation: string,
  args: unknown,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly message: string } {
  const resolved = resolveDeclaredOperation(tool, operation)
  if (!resolved.ok) return resolved
  return validateCliArgs(resolved.operationDef, args)
}

/** Validated plan for one declared operation: executable + literal argv array. */
export function buildCliInvocation(
  tool: string,
  operation: string,
  args: unknown,
): { readonly ok: true; readonly invocation: CliInvocation } | { readonly ok: false; readonly message: string } {
  const resolved = resolveDeclaredOperation(tool, operation)
  if (!resolved.ok) return resolved
  const validated = validateCliArgs(resolved.operationDef, args)
  if (!validated.ok) return validated
  const executable = resolved.executable
  if (executable === undefined) {
    return { ok: false, message: `cli.${tool}.${operation} is host-implemented in-process and has no spawned executable` }
  }
  try {
    return { ok: true, invocation: { executable, argv: resolved.operationDef.toArgv(validated.value) } }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

function validateCliArgs(
  definition: CliOperationDefinition,
  args: unknown,
): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly message: string } {
  const candidate = args === undefined || args === null ? {} : args
  if (typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, message: "CLI args must be an object" }
  }
  const provided = candidate as Record<string, unknown>
  for (const key of Object.keys(provided)) {
    if (!(key in definition.params)) return { ok: false, message: `Unknown CLI argument: ${key}` }
  }
  for (const key of definition.required) {
    const value = provided[key]
    if (value === undefined || value === "") return { ok: false, message: `${key} is required` }
  }
  for (const [key, spec] of Object.entries(definition.params)) {
    const value = provided[key]
    if (value === undefined) continue
    const problem = checkParam(key, spec, value)
    if (problem !== undefined) return { ok: false, message: problem }
  }
  return { ok: true, value: provided }
}

function checkParam(key: string, spec: CliParamSpec, value: unknown): string | undefined {
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" ? undefined : `${key} must be a boolean`
    case "integer":
      return typeof value === "number" && Number.isInteger(value) ? undefined : `${key} must be an integer`
    case "string": {
      if (typeof value !== "string") return `${key} must be a string`
      if (spec.enum !== undefined && !spec.enum.includes(value)) {
        return `${key} must be one of ${spec.enum.join(", ")}`
      }
      return undefined
    }
    case "string[]":
      return Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? undefined
        : `${key} must be an array of strings`
  }
}

export interface CliResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean }
}

/**
 * One DispatchCapability per DECLARED catalog operation (name
 * `cli.<tool>.<operation>`, group "cli"). The allowlist is re-checked inside
 * each adapter (defense in depth): even a guest that bypasses the typed
 * declarations through a raw bridge call is denied at dispatch time.
 */
export function createCliCapabilities(allowlist: CliAllowlist): readonly DispatchCapability[] {
  const capabilities: DispatchCapability[] = []
  for (const [tool, toolDef] of Object.entries(CLI_TOOLS)) {
    for (const operation of Object.keys(toolDef.operations)) {
      capabilities.push({
        name: `cli.${tool}.${operation}`,
        group: "cli",
        run: (input, env) => runCliOperation(tool, operation, allowlist, input, env),
      })
    }
  }
  return capabilities
}

/**
 * The one execution path for a declared CLI operation: allowlist re-check →
 * abort/root check → typed-arg validation → in-process enumeration (find,
 * grep, ls) OR validated argv build → spawnCli. Exported so the Task 8 npm
 * script runner (capabilities/npm-scripts.ts) executes planned steps through
 * THIS pipeline (no shell, per-op bounds, nonzero exit as data).
 */
export async function runCliOperation(
  tool: string,
  operation: string,
  allowlist: CliAllowlist,
  input: unknown,
  env: DispatchEnvironment,
): Promise<DispatchOutcome> {
  const callName = `cli.${tool}.${operation}`
  // Defense in depth: the dispatcher never trusts its caller (dispatch.ts
  // criterion 1) — the allowlist is re-checked here even though the guest
  // surface and capabilitiesFor() should already have gated the call.
  if (!cliAllowlistAllows(allowlist, tool, operation)) {
    return dispatchError("mode", `${callName} is not in the effective CLI allowlist`)
  }
  if (env.signal?.aborted) return dispatchError("cancelled", "Execution cancelled")
  if (typeof env.root !== "string" || env.root.length === 0) {
    return dispatchError("root", "the active project root is unknown; CLI capabilities are disabled")
  }
  // In-process branch (find/grep/ls): the same gate and typed-arg validation
  // as the spawned tools, but no PATH lookup and no spawn (enumerate.ts).
  if (isEnumeratedOperation(tool, operation)) {
    const validated = validateDeclaredArgs(tool, operation, input)
    if (!validated.ok) return dispatchError("input", validated.message)
    return runEnumeratedOperation(tool, operation, validated.value, env)
  }
  const built = buildCliInvocation(tool, operation, input)
  if (!built.ok) return dispatchError("input", built.message)
  return spawnCli({
    executable: built.invocation.executable,
    argv: built.invocation.argv,
    cwd: env.root,
    envTool: tool,
    timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
    signal: env.signal,
    label: callName,
  })
}

export interface CliSpawnRequest {
  readonly executable: string
  readonly argv: readonly string[]
  /** Working directory: the canonical active checkout root. */
  readonly cwd: string
  /** Tool name for the spawn env allowlist (gh gets its token variables). */
  readonly envTool: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  /** Diagnostic label, e.g. "cli.git.status". */
  readonly label: string
}

/**
 * Runs one executable with a literal argv array (shell:false — see the Node
 * child_process docs: with `shell` disabled the args are not parsed by any
 * shell) and resolves a DispatchOutcome, never a rejection:
 *   - close → { ok: true, data: { stdout, stderr, exitCode, truncated } } —
 *     nonzero exit codes are data;
 *   - timeout → kill the child, { ok: false, kind: "limit" };
 *   - abort (env.signal) → kill the child, { ok: false, kind: "cancelled" };
 *   - ENOENT → { ok: false, kind: "not-found" }.
 */
export function spawnCli(request: CliSpawnRequest): Promise<DispatchOutcome> {
  return new Promise((resolve) => {
    if (request.signal?.aborted) {
      resolve(dispatchError("cancelled", "Execution cancelled"))
      return
    }
    let child
    try {
      child = spawn(request.executable, [...request.argv], {
        cwd: request.cwd,
        env: hostCommandEnv(request.envTool),
        shell: false,
        windowsHide: true,
      })
    } catch (error) {
      resolve(dispatchError("io", errorMessage(error)))
      return
    }

    const stdout = createStreamCollector()
    const stderr = createStreamCollector()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let abortHandler: (() => void) | undefined

    const settle = (outcome: DispatchOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (abortHandler !== undefined) request.signal?.removeEventListener("abort", abortHandler)
      resolve(outcome)
    }
    const kill = (): void => {
      try {
        child.kill("SIGTERM")
      } catch {
        // the child may already have exited; nothing to do
      }
    }

    timer = setTimeout(() => {
      kill()
      settle(dispatchError("limit", `CLI operation timed out after ${request.timeoutMs}ms: ${request.label}`))
    }, request.timeoutMs)
    abortHandler = () => {
      kill()
      settle(dispatchError("cancelled", "Execution cancelled"))
    }
    request.signal?.addEventListener("abort", abortHandler, { once: true })
    if (request.signal?.aborted) abortHandler()

    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => stdout.append(chunk))
    child.stderr?.on("data", (chunk: string) => stderr.append(chunk))
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        settle(dispatchError("not-found", `CLI executable not found for ${request.label}: ${request.executable}`))
      } else {
        settle(dispatchError("io", errorMessage(error)))
      }
    })
    child.on("close", (code) => {
      settle({
        ok: true,
        data: {
          stdout: stdout.finalize(),
          stderr: stderr.finalize(),
          exitCode: code ?? 0,
          truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
        } satisfies CliResult,
      })
    })
  })
}

interface StreamCollector {
  readonly truncated: boolean
  append(chunk: string): void
  finalize(): string
}

/**
 * Rolling per-stream collector (Pi semantics: the tail is kept — the most
 * recent output is the most useful for a failing command). Memory stays
 * bounded at MAX_CLI_STREAM_BYTES + one chunk; `finalize` marks truncation
 * explicitly and the whole returned string stays within the cap.
 */
function createStreamCollector(): StreamCollector {
  let text = ""
  let truncated = false
  return {
    get truncated(): boolean {
      return truncated
    },
    append(chunk: string): void {
      text += chunk
      if (byteLength(text) > MAX_CLI_STREAM_BYTES) {
        text = tailBytes(text, MAX_CLI_STREAM_BYTES)
        truncated = true
      }
    },
    finalize(): string {
      if (!truncated) return text
      const marker = `\n[Output truncated, showing last ${MAX_CLI_STREAM_BYTES / 1024} KiB.]`
      return tailBytes(text, Math.max(MAX_CLI_STREAM_BYTES - byteLength(marker), 0)) + marker
    },
  }
}

function tailBytes(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length <= maxBytes) return value
  return new TextDecoder().decode(bytes.subarray(bytes.length - maxBytes))
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Task 11: the explicit `yolo` shell escape hatch (capability group "shell").
// The guest `shell.run({ command, timeoutMs? })` surface exists only while the
// effective mode is yolo; the dispatcher's group check is the guest boundary
// (a raw bridge call is denied with kind "mode" in off/on), and the adapter
// re-checks the group defensively. Commands run through the PLATFORM shell as
// an argv array (shell:false in child_process terms — Node does not re-parse
// the command), in the canonical active root, under the same bounds as the CLI
// adapter: 50 KiB per stream with the explicit marker, a 30_000 ms default
// timeout (the 120 s executor bound still caps the whole execution), kill on
// timeout/abort, and a nonzero exit as data.
// ---------------------------------------------------------------------------

/** Guest-visible name of the shell escape-hatch global. */
export const SHELL_GLOBAL_NAME = "shell"

/** Capability name of the shell adapter (group "shell"). */
export const SHELL_CAPABILITY_NAME = "shell.run"

/** Default shell command timeout (ms); mirrors the CLI operation default. */
export const DEFAULT_SHELL_TIMEOUT_MS = 30_000

/** Hard ceiling for a caller-provided timeout: the executor's own 120 s bound. */
export const MAX_SHELL_TIMEOUT_MS = 120_000

/**
 * TypeScript declaration for the shell surface (single source of truth: this
 * module drives both the runtime install in globals.ts and this typechecker
 * input, so the guest only ever names what it actually gets).
 */
export const SHELL_DECLARATION = [
  "interface ShellResult {",
  "  readonly stdout: string;",
  "  readonly stderr: string;",
  "  readonly exitCode: number;",
  "  readonly truncated: { readonly stdout: boolean; readonly stderr: boolean };",
  "}",
  "/** Run one command through the platform shell in the project root (yolo mode only). stdout/stderr are each capped at 50 KiB; a nonzero exit is returned as data. */",
  "declare const shell: {",
  "  run(params: { command: string; timeoutMs?: number }): Promise<ShellResult>;",
  "};",
].join("\n")

/**
 * The platform shell invocation for one command line: an argv array with
 * `shell:false` spawn semantics on every platform. win32: ComSpec (or
 * cmd.exe) with `/d /s /c`; elsewhere: `/bin/sh -c`.
 */
export function platformShellArgv(command: string): { readonly executable: string; readonly argv: readonly string[] } {
  if (process.platform === "win32") {
    return { executable: process.env.ComSpec ?? "cmd.exe", argv: ["/d", "/s", "/c", command] }
  }
  return { executable: "/bin/sh", argv: ["-c", command] }
}

function parseShellInput(
  input: unknown,
): { readonly ok: true; readonly command: string; readonly timeoutMs: number } | { readonly ok: false; readonly reason: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "shell.run input must be an object { command, timeoutMs? }" }
  }
  const provided = input as Record<string, unknown>
  for (const key of Object.keys(provided)) {
    if (key !== "command" && key !== "timeoutMs") return { ok: false, reason: `Unknown shell.run argument: ${key}` }
  }
  if (typeof provided.command !== "string" || provided.command.length === 0) {
    return { ok: false, reason: "shell.run requires a non-empty string command" }
  }
  const timeout = provided.timeoutMs
  if (timeout !== undefined) {
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_SHELL_TIMEOUT_MS) {
      return { ok: false, reason: `shell.run timeoutMs must be a positive integer of at most ${MAX_SHELL_TIMEOUT_MS}` }
    }
  }
  return { ok: true, command: provided.command, timeoutMs: timeout ?? DEFAULT_SHELL_TIMEOUT_MS }
}

/**
 * The one execution path for `shell.run`: group/abort/root checks → input
 * validation → platform-shell spawn through spawnCli (the shared executor:
 * 50 KiB per stream with the explicit marker, timeout/abort kill, nonzero exit
 * as data). Failures are DispatchOutcomes, never rejections.
 */
export async function runShellCommand(input: unknown, env: DispatchEnvironment): Promise<DispatchOutcome> {
  // Defense in depth (the dispatcher's group check is the guest boundary): a
  // direct caller cannot run the escape hatch while the group is closed.
  if (!env.capabilities.shell) {
    return dispatchError("mode", `capability "${SHELL_CAPABILITY_NAME}" is not enabled by the effective policy`)
  }
  if (env.signal?.aborted) return dispatchError("cancelled", "Execution cancelled")
  if (typeof env.root !== "string" || env.root.length === 0) {
    return dispatchError("root", "the active project root is unknown; the shell capability is disabled")
  }
  const parsed = parseShellInput(input)
  if (!parsed.ok) return dispatchError("input", parsed.reason)
  const invocation = platformShellArgv(parsed.command)
  return spawnCli({
    executable: invocation.executable,
    argv: invocation.argv,
    cwd: env.root,
    envTool: "shell",
    timeoutMs: parsed.timeoutMs,
    signal: env.signal,
    label: SHELL_CAPABILITY_NAME,
  })
}

/** The dispatcher adapter for the explicit shell escape hatch (group "shell"). */
export function createShellCapabilities(): readonly DispatchCapability[] {
  return [{ name: SHELL_CAPABILITY_NAME, group: "shell", run: (input, env) => runShellCommand(input, env) }]
}
