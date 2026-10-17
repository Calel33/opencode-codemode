// src/capabilities/npm-scripts.ts
// TASK 8 — safe npm script decomposition: `codemode.plan_npm_script` +
// `codemode.run_npm_script` (Pi parity names, research §2.9/§2.10).
//
// The parser is a faithful port of the original package's npm-scripts.ts:
//   - DENIED_COMMANDS {node, npm, npx, bash, sh, python, python3} refuse
//     plainly, except the exact recursive forms `npm run <script>` (3 argv)
//     and `npm test` (2 argv);
//   - SHELL_CONSTRUCTS ["|", ">", "<", "$", "`", "(", ")", ";", "||"] refuse
//     the WHOLE command before tokenizing (first match reports);
//   - `&&` chains split and validate each segment independently;
//   - decompose targets: tsc (build, --watch), oxfmt (<path> --check|--write),
//     oxlint (--deny warnings --vitest-plugin <path>), `vitest run`;
//   - cycles are detected across the chain and the refusal message format is
//     preserved verbatim:
//     "Refusing to decompose npm script '<s>' (chain: …): <reason>".
// Port adaptations (recorded for review):
//   - the plan is returned as STRUCTURED DATA (steps: tool/operation/args plus
//     the validated executable+argv from the declared CLI catalog) instead of
//     Pi's rendered text — the guest can inspect it, and the typechecker
//     declaration mirrors the exact shape;
//   - planning is bounded: expansion is capped at MAX_NPM_PLAN_STEPS (Pi had
//     no cap; diamond-shaped recursive scripts could otherwise blow up) and
//     package.json is read with a size bound;
//   - run REFUSES the whole script before executing anything when any step is
//     blocked by the effective allowlist (Pi aborted at the first throwing
//     call, after earlier steps had already run — a refused plan must not
//     half-execute);
//   - `verbose` (Pi input) is preserved: compact results omit successful-step
//     output, failures always include it;
//   - only Pi's four decompose targets exist; a script like `git status` is
//     `unsupported command 'git'` (no general catalog inversion is attempted).
//
// Safety invariants:
//   - PLANNING has no side effects: it reads package.json (bounded) and the
//     declared catalog; it never spawns. The step executor is injectable so
//     tests can assert zero invocations;
//   - RUNNING re-plans from the same inputs and rechecks the effective
//     allowlist at execution time; steps execute one at a time through the
//     existing CLI pipeline (runCliOperation -> spawnCli; shell:false, argv
//     arrays only, 50 KiB per stream, 30 s per-op timeout, nonzero exit is
//     data). A blocked step is surfaced as data at plan time and refuses the
//     run — never executed, never silently dropped.
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { CliAllowlist } from "../config/policy.js"
import { dispatchError } from "../codemode/dispatch.js"
import type { DispatchCapability, DispatchEnvironment, DispatchErrorKind, DispatchOutcome } from "../codemode/dispatch.js"
import { cliAllowlistAllows } from "../security/allowlist.js"
import { buildCliInvocation, runCliOperation } from "./cli.js"
import type { CliResult } from "./cli.js"

// ---------------------------------------------------------------------------
// Bounds and the Pi denylists
// ---------------------------------------------------------------------------

/** Pi parity: hard command denylist for npm script bodies (research §2.9). */
export const NPM_DENIED_COMMANDS: ReadonlySet<string> = new Set(["node", "npm", "npx", "bash", "sh", "python", "python3"])
/** Pi parity: any of these anywhere in a command refuses the whole script. */
export const NPM_SHELL_CONSTRUCTS: readonly string[] = ["|", ">", "<", "$", "`", "(", ")", ";", "||"]
/** Bounded expansion: the cap applies while decomposing, not after. */
export const MAX_NPM_PLAN_STEPS = 32
/** Bounded read: a larger package.json fails closed instead of being parsed. */
export const MAX_PACKAGE_JSON_BYTES = 1024 * 1024

// ---------------------------------------------------------------------------
// The pure parser (no I/O, no spawn)
// ---------------------------------------------------------------------------

