#!/usr/bin/env node
// tests/fixtures/mcp-fixture-server.mjs
// Minimal deterministic MCP stdio fixture server (newline-delimited JSON-RPC
// 2.0). Spawned as a REAL child process over REAL stdio by the Task 7
// integration tests: the plugin's production MCP client path (SDK stdio
// transport + catalog) is what is exercised — a fixture server over a real
// transport is a real integration test for the client path. No network, no
// mocking of the client.
//
// Protocol notes:
//   - initialize replies with the client's requested protocolVersion (a server
//     that supports it must); a legacy fallback covers clients that omit it.
//   - notifications (no id) are never answered.
//   - tools: echo (echoes {message}), add ({a,b}), fail (isError result),
//     mutate (removes "vanish" from tools/list AND rejects further calls),
//     vanish (only answerable while listed), boom (JSON-RPC error),
//     big (80 KiB text), hang (never answers — bounded-call-timeout tests).
import { createInterface } from "node:readline"

const BASE_TOOLS = [
  {
    name: "echo",
    description: "Echo a message back.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
  },
  {
    name: "add",
    description: "Add two integers.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" } },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
  {
    name: "fail",
    description: "Always fails with an isError result.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mutate",
    description: "Removes the 'vanish' tool from tools/list.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "vanish",
    description: "Only answerable while still present in tools/list.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "boom",
    description: "Fails the request with a JSON-RPC error.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "big",
    description: "Returns a large text payload.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hang",
    description: "Never answers (bounded-timeout tests).",
    inputSchema: { type: "object", properties: {} },
  },
]

let tools = [...BASE_TOOLS]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const rl = createInterface({ input: process.stdin })
rl.on("line", (raw) => {
  const line = raw.trim()
  if (!line) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = message
  const reply = (result) => send({ jsonrpc: "2.0", id, result })
  const fail = (code, text) => send({ jsonrpc: "2.0", id, error: { code, message: text } })

  if (method === "initialize") {
    reply({
      protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "codemode-fixture", version: "1.0.0" },
    })
    return
  }
  if (method === "notifications/initialized" || id === undefined || id === null) return
  if (method === "ping") {
    reply({})
    return
  }
  if (method === "tools/list") {
    reply({ tools })
    return
  }
  if (method === "tools/call") {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name === "echo") {
      if (typeof args.message !== "string") {
        return reply({ content: [{ type: "text", text: "bad args" }], isError: true })
      }
      return reply({ content: [{ type: "text", text: `echo:${args.message}` }], isError: false })
    }
    if (name === "add") {
      return reply({ content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }], isError: false })
    }
    if (name === "fail") {
      return reply({ content: [{ type: "text", text: "fixture failure" }], isError: true })
    }
    if (name === "mutate") {
      tools = tools.filter((tool) => tool.name !== "vanish")
      return reply({ content: [{ type: "text", text: "mutated" }], isError: false })
    }
    if (name === "vanish") {
      if (!tools.some((tool) => tool.name === "vanish")) {
        return fail(-32602, "unknown tool: vanish")
      }
      return reply({ content: [{ type: "text", text: "still here" }], isError: false })
    }
    if (name === "boom") {
      return fail(-32000, "fixture internal error")
    }
    if (name === "big") {
      return reply({ content: [{ type: "text", text: "x".repeat(80 * 1024) }], isError: false })
    }
    if (name === "hang") {
      return // never answers
    }
    return fail(-32602, `unknown tool: ${String(name)}`)
  }
  fail(-32601, `method not found: ${String(method)}`)
})
