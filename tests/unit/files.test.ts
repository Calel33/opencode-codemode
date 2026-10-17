// tests/unit/files.test.ts
// Task 5 acceptance: root-scoped read/write/edit guest helpers routed through
// the single guest->host dispatcher (src/codemode/dispatch.ts) to host file
// adapters (src/capabilities/files.ts) with path policy in src/security/paths.ts.
//
// Every guest-facing assertion runs THROUGH execute_tools (checkpoint-2 rule:
// capabilities are exercised via the pipeline, not only via helper functions);
// the dispatch-level tests below additionally pin the stable T6/T7 interface.
//
// Filesystem isolation: mkdtempSync temp roots (fake-ctx harness pattern from
// tests/enforcement.test.ts). Root and outside dir are created once; the root
// contains both an escaping link and an in-root link.
//
// Windows symlink evidence (probed on this host, 2026-10-16): file symlinks
// fail with EPERM (SeCreateSymbolicLinkPrivilege absent, no developer mode);
// directory junctions succeed. The escape tests therefore use directory
// junctions/symlinks — the same realpath-escape path a file symlink exercises.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { createDispatcher, createHostCall } from "../../src/codemode/dispatch"
import { MAX_OUTPUT_BYTES, executeTools } from "../../src/codemode/execute-tools"
import { MAX_READ_BYTES, MAX_READ_FILE_BYTES, MAX_WRITE_BYTES, createFileCapabilities } from "../../src/capabilities/files"
import { capabilitiesFor, defaultPolicy } from "../../src/config/policy"
import type { Capabilities, Mode } from "../../src/config/policy"
import { registerExecuteTools } from "../../src/plugin/register"
import { resolveActiveRoot } from "../../src/security/paths"

const root = mkdtempSync(join(tmpdir(), "codemode-files-"))
const outside = mkdtempSync(join(tmpdir(), "codemode-outside-"))
const SECRET = "outside-secret-content"
const LINK_TYPE: "junction" | "dir" = process.platform === "win32" ? "junction" : "dir"

writeFileSync(join(outside, "secret.txt"), SECRET, "utf-8")
writeFileSync(join(root, "notes.txt"), "hello files", "utf-8")
writeFileSync(join(root, "ten.txt"), Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n"), "utf-8")
writeFileSync(join(root, "edit.txt"), "alpha beta gamma", "utf-8")
writeFileSync(join(root, "dup.txt"), "xx yy xx", "utf-8")

// escape link -> outside dir; in-root link -> real-sub (positive control)
symlinkSync(outside, join(root, "jump"), LINK_TYPE)
mkdirSync(join(root, "real-sub"), { recursive: true })
writeFileSync(join(root, "real-sub", "ok.txt"), "inside-ok", "utf-8")
symlinkSync(join(root, "real-sub"), join(root, "inside-link"), LINK_TYPE)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const byteLength = (value: string): number => new TextEncoder().encode(value).length

interface HostEnv {
  readonly mode: Mode
  readonly capabilities: Capabilities
  readonly root: string | undefined
}

function hostWith(rootPath: string | undefined, mode: Mode = "on"): HostEnv {
  return { mode, capabilities: capabilitiesFor({ ...defaultPolicy(), mode }), root: rootPath }
}

function onHost(mode: Mode = "on"): HostEnv {
  return hostWith(root, mode)
}

async function runGuest(code: string, host: HostEnv = onHost()) {
  return executeTools(code, { host, timeoutMs: 20_000 })
}

function makeToolHarness() {
  let captured: {
    execute: (input: unknown, context: unknown) => Promise<{ content?: string; metadata?: Record<string, unknown> }>
  } | undefined
  const ctx = {
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        const editor = { add: (tool: unknown) => { captured = tool as typeof captured } }
        callback(editor)
        return { dispose: async () => {} }
      },
    },
  } as any
  return {
    ctx,
    call: async (code: string) => {
      if (!captured) throw new Error("tool was not registered")
      return captured.execute({ code }, { sessionID: "ses_task5", signal: new AbortController().signal, progress: async () => {} })
    },
  }
}

