// tests/unit/jev.test.ts
// Task 10 acceptance: the optional TypeSafe `jev.ask(state, questions)` guest
// capability behind explicit credential presence and an optional SDK adapter.
//
// Design (recorded decisions):
//   - The `jev` guest surface is POLICY-derived, exactly like cli/mcp: it
//     exists iff the jev capability group is on (mode != off AND
//     options.jev.enabled !== false). Runtime availability of the SDK and the
//     API key is answered by the HOST adapter at call time as a bounded
//     "unavailable" DispatchOutcome carrying an actionable message ("tell the
//     user how to enable it") — the attempted-use status path.
//   - Credentials stay host-side: the API key comes from the HOST environment
//     (TYPESAFE_API_KEY; never a guest input, never a Pi config path), the
//     guest globals and the typechecker declaration carry no credential, and
//     error text is scrubbed of the key and the (truncated) state before it
//     can reach logs or tool results.
//   - Pi parity defaults (research §2.13): model "jev-latest", timeout 8000 ms,
//     state bound 12000 chars, array questions normalized to index keys.
//   - The SDK is an OPTIONAL dependency loaded lazily per call through an
//     injectable factory; when absent (MODULE_NOT_FOUND / factory null) the
//     call path resolves a bounded outcome and nothing crashes.
import { describe, expect, test } from "bun:test"
import {
  JEV_ANSWERS_MAX_BYTES,
  JEV_DECLARATION,
  JEV_DISABLED_MESSAGE,
  JEV_GLOBAL_NAME,
  JEV_INPUT_MAX_BYTES,
  JEV_NO_KEY_MESSAGE,
  JEV_SDK_MISSING_MESSAGE,
  JEV_STATE_MAX_CHARS,
  askJev,
  createJevCapabilities,
  jevStatusMessage,
  truncateJevState,
} from "../../src/capabilities/jev"
import type { JevClient, JevEnvironment, JevQuestion } from "../../src/capabilities/jev"
import { executeTools, formatExecuteToolsResult } from "../../src/codemode/execute-tools"
import { buildTypeDefs } from "../../src/codemode/globals"
import { resolvePolicy } from "../../src/config/load-policy"
import { DEFAULT_JEV, capabilitiesFor, defaultPolicy } from "../../src/config/policy"
import type { Capabilities, Mode } from "../../src/config/policy"
import { registerExecuteTools } from "../../src/plugin/register"

const SENTINEL_KEY = "TST-SENTINEL-KEY-7f3a9c2d"
const SENTINEL_STATE = "TST-SENTINEL-STATE-2b8c1d"

// ---------------------------------------------------------------------------
// Fakes: a recording client and an injectable environment
// ---------------------------------------------------------------------------

function fakeClient(behavior: (request: unknown, options: unknown) => unknown): {
  client: JevClient
  calls: Array<{ request: any; options: any }>
} {
  const calls: Array<{ request: any; options: any }> = []
  const client: JevClient = {
    systemOne: (request, options) => {
      calls.push({ request, options })
      return Promise.resolve(behavior(request, options))
    },
  }
  return { client, calls }
}

function mkEnv(
  envVars: Readonly<Record<string, string | undefined>>,
  clientFactory?: JevEnvironment["clientFactory"],
): JevEnvironment {
  return { policy: DEFAULT_JEV, env: envVars, clientFactory: clientFactory ?? (async () => null) }
}

const noulQuestion: JevQuestion = { type: "noul", instructions: "Is the sky blue?" }

// ---------------------------------------------------------------------------
// Policy: the strict, fail-closed `jev` option
// ---------------------------------------------------------------------------

