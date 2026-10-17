// src/plugin/command.ts
// `/codemode` command + in-memory session mode state.
//
// Pi parity (research §2.3): `/codemode [on|yolo|off|refresh|reload|jev]`,
// bare invocation toggles off<->on; a locked policy warns and widening is
// refused. Re-homed onto the verified v2 command surface:
//   ctx.command.transform((editor) => editor.add({ name, description, execute }))
// (@opencode/plugin@2.0.19 dist/promise/command.d.ts). Session MODE state is
// in memory and keyed by the invocation's sessionID; persistent settings live
// in plugin options (ctx.options) — never in Pi config paths.
import type { Plugin } from "@opencode/plugin"
import type { Mode, Policy } from "../config/policy.js"
import { modeRank } from "../config/policy.js"

/**
 * In-memory session-scoped mode state. Sessions without an explicit entry
 * fall back to the effective policy mode; a stored mode can never read wider
 * than the current policy (defensive clamp — widening is refused at set time,
 * but a policy change between commands must not leak a stale wider value).
 */
export class SessionModeStore {
  private readonly modes = new Map<string, Mode>()

  get(sessionID: string): Mode | undefined {
    return this.modes.get(sessionID)
  }

  set(sessionID: string, mode: Mode): void {
    this.modes.set(sessionID, mode)
  }

  effective(policy: Policy, sessionID: string): Mode {
    const stored = this.modes.get(sessionID)
    if (stored === undefined) return policy.mode
    return modeRank(stored) > modeRank(policy.mode) ? policy.mode : stored
  }

  /**
   * Refresh-time reconciliation: never widens a session; entries above the
   * new policy are clamped down (adjusted) and entries already equal to the
   * policy are dropped as redundant (purged).
   */
  reconcile(policy: Policy): { adjusted: readonly string[]; purged: readonly string[] } {
    const adjusted: string[] = []
    const purged: string[] = []
    for (const [sessionID, mode] of [...this.modes]) {
      if (mode === policy.mode) {
        this.modes.delete(sessionID)
        purged.push(sessionID)
        continue
      }
      if (modeRank(mode) > modeRank(policy.mode)) {
        this.modes.set(sessionID, policy.mode)
        adjusted.push(sessionID)
      }
    }
    return { adjusted, purged }
  }
}

export type CodemodeAction = "toggle" | "on" | "off" | "refresh" | "yolo" | "jev" | "unknown"

export interface CodemodeRequest {
  readonly action: CodemodeAction
  readonly raw: string
}

/**
 * Parses the command argument text. The verified command contract hands the
 * plugin `prompt: PromptInput.Prompt`; the docs do not pin whether `text`
 * echoes the command itself, so a leading `/…` token is tolerated. `reload`
 * maps to `refresh` (Pi parity).
 */
export function parseCodemodeArgs(text: string): CodemodeRequest {
  const raw = typeof text === "string" ? text.trim() : ""
  const tokens = raw.split(/\s+/).filter(Boolean)
  if (tokens.length > 0 && tokens[0].startsWith("/")) tokens.shift()
  const token = (tokens[0] ?? "").toLowerCase()
  const action: CodemodeAction =
    token === ""
      ? "toggle"
      : token === "on" || token === "off"
        ? token
        : token === "refresh" || token === "reload"
          ? "refresh"
          : token === "yolo" || token === "jev"
            ? token
            : "unknown"
  return { action, raw }
}

/** Structural command invocation (v2 CommandInvocation is not re-exported at the package root). */
export interface CodemodeCommandInvocation {
  readonly sessionID: string
  readonly prompt: { readonly text: string }
}

export interface CodemodeCommandDefinition {
  readonly name: string
  readonly description: string
  readonly execute: (input: CodemodeCommandInvocation) => Promise<void>
}

export interface CodemodeCommandDeps {
  readonly sessions: SessionModeStore
  readonly getPolicy: () => Policy
  /** Re-resolves the policy from the current options snapshot. */
  readonly refreshPolicy: () => Policy
  /** Task 7: refreshes the plugin-owned MCP catalog; the stats feed the reply. */
  readonly refreshCatalog?: () => Promise<{ readonly servers: number; readonly tools: number }>
  /**
   * Task 11: the truthful `/codemode jev` availability status (host-only
   * probe; never the credential value). Absent = the reply lists how to
   * enable the optional feature.
   */
  readonly jevStatus?: () => Promise<string> | string
  readonly reply: (sessionID: string, text: string) => Promise<void> | void
}

