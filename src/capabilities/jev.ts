// src/capabilities/jev.ts
// Task 10: the optional TypeSafe (Jev / System One) integration — Pi's
// `jev.ask(state, questions)` re-homed onto this port's dispatcher boundary.
//
// Availability model (recorded decision): the guest `jev` surface is
// POLICY-derived, exactly like cli/mcp — it exists iff the jev capability
// group is on (mode != "off" AND `jev.enabled`). Runtime availability of the
// credential and the SDK is answered HERE, per call, as a bounded
// DispatchOutcome (the "bounded unavailable outcome on attempted use" status
// path the task allows — the guest is told how to enable the feature):
//   - no host TYPESAFE_API_KEY       -> "unavailable" + how to enable
//   - optional SDK missing/unloadable -> "unavailable" + how to enable
//   - policy opted out (enabled:false) -> "mode" + how to re-enable
//
// Credential handling (credentials stay in the host):
//   - the API key is read from the HOST environment (TYPESAFE_API_KEY) only —
//     never a guest input, never a Pi config path (~/.pi/... is forbidden);
//   - the key gates client construction BEFORE the SDK constructor runs (the
//     SDK constructor throws when the key is missing; research §3.10);
//   - the guest globals and the typechecker declaration (JEV_DECLARATION)
//     carry generic shapes only — no credential, no key lookup;
//   - error text is scrubbed of the key and the (truncated) state, and length
//     bounded, before it can reach logs or tool results; no other host code
//     path logs state, questions, answers, or the key.
//
// Bounds (Pi parity, research §2.13): model "jev-latest", timeout 8000 ms
// timeout (policy defaults in config/policy.ts), state truncated to 12000
// chars with Pi's "…[truncated]" suffix, array questions normalized to index
// keys. This port additionally bounds the wire request and the answers
// payload at the shared 50 KiB convention.
//
// Transport: the lazily imported `@typesafe-ai/sdk` (optionalDependency,
// ^0.6.0: ESM+CJS, no runtime dependencies, node >= 20 — research §3.10). The
// import is dynamic with a NON-LITERAL specifier so typecheck/build never
// require the package to be resolvable, and a load failure (MODULE_NOT_FOUND)
// is data, not a crash. Tests inject `clientFactory` to exercise the full
// call path without the SDK or a network.
//
// Retry policy: one retry max (SDK RequestOptions `retry: { maxRetries: 1 }`),
// matching Pi's two-attempt 429/529 handling; the SDK owns backoff.
import type { DispatchCapability, DispatchOutcome } from "../codemode/dispatch.js"
import { dispatchError } from "../codemode/dispatch.js"
import type { JevPolicy } from "../config/policy.js"

/** Guest-visible name of the optional Jev surface global. */
export const JEV_GLOBAL_NAME = "jev"

/** Pi-parity state bound (DEFAULT_STATE_MAX_CHARS = 12000, research §2.13). */
export const JEV_STATE_MAX_CHARS = 12_000

/** Shared bound convention of this port (50 KiB) for the wire request. */
export const JEV_INPUT_MAX_BYTES = 50 * 1024

/** Shared bound convention of this port (50 KiB) for the answers payload. */
export const JEV_ANSWERS_MAX_BYTES = 50 * 1024

/** Bound for error text that can reach the guest (dispatch.ts convention). */
export const JEV_ERROR_MAX_CHARS = 2_000

/** Only strings at least this long are scrubbed (avoids mangling messages). */
const REDACTION_MIN_CHARS = 8

/** Pi-parity truncation suffix (client.ts TRUNCATION_SUFFIX). */
const TRUNCATION_SUFFIX = "…[truncated]"

export const JEV_NO_KEY_MESSAGE =
  "jev.ask is unavailable: TYPESAFE_API_KEY is not set in the host environment. " +
  "This is an optional feature — to enable it, set TYPESAFE_API_KEY for the host and install the optional @typesafe-ai/sdk package."