describe("guest file helpers through execute_tools (in-root happy path)", () => {
  test("read returns the exact in-root file content", async () => {
    const result = await runGuest(`const content = await read({ path: "notes.txt" }); return content`)
    expect(result.errorKind).toBeUndefined()
    expect(result.result).toBe("hello files")
  }, 30_000)

  test("write creates exact content (nested parents) and overwrites exactly", async () => {
    const result = await runGuest(`
      await write({ path: "nested/deep/created.txt", content: "exact-content\\nsecond" })
      await write({ path: "overwrite.txt", content: "first" })
      await write({ path: "overwrite.txt", content: "second" })
      print("done")
    `)
    expect(result.errorKind).toBeUndefined()
    expect(result.logs).toEqual(["done"])
    expect(readFileSync(join(root, "nested", "deep", "created.txt"), "utf-8")).toBe("exact-content\nsecond")
    expect(readFileSync(join(root, "overwrite.txt"), "utf-8")).toBe("second")
  }, 30_000)

  test("edit applies an exact unique replacement and reports the count", async () => {
    const result = await runGuest(`return await edit({ path: "edit.txt", edits: [{ oldText: "beta", newText: "BETA" }] })`)
    expect(result.errorKind).toBeUndefined()
    expect(String(result.result)).toContain("Replaced 1")
    expect(readFileSync(join(root, "edit.txt"), "utf-8")).toBe("alpha BETA gamma")
  }, 30_000)

  test("edit with oldText not found or ambiguous is structured error data; the file is unchanged", async () => {
    const notFound = await runGuest(`
      try { await edit({ path: "edit.txt", edits: [{ oldText: "no-such-text-anywhere", newText: "x" }] }) }
      catch (e) { print("caught", (e as Error).message) }
      return "handled"
    `)
    expect(notFound.errorKind).toBeUndefined()
    expect(notFound.logs.join("\n")).toContain("oldText not found")
    expect(readFileSync(join(root, "edit.txt"), "utf-8")).toBe("alpha BETA gamma")

    // Uncaught: the pipeline returns a bounded runtime error, never a crash.
    const uncaught = await runGuest(`await edit({ path: "edit.txt", edits: [{ oldText: "no-such-text-anywhere", newText: "x" }] })`)
    expect(uncaught.errorKind).toBe("runtime")
    expect(uncaught.error ?? "").toContain("oldText not found")
    expect(readFileSync(join(root, "edit.txt"), "utf-8")).toBe("alpha BETA gamma")

    const ambiguous = await runGuest(`await edit({ path: "dup.txt", edits: [{ oldText: "xx", newText: "yy" }] })`)
    expect(ambiguous.errorKind).toBe("runtime")
    expect(ambiguous.error ?? "").toContain("matches 2 times")
    expect(readFileSync(join(root, "dup.txt"), "utf-8")).toBe("xx yy xx")
  }, 30_000)
})

