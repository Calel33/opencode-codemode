// tests/unit/enumerate.test.ts
// In-process enumerated CLI operations (find.files / grep.search / ls.list):
// host-side Node-fs implementations declared by the CLI catalog
// (src/capabilities/cli.ts) but never spawned — no PATH lookup,
// OS-independent. Window's `ls` (PowerShell alias), `grep` (absent) and
// `find.exe` (an unrelated string-search utility) are the motivation; these
// tests pin the semantics the README documents as deliberate deviations.
//
// Covered here, against a real temp root:
//   - ls: one level only, dotfile filtering, root-relative names, long shape;
//   - find: maxDepth semantics (start point = depth 0), case-sensitive
//     basename -name globs, type filters, .git/node_modules skipping,
//     symlinked directories listed but never followed;
//   - grep: recursive vs top-level, ignoreCase, invalid regex as input error,
//     binary skip, match cap and line cap with honest truncation flags;
//   - path containment (relative escapes and absolute outside paths);
//   - the runCliOperation branch wiring (gate, validation, in-process run).
//
// Filesystem isolation: mkdtempSync temp roots; the symlink fixture uses a
// directory junction on Windows (file symlinks need privileges — same pattern
// as tests/unit/files.test.ts).
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join, relative } from "node:path"

import { createCliCapabilities } from "../../src/capabilities/cli"
import {
  ENUMERATED_OPERATIONS,
  GREP_MAX_LINE_CHARS,
  GREP_MAX_MATCHES,
  isEnumeratedOperation,
  runEnumeratedOperation,
} from "../../src/capabilities/enumerate"
import { createDispatcher } from "../../src/codemode/dispatch"
import { capabilitiesFor, defaultPolicy } from "../../src/config/policy"
import type { CliAllowlist, Mode } from "../../src/config/policy"

const root = mkdtempSync(join(tmpdir(), "codemode-enum-"))
const outside = mkdtempSync(join(tmpdir(), "codemode-enum-outside-"))
const LINK_TYPE: "junction" | "dir" = process.platform === "win32" ? "junction" : "dir"

mkdirSync(join(root, "sub", "deep"), { recursive: true })
mkdirSync(join(root, ".hidden"), { recursive: true })
mkdirSync(join(root, ".git"), { recursive: true })
mkdirSync(join(root, "node_modules", "pkg"), { recursive: true })
writeFileSync(join(root, "alpha.ts"), "export const alpha = 1\n", "utf-8")
writeFileSync(join(root, "beta.ts"), "export const beta = 2\n", "utf-8")
writeFileSync(join(root, "notes.txt"), "hello files\nneedle at top\n", "utf-8")
writeFileSync(join(root, ".dotfile"), "hidden\n", "utf-8")
writeFileSync(join(root, "binary.bin"), Buffer.from("needle\u0000needle"))
writeFileSync(join(root, ".hidden", "secret.ts"), "export const hidden = 0\n", "utf-8")
writeFileSync(join(root, "sub", "inner.ts"), "export const needle = 1\n", "utf-8")
writeFileSync(join(root, "sub", "deep", "deeper.ts"), "export const deeper = 3\n", "utf-8")
writeFileSync(join(root, ".git", "config"), "git\n", "utf-8")
writeFileSync(join(root, "node_modules", "pkg", "index.ts"), "export const pkg = 4\n", "utf-8")
writeFileSync(
  join(root, "many.txt"),
  Array.from({ length: GREP_MAX_MATCHES + 5 }, (_, index) => `hitline ${index}`).join("\n") + "\n",
  "utf-8",
)
writeFileSync(join(root, "longline.txt"), `hitline ${"x".repeat(GREP_MAX_LINE_CHARS * 2)}\n`, "utf-8")
writeFileSync(join(outside, "secret.txt"), "outside\n", "utf-8")
symlinkSync(join(root, "sub"), join(root, "linked"), LINK_TYPE)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const CAPABILITIES = { executeTools: true, files: true, cli: true, shell: false, mcp: false, jev: false }

type Outcome = ReturnType<typeof runEnumeratedOperation>

function runWithEnv(
  tool: string,
  operation: string,
  args: Record<string, unknown>,
  rootPath: string | undefined,
): Outcome {
  return runEnumeratedOperation(tool, operation, args, { mode: "on", capabilities: CAPABILITIES, root: rootPath })
}

function run(tool: string, operation: string, args: Record<string, unknown>): Outcome {
  return runWithEnv(tool, operation, args, root)
}

function output(outcome: Outcome): { lines: string[]; truncated: boolean; exitCode: number } {
  if (!outcome.ok) throw new Error(`expected ok outcome, got ${outcome.error.kind}: ${outcome.error.message}`)
  const data = outcome.data as { stdout: string; exitCode: number; truncated: { stdout: boolean; stderr: boolean } }
  return {
    lines: data.stdout === "" ? [] : data.stdout.split("\n"),
    truncated: data.truncated.stdout,
    exitCode: data.exitCode,
  }
}

function failure(outcome: Outcome): { kind: string; message: string } {
  if (outcome.ok) throw new Error("expected a failed outcome")
  return outcome.error
}