export interface NpmScriptCall {
  readonly tool: string
  readonly operation: string
  readonly args: Record<string, unknown>
}

/** A bounded refusal from the decomposition pass — always a case review, never a crash. */
export class NpmScriptRefusalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "NpmScriptRefusalError"
  }
}

export function decomposeNpmScript(
  scripts: Readonly<Record<string, string>>,
  script: string,
): readonly NpmScriptCall[] {
  const calls: NpmScriptCall[] = []
  resolveScript(scripts, script, [], calls)
  return calls
}

function resolveScript(
  scripts: Readonly<Record<string, string>>,
  script: string,
  chain: readonly string[],
  out: NpmScriptCall[],
): void {
  if (chain.includes(script)) {
    throw new NpmScriptRefusalError(
      `cycle detected while resolving npm scripts: ${[...chain, script].join(" -> ")}`,
    )
  }
  const command = scripts[script]
  if (typeof command !== "string") {
    throw new NpmScriptRefusalError(`npm script '${script}' is not defined`)
  }
  const nextChain = [...chain, script]
  for (const part of splitSafeAnd(command, script, nextChain)) {
    decomposeCommand(scripts, script, nextChain, tokenize(part), out)
  }
}

function splitSafeAnd(command: string, script: string, chain: readonly string[]): string[] {
  rejectShellConstructs(command, script, chain)
  return command
    .split("&&")
    .map((part) => part.trim())
    .filter(Boolean)
}

function rejectShellConstructs(command: string, script: string, chain: readonly string[]): void {
  for (const construct of NPM_SHELL_CONSTRUCTS) {
    if (command.includes(construct)) {
      refuse(script, chain, `unsupported shell construct '${construct}'`)
    }
  }
}

function decomposeCommand(
  scripts: Readonly<Record<string, string>>,
  script: string,
  chain: readonly string[],
  argv: string[],
  out: NpmScriptCall[],
): void {
  const command: string | undefined = argv[0]
  if (command === undefined) return
  if (command === "npm" && argv[1] === "run" && typeof argv[2] === "string" && argv.length === 3) {
    resolveScript(scripts, argv[2], chain, out)
    return
  }
  if (command === "npm" && argv[1] === "test" && argv.length === 2) {
    resolveScript(scripts, "test", chain, out)
    return
  }
  if (NPM_DENIED_COMMANDS.has(command)) {
    refuse(script, chain, `command '${command}' is denied. Use surfaced cli.* tools instead.`)
  }
  if (command === "tsc") {
    emit(out, script, chain, decomposeTsc(script, chain, argv))
    return
  }
  if (command === "oxfmt") {
    emit(out, script, chain, decomposeOxfmt(script, chain, argv))
    return
  }
  if (command === "oxlint") {
    emit(out, script, chain, decomposeOxlint(script, chain, argv))
    return
  }
  if (command === "vitest" && argv[1] === "run" && argv.length === 2) {
    emit(out, script, chain, { tool: "vitest", operation: "run", args: {} })
    return
  }
  refuse(script, chain, `unsupported command '${command}'`)
}

function decomposeTsc(script: string, chain: readonly string[], argv: string[]): NpmScriptCall {
  if (argv.length === 1) return { tool: "tsc", operation: "build", args: {} }
  if (argv.length === 2 && argv[1] === "--watch") {
    return { tool: "tsc", operation: "build", args: { watch: true } }
  }
  refuse(script, chain, `unsupported tsc arguments: ${argv.slice(1).join(" ")}`)
}

function decomposeOxfmt(script: string, chain: readonly string[], argv: string[]): NpmScriptCall {
  if (argv.length === 3 && argv[2] === "--check") {
    return { tool: "oxfmt", operation: "check", args: { paths: [argv[1]] } }
  }
  if (argv.length === 3 && argv[2] === "--write") {
    return { tool: "oxfmt", operation: "write", args: { paths: [argv[1]] } }
  }
  refuse(script, chain, `unsupported oxfmt arguments: ${argv.slice(1).join(" ")}`)
}