describe("policy: jev option (strict, fail-closed)", () => {
  test("the Pi-parity defaults are preserved and jev defaults to enabled", () => {
    expect(DEFAULT_JEV).toEqual({ enabled: true, model: "jev-latest", timeoutMs: 8_000 })
    const { policy, errors } = resolvePolicy(undefined)
    expect(errors).toEqual([])
    expect(policy.jev).toEqual({ enabled: true, model: "jev-latest", timeoutMs: 8_000 })
  })

  test("a valid jev option is applied and `enabled: false` closes the capability group", () => {
    const { policy, errors } = resolvePolicy({ jev: { enabled: false, model: "jev-test", timeoutMs: 1500 } })
    expect(errors).toEqual([])
    expect(policy.jev).toEqual({ enabled: false, model: "jev-test", timeoutMs: 1500 })
    expect(capabilitiesFor(policy).jev).toBe(false)
  })

  test("malformed jev values fail closed like every other option", () => {
    const malformed: unknown[] = [
      { jev: "on" },
      { jev: { enabled: "yes" } },
      { jev: { model: "" } },
      { jev: { model: 7 } },
      { jev: { timeoutMs: 0 } },
      { jev: { timeoutMs: 1.5 } },
      { jev: { timeoutMs: 120_000 } },
      { jev: { extra: true } },
    ]
    for (const options of malformed) {
      const { policy, errors } = resolvePolicy(options)
      expect(errors.length).toBeGreaterThan(0)
      expect(policy.source).toBe("fail-closed")
      expect(policy.mode).toBe("off")
      expect(policy.jev.enabled).toBe(false)
      expect(capabilitiesFor(policy).jev).toBe(false)
    }
  })

  test("the project overlay may narrow jev but never enable a disabled global", () => {
    const narrowed = resolvePolicy({ jev: { enabled: true }, project: { jev: { enabled: false } } })
    expect(narrowed.policy.jev.enabled).toBe(false)
    expect(narrowed.policy.source).toBe("project")

    const widenedAttempt = resolvePolicy({ jev: { enabled: false }, project: { jev: { enabled: true } } })
    expect(widenedAttempt.policy.jev.enabled).toBe(false)
    expect(widenedAttempt.notes.join(" ")).toContain("narrow-only")

    const modelOverride = resolvePolicy({ project: { jev: { model: "proj-model", timeoutMs: 2000 } } })
    expect(modelOverride.policy.jev.model).toBe("proj-model")
    expect(modelOverride.policy.jev.timeoutMs).toBe(2000)

    const malformedProject = resolvePolicy({ project: { jev: { enabled: "nope" } } })
    expect(malformedProject.policy.source).toBe("fail-closed")
  })

  test("capability groups: jev follows the policy and dies with mode off", () => {
    expect(capabilitiesFor(defaultPolicy()).jev).toBe(true)
    expect(capabilitiesFor({ ...defaultPolicy(), mode: "off" }).jev).toBe(false)
    expect(capabilitiesFor({ ...defaultPolicy(), jev: { ...DEFAULT_JEV, enabled: false } }).jev).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// askJev: availability with an actionable optional-feature status
// ---------------------------------------------------------------------------

describe("askJev availability (actionable optional-feature status)", () => {
  test("absent API key reports an actionable unavailable status without touching the factory", async () => {
    let factoryCalled = 0
    const jev = mkEnv({}, async () => {
      factoryCalled += 1
      return null
    })
    const outcome = await askJev({ state: "s", questions: { q: noulQuestion } }, jev)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("unavailable")
      expect(outcome.error.message).toBe(JEV_NO_KEY_MESSAGE)
      expect(outcome.error.message).toContain("TYPESAFE_API_KEY")
      expect(outcome.error.message).toContain("@typesafe-ai/sdk")
      expect(outcome.error.message).toContain("optional")
      expect(outcome.error.message).toContain("enable")
      expect(outcome.error.message.length).toBeLessThan(512)
    }
    expect(factoryCalled).toBe(0)
  })

  test("a missing SDK (MODULE_NOT_FOUND from the factory) is unavailable without crashing", async () => {
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => {
      throw Object.assign(new Error("Cannot find module '@typesafe-ai/sdk'"), { code: "MODULE_NOT_FOUND" })
    })
    const outcome = await askJev({ state: "s", questions: { q: noulQuestion } }, jev)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("unavailable")
      expect(outcome.error.message).toBe(JEV_SDK_MISSING_MESSAGE)
      expect(outcome.error.message).toContain("@typesafe-ai/sdk")
      expect(outcome.error.message).toContain("optional")
      expect(outcome.error.message.length).toBeLessThan(512)
    }
  })

  test("a factory resolving null (SDK absent) is unavailable with the same status", async () => {
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => null)
    const outcome = await askJev({ state: "s", questions: { q: noulQuestion } }, jev)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("unavailable")
      expect(outcome.error.message).toBe(JEV_SDK_MISSING_MESSAGE)
    }
  })

  test("`enabled: false` with credentials present is unavailable with the opt-out status", async () => {
    let factoryCalled = 0
    const jev: JevEnvironment = {
      policy: { ...DEFAULT_JEV, enabled: false },
      env: { TYPESAFE_API_KEY: SENTINEL_KEY },
      clientFactory: async () => {
        factoryCalled += 1
        return null
      },
    }
    const outcome = await askJev({ state: "s", questions: { q: noulQuestion } }, jev)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("mode")
      expect(outcome.error.message).toBe(JEV_DISABLED_MESSAGE)
      expect(outcome.error.message).toContain("options.jev.enabled")
      expect(outcome.error.message).toContain("optional")
    }
    expect(factoryCalled).toBe(0)
  })

  test("malformed input shapes are bounded input errors before any client work", async () => {
    let factoryCalled = 0
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => {
      factoryCalled += 1
      return null
    })
    const cases: unknown[] = [
      "not-an-object",
      { state: "s" },
      { state: "s", questions: "nope" },
      { state: "s", questions: [42] },
      { state: "s", questions: { q: { type: "wat", instructions: "x" } } },
      { state: "s", questions: { q: { type: "noul" } } },
      { state: "s", questions: { q: { type: "choice", instructions: "x" } } },
      { state: "s", questions: { q: { type: "score", instructions: "x", criteria: "no" } } },
    ]
    for (const input of cases) {
      const outcome = await askJev(input, jev)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error.kind).toBe("input")
    }
    expect(factoryCalled).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// askJev success path: request mapping, normalization, bounds