describe("path containment (traversal, symlink escapes, Windows forms)", () => {
  test("relative .. traversal out of the root is denied (read and write)", async () => {
    const relSecret = relative(root, join(outside, "secret.txt"))
    const relPlanted = relative(root, join(outside, "planted.txt"))
    const result = await runGuest(`
      const messages: string[] = []
      try { await read({ path: ${JSON.stringify(relSecret)} }) } catch (e) { messages.push((e as Error).message) }
      try { await write({ path: ${JSON.stringify(relPlanted)}, content: "x" }); messages.push("write-allowed") } catch (e) { messages.push((e as Error).message) }
      try { await read({ path: "real-sub/../../escaped.txt" }) } catch (e) { messages.push((e as Error).message) }
      return messages
    `)
    expect(result.errorKind).toBeUndefined()
    const messages = result.result as string[]
    expect(messages).toHaveLength(3)
    for (const message of messages) expect(message).toContain("outside the project root")
    expect(existsSync(join(outside, "planted.txt"))).toBe(false)
    expect(JSON.stringify(result)).not.toContain(SECRET)
  }, 30_000)

  test("a link inside the root pointing outside is denied (read and write); in-root links still work", async () => {
    const result = await runGuest(`
      const messages: string[] = []
      try { await read({ path: "jump/secret.txt" }); messages.push("read-allowed") } catch (e) { messages.push("read:" + (e as Error).message) }
      try { await write({ path: "jump/planted.txt", content: "x" }); messages.push("write-allowed") } catch (e) { messages.push("write:" + (e as Error).message) }
      const inside = await read({ path: "inside-link/ok.txt" })
      return { messages, inside }
    `)
    expect(result.errorKind).toBeUndefined()
    const { messages, inside } = result.result as { messages: string[]; inside: string }
    expect(messages[0]).toStartWith("read:")
    expect(messages[0]).toContain("outside the project root")
    expect(messages[1]).toStartWith("write:")
    expect(messages[1]).toContain("outside the project root")
    expect(messages).not.toContain("read-allowed")
    expect(messages).not.toContain("write-allowed")
    expect(inside).toBe("inside-ok")
    expect(existsSync(join(outside, "planted.txt"))).toBe(false)
  }, 30_000)

  test("Windows drive paths and drive-relative forms are handled", async () => {
    const absoluteOutside = join(outside, "secret.txt")
    const forwardSlashOutside = absoluteOutside.replace(/\\/g, "/")
    const result = await runGuest(`
      const messages: string[] = []
      try { await read({ path: ${JSON.stringify(absoluteOutside)} }) } catch (e) { messages.push((e as Error).message) }
      try { await read({ path: ${JSON.stringify(forwardSlashOutside)} }) } catch (e) { messages.push((e as Error).message) }
      try { await read({ path: "C:secret.txt" }) } catch (e) { messages.push((e as Error).message) }
      return messages
    `)
    expect(result.errorKind).toBeUndefined()
    const messages = result.result as string[]
    expect(messages).toHaveLength(3)
    expect(messages[0]).toContain("outside the project root")
    expect(messages[1]).toContain("outside the project root")
    expect(messages[2]).toMatch(/drive-relative/i)
  }, 30_000)

  test("policy-protected paths (.mcp.json, .pi/) are refused for writes regardless of casing", async () => {
    const result = await runGuest(`
      const messages: string[] = []
      try { await write({ path: ".mcp.json", content: "{}" }); messages.push("allowed-mcp") } catch (e) { messages.push((e as Error).message) }
      try { await write({ path: ".MCP.JSON", content: "{}" }); messages.push("allowed-upper-mcp") } catch (e) { messages.push((e as Error).message) }
      try { await write({ path: ".pi/notes.json", content: "{}" }); messages.push("allowed-pi") } catch (e) { messages.push((e as Error).message) }
      try { await write({ path: ".PI/notes.json", content: "{}" }); messages.push("allowed-upper-pi") } catch (e) { messages.push((e as Error).message) }
      try { await write({ path: "sub/.pi/notes.json", content: "{}" }); messages.push("allowed-subpi") } catch (e) { messages.push((e as Error).message) }
      try { await write({ path: "sub/.PI/notes.json", content: "{}" }); messages.push("allowed-sub-upper-pi") } catch (e) { messages.push((e as Error).message) }
      return messages
    `)
    expect(result.errorKind).toBeUndefined()
    const messages = result.result as string[]
    expect(messages).toHaveLength(6)
    for (const message of messages) expect(message).toContain("policy-protected")
    expect(existsSync(join(root, ".mcp.json"))).toBe(false)
    expect(existsSync(join(root, ".MCP.JSON"))).toBe(false)
    expect(existsSync(join(root, ".pi"))).toBe(false)
    expect(existsSync(join(root, ".PI"))).toBe(false)
  }, 30_000)
})