function decomposeOxlint(script: string, chain: readonly string[], argv: string[]): NpmScriptCall {
  if (argv.length === 5 && argv[1] === "--deny" && argv[2] === "warnings" && argv[3] === "--vitest-plugin") {
    return {
      tool: "oxlint",
      operation: "run",
      args: { deny: "warnings", vitestPlugin: true, paths: [argv[4]] },
    }
  }
  refuse(script, chain, `unsupported oxlint arguments: ${argv.slice(1).join(" ")}`)
}

function tokenize(command: string): string[] {
  return command.split(/\s+/u).filter(Boolean)
}

/** Appends one decomposed call; enforces the bounded expansion cap. */
function emit(out: NpmScriptCall[], script: string, chain: readonly string[], call: NpmScriptCall): void {
  out.push(call)
  if (out.length > MAX_NPM_PLAN_STEPS) {
    refuse(script, chain, `decomposition exceeds ${MAX_NPM_PLAN_STEPS} steps (bounded)`)
  }
}

/** The preserved Pi refusal shape: never a partial result. */
function refuse(script: string, chain: readonly string[], reason: string): never {
  throw new NpmScriptRefusalError(
    `Refusing to decompose npm script '${script}' (chain: ${chain.join(" -> ")}): ${reason}`,
  )
}

// ---------------------------------------------------------------------------
// Bounded package.json read (read-only; fail closed)
// ---------------------------------------------------------------------------

export type NpmScriptsReadResult =
  | { readonly ok: true; readonly scripts: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly kind: DispatchErrorKind; readonly message: string }

export async function readNpmScripts(root: string): Promise<NpmScriptsReadResult> {
  const path = join(root, "package.json")
  let size: number
  try {
    size = (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, kind: "not-found", message: `package.json not found in the active project root (${path})` }
    }
    return { ok: false, kind: "io", message: `package.json could not be read (${path}): ${errorMessage(error)}` }
  }
  if (size > MAX_PACKAGE_JSON_BYTES) {
    return {
      ok: false,
      kind: "limit",
      message: `package.json exceeds ${MAX_PACKAGE_JSON_BYTES / (1024 * 1024)} MiB; refusing to read (bounded)`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    return { ok: false, kind: "input", message: `package.json is not valid JSON: ${boundText(errorMessage(error), 200)}` }
  }
  if (!isPlainObject(parsed)) return { ok: false, kind: "input", message: "package.json must be a JSON object" }
  const rawScripts = parsed.scripts
  if (rawScripts !== undefined && !isPlainObject(rawScripts)) {
    return { ok: false, kind: "input", message: 'package.json "scripts" must be an object' }
  }
  const scripts: Record<string, string> = {}
  for (const [name, value] of Object.entries(rawScripts ?? {})) {
    if (typeof value === "string") scripts[name] = value
  }
  return { ok: true, scripts }
}

// ---------------------------------------------------------------------------
// Plan/run data shapes (mirrored exactly by the guest typechecker declaration
// in codemode/globals.ts — keep them in lockstep)
// ---------------------------------------------------------------------------

export interface NpmScriptStep {
  readonly tool: string
  readonly operation: string
  readonly args: Record<string, unknown>
  /** From the declared CLI catalog (absent only when the adapter cannot express the call). */
  readonly executable?: string
  readonly argv?: readonly string[]
  readonly status: "ready" | "blocked"
  readonly reason?: string
}

export interface NpmScriptPlan {
  readonly script: string
  readonly steps: readonly NpmScriptStep[]
}

export interface NpmScriptStepResult {
  readonly tool: string
  readonly operation: string
  readonly args: Record<string, unknown>
  readonly outcome: "ok" | "nonzero-exit" | "error" | "skipped"
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
  readonly truncated?: { readonly stdout: boolean; readonly stderr: boolean }
  readonly error?: { readonly kind: string; readonly message: string }
}

export interface NpmScriptRunResult {
  readonly script: string
  readonly results: readonly NpmScriptStepResult[]
}

// ---------------------------------------------------------------------------
// Capabilities (ONE dispatcher adapter per helper; group "cli" — the npm
// script surface requires CLI access by definition)
// ---------------------------------------------------------------------------

