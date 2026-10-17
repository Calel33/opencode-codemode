# @boozedog/opencode-codemode

An OpenCode v2 plugin that exposes a typed Code Mode execution tool
(`execute_tools`) with explicit policy and host-mediated capabilities. The
guest code runs in an isolated QuickJS sandbox: it is typechecked before any
effect, and every host capability crosses one validated dispatcher.

Port of [`@boozedog/pi-codemode`](https://www.npmjs.com/package/@boozedog/pi-codemode)
(research and mapping in the port branch; the Pi process/model layer is
replaced by verified OpenCode v2 contracts).

**Status:** feature-complete port (Tasks 1–11) staged on the port branch;
release acceptance (Task 12) verified with the matrix below.

## Install

Requirements: OpenCode v2 CLI and Node ≥ 20 (or Bun) on the host machine.

### Local checkout (development / pre-publish)

```sh
bun install
bun run build        # tsc -> dist/ (the loader entry re-exports it)
```

Point a project's `opencode.json` at the checkout — string form or the
documented object form with plugin options:

```jsonc
{
  "plugins": ["file:///D:/Dev/opencode-codemode"]
}
```

```jsonc
{
  "plugins": [
    {
      "package": "file:///D:/Dev/opencode-codemode",
      "options": { "mode": "on" }
    }
  ]
}
```

The v2 loader resolves a configured plugin directory through `index.ts` or
`index.js` at its root; the root `index.js` here re-exports the built
`dist/index.js`, so run `bun run build` before loading. `opencode api
--standalone --print-logs GET /api/config` from the project validates the load.

### Published package (npm)

```sh
opencode plugin add @boozedog/opencode-codemode
```

or add `"@boozedog/opencode-codemode"` (optionally as `{ "package": "...",
"options": { ... } }`) to the `plugins` array. The published entry resolves
through `exports["."]` → `dist/index.js`. The name was verified available on
npm (2026-10-16); publish with `npm publish` from this repository when ready.

## Configuration (plugin `options`)

Top-level keys are the effective **global policy**; the optional `project` key
is an explicit **project overlay** that can only narrow. The host merges one
options record per plugin entry; the plugin itself implements the narrow-only
intersection and `lock` semantics (the host does not).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `"off" \| "on" \| "yolo"` | `"on"` | Effective mode (see Modes). |
| `executor` | `{ type: "quickjs", timeoutMs: number }` | `{ type: "quickjs", timeoutMs: 120000 }` | Guest runtime + per-execution deadline. |
| `cli` | `{ [tool]: [operation, ...] }` | `{}` | CLI allowlist: only these `cli.<tool>.<operation>` calls exist. |
| `lock` | `boolean` | `false` | `true` ignores every project `mode`/`cli`/`jev` override. |
| `jev` | `{ enabled?: boolean, model?: string, timeoutMs?: number }` | `{ enabled: true, model: "jev-latest", timeoutMs: 8000 }` | Optional TypeSafe integration (see Jev setup). |
| `project` | object | — | Narrow-only overlay: `mode`, `executor`, `cli`, `jev`. |

Narrowing rules (Pi parity): a project `mode` may only lower permissiveness
(`yolo` > `on` > `off`); a project `cli` may only drop tools/operations already
granted globally; `jev.enabled` may only turn off. Widening attempts are
ignored and logged as policy notes — never applied silently. `lock` is
global-only (a `project` can never set or clear it). Unknown top-level keys are
ignored (the options record is host-owned); unknown `project` keys and
malformed values fail closed: mode `off`, locked, no CLI.

```jsonc
{
  "plugins": [
    {
      "package": "@boozedog/opencode-codemode",
      "options": {
        "mode": "on",
        "cli": { "git": ["status", "diff", "log"], "rg": ["search"] },
        "project": { "mode": "off", "cli": { "git": ["status"] } }
      }
    }
  ]
}
```

### Modes

| Mode | Guest can | Native-tool posture |
|---|---|---|
| `off` | nothing — `execute_tools` refuses per session (`errorKind: "mode"`) | plugin registers no rules; host defaults apply |
| `on` (default) | typechecked code, root-scoped `read`/`write`/`edit`, allowlisted `cli.*`, `codemode.*` discovery, `mcp.*` (plugin-owned bridge), npm plan/run, `π` strings, optional `jev.ask` | native `write`/`edit`/`shell` denies stay **fail-closed** until a host proof exists (see Limitations) |
| `yolo` | everything in `on` **plus** `shell.run` — an explicit platform-shell escape hatch via the validated dispatcher | deliberate trust expansion; `/codemode yolo` prints a warning |

Session modes change at runtime with the `/codemode` command:

```text
/codemode            toggle on <-> off for this session
/codemode on|off     set the session mode (cannot widen past policy)
/codemode yolo       requires a policy that allows yolo; warns about trust
/codemode refresh    re-resolve policy + rebuild the MCP catalog
/codemode jev        print the optional Jev availability status
```

Mode state is in memory, keyed per session; the effective policy is always the
ceiling. Denials are data (`DispatchOutcome` errors), never exceptions across
the boundary.

## Capabilities

* **`execute_tools`** (the one tool): input `{ code: string, strings?: Record<string,string> }`.
  `code` is a TypeScript body wrapped as `(async function() { ... })()`; the
  return value becomes the tool result, `print(...)` is captured. The body is
  **typechecked first** — a type error returns diagnostics and the code is
  **not executed** (no side effects). Results, logs, and errors are bounded.
* **`read` / `write` / `edit`** — root-scoped file helpers (single file exact
  edit semantics). The active checkout root is resolved once at setup
  (`ctx.location`, canonicalized); an unknown root fails closed. Traversal,
  drive-relative forms, symlink escapes, and Windows path forms are rejected;
  writes to `.mcp.json` and `.pi/` are policy-protected.
* **`cli.<tool>.<operation>`** — typed, allowlisted CLI operations. Catalog:
  `git`, `rg`, `find`, `grep`, `ls`, `vitest`, `tsc`, `oxfmt`, `oxlint` (the
  exact operations are declared in `src/capabilities/cli.ts`). `find`, `ls`,
  and `grep` are host-implemented **in-process** (Node fs, OS-independent — no
  PATH lookup, no spawn; see the deviations bullet under Limitations). The
  remaining tools are spawned with an argv array (`shell: false`), a minimal
  environment, and the active root as cwd. Nonzero exit codes are returned as
  data. Each spawned stream is capped at 50 KiB (tail kept, explicit marker);
  in-process results set `truncated.stdout` when a cap bites. No arbitrary
  commands: a capability the allowlist does not grant is denied at dispatch
  even on a raw bridge call.
* **`codemode.*` discovery** — `search_tools`, `list_mcp_servers`,
  `list_tools`, `describe_tools` over the live plugin-owned catalog (bounded).
* **`mcp.<namespace>.<tool>`** — MCP tool calls through the **plugin-owned
  bridge**: the plugin reads the host's MCP *config* (`ctx.mcp.list()`) and
  connects to **local (stdio) servers** itself (the host exposes no tool
  invocation surface — recorded deviation, research §5.1b). Remote/HTTP MCP
  servers and disabled servers are not available in this slice.
* **`codemode.plan_npm_script` / `codemode.run_npm_script`** — decompose a
  safe npm script (`tsc`/`vitest`/`oxfmt`/`oxlint` forms, recursive
  `npm run`/`npm test`) into explicit allowlisted CLI steps (≤ 32 steps).
  Planning has no effects; pipes, redirection, substitution, and chaining are
  rejected; running re-checks the allowlist per step and returns per-step data.
* **`π.<key>`** — string constants passed as the `strings` input; available
  only for that execution, never logged or persisted.
* **`jev.ask(state, questions)`** (optional) — TypeSafe System One
  classification (`noul`/`choice`/`score` questions). Exists only when the
  Jev policy is enabled **and** the host has `TYPESAFE_API_KEY` and the
  optional SDK installed; otherwise calls return an actionable bounded
  "unavailable" outcome.

## Limits

| Bound | Value |
|---|---|
| Guest execution deadline (per `execute_tools` call) | 120 000 ms default, overridable via `executor.timeoutMs` |
| QuickJS heap | 64 MiB |
| Tool result / logs / error text | 50 KiB total each, explicit truncation markers |
| `strings` payload | 50 KiB serialized |
| File read output / whole-file guard / write payload | 50 KiB / 4 MiB / 1 MiB |
| CLI stdout, stderr | 50 KiB per stream (tail kept) |
| CLI operation timeout | 30 000 ms default; `shell.run` up to 120 000 ms |
| npm script plan | ≤ 32 steps; `package.json` ≤ 1 MiB |
| `find`/`ls`/`grep` (in-process) | find/ls ≤ 2 000 entries; grep ≤ 1 000 files, 1 000 matches, 500 chars/line, 1 MiB/file, 16 MiB total; stdout backstop 50 KiB |
| Jev state / input / answers / timeout | 12 000 chars / 50 KiB / 50 KiB / 8 000 ms default (≤ 60 000) |
| MCP catalog | ≤ 16 servers, ≤ 200 tools/server, ≤ 40 schema params; results ≤ 50 KiB; search ≤ 50, list ≤ 100 |

## Security boundary

* **No ambient guest APIs.** The QuickJS guest gets only the declared globals
  (`print`, the file helpers, `cli`, `codemode`, `mcp`, `π`, optional `jev`,
  and `shell` in yolo). There is no `process`, `require`, filesystem,
  environment, network, subprocess, or timers surface unless the host installs
  one — and nothing does.
* **One validated dispatcher.** Every capability call crosses a single JSON
  bridge (`__codemodeHostCall`) and is re-validated at dispatch: mode, the
  capability group, the input envelope. A guest that casts its way around the
  typed declarations still hits the same validation (adversarial tests in
  `tests/integration/security.test.ts`).
* **Typecheck before effects.** Invalid code returns diagnostics with zero
  guest execution and zero host side effects.
* **Paths.** Canonical root containment with `realpath` symlink checks,
  Windows drive-form handling, protected writes; unknown root = fail closed.
* **CLI.** Explicit `cli.<tool>.<operation>` allowlist; argv arrays only, no
  shell concatenation; restricted environment. The only shell execution is
  yolo's explicit `shell.run` hatch, which remains bounded and dispatcher-gated.
* **Credentials stay host-side.** The Jev API key is read from the host
  environment, never enters guest globals or type declarations, never reaches
  logs or results (error text is redacted). Plugin logs carry bounded policy
  facts only — no code, file contents, or credentials.
* **Fail-closed unknowns.** The native session-scoped deny surface
  (`ctx.session.update({ permissions })`) is type-proven but its runtime
  isolation is not; while unproven the plugin writes no host rules
  (`NATIVE_DENY_GATE.proven = false`) and instead denies its own surface
  in-process per invoking session.

## Jev setup (optional)

```sh
# host environment (never in guest code or config files committed to a repo)
export TYPESAFE_API_KEY=...        # Windows: setx / $env:TYPESAFE_API_KEY
bun add @typesafe-ai/sdk           # optional dependency; lazy-loaded per call
```

The SDK is optional: without it (or without the key) the plugin loads and runs
normally, and `jev.ask` / `/codemode jev` report a bounded, actionable status.
Policy: `options.jev = { enabled, model, timeoutMs }` (defaults
`jev-latest`/8000 ms).

## Limitations (recorded)

* **No host tool/MCP invocation surface.** `@opencode/plugin` 2.0.19 exposes
  no plugin-side tool invocation (no `invoke`; `ctx.tool.list()` items carry
  no documented call contract), so the `mcp.*` bridge is plugin-owned and
  speaks the MCP protocol itself (recorded deviation: research §5.1b;
  `src/host/opencode.ts`). No private or guessed host call is used.
* **Remote MCP servers unsupported in this slice** — local stdio only.
* **Host quirk: no `undefined` values in tool-result metadata.** On opencode
  2.0.29 a tool-result `metadata` property whose value is `undefined` makes the
  host's `session.tool.success` event encode fail silently: the part stays
  `running`, no result is stored, and the model receives the host placeholder
  "Tool result missing". The plugin emits only present metadata keys
  (regression test: `success metadata never carries undefined-valued keys`).
* **Native deny gate is fail-closed.** Pi's write-door matrix (native
  `write`/`edit`/`shell` denies in `on`) is not applied through host session
  rules until a running-host proof of per-session isolation exists; the plugin
  denies its own surface instead (`NATIVE_DENY_GATE` in `src/plugin/register.ts`).
