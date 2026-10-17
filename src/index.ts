// src/index.ts — OpenCode v2 plugin entry.
// Wires the Task 4/5 slices: policy resolution from ctx.options, the in-memory
// session mode store, the /codemode command, the execute_tools registration
// (direct top-level exposure; options.codemode flipped to false), the
// session-scoped mode enforcement (fail closed where the host surface is
// unproven — see register.ts MODE_ENFORCEMENT_FINDING), the Task 5
// root-scoped file helpers (active checkout root resolution feeding the
// dispatcher through the ExecuteToolsGate), the Task 6 allowlisted CLI
// capabilities (policy.cli threaded per session), and the Task 7
// plugin-owned MCP bridge (McpCatalog over the host's ctx.mcp.list() config;
// the host exposes no invocation surface — see capabilities/mcp.ts +
// host/opencode.ts TASK7_BRIDGE_DEVIATION; research §5.1b).
//
// V2 contract (authority: @opencode/plugin@2.0.19 dist/promise/plugin.d.ts):
//   export interface Plugin { readonly id: string; readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void }
//   export declare function define(plugin: Plugin): Plugin
import { Plugin } from "@opencode/plugin"
import { jevStatusMessage } from "./capabilities/jev.js"
import { McpCatalog } from "./capabilities/mcp.js"
import { resolvePolicy } from "./config/load-policy.js"
import { capabilitiesFor } from "./config/policy.js"
import { collectHostProbe } from "./host/opencode.js"
import { SessionModeStore, registerCodemodeCommand } from "./plugin/command.js"
import { registerExecuteTools, registerModeEnforcement } from "./plugin/register.js"
import { resolveActiveRoot } from "./security/paths.js"

const ID = "opencode-codemode"

export async function setupPlugin(ctx: Plugin.Context): Promise<Plugin.Cleanup> {
  // V2 exposes no client logging API (ctx.app = {name, version, channel});
  // console is the documented replacement (playbook port-opencode-plugins-v1-to-v2, step 4).
  console.log(`[${ID}] setup (opencode ${ctx.app.version}) at ${ctx.location.directory}`)

  // Effective policy: top-level ctx.options keys are the merged global policy;
  // the explicit `project` key is the narrow-only overlay (load-policy.ts).
  // Persistent settings are config; session MODE state is in memory only.
  const sessions = new SessionModeStore()
  let resolution = resolvePolicy(ctx.options)
  const getPolicy = () => resolution.policy
  const refreshPolicy = () => {
    resolution = resolvePolicy(ctx.options)
    return resolution.policy
  }

  const { policy, errors, notes, ignoredKeys } = resolution
  // Log only bounded policy facts (no code, no file contents, no secrets).
  console.log(
    `[${ID}] policy: mode=${policy.mode} source=${policy.source} lock=${policy.lock} cliTools=${Object.keys(policy.cli).length}`,
  )
  if (errors.length > 0) console.log(`[${ID}] options rejected; failing closed: ${errors.join("; ")}`)
  if (notes.length > 0) console.log(`[${ID}] policy notes: ${notes.join(" ")}`)
  if (ignoredKeys.length > 0) console.log(`[${ID}] ignored option keys: ${ignoredKeys.join(", ")}`)

  // Task 10: capability STATUS only — never the key value. The optional SDK
  // is probed lazily per call, so setup reports policy + credential presence.
  const jevKeyPresent = (process.env.TYPESAFE_API_KEY ?? "").trim().length > 0
  console.log(
    `[${ID}] jev: enabled=${policy.jev.enabled} model=${policy.jev.model} key=${jevKeyPresent ? "present" : "absent"} (optional SDK loaded lazily per call)`,
  )

  // Active checkout root for the root-scoped file helpers (Task 5): resolved
  // once from the setup-time location context (the per-call ToolContext has no
  // location field in @opencode/plugin@2.0.19). Unknown root = helpers fail
  // closed at dispatch time.
  const activeRoot = resolveActiveRoot(ctx.location)
  if (activeRoot.ok) {
    console.log(`[${ID}] active root: ${activeRoot.root} (source: ${activeRoot.source})`)
  } else {
    console.log(`[${ID}] active root unresolved (${activeRoot.reason}); file helpers fail closed`)
  }

  // Task 7: the plugin-owned MCP bridge. The host exposes no invocation
  // surface (host/opencode.ts TASK7_BRIDGE_DEVIATION), so this catalog owns
  // its own local-stdio connections over the host's MCP CONFIG
  // (ctx.mcp.list() — the documented config surface). Connections are lazy
  // and TTL-bounded: the first execute_tools call refreshes the catalog.
  const mcpCatalog = new McpCatalog({
    servers: () => ctx.mcp.list(),
    log: (line) => console.log(`[${ID}] ${line}`),
  })

  const cleanupTool = await registerExecuteTools(ctx, {
    modeForSession: (sessionID) => sessions.effective(getPolicy(), sessionID),
    capabilitiesForSession: (sessionID) =>
      capabilitiesFor({ ...getPolicy(), mode: sessions.effective(getPolicy(), sessionID) }),
    executorTimeoutMsForSession: () => getPolicy().executor.timeoutMs,
    cliAllowlistForSession: () => getPolicy().cli,
    activeRoot: activeRoot.ok ? activeRoot.root : undefined,
    mcpCatalog,
    // Task 10: the effective Jev policy (optional TypeSafe integration).
    jevPolicyForSession: () => getPolicy().jev,
  })

  const cleanupCommand = await registerCodemodeCommand(ctx, {
    sessions,
    getPolicy,
    refreshPolicy,
    // /codemode refresh also rebuilds the plugin-owned MCP catalog (Task 7).
    refreshCatalog: async () => {
      await mcpCatalog.refresh()
      return mcpCatalog.stats()
    },
    // Task 11: the truthful `/codemode jev` status — host-side probe only
    // (policy, credential presence, optional SDK); never the credential value.
    jevStatus: () => jevStatusMessage({ policy: getPolicy().jev }),
    // Command output channel: the documented synthetic (no-reply) session
    // message (ctx.session.synthetic({..., resume:false}) — migrate-v1/playbook).
    reply: async (sessionID, text) => {
      await ctx.session.synthetic({ sessionID, text, resume: false })
    },
  })

  const cleanupEnforcement = await registerModeEnforcement(ctx, { sessions, getPolicy })

  // GATE 1 host probe (Task 2): when enabled via plugin options, persist the
  // live ToolDomain surface + tool catalog to plugin storage as raw evidence.
  if (ctx.options.hostProbe === true) {
    try {
      await ctx.storage.set("host-probe", await collectHostProbe(ctx))
    } catch (error) {
      console.log(`[${ID}] host probe failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // The returned cleanup is the v2 dispose path (reverse registration order).
  return async () => {
    await cleanupEnforcement()
    await cleanupCommand()
    await cleanupTool()
    await mcpCatalog.dispose()
  }
}

export default Plugin.define({
  id: ID,
  setup: setupPlugin,
})
