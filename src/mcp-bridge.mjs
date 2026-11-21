#!/usr/bin/env node
// Minimal stdio <-> HTTP bridge for the OpenCode MCP server.
// ACP agents that do not accept HTTP MCP servers launch this file.

const endpoint = process.env.OPENCODE_MCP_URL
const token = process.env.OPENCODE_MCP_TOKEN
const timeoutMs = Number(process.env.OPENCODE_MCP_TIMEOUT_MS ?? 10 * 60_000)

if (!endpoint || !token) {
  process.stderr.write("mcp-bridge: OPENCODE_MCP_URL and OPENCODE_MCP_TOKEN are required\n")
  process.exit(2)
}

let sessionId = null
let protocolVersion = null
let buffer = ""
const aborters = new Map()

function extractErrorMessage(error, seen) {
  if (error === null || error === undefined) return undefined
  if (typeof error === "string") return error.trim() ? error : undefined
  if (typeof error !== "object") {
    try {
      return String(error)
    } catch {
      return undefined
    }
  }
  if (seen.has(error)) return undefined
  seen.add(error)
  if (typeof error.message === "string" && error.message.trim()) return error.message
  if (error.cause !== undefined) {
    const caused = extractErrorMessage(error.cause, seen)
    if (caused) return caused
  }
  if (typeof error.name === "string" && error.name.trim()) return error.name
  try {
    const text = String(error).trim()
    return text && text !== "[object Object]" ? text : undefined
  } catch {
    return undefined
  }
}

function errorMessage(error) {
  return extractErrorMessage(error, new Set()) ?? "Unknown error"
}

process.stdout.on("error", (error) => {
  process.stderr.write(`mcp-bridge: stdout failed: ${errorMessage(error)}\n`)
  process.exit(1)
})
process.stderr.on("error", () => process.exit(1))

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function log(message) {
  process.stderr.write(`mcp-bridge: ${message}\n`)
}

function signalWithTimeout(external) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return external
  if (typeof AbortSignal.timeout !== "function") return external
  const timeout = AbortSignal.timeout(timeoutMs)
  if (typeof AbortSignal.any !== "function") return external ?? timeout
  return external ? AbortSignal.any([external, timeout]) : timeout
}

async function post(message, signal) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  }
  if (sessionId) headers["mcp-session-id"] = sessionId
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal: signalWithTimeout(signal),
  })
  sessionId = response.headers.get("mcp-session-id") ?? sessionId
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`MCP endpoint returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`)
  }

  const contentType = response.headers.get("content-type") ?? ""
  const text = await response.text()
  if (contentType.includes("text/event-stream")) {
    const payloads = []
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (!data || data === "[DONE]") continue
      try {
        payloads.push(JSON.parse(data))
      } catch {
        // ignore non-JSON events
      }
    }
    return payloads
  }
  if (!text.trim()) return []
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function handle(message) {
  if (Array.isArray(message)) {
    await Promise.all(message.map((entry) => handle(entry)))
    return
  }
  if (!message || typeof message !== "object") return
  if (!("id" in message) || message.id === null || message.id === undefined) {
    if (message.method === "notifications/cancelled") {
      const requestId = message.params?.requestId
      aborters.get(requestId)?.abort()
      aborters.delete(requestId)
    }
    try {
      await post(message)
    } catch (error) {
      log(errorMessage(error))
    }
    return
  }

  const controller = new AbortController()
  aborters.set(message.id, controller)
  try {
    const payloads = await post(message, controller.signal)
    const response = payloads.find((payload) => payload && payload.id === message.id) ?? payloads[0]
    if (!response) {
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "MCP server returned no response" } })
      return
    }
    if (message.method === "initialize" && response.result && typeof response.result.protocolVersion === "string") {
      protocolVersion = response.result.protocolVersion
    }
    write(response)
  } catch (error) {
    write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: errorMessage(error) },
    })
  } finally {
    aborters.delete(message.id)
  }
}

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      log(`ignoring invalid JSON: ${line.slice(0, 200)}`)
      continue
    }
    void handle(message)
  }
})
process.stdin.on("end", () => process.exit(0))
process.stdin.on("close", () => process.exit(0))
process.stdin.on("error", (error) => {
  log(errorMessage(error))
  process.exit(1)
})