// ---------------------------------------------------------------------------

describe("askJev success path (Pi-parity mapping and bounds)", () => {
  test("maps state/questions/model and passes bounded SDK RequestOptions", async () => {
    const answers = { q: { type: "noul", noul: 1, confidence: 0.9 } }
    const { client, calls } = fakeClient(() => ({ answers }))
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => client)
    const state = { task: "summarize", items: [1, 2, 3] }

    const outcome = await askJev({ state, questions: { q: noulQuestion } }, jev)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.data).toEqual(answers)

    expect(calls.length).toBe(1)
    expect(calls[0].request).toEqual({ state, questions: { q: noulQuestion }, model: "jev-latest" })
    expect(calls[0].options.timeout).toBe(8_000)
    expect(calls[0].options.retry).toEqual({ maxRetries: 1 })
    expect(calls[0].options.signal).toBeInstanceOf(AbortSignal)
    expect(calls[0].options.signal.aborted).toBe(false)
  })

  test("array questions normalize to index keys (Pi parity) and policy overrides apply", async () => {
    const { client, calls } = fakeClient(() => ({ answers: {} }))
    const jej: JevEnvironment = {
      policy: { enabled: true, model: "jev-test", timeoutMs: 500 },
      env: { TYPESAFE_API_KEY: SENTINEL_KEY },
      clientFactory: async () => client,
    }
    const questions: JevQuestion[] = [
      { type: "noul", instructions: "one" },
      { type: "score", instructions: "two", criteria: ["a", "b"] },
    ]
    const outcome = await askJev({ state: "x", questions }, jej)
    expect(outcome.ok).toBe(true)
    expect(calls[0].request.model).toBe("jev-test")
    expect(calls[0].request.questions).toEqual({ "0": questions[0], "1": questions[1] })
    expect(calls[0].options.timeout).toBe(500)
  })

  test("state over the 12000-char bound truncates with the Pi suffix (string and object)", () => {
    const atBound = "x".repeat(JEV_STATE_MAX_CHARS)
    expect(truncateJevState(atBound, JEV_STATE_MAX_CHARS)).toBe(atBound)

    const over = "x".repeat(JEV_STATE_MAX_CHARS + 5)
    const truncated = truncateJevState(over, JEV_STATE_MAX_CHARS) as string
    expect(typeof truncated).toBe("string")
    expect(truncated.length).toBe(JEV_STATE_MAX_CHARS)
    expect(truncated.endsWith("…[truncated]")).toBe(true)

    const small = { a: 1 }
    expect(truncateJevState(small, JEV_STATE_MAX_CHARS)).toBe(small)

    const bigObject = { blob: "y".repeat(JEV_STATE_MAX_CHARS + 5) }
    const truncatedObject = truncateJevState(bigObject, JEV_STATE_MAX_CHARS) as string
    expect(typeof truncatedObject).toBe("string")
    expect(truncatedObject.endsWith("…[truncated]")).toBe(true)
  })

  test("the guest wire state is truncated before the client sees it", async () => {
    const { client, calls } = fakeClient(() => ({ answers: {} }))
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => client)
    const outcome = await askJev({ state: "z".repeat(JEV_STATE_MAX_CHARS + 100), questions: { q: noulQuestion } }, jev)
    expect(outcome.ok).toBe(true)
    const wireState = calls[0].request.state as string
    expect(wireState.length).toBe(JEV_STATE_MAX_CHARS)
    expect(wireState.endsWith("…[truncated]")).toBe(true)
  })

  test("oversized inputs and answers stay bounded", async () => {
    const { client } = fakeClient(() => ({ answers: {} }))
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => client)
    const huge = await askJev(
      { state: "s", questions: { q: { type: "score", instructions: "i".repeat(JEV_INPUT_MAX_BYTES), criteria: ["a", "b"] } } },
      jev,
    )
    expect(huge.ok).toBe(false)
    if (!huge.ok) {
      expect(huge.error.kind).toBe("limit")
      expect(huge.error.message).toContain("50 KiB")
    }

    const { client: bigClient } = fakeClient(() => ({
      answers: { q: { type: "score", score: 1, blob: "b".repeat(JEV_ANSWERS_MAX_BYTES) } },
    }))
    const bigJev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => bigClient)
    const bigAnswers = await askJev({ state: "s", questions: { q: noulQuestion } }, bigJev)
    expect(bigAnswers.ok).toBe(false)
    if (!bigAnswers.ok) {
      expect(bigAnswers.error.kind).toBe("limit")
      expect(bigAnswers.error.message).toContain("50 KiB")
    }
  })

  test("a response without an answers object is a bounded io error", async () => {
    const { client } = fakeClient(() => ({}))
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => client)
    const outcome = await askJev({ state: "s", questions: { q: noulQuestion } }, jev)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("io")
      expect(outcome.error.message).toContain("answers")
    }
  })

  test("a client failure is a bounded io error carrying the sanitized message", async () => {
    const { client } = fakeClient(() => {
      throw new Error("Something broke upstream")
    })
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => client)
    const outcome = await askJev({ state: "s", questions: { q: noulQuestion } }, jev)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("io")
      expect(outcome.error.message).toContain("Something broke upstream")
    }
  })
})