* **`setup()` runs on session activation.** The loader loads plugin modules at
  server boot (verified: `opencode api --standalone` logs the resolved
  entrypoint); plugin `setup()` console output appears once a session
  activates, so config-only boots verify load, not setup. Session-driven
  end-to-end checks require an authenticated model call (not CI-deterministic;
  covered by the fake-ctx suites). A session-driven end-to-end run on
  opencode 2.0.29 proves direct top-level `execute_tools` dispatch returns the
  sandbox result (`e2e-ok`/`42`, recorded 2026-10-17).
* **Windows `.cmd` shims.** CLI capabilities spawn with `shell: false`; an
  allowlisted executable must be a real binary under Node 24 (Bun's spawn also
  resolves `.cmd`). Prefer real executables (`git`, not a package-manager shim).
  `find`, `ls`, and `grep` are exempt: they are **no longer PATH lookups at
  all** (see the in-process bullet below) — Windows ships no usable `grep` and
  no real `ls` binary (PowerShell alias only), and its `find.exe` is an
  unrelated string-search utility, so a PATH-based spawn could only be wrong
  there.
* **In-process `find` / `ls` / `grep` (deliberate deviations).** These three
  declared operations run on the host (Node fs, `src/capabilities/enumerate.ts`)
  instead of spawning a binary; the catalog entries, allowlist gate, and typed
  argument validation are unchanged. Documented deviations from POSIX: every
  printed path is **root-relative** with forward slashes (the root itself
  prints as `.`; POSIX prints the path as typed — root-relative is the safe
  form inside the sandbox); `find`/`grep` walks skip `.git` and `node_modules`
  and never descend symlinked directories (bounded, cycle-safe traversal —
  POSIX `find` descends both); `ls -l` renders real `stat.mode` bits on POSIX
  but synthesizes type-only modes on Windows (`drwxr-xr-x` / `-rw-r--r--` /
  `lrwxrwxrwx`), which has no POSIX mode; `grep` prints its own stable
  `<path>:<line>:<text>` format (1-indexed) and reports zero matches as exit
  code 0, unlike POSIX grep's nonzero exit.