describe("ls.list (one level, root-relative, deterministic order)", () => {
  test("lists only the immediate children, dotfiles excluded by default", () => {
    const result = output(run("ls", "list", {}))
    expect(result.lines).toEqual([
      "alpha.ts",
      "beta.ts",
      "binary.bin",
      "linked",
      "longline.txt",
      "many.txt",
      "node_modules",
      "notes.txt",
      "sub",
    ])
    expect(result.exitCode).toBe(0)
    expect(result.truncated).toBe(false)
  })

  test("all includes dot-entries (ls never skips node_modules — only find/grep do)", () => {
    const result = output(run("ls", "list", { all: true }))
    expect(result.lines).toContain(".dotfile")
    expect(result.lines).toContain(".git")
    expect(result.lines).toContain(".hidden")
    expect(result.lines).toContain("node_modules")
  })

  test("path lists that directory with root-relative names", () => {
    const result = output(run("ls", "list", { path: "sub" }))
    expect(result.lines).toEqual(["sub/deep", "sub/inner.ts"])
  })

  test("long format carries mode, links, owner, group, size, mtime, and name", () => {
    const result = output(run("ls", "list", { long: true }))
    expect(result.lines).toHaveLength(9)
    for (const line of result.lines) {
      expect(line).toMatch(/^[-dl][rwxstST-]{9} \d+ \S+ - \d+ \d{4}-\d{2}-\d{2} \d{2}:\d{2} .+$/)
    }
    const directoryLine = result.lines.find((line) => line.endsWith(" sub"))
    const linkLine = result.lines.find((line) => line.endsWith(" linked"))
    expect(directoryLine).toBeDefined()
    expect(linkLine).toBeDefined()
    expect(directoryLine?.startsWith("d")).toBe(true)
    expect(linkLine?.startsWith("l")).toBe(true)
    expect(directoryLine).toContain(` ${userInfo().username} - `)
    if (process.platform === "win32") {
      // Windows has no POSIX mode: type-only bits are synthesized (documented).
      expect(directoryLine?.slice(0, 10)).toBe("drwxr-xr-x")
      expect(linkLine?.slice(0, 10)).toBe("lrwxrwxrwx")
    }
  })
})

describe("find.files (depth, basename glob, type filter, bounded traversal)", () => {
  test("maxDepth treats the start point as depth 0", () => {
    expect(output(run("find", "files", { path: "sub", maxDepth: 0 })).lines).toEqual(["sub"])
    expect(output(run("find", "files", { path: "sub", maxDepth: 1 })).lines).toEqual([
      "sub",
      "sub/deep",
      "sub/inner.ts",
    ])
    expect(output(run("find", "files", { path: "sub", maxDepth: 2 })).lines).toEqual([
      "sub",
      "sub/deep",
      "sub/deep/deeper.ts",
      "sub/inner.ts",
    ])
  })

  test("name is a case-sensitive basename glob", () => {
    const files = output(run("find", "files", { path: ".", name: "*.ts" })).lines
    expect(files).toEqual([".hidden/secret.ts", "alpha.ts", "beta.ts", "sub/deep/deeper.ts", "sub/inner.ts"])
    expect(output(run("find", "files", { path: ".", name: "*.TS" })).lines).toEqual([])
    expect(output(run("find", "files", { path: ".", name: "inner.??" })).lines).toEqual(["sub/inner.ts"])
  })

  test("type filters regular files vs directories; symlinks match neither", () => {
    expect(output(run("find", "files", { path: ".", type: "directory" })).lines).toEqual([
      ".",
      ".hidden",
      "sub",
      "sub/deep",
    ])
    expect(output(run("find", "files", { path: ".", type: "file" })).lines).toEqual([
      ".dotfile",
      ".hidden/secret.ts",
      "alpha.ts",
      "beta.ts",
      "binary.bin",
      "longline.txt",
      "many.txt",
      "notes.txt",
      "sub/deep/deeper.ts",
      "sub/inner.ts",
    ])
  })

  test(".git and node_modules are skipped; symlinked directories are listed but never followed", () => {
    const all = output(run("find", "files", { path: "." })).lines
    expect(all).toContain("linked") // the symlink entry itself is listed
    expect(all.some((line) => line === "node_modules" || line.startsWith("node_modules/"))).toBe(false)
    expect(all.some((line) => line === ".git" || line.startsWith(".git/"))).toBe(false)
    expect(all.some((line) => line.startsWith("linked/"))).toBe(false) // never descended
    expect(all).toContain("sub/inner.ts") // positive control: real directories are walked
  })
})