// ---------------------------------------------------------------------------
// askJev bounds: timeout and cancellation
// ---------------------------------------------------------------------------

describe("askJev bounds (timeout, cancellation)", () => {
  test("a hanging client is stopped by the bounded timeout and receives the aborted signal", async () => {
    const { client, calls } = fakeClient(() => new Promise(() => {}))
    const jev: JevEnvironment = {
      policy: { enabled: true, model: "jev-latest", timeoutMs: 25 },
      env: { TYPESAFE_API_KEY: SENTINEL_KEY },
      clientFactory: async () => client,
    }
    const started = Date.now()
    const outcome = await askJev({ state: "s", questions: { q: noulQuestion } }, jev)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("io")
      expect(outcome.error.message).toContain("timed out after 25ms")
    }
    expect(calls[0].options.signal.aborted).toBe(true)
  })

  test("a pre-aborted caller signal cancels before any client work", async () => {
    let factoryCalled = 0
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => {
      factoryCalled += 1
      return null
    })
    const controller = new AbortController()
    controller.abort()
    const outcome = await askJev({ state: "s", questions: { q: noulQuestion } }, jev, controller.signal)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("cancelled")
      expect(outcome.error.message).toBe("Execution cancelled")
    }
    expect(factoryCalled).toBe(0)
  })

  test("a caller abort while the call is pending cancels the call", async () => {
    const { client } = fakeClient(() => new Promise(() => {}))
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => client)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)
    const outcome = await askJev({ state: "s", questions: { q: noulQuestion } }, jev, controller.signal)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("cancelled")
      expect(outcome.error.message).toBe("Execution cancelled")
    }
  })
})