export function createCodemodeCommand(deps: CodemodeCommandDeps): CodemodeCommandDefinition {
  const send = async (sessionID: string, text: string): Promise<void> => {
    await deps.reply(sessionID, text)
  }

  const switchTo = async (
    sessionID: string,
    requested: Mode,
    policy: Policy,
    lockedWarning: string,
    successNote = "",
  ): Promise<void> => {
    if (modeRank(requested) > modeRank(policy.mode)) {
      await send(
        sessionID,
        `Refused: "${requested}" exceeds the effective policy mode "${policy.mode}" (source: ${policy.source}). ` +
          `Only narrowing within the effective policy is allowed.${lockedWarning}`,
      )
      return
    }
    deps.sessions.set(sessionID, requested)
    await send(sessionID, `CodeMode is now "${requested}" for this session.${lockedWarning}${successNote}`)
  }

  return {
    name: "codemode",
    description: "Show or change the CodeMode mode for this session: on | off | yolo | refresh | jev (bare invocation toggles on/off).",
    execute: async (input) => {
      const sessionID = String(input.sessionID)
      const request = parseCodemodeArgs(input.prompt.text)
      const policy = deps.getPolicy()
      const lockedWarning = policy.lock
        ? " Policy is locked (lock: true); changes may only narrow within the effective policy."
        : ""

      switch (request.action) {
        case "toggle": {
          const current = deps.sessions.effective(policy, sessionID)
          await switchTo(sessionID, current === "off" ? "on" : "off", policy, lockedWarning)
          return
        }
        case "on":
          await switchTo(sessionID, "on", policy, lockedWarning)
          return
        case "off":
          await switchTo(sessionID, "off", policy, lockedWarning)
          return
        case "yolo": {
          // Task 11: live. Explicit selection only — switchTo refuses when the
          // effective policy does not allow yolo (e.g. global on/off); the
          // granted reply always carries the trust-expansion warning.
          await switchTo(
            sessionID,
            "yolo",
            policy,
            lockedWarning,
            ' WARNING: "yolo" expands trust — the shell escape hatch becomes available to guest code.',
          )
          return
        }
        case "jev": {
          // Task 11: surface the REAL availability status (Task 10's adapter).
          // No provider wired → enablement instructions; otherwise the reply is
          // the host adapter's bounded, secret-free status text.
          if (deps.jevStatus === undefined) {
            await send(
              sessionID,
              "jev.ask is an optional TypeSafe capability — set TYPESAFE_API_KEY for the host and install @typesafe-ai/sdk to enable it (no status provider is wired).",
            )
            return
          }
          let status: string
          try {
            status = await deps.jevStatus()
          } catch {
            status = "jev status probe failed; the optional jev.ask capability is unchanged."
          }
          await send(sessionID, status)
          return
        }
        case "refresh": {
          const refreshed = deps.refreshPolicy()
          const { adjusted, purged } = deps.sessions.reconcile(refreshed)
          // Task 7: the same command rebuilds the plugin-owned MCP catalog
          // metadata (the explicit refresh path of the catalog TTL strategy).
          let catalogNote = ""
          if (deps.refreshCatalog !== undefined) {
            try {
              const stats = await deps.refreshCatalog()
              catalogNote = ` MCP catalog refreshed: ${stats.servers} server(s), ${stats.tools} tool(s).`
            } catch {
              catalogNote = " MCP catalog refresh failed; the previous catalog is kept."
            }
          }
          await send(
            sessionID,
            `Policy refreshed: mode "${refreshed.mode}", source "${refreshed.source}". ` +
              `Session modes reconciled: ${adjusted.length} adjusted, ${purged.length} purged.${catalogNote}`,
          )
          return
        }
        default: {
          await send(
            sessionID,
            'Usage: /codemode [on|off|yolo|refresh|jev] (bare invocation toggles on/off). "yolo" can only be selected when the effective policy allows it.',
          )
        }
      }
    },
  }
}

const commandRegistrations = new WeakMap<object, { dispose: () => Promise<void> }>()

/**
 * Registers `/codemode` via ctx.command.transform. Idempotent per context;
 * the returned cleanup disposes the registration (v2 dispose path).
 */
export async function registerCodemodeCommand(ctx: Plugin.Context, deps: CodemodeCommandDeps): Promise<Plugin.Cleanup> {
  if (commandRegistrations.has(ctx)) return () => {}
  const registration = await ctx.command.transform((editor) => {
    editor.add(createCodemodeCommand(deps))
  })
  commandRegistrations.set(ctx, registration)
  return async () => {
    commandRegistrations.delete(ctx)
    await registration.dispose()
  }
}