describe("fail closed (mode, capabilities, root, host availability)", () => {
  test("mode off denies helper calls defensively even inside execute_tools", async () => {
    const result = await runGuest(`await read({ path: "notes.txt" })`, onHost("off"))
    expect(result.errorKind).toBe("runtime")
    expect(result.error ?? "").toMatch(/CodeMode is off/)
    expect(JSON.stringify(result)).not.toContain("hello files")
  }, 30_000)

  test("the dispatcher re-checks the files capability group even when the mode is on", async () => {
    const dispatcher = createDispatcher(createFileCapabilities(), {
      mode: "on",
      capabilities: { executeTools: true, files: false, cli: false, shell: false, mcp: false, jev: false },
      root,
    })
    const outcome = await dispatcher.dispatch({ capability: "read", input: { path: "notes.txt" } })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("mode")
      expect(outcome.error.message).toContain("not enabled")
    }
  })

  test("an unknown root fails closed for read, write, and edit", async () => {
    const readAttempt = await runGuest(`await read({ path: "notes.txt" })`, hostWith(undefined))
    expect(readAttempt.errorKind).toBe("runtime")
    expect(readAttempt.error ?? "").toMatch(/root is unknown/i)

    const writeAttempt = await runGuest(`await write({ path: "ghost.txt", content: "x" })`, hostWith(undefined))
    expect(writeAttempt.error ?? "").toMatch(/root is unknown/i)
    expect(existsSync(join(root, "ghost.txt"))).toBe(false)

    const editAttempt = await runGuest(`await edit({ path: "edit.txt", edits: [{ oldText: "alpha", newText: "A" }] })`, hostWith(undefined))
    expect(editAttempt.error ?? "").toMatch(/root is unknown/i)
    expect(readFileSync(join(root, "edit.txt"), "utf-8")).toBe("alpha BETA gamma")
  }, 30_000)

  test("without a host environment the helpers report unavailable instead of silently no-oping", async () => {
    const result = await executeTools(
      `try { await read({ path: "notes.txt" }) } catch (e) { print("caught:", (e as Error).message) }`,
      { timeoutMs: 20_000 },
    )
    expect(result.errorKind).toBeUndefined()
    expect(result.logs.join("\n")).toContain("unavailable")
  }, 30_000)

  test("the register gate refuses off sessions before the guest runs", async () => {
    const harness = makeToolHarness()
    await registerExecuteTools(harness.ctx, { modeForSession: () => "off" })
    const result = await harness.call(`await read({ path: "notes.txt" })`)
    expect(result.metadata?.errorKind).toBe("mode")
    expect(result.content ?? "").toContain("CodeMode is off")
  }, 30_000)

  test("the register gate threads the active root: unknown fails closed, resolved succeeds end to end", async () => {
    const unknownRoot = makeToolHarness()
    await registerExecuteTools(unknownRoot.ctx, { modeForSession: () => "on", activeRoot: undefined })
    const denied = await unknownRoot.call(`await write({ path: "gate-ghost.txt", content: "x" })`)
    expect(denied.content ?? "").toMatch(/root is unknown/i)
    expect(existsSync(join(root, "gate-ghost.txt"))).toBe(false)

    const resolvedRoot = makeToolHarness()
    await registerExecuteTools(resolvedRoot.ctx, { modeForSession: () => "on", activeRoot: root })
    const accepted = await resolvedRoot.call(`await write({ path: "gate-written.txt", content: "via-gate" }); print("done")`)
    expect(accepted.content ?? "").toContain("done")
    expect(readFileSync(join(root, "gate-written.txt"), "utf-8")).toBe("via-gate")
  }, 30_000)
})

describe("bounded reads and writes", () => {
  test("offset/limit slice lines; out-of-range offsets return empty; malformed offsets are input errors", async () => {
    const sliced = await runGuest(`const s = await read({ path: "ten.txt", offset: 2, limit: 3 }); return s`)
    expect(sliced.result).toBe("l2\nl3\nl4")

    const limited = await runGuest(`const s = await read({ path: "ten.txt", limit: 2 }); return s`)
    expect(limited.result).toBe("l0\nl1")

    const pastEnd = await runGuest(`const s = await read({ path: "ten.txt", offset: 99 }); return s`)
    expect(pastEnd.result).toBe("")

    const badOffset = await runGuest(`await read({ path: "ten.txt", offset: -1 })`)
    expect(badOffset.errorKind).toBe("runtime")
    expect(badOffset.error ?? "").toMatch(/offset/)
  }, 30_000)

  test("a read larger than 50 KiB is capped with an explicit marker", async () => {
    expect(MAX_READ_BYTES).toBe(MAX_OUTPUT_BYTES) // semantics reused from execute-tools.ts (documented)
    writeFileSync(join(root, "big.txt"), "x".repeat(60 * 1024), "utf-8")

    // Adapter cap, proven exactly at the dispatcher boundary: the returned
    // string is bounded at MAX_READ_BYTES and carries this adapter's marker.
    const hostCall = createHostCall(createDispatcher(createFileCapabilities(), onHost()))
    const response = JSON.parse(await hostCall(JSON.stringify({ capability: "read", input: { path: "big.txt" } })))
    expect(response.ok).toBe(true)
    expect(byteLength(response.data)).toBeLessThanOrEqual(MAX_READ_BYTES)
    expect(response.data.endsWith("[truncated at 50 KiB]")).toBe(true)

    // Through the full pipeline the same value stays bounded: execute_tools
    // additionally caps its serialized result at 50 KiB (Task 3), which can
    // substitute its own marker on top — both are explicit and bounded.
    const result = await runGuest(`const s = await read({ path: "big.txt" }); return s`)
    expect(result.errorKind).toBeUndefined()
    const content = String(result.result)
    expect(byteLength(content)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES + 100)
    expect(content).toContain("truncated at 50 KiB")
    expect(content.length).toBeLessThan(60 * 1024)
  }, 30_000)

  test("files larger than the whole-file guard are refused with a limit error", async () => {
    writeFileSync(join(root, "huge.txt"), "h".repeat(MAX_READ_FILE_BYTES + 1))
    const result = await runGuest(`await read({ path: "huge.txt" })`)
    expect(result.errorKind).toBe("runtime")
    expect(result.error ?? "").toMatch(/too large/i)
  }, 30_000)

  test("edit refuses files larger than the whole-file guard without changing them", async () => {
    const path = join(root, "huge-edit.txt")
    writeFileSync(path, "h".repeat(MAX_READ_FILE_BYTES + 1) + "TARGET-UNIQUE")

    const result = await runGuest(`await edit({ path: "huge-edit.txt", edits: [{ oldText: "TARGET-UNIQUE", newText: "done" }] })`)

    expect(result.errorKind).toBe("runtime")
    expect(result.error ?? "").toMatch(/too large/i)
    expect(readFileSync(path, "utf-8").endsWith("TARGET-UNIQUE")).toBe(true)
  }, 30_000)

  test("edit replacement payloads obey the write-content limit", async () => {
    const path = join(root, "edit-limit.txt")
    writeFileSync(path, "target")

    const result = await runGuest(
      `await edit({ path: "edit-limit.txt", edits: [{ oldText: "target", newText: "x".repeat(${MAX_WRITE_BYTES + 1}) }] })`,
    )

    expect(result.errorKind).toBe("runtime")
    expect(result.error ?? "").toMatch(/too large/i)
    expect(readFileSync(path, "utf-8")).toBe("target")
  }, 30_000)

  test("a write above the content cap is refused and writes nothing", async () => {
    const result = await runGuest(`await write({ path: "big-out.txt", content: "y".repeat(${MAX_WRITE_BYTES + 1}) })`)
    expect(result.errorKind).toBe("runtime")
    expect(result.error ?? "").toMatch(/too large/i)
    expect(existsSync(join(root, "big-out.txt"))).toBe(false)
  }, 30_000)
})