// ---------------------------------------------------------------------------
// Redaction: credentials and state never leak into outcomes, logs, or types
// ---------------------------------------------------------------------------

describe("redaction (host-only credentials)", () => {
  test("error text echoing the key or the state is scrubbed before it reaches the outcome", async () => {
    const { client } = fakeClient(() => {
      throw new Error(`auth failed for ${SENTINEL_KEY} while classifying ${SENTINEL_STATE}`)
    })
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => client)
    const outcome = await askJev({ state: SENTINEL_STATE, questions: { q: noulQuestion } }, jev)
    expect(outcome.ok).toBe(false)
    const serialized = JSON.stringify(outcome)
    expect(serialized).not.toContain(SENTINEL_KEY)
    expect(serialized).not.toContain(SENTINEL_STATE)
    if (!outcome.ok) expect(outcome.error.message).toContain("[redacted]")
  })

  test("error text echoing a nested state value is scrubbed before it reaches the outcome", async () => {
    const nestedSecret = "NESTED-STATE-SECRET-59e7d2"
    const state = { task: { privateValue: nestedSecret } }
    const { client } = fakeClient(() => {
      throw new Error(`provider rejected value ${nestedSecret}`)
    })
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => client)
    const outcome = await askJev({ state, questions: { q: noulQuestion } }, jev)

    expect(outcome.ok).toBe(false)
    const serialized = JSON.stringify(outcome)
    expect(serialized).not.toContain(nestedSecret)
    if (!outcome.ok) expect(outcome.error.message).toContain("[redacted]")
  })

  test("provider error details are suppressed when a nested state value is truncated", async () => {
    const partialSecret = "TRUNCATED-NESTED-STATE-SECRET-7a21"
    const state = { task: { privateValue: partialSecret + "x".repeat(JEV_STATE_MAX_CHARS * 2) } }
    const { client } = fakeClient(() => {
      throw new Error(`provider echoed ${partialSecret}`)
    })
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => client)
    const outcome = await askJev({ state, questions: { q: noulQuestion } }, jev)

    expect(outcome.ok).toBe(false)
    const serialized = JSON.stringify(outcome)
    expect(serialized).not.toContain(partialSecret)
    if (!outcome.ok) expect(outcome.error.message).toContain("details were omitted")
  })

  test("the successful call path leaks neither the key nor the state into results or logs", async () => {
    const calls: string[] = []
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    }
    const record = (...args: unknown[]) => {
      calls.push(args.map((arg) => String(arg)).join(" "))
    }
    console.log = record
    console.info = record
    console.warn = record
    console.error = record
    console.debug = record
    try {
      const { client } = fakeClient(() => ({ answers: { q: { type: "noul", noul: 1 } } }))
      const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => client)
      const outcome = await askJev({ state: SENTINEL_STATE, questions: { q: noulQuestion } }, jev)
      expect(outcome.ok).toBe(true)
      const envelope = JSON.stringify(outcome)
      expect(envelope).not.toContain(SENTINEL_KEY)
      expect(envelope).not.toContain(SENTINEL_STATE)
      expect(calls.join("\n")).not.toContain(SENTINEL_KEY)
      expect(calls.join("\n")).not.toContain(SENTINEL_STATE)
    } finally {
      console.log = original.log
      console.info = original.info
      console.warn = original.warn
      console.error = original.error
      console.debug = original.debug
    }
  })

  test("the typechecker declaration carries generic shapes only — no credential, no key lookup", () => {
    expect(JEV_GLOBAL_NAME).toBe("jev")
    expect(JEV_DECLARATION).toContain("declare const jev:")
    expect(JEV_DECLARATION).toContain("ask(state: unknown")
    expect(JEV_DECLARATION).not.toContain(SENTINEL_KEY)
    expect(JEV_DECLARATION).not.toContain("TYPESAFE_API_KEY")
    const defs = buildTypeDefs({ jev: true })
    expect(defs).toContain("declare const jev:")
    expect(defs).not.toContain(SENTINEL_KEY)
    expect(defs).not.toContain("TYPESAFE_API_KEY")
  })
})