export interface NpmStepExecutor {
  (tool: string, operation: string, args: Record<string, unknown>, env: DispatchEnvironment): Promise<DispatchOutcome>
}

export interface NpmScriptsContext {
  /** Effective CLI allowlist (policy.cli); gates ready-vs-blocked and the run. */
  readonly allowlist: CliAllowlist
  /**
   * Step executor seam: defaults to the real CLI pipeline
   * (runCliOperation -> spawnCli, allowlist rechecked per step, no shell).
   * Tests inject a recorder to assert PLANNING never executes anything.
   */
  readonly executeStep?: NpmStepExecutor
  /** package.json reader override (tests); defaults to the bounded host read. */
  readonly readScripts?: (root: string) => Promise<NpmScriptsReadResult>
}

const ROOT_MESSAGE = "the active project root is unknown; the npm script surface is disabled"

export function createNpmScriptCapabilities(context: NpmScriptsContext): readonly DispatchCapability[] {
  const execute: NpmStepExecutor =
    context.executeStep ??
    ((tool, operation, args, env) => runCliOperation(tool, operation, context.allowlist, args, env))

  const guard = (env: DispatchEnvironment): DispatchOutcome | undefined => {
    // Defense in depth (the dispatcher also gates): never serve this surface
    // outside the cli capability group, and never while mode is off.
    if (env.mode === "off") {
      return dispatchError("mode", "CodeMode is off for this session; the codemode/npm surface is disabled.")
    }
    if (!env.capabilities.cli) {
      return dispatchError("mode", "the codemode/npm surface is not enabled by the effective policy")
    }
    return undefined
  }
  const guarded = (
    env: DispatchEnvironment,
    work: () => Promise<DispatchOutcome>,
  ): Promise<DispatchOutcome> => {
    const denied = guard(env)
    return denied === undefined ? work() : Promise.resolve(denied)
  }

  return [
    {
      name: "codemode.plan_npm_script",
      group: "cli",
      run: (input, env) => guarded(env, () => planNpmScript(context, input, env)),
    },
    {
      name: "codemode.run_npm_script",
      group: "cli",
      run: (input, env) => guarded(env, () => runNpmScript(context, execute, input, env)),
    },
  ]
}

async function planNpmScript(context: NpmScriptsContext, input: unknown, env: DispatchEnvironment): Promise<DispatchOutcome> {
  if (env.signal?.aborted) return dispatchError("cancelled", "Execution cancelled")
  const params = asRecord(input)
  const script = params?.script
  if (typeof script !== "string" || script.trim().length === 0) {
    return dispatchError("input", "plan_npm_script requires { script: string }")
  }
  if (typeof env.root !== "string" || env.root.length === 0) return dispatchError("root", ROOT_MESSAGE)
  const reader = context.readScripts ?? readNpmScripts
  const scripts = await reader(env.root)
  if (!scripts.ok) return dispatchError(scripts.kind, scripts.message)
  const built = buildPlanSteps(scripts.scripts, script, context.allowlist)
  if (!built.ok) return dispatchError("input", built.message)
  const plan: NpmScriptPlan = { script, steps: built.steps }
  return { ok: true, data: plan }
}