export const JEV_SDK_MISSING_MESSAGE =
  "jev.ask is unavailable: the optional @typesafe-ai/sdk package could not be loaded. " +
  "This is an optional feature — to enable it, install @typesafe-ai/sdk (^0.6.0) and set TYPESAFE_API_KEY in the host environment."

export const JEV_DISABLED_MESSAGE =
  "jev.ask is disabled by the effective plugin policy (options.jev.enabled: false). " +
  "This is an optional feature — remove the opt-out and restart to enable it."

export const JEV_CANCELLED_MESSAGE = "Execution cancelled"

// ---------------------------------------------------------------------------
// Domain shapes (Pi-adapted from pi-codemode-src/src/jev/types.ts)
// ---------------------------------------------------------------------------

export interface JevNoulQuestion {
  readonly type: "noul"
  readonly instructions: string
}

export interface JevChoiceQuestion {
  readonly type: "choice"
  readonly instructions: string
  readonly criteria: Readonly<Record<string, string>>
}

export interface JevScoreQuestion {
  readonly type: "score"
  readonly instructions: string
  readonly criteria: readonly string[]
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion

export interface JevNoulAnswer {
  readonly type: "noul"
  readonly noul: number
  readonly confidence?: number
}

export interface JevChoiceAnswer {
  readonly type: "choice"
  readonly choice: string
  readonly confidence?: number
  readonly probabilities: Readonly<Record<string, number>>
}

export interface JevScoreAnswer {
  readonly type: "score"
  readonly score: number
  readonly confidence?: number
  readonly legend?: Readonly<Record<string, string>>
  readonly probabilities?: Readonly<Record<string, number>>
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer
export type JevAnswers = Record<string, JevAnswer>

/**
 * TypeScript declaration injected into the virtual typecheck source when the
 * jev capability group is on. Generic shapes only — no credential, no key
 * lookup, nothing environment-dependent (Pi-adapted: generateJevTypeDefs()).
 */
export const JEV_DECLARATION = `interface JevNoulQuestion { type: "noul"; instructions: string; }
interface JevChoiceQuestion { type: "choice"; instructions: string; criteria: Record<string, string>; }
interface JevScoreQuestion { type: "score"; instructions: string; criteria: string[]; }
type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;
interface JevNoulAnswer { type: "noul"; noul: number; confidence?: number; }
interface JevChoiceAnswer { type: "choice"; choice: string; confidence?: number; probabilities: Record<string, number>; }
interface JevScoreAnswer { type: "score"; score: number; confidence?: number; legend?: Record<string, string>; probabilities?: Record<string, number>; }
type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;
type JevAnswers = Record<string, JevAnswer>;
/** TypeSafe System One classifier (noul / choice / score). Optional: available only when the host has configured the integration; otherwise calls fail with an actionable status. */
declare const jev: {
  ask(state: unknown, questions: Record<string, JevQuestion> | JevQuestion[]): Promise<JevAnswers>;
};`

// ---------------------------------------------------------------------------
// Client contract (structural; the SDK types are never imported statically)
// ---------------------------------------------------------------------------

export interface JevRequest {
  readonly state: unknown
  readonly questions: Record<string, JevQuestion>
  readonly model: string
}

export interface JevRequestOptions {
  readonly signal: AbortSignal
  readonly timeout: number
  readonly retry: { readonly maxRetries: number }
}

/** Structural shape of the lazily imported SDK client (`TypeSafeClient` v0.6.0). */
export interface JevClient {
  systemOne(request: JevRequest, options?: JevRequestOptions): Promise<unknown>
}

export type JevClientFactory = (apiKey: string) => Promise<JevClient | null>

/** Host-side environment for the Jev adapter (injected in tests). */
export interface JevEnvironment {
  /** Effective jev policy (config/policy.ts; enabled/model/timeoutMs). */
  readonly policy: JevPolicy
  /** Host environment source for the API key (default: process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Client factory; default lazily imports the optional @typesafe-ai/sdk. */
  readonly clientFactory?: JevClientFactory
}

// ---------------------------------------------------------------------------
// Bounded helpers (Pi-adapted)
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

/** Pi-adapted state truncation; guards non-serializable input (Pi would throw). */
export function truncateJevState(state: unknown, maxChars: number): unknown {
  if (maxChars <= TRUNCATION_SUFFIX.length) return TRUNCATION_SUFFIX.slice(0, maxChars)
  const budget = maxChars - TRUNCATION_SUFFIX.length
  if (typeof state === "string") {
    return state.length <= maxChars ? state : state.slice(0, budget) + TRUNCATION_SUFFIX
  }
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(state)
  } catch {
    return "[unserializable state]"
  }
  if (serialized === undefined) return state
  return serialized.length <= maxChars ? state : serialized.slice(0, budget) + TRUNCATION_SUFFIX
}

function stateText(state: unknown): string | undefined {
  if (typeof state === "string") return state
  try {
    return JSON.stringify(state)
  } catch {
    return undefined
  }
}

/** Collect bounded state fragments as well as the whole serialization for error redaction. */
function stateSecrets(state: unknown): readonly unknown[] {
  const secrets: unknown[] = [stateText(state)]
  const pending: unknown[] = [state]
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value === "string") {
      secrets.push(value)
      // Oversized object states are passed to the client as a truncated JSON
      // prefix string. Recover complete JSON string tokens in that prefix so
      // a provider error that echoes one field value is still scrubbed.
      for (const match of value.matchAll(/"(?:\\.|[^"\\])*"/g)) {
        try {
          const decoded: unknown = JSON.parse(match[0])
          if (typeof decoded === "string") secrets.push(decoded)
        } catch {
          // An incomplete token at the truncation boundary is not decodable.
        }
      }
      continue
    }
    if (Array.isArray(value)) {
      pending.push(...value)
      continue
    }
    if (isPlainObject(value)) {
      for (const [key, nested] of Object.entries(value)) {
        secrets.push(key)
        pending.push(nested)
      }
    }
  }
  return secrets
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return "unknown error"
  }
}