// ---------------------------------------------------------------------------
// The guest surface through the real pipeline (execute_tools -> QuickJS)
// ---------------------------------------------------------------------------

function hostFor(jev?: JevEnvironment, mode: Mode = "on", caps?: Partial<Capabilities>) {
  const capabilities = { ...capabilitiesFor({ ...defaultPolicy(), mode }), ...caps }
  return { mode, capabilities, root: undefined, cli: {}, jev }
}

describe("jev guest surface through execute_tools", () => {
  test("with the capability on, jev.ask is declared, callable, and returns answers", async () => {
    const { client, calls } = fakeClient(() => ({ answers: { verdict: { type: "noul", noul: 1 } } }))
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => client)
    const result = await executeTools(
      `
      const shape = { name: typeof jev, ask: typeof jev.ask }
      const questions: JevQuestion[] = [{ type: "noul", instructions: "Is this a test?" }]
      const answers: JevAnswers = await jev.ask("pipeline state", questions)
      return { shape, answers }
      `,
      { host: hostFor(jev), timeoutMs: 20_000 },
    )
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toEqual({
      shape: { name: "object", ask: "function" },
      answers: { verdict: { type: "noul", noul: 1 } },
    })
    expect(calls[0].request.state).toBe("pipeline state")
    expect(calls[0].request.questions).toEqual({ "0": { type: "noul", instructions: "Is this a test?" } })
  }, 30_000)

  test("with no jev environment the surface is absent and naming jev is a type error before execution", async () => {
    const absent = await executeTools(`return "jev" in globalThis`, { host: hostFor(undefined), timeoutMs: 20_000 })
    expect(absent.errorKind).toBeUndefined()
    expect(absent.result).toBe(false)

    const typed = await executeTools(`return await jev.ask("s", [])`, { host: hostFor(undefined), timeoutMs: 20_000 })
    expect(typed.errorKind).toBe("type")
    expect(typed.error ?? "").toContain("jev")
  }, 30_000)

  test("`enabled: false` (capability group off) also removes the surface even with credentials", async () => {
    const { client } = fakeClient(() => ({ answers: {} }))
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => client)
    const result = await executeTools(`return "jev" in globalThis`, {
      host: hostFor(jev, "on", { jev: false }),
      timeoutMs: 20_000,
    })
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toBe(false)
  }, 30_000)

  test("an absent API key surfaces the actionable status inside the guest (no crash)", async () => {
    const jev = mkEnv({})
    const result = await executeTools(
      `
      try {
        await jev.ask("state", [{ type: "noul", instructions: "q" }])
        return "unexpected success"
      } catch (error) {
        return (error as Error).message
      }
      `,
      { host: hostFor(jev), timeoutMs: 20_000 },
    )
    expect(result.errorKind).toBeUndefined()
    const message = result.result as string
    expect(message).toContain("TYPESAFE_API_KEY")
    expect(message).toContain("@typesafe-ai/sdk")
    expect(message).toContain("optional")
  }, 30_000)

  test("a missing SDK surfaces the actionable install status inside the guest", async () => {
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => {
      throw Object.assign(new Error("Cannot find module '@typesafe-ai/sdk'"), { code: "MODULE_NOT_FOUND" })
    })
    const result = await executeTools(
      `
      try {
        await jev.ask("state", [{ type: "noul", instructions: "q" }])
        return "unexpected success"
      } catch (error) {
        return (error as Error).message
      }
      `,
      { host: hostFor(jev), timeoutMs: 20_000 },
    )
    expect(result.errorKind).toBeUndefined()
    expect(result.result as string).toContain("install @typesafe-ai/sdk")
  }, 30_000)

  test("credentials never enter the guest globals or the tool envelope", async () => {
    const calls: string[] = []
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug }
    const record = (...args: unknown[]) => {
      calls.push(args.map((arg) => String(arg)).join(" "))
    }
    console.log = record
    console.info = record
    console.warn = record
    console.error = record
    console.debug = record
    try {
      const { client } = fakeClient(() => ({ answers: { q: { type: "noul", noul: 1 } } }))
      const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => client)
      const result = await executeTools(
        `
        const globalsLeak = JSON.stringify(globalThis).includes("TST-SENTINEL")
        const answers = await jev.ask("TST-SENTINEL-STATE-2b8c1d", [{ type: "noul", instructions: "q" }])
        return { globalsLeak, answers }
        `,
        { host: hostFor(jev), timeoutMs: 20_000 },
      )
      expect(result.errorKind).toBeUndefined()
      expect((result.result as { globalsLeak: boolean }).globalsLeak).toBe(false)
      const envelope = JSON.stringify({
        content: formatExecuteToolsResult(result),
        logs: result.logs,
        result: result.result,
      })
      expect(envelope).not.toContain(SENTINEL_KEY)
      expect(envelope).not.toContain(SENTINEL_STATE)
      expect(calls.join("\n")).not.toContain(SENTINEL_KEY)
      expect(calls.join("\n")).not.toContain(SENTINEL_STATE)
    } finally {
      console.log = original.log
      console.info = original.info
      console.warn = original.warn
      console.error = original.error
      console.debug = original.debug
    }
  }, 30_000)

  test("the dispatcher re-checks the jev capability group even when a handler is wired", async () => {
    const { client } = fakeClient(() => ({ answers: {} }))
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => client)
    const capabilities = createJevCapabilities(jev)
    const { createDispatcher } = await import("../../src/codemode/dispatch")
    const dispatcher = createDispatcher(capabilities, {
      mode: "on",
      capabilities: { executeTools: true, files: true, cli: false, shell: false, mcp: false, jev: false },
      root: undefined,
    })
    const outcome = await dispatcher.dispatch({ capability: "jev.ask", input: { state: "s", questions: { q: noulQuestion } } })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("mode")
      expect(outcome.error.message).toContain("not enabled")
    }
  })
})