async function runNpmScript(
  context: NpmScriptsContext,
  execute: NpmStepExecutor,
  input: unknown,
  env: DispatchEnvironment,
): Promise<DispatchOutcome> {
  if (env.signal?.aborted) return dispatchError("cancelled", "Execution cancelled")
  const params = asRecord(input)
  const script = params?.script
  if (typeof script !== "string" || script.trim().length === 0) {
    return dispatchError("input", "run_npm_script requires { script: string }")
  }
  const verbose = params?.verbose
  if (verbose !== undefined && typeof verbose !== "boolean") {
    return dispatchError("input", "verbose must be a boolean when provided")
  }
  if (typeof env.root !== "string" || env.root.length === 0) return dispatchError("root", ROOT_MESSAGE)

  // Re-plan from the same inputs; the allowlist is applied as of THIS call
  // (execution time), so a policy narrowed after a previous plan is honored.
  const reader = context.readScripts ?? readNpmScripts
  const scripts = await reader(env.root)
  if (!scripts.ok) return dispatchError(scripts.kind, scripts.message)
  const built = buildPlanSteps(scripts.scripts, script, context.allowlist)
  if (!built.ok) return dispatchError("input", built.message)

  // All-or-nothing: a blocked step refuses the run BEFORE anything executes
  // (Pi aborted mid-sequence at the first throwing call; a refused plan must
  // never half-execute). Blocked steps were surfaced as data at plan time.
  const blocked = built.steps.filter((step) => step.status === "blocked")
  if (blocked.length > 0) {
    const names = blocked.map((step) => `cli.${step.tool}.${step.operation}`)
    const listed = names.slice(0, 5).join(", ") + (names.length > 5 ? ` (+${names.length - 5} more)` : "")
    return dispatchError("mode", `run refused: npm script '${script}' includes blocked step(s): ${listed}`)
  }

  const results: NpmScriptStepResult[] = []
  for (const step of built.steps) {
    const outcome = await execute(step.tool, step.operation, step.args, env)
    if (outcome.ok) {
      const data = outcome.data as Partial<CliResult> | undefined
      const exitCode = typeof data?.exitCode === "number" ? data.exitCode : 0
      const includeOutput = verbose === true || exitCode !== 0
      results.push({
        tool: step.tool,
        operation: step.operation,
        args: step.args,
        outcome: exitCode === 0 ? "ok" : "nonzero-exit",
        exitCode,
        ...(includeOutput
          ? {
              stdout: typeof data?.stdout === "string" ? data.stdout : "",
              stderr: typeof data?.stderr === "string" ? data.stderr : "",
              truncated: normalizeTruncation(data?.truncated),
            }
          : {}),
      })
      if (exitCode !== 0) break // Pi parity: stop after the first nonzero exit
    } else {
      results.push({ tool: step.tool, operation: step.operation, args: step.args, outcome: "error", error: outcome.error })
      break
    }
  }
  // Everything not reached is surfaced as skipped — never silently dropped.
  for (let index = results.length; index < built.steps.length; index++) {
    const step = built.steps[index]
    if (step === undefined) break
    results.push({ tool: step.tool, operation: step.operation, args: step.args, outcome: "skipped" })
  }
  const run: NpmScriptRunResult = { script, results }
  return { ok: true, data: run }
}

function buildPlanSteps(
  scripts: Readonly<Record<string, string>>,
  script: string,
  allowlist: CliAllowlist,
): { readonly ok: true; readonly steps: readonly NpmScriptStep[] } | { readonly ok: false; readonly message: string } {
  let calls: readonly NpmScriptCall[]
  try {
    calls = decomposeNpmScript(scripts, script)
  } catch (error) {
    if (error instanceof NpmScriptRefusalError) return { ok: false, message: error.message }
    throw error
  }
  return { ok: true, steps: calls.map((call) => toStep(call, allowlist)) }
}

function toStep(call: NpmScriptCall, allowlist: CliAllowlist): NpmScriptStep {
  const built = buildCliInvocation(call.tool, call.operation, call.args)
  if (!built.ok) {
    return { ...call, status: "blocked", reason: `the declared adapter cannot express this call: ${built.message}` }
  }
  if (!cliAllowlistAllows(allowlist, call.tool, call.operation)) {
    return {
      ...call,
      executable: built.invocation.executable,
      argv: built.invocation.argv,
      status: "blocked",
      reason: `cli.${call.tool}.${call.operation} is not in the effective CLI allowlist`,
    }
  }
  return {
    ...call,
    executable: built.invocation.executable,
    argv: built.invocation.argv,
    status: "ready",
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return isPlainObject(input) ? input : undefined
}

function normalizeTruncation(value: unknown): { stdout: boolean; stderr: boolean } {
  if (isPlainObject(value)) return { stdout: value.stdout === true, stderr: value.stderr === true }
  return { stdout: false, stderr: false }
}

function boundText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...[truncated]` : text
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
