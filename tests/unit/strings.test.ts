// tests/unit/strings.test.ts
// Task 9 acceptance: the execute_tools `strings` input and the typed
// `π.<key>` guest binding for hard-to-quote values.
//
// Pi-exact semantics (source-verified in pi-codemode-src):
//   - the `π` global ALWAYS exists; absent strings install as {} —
//     quickjs-executor.ts:134-136 sets π to `options?.strings ?? {}`
//   - missing keys are plain property reads -> undefined (stable)
//   - typechecker declaration is unconditional:
//     `declare const π: Readonly<Record<string, string>>;` (type-generator.ts:386-387)
//   - cleanup nulls π before vm.dispose (quickjs-executor.ts:297)
//
// Port bounds (documented divergence): Pi performs no size validation on
// `strings`; this port rejects invalid shape/values at the tool boundary as a
// bounded "input" error BEFORE any guest execution, and caps the total
// JSON-serialized payload at 50 KiB (the port's shared bound).
//
// Values are per-execution data: never persisted across executions, never
// shared, never logged by host code paths.
import { describe, expect, test } from "bun:test"
import { executeTools, formatExecuteToolsResult } from "../../src/codemode/execute-tools"
import { STRINGS_GLOBAL_NAME, STRINGS_MAX_BYTES, validateStrings } from "../../src/codemode/strings"
import { buildTypeDefs } from "../../src/codemode/globals"
import { registerExecuteTools } from "../../src/plugin/register"

const byteLength = (value: string) => new TextEncoder().encode(value).length

// Fake-ctx harness for the registered execute_tools tool; same pattern as
// tests/integration/execute-tools.test.ts (record the editor passed to
// ctx.tool.transform, then drive the captured tool).
type CapturedTool = {
  name: string
  input: {
    properties: Record<
      string,
      {
        type: string
        description?: string
        propertyNames?: { type: string }
        additionalProperties?: { type: string }
      }
    >
  }
  execute: (input: unknown, context: unknown) => Promise<{ content?: string; metadata?: Record<string, unknown> }>
}