/** Replaces every occurrence of a secret with "[redacted]" (long values only). */
function redactSecrets(text: string, secrets: readonly unknown[]): string {
  let redacted = text
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < REDACTION_MIN_CHARS) continue
    redacted = redacted.split(secret).join("[redacted]")
  }
  return redacted
}

// ---------------------------------------------------------------------------
// Input validation (boundary, fail closed)
// ---------------------------------------------------------------------------

type QuestionsParse =
  | { readonly ok: true; readonly questions: Record<string, JevQuestion> }
  | { readonly ok: false; readonly reason: string }

function checkQuestion(value: unknown, label: string): string | undefined {
  if (!isPlainObject(value)) return `${label} must be an object`
  if (value.type !== "noul" && value.type !== "choice" && value.type !== "score") {
    return `${label}.type must be "noul" | "choice" | "score"`
  }
  if (typeof value.instructions !== "string" || value.instructions.length === 0) {
    return `${label}.instructions must be a non-empty string`
  }
  if (value.type === "choice") {
    if (!isPlainObject(value.criteria) || Object.values(value.criteria).some((entry) => typeof entry !== "string")) {
      return `${label}.criteria must be an object mapping choice names to descriptions`
    }
  }
  if (value.type === "score") {
    if (!Array.isArray(value.criteria) || value.criteria.length === 0 || value.criteria.some((entry) => typeof entry !== "string")) {
      return `${label}.criteria must be a non-empty array of strings`
    }
  }
  return undefined
}