// ---------------------------------------------------------------------------
// Registered-tool wiring (the gate threads the jev policy into the pipeline)
// ---------------------------------------------------------------------------

type CapturedTool = {
  name: string
  execute: (input: unknown, context: unknown) => Promise<{ content?: string; metadata?: Record<string, unknown> }>
}

function makeToolHarness() {
  let captured: CapturedTool | undefined
  const ctx = {
    app: { name: "opencode", version: "2.0.29", channel: "latest" },
    location: {
      directory: "C:/tmp/oc-codemode-jev",
      project: { id: "p1", directory: "C:/tmp/oc-codemode-jev", canonical: "C:/tmp/oc-codemode-jev" },
    },
    options: {},
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        const editor = {
          namespace: () => {},
          add: (tool: CapturedTool) => {
            captured = tool
          },
          update: () => {},
          remove: () => {},
          list: () => [],
          get: () => undefined,
        }
        callback(editor)
        return { dispose: async () => {} }
      },
      list: async () => [],
      reload: async () => {},
      hook: async () => ({ dispose: async () => {} }),
    },
    command: {
      transform: async (callback: (editor: { add: (definition: unknown) => void }) => void) => {
        callback({ add: () => {} })
        return { dispose: async () => {} }
      },
    },
    permission: {
      hook: async () => ({ dispose: async () => {} }),
    },
    storage: {
      get: async () => undefined,
      set: async () => {},
      remove: async () => {},
      scan: async () => ({}),
    },
  } as any
  return {
    ctx,
    run: (input: unknown) =>
      captured!.execute(input, {
        sessionID: "ses_jev",
        agent: "build",
        messageID: "msg_jev",
        id: "call_jev",
        signal: new AbortController().signal,
        progress: async () => {},
      }),
  }
}

