#!/usr/bin/env node
// Scripted ACP agent used by the tests. Speaks newline-delimited JSON-RPC on
// stdio and implements just enough of the protocol for the client.

let nextSession = 1
const sessionDirectories = new Map()
const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "fast",
    options: [
      { value: "fast", name: "Fast" },
      { value: "slow", name: "Slow" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const replies = new Map()
let nextRequest = 1000

function ask(method, params) {
  const id = nextRequest++
  return new Promise((resolve) => {
    replies.set(id, resolve)
    send({ jsonrpc: "2.0", id, method, params })
  })
}

function update(sessionId, payload) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: payload } })
}

function handle(message) {
  if (!message || typeof message !== "object") return
  if (!message.method) {
    // A reply to an agent-initiated client request.
    const callback = replies.get(message.id)
    if (callback) {
      replies.delete(message.id)
      callback(message)
    }
    return
  }
  if (message.id === undefined) return

  switch (message.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-agent", version: "1.0.0" },
          agentCapabilities: { sessionCapabilities: { close: true } },
          authMethods: [],
        },
      })
    case "session/new": {
      const sessionId = `sess-${nextSession++}`
      sessionDirectories.set(sessionId, message.params?.additionalDirectories ?? [])
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId, configOptions },
      })
    }
    case "session/set_config_option": {
      const value = message.params?.value
      const accepted = ["fast", "slow"].includes(value) || String(value).startsWith("extra-")
      if (message.params?.configId === "model" && !accepted) {
        return send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: `unknown model: ${value}` },
        })
      }
      return send({ jsonrpc: "2.0", id: message.id, result: {} })
    }
    case "session/set_mode":
    case "session/close":
      return send({ jsonrpc: "2.0", id: message.id, result: {} })
    case "session/prompt": {
      const sessionId = message.params?.sessionId
      const text = (message.params?.prompt ?? [])
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("\n")

      if (/\bfail\b/i.test(text)) {
        return send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "scripted failure" },
        })
      }
      if (/\bhang\b/i.test(text)) return
      if (/\bdirectories\b/i.test(text)) {
        const directories = sessionDirectories.get(sessionId) ?? []
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `directories:${directories.join(",")}` },
        })
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
      }
      if (/\bwrite files?\b/i.test(text)) {
        void (async () => {
          const inside = await ask("fs/write_text_file", {
            sessionId,
            path: "inside.txt",
            content: "inside",
          })
          const escape = await ask("fs/write_text_file", {
            sessionId,
            path: "link/escape.txt",
            content: "escape",
          })
          const label = `${inside.error ? "denied" : "ok"}/${escape.error ? "denied" : "ok"}`
          update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `write:${label}` } })
          send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
        })()
        return
      }

      update(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking " },
      })
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "ls",
        kind: "execute",
        status: "pending",
        rawInput: { command: "ls" },
      })
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
        rawOutput: { stdout: "a.txt" },
      })
      const reply = `got:${text}`
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } })
      update(sessionId, { sessionUpdate: "usage_update", used: 12, size: 200 })

      setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }), 5)
      return
    }
    default:
      return send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `unsupported method: ${message.method}` },
      })
  }
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line))
    } catch {
      // ignore malformed input
    }
  }
})
