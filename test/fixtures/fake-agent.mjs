#!/usr/bin/env node
// Scripted ACP agent used by the tests. Speaks newline-delimited JSON-RPC on
// stdio and implements just enough of the protocol for the client.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

let nextSession = 1
const sessionDirectories = new Map()
const sessionPrompts = new Map()
const sessionSelections = new Map()
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

if (process.argv.includes("--list-models")) {
  console.log("fast  Fast\nslow  Slow")
  process.exit(0)
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const replies = new Map()
let nextRequest = 1000

const runningTurns = new Map()

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const pidLog = argument("--pid-log")
if (pidLog) appendFileSync(pidLog, `${process.pid}\n`)

// A sessions file lets a later process resume sessions this one opened, which
// is how an agent survives a plugin reload. `--no-restore` keeps the same file
// but hides the capabilities, covering agents without session restore.
const sessionsFile = argument("--sessions-file")
const canRestore = Boolean(sessionsFile) && !process.argv.includes("--no-restore")

function knownSessions() {
  if (!sessionsFile) return []
  try {
    const value = JSON.parse(readFileSync(sessionsFile, "utf8"))
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : []
  } catch {
    return []
  }
}

function rememberSession(sessionId) {
  if (!sessionsFile) return
  const ids = new Set(knownSessions())
  ids.add(sessionId)
  writeFileSync(sessionsFile, JSON.stringify([...ids]))
}

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

function optionsFor(sessionId) {
  const selection = sessionSelections.get(sessionId) ?? { model: "fast", effort: "medium" }
  return configOptions.map((option) => ({
    ...option,
    id: option.category === "model" ? argument("--model-option-id") ?? option.id : option.id,
    currentValue: option.category === "model" ? selection.model : selection.effort,
  }))
}

function handle(message) {
  if (!message || typeof message !== "object") return
  if (message.method && message.id !== undefined && argument("--rpc-log")) {
    appendFileSync(argument("--rpc-log"), `${JSON.stringify({ method: message.method, params: message.params })}\n`)
  }
  if (!message.method) {
    // A reply to an agent-initiated client request.
    const callback = replies.get(message.id)
    if (callback) {
      replies.delete(message.id)
      callback(message)
    }
    return
  }
  if (message.method === "session/cancel") {
    // Cancellation is a notification: end the held turn, if there is one.
    const sessionId = message.params?.sessionId
    const pending = runningTurns.get(sessionId)
    if (pending) {
      runningTurns.delete(sessionId)
      update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "cancelled" },
      })
      send({ jsonrpc: "2.0", id: pending.id, result: { stopReason: "cancelled" } })
    }
    return
  }
  if (message.id === undefined) return

  switch (message.method) {
    case "initialize": {
      const gate = argument("--initialize-gate")
      if (gate && !existsSync(gate)) {
        setTimeout(() => handle(message), 10)
        return
      }
      return send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-agent", version: "1.0.0" },
          agentCapabilities: {
            sessionCapabilities: { close: true, ...(canRestore ? { resume: {} } : {}) },
            ...(canRestore ? { loadSession: true } : {}),
          },
          authMethods: [],
        },
      })
    }
    case "session/new": {
      const sessionId = `sess-${nextSession++}`
      sessionSelections.set(sessionId, { model: "fast", effort: "medium" })
      sessionDirectories.set(sessionId, message.params?.additionalDirectories ?? [])
      rememberSession(sessionId)
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId, configOptions: process.argv.includes("--no-model-selector") ? [] : optionsFor(sessionId) },
      })
      if (!process.argv.includes("--no-commands")) {
        update(sessionId, {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "compact", description: "Summarize the conversation so far" }],
        })
      }
      return
    }
    case "session/resume":
    case "session/load": {
      const sessionId = message.params?.sessionId
      if (typeof sessionId !== "string" || !knownSessions().includes(sessionId)) {
        return send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32002, message: `unknown session: ${sessionId}` },
        })
      }
      sessionDirectories.set(sessionId, message.params?.additionalDirectories ?? [])
      sessionSelections.set(sessionId, { model: "fast", effort: "medium" })
      // Never hand out an id this process already restored.
      const suffix = Number(sessionId.slice("sess-".length))
      if (Number.isFinite(suffix) && suffix >= nextSession) nextSession = suffix + 1
      return send({ jsonrpc: "2.0", id: message.id, result: {} })
    }
    case "session/set_config_option": {
      const sessionId = message.params?.sessionId
      const modelOption = argument("--model-option-id") ?? "model"
      if (
        (process.argv.includes("--no-live-switch") && sessionPrompts.has(sessionId)) ||
        runningTurns.has(sessionId)
      ) {
        return send({
          jsonrpc: "2.0", id: message.id,
          error: { code: -32602, message: "session cannot change config now" },
        })
      }
      const value = message.params?.value
      const accepted = ["fast", "slow"].includes(value) || String(value).startsWith("extra-")
      if (message.params?.configId === modelOption && !accepted) {
        return send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: `unknown model: ${value}` },
        })
      }
      const selection = sessionSelections.get(sessionId) ?? { model: "fast", effort: "medium" }
      if (message.params?.configId === modelOption) {
        selection.model = value
        // Model changes may reset reasoning effort.
        selection.effort = "medium"
      } else if (message.params?.configId === "effort") selection.effort = value
      else return send({
        jsonrpc: "2.0", id: message.id,
        error: { code: -32602, message: "unknown config option" },
      })
      sessionSelections.set(sessionId, selection)
      return send({ jsonrpc: "2.0", id: message.id, result: { configOptions: optionsFor(sessionId) } })
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

      if (process.argv.includes("--echo-history")) {
        const prompts = sessionPrompts.get(sessionId) ?? []
        prompts.push(text)
        sessionPrompts.set(sessionId, prompts)
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify({ sessionId, prompts, ...sessionSelections.get(sessionId) }) },
        })
        runningTurns.set(sessionId, { id: message.id, text })
        setTimeout(() => {
          runningTurns.delete(sessionId)
          send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
        }, 10)
        return
      }

      if (/\bfail\b/i.test(text)) {
        return send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "scripted failure" },
        })
      }
      if (/\bhang\b/i.test(text)) return
      if (/\bcrash\b/i.test(text)) {
        // Simulate the agent process dying mid-turn.
        process.exit(1)
      }
      if (/\bpermission\b/i.test(text)) {        void (async () => {
          const reply = await ask("session/request_permission", {
            sessionId,
            toolCall: {
              toolCallId: "call-permission",
              title: "Run ls",
              kind: "execute",
              status: "pending",
              rawInput: { command: "ls" },
              content: [{ type: "content", content: { type: "text", text: "ls -la" } }],
            },
            options: [
              { optionId: "allow_once", name: "Allow", kind: "allow_once" },
              { optionId: "reject_once", name: "Reject", kind: "reject_once" },
            ],
          })
          const outcome = reply?.result?.outcome
          const selected = outcome?.outcome === "selected" ? outcome.optionId : "cancelled"
          update(sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `permission:${selected}` },
          })
          send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
        })()
        return
      }
      if (/\bask\b/i.test(text)) {
        void (async () => {
          const reply = await ask("session/request_permission", {
            sessionId,
            toolCall: {
              toolCallId: "call-question",
              title: "Stack: Which stack?",
              kind: "other",
              status: "pending",
              rawInput: { question: "Which stack?", options: ["TypeScript", "Python"] },
            },
            options: [
              { optionId: "option_0", name: "TypeScript: Node", kind: "allow_once" },
              { optionId: "option_1", name: "Python: FastAPI", kind: "allow_once" },
            ],
          })
          const outcome = reply?.result?.outcome
          const selected = outcome?.outcome === "selected" ? outcome.optionId : "cancelled"
          update(sessionId, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `question:${selected}` },
          })
          send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
        })()
        return
      }
      if (text === "/compact") {
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Compacted ${sessionId}.` } })
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
      }
      if (/\bdirectories\b/i.test(text)) {
        const directories = sessionDirectories.get(sessionId) ?? []
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `directories:${directories.join(",")}` },
        })
        return send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
      }
      if (text.startsWith("fs-probe ")) {
        // fs-probe [["read"|"write", path], ...] -> "fs:ok,denied,..."
        void (async () => {
          const probes = JSON.parse(text.slice("fs-probe ".length))
          const results = []
          for (const [kind, path] of probes) {
            const reply =
              kind === "write"
                ? await ask("fs/write_text_file", { sessionId, path, content: "probe" })
                : await ask("fs/read_text_file", { sessionId, path })
            results.push(reply.error ? "denied" : "ok")
          }
          update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `fs:${results.join(",")}` } })
          send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } })
        })()
        return
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

      if (/\bsteer-me\b/i.test(text)) {
        // Hold the turn open until the client cancels it.
        runningTurns.set(sessionId, { id: message.id, text })
        update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "working" } })
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