describe("grep.search (recursive walk, regex, caps)", () => {
  test("non-recursive scans only top-level files; recursive descends", () => {
    const top = output(run("grep", "search", { pattern: "needle", paths: ["."] }))
    expect(top.lines).toEqual(["notes.txt:2:needle at top"])
    const deep = output(run("grep", "search", { pattern: "needle", paths: ["."], recursive: true }))
    expect(deep.lines).toEqual(["notes.txt:2:needle at top", "sub/inner.ts:1:export const needle = 1"])
  })

  test("ignoreCase switches matching and the pattern is a regex", () => {
    expect(output(run("grep", "search", { pattern: "NEEDLE", paths: ["notes.txt"] })).lines).toEqual([])
    expect(
      output(run("grep", "search", { pattern: "NEEDLE", paths: ["notes.txt"], ignoreCase: true })).lines,
    ).toEqual(["notes.txt:2:needle at top"])
    expect(output(run("grep", "search", { pattern: "const \\w+ =", paths: ["alpha.ts"] })).lines).toEqual([
      "alpha.ts:1:export const alpha = 1",
    ])
  })

  test("an invalid regex is an input error, never a throw", () => {
    const error = failure(run("grep", "search", { pattern: "([" }))
    expect(error.kind).toBe("input")
    expect(error.message).toContain("invalid regular expression")
  })

  test("binary files (NUL byte) are skipped", () => {
    const result = output(run("grep", "search", { pattern: "needle", paths: ["binary.bin"] }))
    expect(result.lines).toEqual([])
  })

  test("the match cap stops the scan and sets truncated.stdout", () => {
    const result = output(run("grep", "search", { pattern: "hitline", paths: ["many.txt"] }))
    expect(result.lines).toHaveLength(GREP_MAX_MATCHES)
    expect(result.lines[0]).toBe("many.txt:1:hitline 0")
    expect(result.lines[GREP_MAX_MATCHES - 1]).toBe(`many.txt:${GREP_MAX_MATCHES}:hitline ${GREP_MAX_MATCHES - 1}`)
    expect(result.truncated).toBe(true)
  })

  test("a match line longer than the line cap is clipped and truncation is flagged", () => {
    const result = output(run("grep", "search", { pattern: "hitline", paths: ["longline.txt"] }))
    expect(result.lines).toHaveLength(1)
    const first = result.lines[0] ?? ""
    const text = first.split(":").slice(2).join(":")
    expect(text.startsWith("hitline ")).toBe(true)
    expect(text.length).toBe(GREP_MAX_LINE_CHARS)
    expect(result.truncated).toBe(true)
  })
})

describe("path containment", () => {
  test("relative escapes and absolute outside paths are rejected with kind path", () => {
    const escaped = relative(root, join(outside, "secret.txt"))
    for (const args of [{ path: "../outside" }, { path: escaped }, { path: join(outside, "secret.txt") }]) {
      expect(failure(run("ls", "list", args)).kind).toBe("path")
    }
    expect(failure(run("find", "files", { path: join(outside, "secret.txt") })).kind).toBe("path")
    expect(failure(run("grep", "search", { pattern: "x", paths: [escaped] })).kind).toBe("path")
  })

  test("an unknown root fails closed with kind root", () => {
    expect(failure(runWithEnv("ls", "list", {}, undefined)).kind).toBe("root")
  })
})

describe("runCliOperation branch (in-process, same gate)", () => {
  const allowlist: CliAllowlist = { find: ["files"], grep: ["search"], ls: ["list"] }
  const cliEnv = {
    mode: "on" as Mode,
    capabilities: capabilitiesFor({ ...defaultPolicy(), cli: allowlist }),
    root,
  }

  test("the enumerated set is exactly find.files, grep.search, ls.list", () => {
    expect([...ENUMERATED_OPERATIONS].sort()).toEqual(["find.files", "grep.search", "ls.list"])
    expect(isEnumeratedOperation("find", "files")).toBe(true)
    expect(isEnumeratedOperation("grep", "search")).toBe(true)
    expect(isEnumeratedOperation("ls", "list")).toBe(true)
    expect(isEnumeratedOperation("git", "status")).toBe(false)
    expect(isEnumeratedOperation("find", "status")).toBe(false)
  })

  test("allowlisted enumerated ops run in-process and return the synthesized CliResult", async () => {
    const dispatcher = createDispatcher(createCliCapabilities(allowlist), cliEnv)
    const outcome = await dispatcher.dispatch({ capability: "cli.find.files", input: { path: "sub", maxDepth: 1 } })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.data).toEqual({
        stdout: "sub\nsub/deep\nsub/inner.ts",
        stderr: "",
        exitCode: 0,
        truncated: { stdout: false, stderr: false },
      })
    }
  })

  test("typed-arg validation still runs before the in-process handler", async () => {
    const dispatcher = createDispatcher(createCliCapabilities(allowlist), cliEnv)
    const outcome = await dispatcher.dispatch({ capability: "cli.ls.list", input: { path: 42 } })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("input")
      expect(outcome.error.message).toBe("path must be a string")
    }
  })

  test("enumerated ops stay allowlist-gated (defense in depth)", async () => {
    const partial: CliAllowlist = { git: ["status"] }
    const dispatcher = createDispatcher(createCliCapabilities(partial), {
      mode: "on",
      capabilities: capabilitiesFor({ ...defaultPolicy(), cli: partial }),
      root,
    })
    const outcome = await dispatcher.dispatch({ capability: "cli.grep.search", input: { pattern: "x" } })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("mode")
      expect(outcome.error.message).toContain("not in the effective CLI allowlist")
    }
  })
})