/** Normalizes `Record<string, Question> | Question[]` (array -> index keys, Pi parity). */
function parseQuestions(raw: unknown): QuestionsParse {
  if (raw === undefined) {
    return { ok: false, reason: 'jev.ask requires "questions" (an object of questions or an array of questions)' }
  }
  const normalized: Record<string, JevQuestion> = {}
  if (Array.isArray(raw)) {
    if (raw.length === 0) return { ok: false, reason: "questions must contain at least one question" }
    for (let index = 0; index < raw.length; index += 1) {
      const problem = checkQuestion(raw[index], `questions[${index}]`)
      if (problem) return { ok: false, reason: problem }
      normalized[String(index)] = raw[index] as JevQuestion
    }
    return { ok: true, questions: normalized }
  }
  if (!isPlainObject(raw)) return { ok: false, reason: "questions must be an object of questions or an array of questions" }
  for (const [key, value] of Object.entries(raw)) {
    const problem = checkQuestion(value, `questions[${JSON.stringify(key)}]`)
    if (problem) return { ok: false, reason: problem }
    normalized[key] = value as JevQuestion
  }
  if (Object.keys(normalized).length === 0) return { ok: false, reason: "questions must contain at least one question" }
  return { ok: true, questions: normalized }
}

function parseJevAskInput(
  input: unknown,
): { readonly ok: true; readonly state: unknown; readonly questions: Record<string, JevQuestion> } | { readonly ok: false; readonly reason: string } {
  if (!isPlainObject(input)) return { ok: false, reason: "jev.ask input must be an object { state, questions }" }
  const questions = parseQuestions(input.questions)
  if (!questions.ok) return questions
  return { ok: true, state: input.state, questions: questions.questions }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Default factory: gate on the key FIRST (the SDK constructor throws when the
 * key is missing), then lazily import the optional SDK. The specifier is
 * non-literal so neither the compiler nor the runtime require the package
 * until a call actually happens; any load failure resolves null (data).
 */
async function defaultJevClientFactory(apiKey: string): Promise<JevClient | null> {
  const specifier = "@typesafe-ai/sdk"
  try {
    const module = (await import(specifier)) as {
      TypeSafeClient?: new (config: { apiKey: string; logLevel: string }) => unknown
    }
    const TypeSafeClient = module?.TypeSafeClient
    if (typeof TypeSafeClient !== "function") return null
    return new TypeSafeClient({ apiKey, logLevel: "off" }) as JevClient
  } catch {
    return null
  }
}

/**
 * Awaits `client.systemOne` under this port's bounds: a hard timeout (the SDK
 * gets the same value via RequestOptions and the abort signal), caller
 * cancellation, and one SDK retry. Losing promises are guarded so a late
 * rejection never surfaces as an unhandled rejection.
 */
async function callBounded(
  client: JevClient,
  request: JevRequest,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<unknown> {
  const controller = new AbortController()
  const callerSignal = options.signal
  if (callerSignal?.aborted) throw new Error(JEV_CANCELLED_MESSAGE)
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason)
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutFailure = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`Jev request timed out after ${options.timeoutMs}ms`))
      }, options.timeoutMs)
    })
    const cancellation = new Promise<never>((_, reject) => {
      if (!callerSignal) return
      callerSignal.addEventListener("abort", () => reject(new Error(JEV_CANCELLED_MESSAGE)), { once: true })
    })
    const pending = Promise.resolve(
      client.systemOne(request, {
        signal: controller.signal,
        timeout: options.timeoutMs,
        retry: { maxRetries: 1 },
      }),
    )
    void pending.catch(() => undefined)
    return await Promise.race([pending, timeoutFailure, cancellation])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    callerSignal?.removeEventListener("abort", onCallerAbort)
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Runs one `jev.ask`. Every failure mode is DATA (DispatchOutcome), never a
 * thrown exception across the boundary: policy opt-out ("mode"), malformed
 * input ("input"), missing credential / SDK ("unavailable"), oversized
 * payloads ("limit"), cancellation ("cancelled"), and transport/API errors
 * ("io", scrubbed and bounded).
 */