* **`gh` CLI group deferred** (Pi's `gh` operations are not in this slice's catalog).

## Compatibility

| Component | Verified |
|---|---|
| OpenCode CLI | 2.0.29 (Windows; real host load test in `tests/integration/plugin-load.test.ts`) |
| `@opencode/plugin` | 2.0.19 (peer range `^2.0.19`) |
| Bun | 1.4.3 (test runner) |
| Node | v24.18.0 (typecheck/build) |
| TypeScript | 6.0.3 (runtime: guest typecheck + transpile) |
| `quickjs-emscripten-core` + `@jitl/quickjs-singlefile-mjs-release-sync` | 0.32.0 |
| `@modelcontextprotocol/client` | 2.3.1 |
| `@typesafe-ai/sdk` | 0.6.0 (optional) |

## Development

```sh
bun install
bun run typecheck    # tsc --noEmit
bun run build        # tsc -> dist/
bun test             # full unit + integration suites
```

The integration suites run the real host load when `opencode` is on `PATH` and
`dist/` is built; set `OPENCODE_SKIP_HOST_LOAD=1` to skip in constrained
environments. Adversarial security checks live in
`tests/integration/security.test.ts`.

## Attribution

Port of [`@boozedog/pi-codemode`](https://www.npmjs.com/package/@boozedog/pi-codemode)
by Mario Zechner, MIT licensed (Copyright (c) 2026 Mario Zechner and contributors).
This port adapts the original capability model to verified OpenCode v2 plugin
contracts; Pi runtime code is not copied verbatim.

## License

MIT