describe("pipeline order: type error before side effects", () => {
  test("a type error prevents the write helper from running at all", async () => {
    const result = await runGuest(`await write({ path: "never.txt", content: "x" })\nconst n: number = "not a number"`)
    expect(result.errorKind).toBe("type")
    expect(result.diagnostics?.length ?? 0).toBeGreaterThan(0)
    expect(existsSync(join(root, "never.txt"))).toBe(false)
  }, 30_000)
})

describe("dispatcher contract (the stable T6/T7 extension surface)", () => {
  const env = { mode: "on" as Mode, capabilities: capabilitiesFor(defaultPolicy()), root }

  test("capabilityNames lists the files slice surface", () => {
    expect(createDispatcher(createFileCapabilities(), env).capabilityNames).toEqual(["read", "write", "edit"])
  })

  test("unknown capabilities and malformed requests are error data, never throws", async () => {
    const dispatcher = createDispatcher(createFileCapabilities(), env)
    const unknown = await dispatcher.dispatch({ capability: "cli.git.status", input: {} })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error.kind).toBe("unknown-capability")

    const malformed = await dispatcher.dispatch("nonsense")
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.error.kind).toBe("input")

    const nonJson = JSON.parse(await createHostCall(dispatcher)("not json {"))
    expect(nonJson.ok).toBe(false)
    expect(nonJson.error.kind).toBe("input")
  })

  test("createHostCall round-trips the JSON protocol end to end", async () => {
    const hostCall = createHostCall(createDispatcher(createFileCapabilities(), env))
    const response = JSON.parse(await hostCall(JSON.stringify({ capability: "read", input: { path: "notes.txt" } })))
    expect(response).toEqual({ ok: true, data: "hello files" })
  })
})

describe("resolveActiveRoot (active checkout root resolution)", () => {
  test("canonicalizes an existing checkout directory and prefers it over project.canonical", () => {
    const resolved = resolveActiveRoot({ directory: root, project: { canonical: outside } })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.root).toBe(realpathSync(root))
      expect(resolved.source).toBe("directory")
    }
  })

  test("falls back to project.canonical when directory is unusable", () => {
    const resolved = resolveActiveRoot({ directory: "relative/not-absolute", project: { canonical: root } })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.root).toBe(realpathSync(root))
      expect(resolved.source).toBe("project.canonical")
    }
  })

  test("fails closed for absent, relative, missing, or non-directory targets", () => {
    const candidates: unknown[] = [
      undefined,
      null,
      {},
      { directory: "" },
      { directory: "relative/path" },
      { directory: join(root, "does-not-exist") },
      { directory: join(root, "notes.txt") }, // exists but is a file
      { directory: join(root, "does-not-exist"), project: { canonical: join(root, "also-missing") } },
    ]
    for (const location of candidates) {
      const resolved = resolveActiveRoot(location as any)
      expect(resolved.ok).toBe(false)
    }
  })

})