describe("registered-tool wiring", () => {
  test("the gate threads the jev policy: the surface is present when the group is on", async () => {
    const harness = makeToolHarness()
    await registerExecuteTools(harness.ctx, {
      jevPolicyForSession: () => ({ ...DEFAULT_JEV, enabled: true }),
    })
    const response = await harness.run({ code: `return "jev" in globalThis` })
    expect(response.metadata?.errorKind).toBeUndefined()
    expect(response.content).toBe("true")
  }, 30_000)

  test("the surface is absent when the session's capability groups exclude jev", async () => {
    const harness = makeToolHarness()
    await registerExecuteTools(harness.ctx, {
      capabilitiesForSession: () => ({ ...capabilitiesFor(defaultPolicy()), jev: false }),
      jevPolicyForSession: () => ({ ...DEFAULT_JEV, enabled: false }),
    })
    const response = await harness.run({ code: `return "jev" in globalThis` })
    expect(response.metadata?.errorKind).toBeUndefined()
    expect(response.content).toBe("false")
  }, 30_000)
})

// ---------------------------------------------------------------------------
// jevStatusMessage (Task 11: the `/codemode jev` status path)
// ---------------------------------------------------------------------------

describe("jevStatusMessage (/codemode jev status)", () => {
  test("a disabled policy reports the opt-out message", async () => {
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => null)
    expect(await jevStatusMessage({ ...jev, policy: { ...DEFAULT_JEV, enabled: false } })).toBe(JEV_DISABLED_MESSAGE)
  })

  test("an absent credential reports the actionable no-key message without touching the factory", async () => {
    let calls = 0
    const jev = mkEnv({}, async () => {
      calls += 1
      return null
    })
    expect(await jevStatusMessage(jev)).toBe(JEV_NO_KEY_MESSAGE)
    expect(calls).toBe(0)
  })

  test("a key with a missing SDK reports the install status", async () => {
    const absent = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => null)
    expect(await jevStatusMessage(absent)).toBe(JEV_SDK_MISSING_MESSAGE)

    const throwing = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => {
      throw Object.assign(new Error("Cannot find module '@typesafe-ai/sdk'"), { code: "MODULE_NOT_FOUND" })
    })
    expect(await jevStatusMessage(throwing)).toBe(JEV_SDK_MISSING_MESSAGE)
  })

  test("a configured key and SDK reports ready without echoing the key", async () => {
    const { client } = fakeClient(() => ({ answers: {} }))
    const jev = mkEnv({ TYPESAFE_API_KEY: SENTINEL_KEY }, async () => client)
    const message = await jevStatusMessage(jev)
    expect(message).toContain("available")
    expect(message).toContain("jev-latest")
    expect(message).not.toContain(SENTINEL_KEY)
  })
})