function makeToolHarness() {
  let captured: CapturedTool | undefined
  const ctx = {
    app: { name: "opencode", version: "2.0.29", channel: "latest" },
    location: {
      directory: "C:/tmp/oc-codemode-strings",
      project: { id: "p1", directory: "C:/tmp/oc-codemode-strings", canonical: "C:/tmp/oc-codemode-strings" },
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
    getCaptured: (): CapturedTool => {
      if (!captured) throw new Error("tool was not registered")
      return captured
    },
  }
}

async function callRegisteredTools(input: unknown) {
  const harness = makeToolHarness()
  await registerExecuteTools(harness.ctx)
  return harness.getCaptured().execute(input, {
    sessionID: "ses_strings",
    agent: "build",
    messageID: "msg_strings",
    id: "call_strings",
    signal: new AbortController().signal,
    progress: async () => {},
  })
}

describe("validateStrings (tool-boundary validation)", () => {
  test("absent input (undefined) is valid and installs an empty object", () => {
    const result = validateStrings(undefined)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.strings).toEqual({})
  })

  test("accepts plain objects with Unicode string keys and string values", () => {
    const result = validateStrings({ "ключ": "значение", "🔑": "emoji-value", plain: "x" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.strings["ключ"]).toBe("значение")
      expect(result.strings["🔑"]).toBe("emoji-value")
    }
  })

  test("rejects non-object shapes: string, number, boolean, null, array", () => {
    for (const bad of ["str", 7, true, null, ["a"]]) {
      const result = validateStrings(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain("plain object")
    }
  })

  test("rejects empty-string keys", () => {
    const result = validateStrings({ "": "value" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("non-empty")
  })

  test("rejects non-string values: number, null, nested object, array, boolean", () => {
    for (const bad of [{ k: 1 }, { k: null }, { k: { nested: "x" } }, { k: ["a"] }, { k: false }]) {
      const result = validateStrings(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain("must be a string")
    }
  })

  test("rejects a payload over the 50 KiB serialized bound and accepts the bound exactly", () => {
    const overhead = byteLength(JSON.stringify({ k: "" }))
    const atBound = { k: "x".repeat(STRINGS_MAX_BYTES - overhead) }
    expect(byteLength(JSON.stringify(atBound))).toBe(STRINGS_MAX_BYTES)
    expect(validateStrings(atBound).ok).toBe(true)
    const over = { k: "x".repeat(STRINGS_MAX_BYTES - overhead + 1) }
    const result = validateStrings(over)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("50 KiB")
  })

  test("rejects a circular payload predictably instead of throwing", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const result = validateStrings(circular)
    expect(result.ok).toBe(false)
  })

  test("error messages never echo invalid values", () => {
    const result = validateStrings({ k: { secret: "SECRET-STRING-VALUE-4f9" } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).not.toContain("SECRET-STRING-VALUE-4f9")
  })

  test("exposes the exact Pi global name and declaration", () => {
    expect(STRINGS_GLOBAL_NAME).toBe("π")
    expect(buildTypeDefs()).toContain("declare const π: Readonly<Record<string, string>>;")
  })
})

describe("π guest surface (Pi-exact semantics)", () => {
  test("round-trips values that are hard to quote: quotes, newlines, backticks, ${}", async () => {
    const value = 'He said "hi" to \'you\'\nwith `backticks` and ${not_interpolated} and \\ backslash'
    const result = await executeTools(`return π.text`, { strings: { text: value } })
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toBe(value)
  }, 15_000)

  test("Unicode keys are addressable in the guest", async () => {
    const result = await executeTools(`return [π["ключ"], π["🔑"]]`, {
      strings: { "ключ": "значение", "🔑": "emoji-value" },
    })
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toEqual(["значение", "emoji-value"])
  }, 15_000)

  test("missing keys are stable undefined property reads", async () => {
    const result = await executeTools(`return { t: typeof π.missing, has: "missing" in π }`, {
      strings: { present: "x" },
    })
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toEqual({ t: "undefined", has: false })
  }, 15_000)

  test("π exists as an empty object when no strings are supplied", async () => {
    const result = await executeTools(`return { t: typeof π, keys: Object.keys(π).length }`)
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toEqual({ t: "object", keys: 0 })
  }, 15_000)

  test("a body referencing π.key typechecks and returns the supplied value", async () => {
    const result = await executeTools(`const s: string = π.script\nprint("len", s.length)\nreturn s`, {
      strings: { script: "echo hello" },
    })
    expect(result.errorKind).toBeUndefined()
    expect(result.logs).toEqual(["len 10"])
    expect(result.result).toBe("echo hello")
  }, 15_000)
})

describe("input rejection and bounds (no execution, bounded errors)", () => {
  test("invalid strings values return a bounded input error before any guest execution", async () => {
    const result = await executeTools(`print("SIDE-EFFECT-RAN")`, { strings: { bad: 1 } })
    expect(result.errorKind).toBe("input")
    expect(result.logs).toEqual([])
    expect(result.result).toBeUndefined()
    expect(result.error).toContain("must be a string")
    const text = formatExecuteToolsResult(result)
    expect(text).toContain("Input error:")
    expect(text).not.toContain("SIDE-EFFECT-RAN")
  }, 15_000)

  test("nested objects, null, and non-object strings all return input errors (no execution)", async () => {
    const cases: unknown[] = [{ k: { nested: true } }, { k: null }, "not an object", ["k"], 42]
    for (const strings of cases) {
      const result = await executeTools(`print("SIDE-EFFECT-RAN")`, { strings })
      expect(result.errorKind).toBe("input")
      expect(result.logs).toEqual([])
      expect(formatExecuteToolsResult(result)).not.toContain("SIDE-EFFECT-RAN")
    }
  }, 30_000)

  test("an oversized strings payload is refused with the documented limit (no execution)", async () => {
    const result = await executeTools(`print("SIDE-EFFECT-RAN")`, {
      strings: { big: "x".repeat(STRINGS_MAX_BYTES) },
    })
    expect(result.errorKind).toBe("input")
    expect(result.error).toContain("50 KiB")
    expect(result.logs).toEqual([])
  }, 15_000)
})

describe("per-execution isolation and logging", () => {
  test("values are per-execution: a later execution without strings never sees earlier values", async () => {
    const first = await executeTools(`return π.secret`, { strings: { secret: "alpha" } })
    expect(first.errorKind).toBeUndefined()
    expect(first.result).toBe("alpha")
    const second = await executeTools(`return { t: typeof π.secret, keys: Object.keys(π) }`)
    expect(second.errorKind).toBeUndefined()
    expect(second.result).toEqual({ t: "undefined", keys: [] })
    const third = await executeTools(`return typeof π.secret`, { strings: { other: "beta" } })
    expect(third.errorKind).toBeUndefined()
    expect(third.result).toBe("undefined")
  }, 30_000)

  test("values never reach the host console or the tool result envelope", async () => {
    const secret = "SECRET-PI-VALUE-9f3c1a"
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
      const result = await executeTools(`print("len", π.secret.length)\nreturn π.secret.length`, {
        strings: { secret },
      })
      expect(result.errorKind).toBeUndefined()
      expect(result.result).toBe(secret.length)
      expect(result.logs).toEqual([`len ${secret.length}`])
      expect(calls.join("\n")).not.toContain(secret)
      const envelope = JSON.stringify({ content: formatExecuteToolsResult(result), logs: result.logs, result: result.result })
      expect(envelope).not.toContain(secret)
    } finally {
      console.log = original.log
      console.info = original.info
      console.warn = original.warn
      console.error = original.error
      console.debug = original.debug
    }
  }, 15_000)
})

describe("execute_tools tool wiring", () => {
  test("the input schema declares strings as a string-to-string record and mentions π", async () => {
    const harness = makeToolHarness()
    await registerExecuteTools(harness.ctx)
    const schema = harness.getCaptured().input.properties.strings!
    expect(schema.type).toBe("object")
    expect(schema.propertyNames).toEqual({ type: "string" })
    expect(schema.additionalProperties).toEqual({ type: "string" })
    expect(schema.description ?? "").toContain("π")
    expect(schema.description ?? "").not.toContain("ignored")
  })

  test("supplied strings flow from the tool input through the pipeline to the guest", async () => {
    const response = await callRegisteredTools({ code: `return π.k`, strings: { k: "v-from-tool" } })
    expect(response.content).toBe("v-from-tool")
    expect(response.metadata?.errorKind).toBeUndefined()
  }, 15_000)

  test("invalid strings through the tool input return an input error and nothing executes", async () => {
    const response = await callRegisteredTools({ code: `print("SIDE-EFFECT-RAN")`, strings: { k: 42 } })
    expect(response.metadata?.errorKind).toBe("input")
    expect(response.content).toContain("Input error:")
    expect(response.content).not.toContain("SIDE-EFFECT-RAN")
  }, 15_000)
})