export async function askJev(input: unknown, jev: JevEnvironment, signal?: AbortSignal): Promise<DispatchOutcome> {
  if (!jev.policy.enabled) return dispatchError("mode", JEV_DISABLED_MESSAGE)
  if (signal?.aborted) return dispatchError("cancelled", JEV_CANCELLED_MESSAGE)

  const parsed = parseJevAskInput(input)
  if (!parsed.ok) return dispatchError("input", parsed.reason)

  const env = jev.env ?? process.env
  const apiKey = (env.TYPESAFE_API_KEY ?? "").trim()
  if (apiKey.length === 0) return dispatchError("unavailable", JEV_NO_KEY_MESSAGE)

  let client: JevClient | null
  try {
    client = await (jev.clientFactory ?? defaultJevClientFactory)(apiKey)
  } catch {
    client = null
  }
  if (client === null) return dispatchError("unavailable", JEV_SDK_MISSING_MESSAGE)

  const state = truncateJevState(parsed.state, JEV_STATE_MAX_CHARS)
  const stateWasTruncated = state !== parsed.state
  const request: JevRequest = { state, questions: parsed.questions, model: jev.policy.model }
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(request)
  } catch {
    serialized = undefined
  }
  if (serialized === undefined) return dispatchError("input", "jev.ask input must be JSON-serializable")
  if (byteLength(serialized) > JEV_INPUT_MAX_BYTES) {
    return dispatchError("limit", `jev.ask input exceeds the 50 KiB (${JEV_INPUT_MAX_BYTES}-byte) bound`)
  }

  const secrets: readonly unknown[] = [apiKey, ...stateSecrets(state)]

  try {
    const result = await callBounded(client, request, { timeoutMs: jev.policy.timeoutMs, signal })
    const answers = isPlainObject(result) ? result.answers : undefined
    if (!isPlainObject(answers)) return dispatchError("io", "Jev response is missing 'answers'")
    let answerBytes: number
    try {
      answerBytes = byteLength(JSON.stringify(answers) ?? "")
    } catch {
      return dispatchError("io", "Jev answers are not JSON-serializable")
    }
    if (answerBytes > JEV_ANSWERS_MAX_BYTES) {
      return dispatchError("limit", `Jev answers exceed the 50 KiB (${JEV_ANSWERS_MAX_BYTES}-byte) bound`)
    }
    return { ok: true, data: answers }
  } catch (error) {
    if (signal?.aborted) return dispatchError("cancelled", JEV_CANCELLED_MESSAGE)
    if (stateWasTruncated) {
      return dispatchError("io", "Jev request failed; provider error details were omitted because the state was truncated.")
    }
    const bounded = redactSecrets(errorText(error), secrets).slice(0, JEV_ERROR_MAX_CHARS)
    return dispatchError("io", redactSecrets(bounded, secrets))
  }
}

/** The dispatcher adapter for `jev.ask` (group "jev"; re-validated at dispatch). */
export function createJevCapabilities(jev: JevEnvironment): DispatchCapability[] {
  return [
    {
      name: "jev.ask",
      group: "jev",
      run: (input, dispatchEnv) => askJev(input, jev, dispatchEnv.signal),
    },
  ]
}

/**
 * Task 11: one truthful, bounded availability line for `/codemode jev`.
 * Probes exactly what the call path gates on — the policy opt-out, the host
 * credential (presence only), and the optional SDK (loaded lazily; no network
 * call happens). The credential value never leaves this function.
 */
export async function jevStatusMessage(jev: JevEnvironment): Promise<string> {
  if (!jev.policy.enabled) return JEV_DISABLED_MESSAGE
  const env = jev.env ?? process.env
  const apiKey = (env.TYPESAFE_API_KEY ?? "").trim()
  if (apiKey.length === 0) return JEV_NO_KEY_MESSAGE
  let client: JevClient | null
  try {
    client = await (jev.clientFactory ?? defaultJevClientFactory)(apiKey)
  } catch {
    client = null
  }
  if (client === null) return JEV_SDK_MISSING_MESSAGE
  return `jev is available: TYPESAFE_API_KEY is set and @typesafe-ai/sdk is installed (model "${jev.policy.model}", timeout ${jev.policy.timeoutMs}ms).`
}
