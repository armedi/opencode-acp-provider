import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"
import type { AcpServerManager } from "./server-manager.ts"
import type { SessionUpdate } from "./acp-client.ts"
import { applyToolUpdate, type AcpToolState } from "./acp-tools.ts"

export interface ShimOptions {
  manager: AcpServerManager
  /** Resolve an OpenAIChat model id to a registered ACP server id. */
  resolveModel: (modelID: string) => { server: string; model: string } | undefined
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void
  /** Bearer token clients must present. When omitted the shim is unauthenticated. */
  token?: string
  /** Include OpenCode's system message in the ACP prompt. Defaults to false. */
  includeSystem?: boolean
  /** Turns of history replayed into a brand new ACP session. Defaults to 16. */
  historyTurns?: number
  /** Characters of history replayed into a brand new ACP session. Defaults to 8192. */
  historyChars?: number
  /** Largest chat-completions body accepted. Defaults to 32 MB. */
  maxBodyBytes?: number
  /** Precompute the debug strings. */
  debugEnabled?: boolean
  /** Show ACP tool calls in the answer stream. Defaults to "inline". */
  toolCallDisplay?: "off" | "inline"
  /**
   * How long `close()` waits for requests that are still streaming before it
   * drops their connections. Defaults to 30 minutes, matching one ACP turn.
   */
  drainTimeoutMs?: number
}

export interface ChatMessage {
  role: string
  content?: string | Array<{ type?: string; text?: string }>
}

interface HistoryLimits {
  turns: number
  chars: number
}

const DEFAULT_HISTORY_TURNS = 16
const DEFAULT_HISTORY_CHARS = 8_192
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024
const DEFAULT_DRAIN_TIMEOUT_MS = 30 * 60_000

class BodyTooLargeError extends Error {}

function textOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
}

function conversationTurns(messages: ChatMessage[]) {
  return messages.filter((message) => (message.role === "user" || message.role === "assistant") && textOf(message).trim())
}

/** User and assistant turns as plain text, capped to the newest `limits.turns` and `limits.chars`. */
function historyText(turns: ChatMessage[], limits: HistoryLimits) {
  const history = limits.turns > 0 && limits.chars > 0 ? turns.slice(-limits.turns) : []
  const text = history
    .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${textOf(message)}`)
    .join("\n\n")
  return text.length > limits.chars ? `[...earlier history omitted...]\n\n${text.slice(-limits.chars)}` : text
}

export function historyLimits(options: { historyTurns?: number; historyChars?: number }): HistoryLimits {
  return {
    turns: Math.max(0, options.historyTurns ?? DEFAULT_HISTORY_TURNS),
    chars: Math.max(0, options.historyChars ?? DEFAULT_HISTORY_CHARS),
  }
}

/** The recent conversation a brand new ACP session would be given, as plain text. */
export function recentConversation(messages: ChatMessage[], limits: HistoryLimits) {
  return historyText(conversationTurns(messages), limits)
}

function buildPrompt(messages: ChatMessage[], includeSystem: boolean, limits: HistoryLimits) {
  const system = messages.filter((message) => message.role === "system").map(textOf).filter(Boolean)
  const turns = conversationTurns(messages)
  const last = turns.pop()
  const history = historyText(turns, limits)
  const parts: string[] = []
  if (includeSystem && system.length) parts.push(`System instructions:\n${system.join("\n\n")}`)
  if (history) parts.push(`Conversation so far:\n\n${history}`)
  parts.push(last ? textOf(last) : "")
  return parts.filter(Boolean).join("\n\n---\n\n")
}

/**
 * A reused ACP session already holds the conversation, so only the newest user
 * turn is needed. Replaying the transcript would duplicate context and cost.
 */
function lastUserPrompt(messages: ChatMessage[], includeSystem: boolean) {
  const system = messages.filter((message) => message.role === "system").map(textOf).filter(Boolean)
  const last = [...messages].reverse().find((message) => message.role !== "system" && textOf(message).trim())
  const parts: string[] = []
  if (includeSystem && system.length) parts.push(`System instructions:\n${system.join("\n\n")}`)
  parts.push(last ? textOf(last) : "")
  return parts.filter(Boolean).join("\n\n---\n\n")
}

function sessionKey(req: IncomingMessage, body: any): string | undefined {
  // x-opencode-session-id is the session itself; x-opencode-session is the
  // affinity/root session (parent or fork source), so it must come second.
  for (const name of [
    "x-opencode-session-id",
    "x-opencode-session",
    "x-session-id",
    "x-session-affinity",
  ]) {
    const value = req.headers[name]
    if (typeof value === "string" && value) return value
  }
  if (typeof body?.user === "string" && body.user) return body.user
  return undefined
}

/**
 * Reasoning effort selected by the OpenCode model variant. OpenAI-compatible
 * providers send it as `reasoning_effort`; other provider shapes nest it.
 */
function effortOf(body: any): string | undefined {
  const value = body?.reasoning_effort ?? body?.reasoning?.effort ?? body?.providerOptions?.reasoningEffort ?? body?.effort
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function finishReason(stopReason: string) {
  if (stopReason === "max_tokens" || stopReason === "max_turn_requests") return "length"
  if (stopReason === "refusal") return "content_filter"
  return "stop"
}

interface ToolCallState {
  title: string
  kind?: string
  status: string
  shown: boolean
}

/**
 * ACP agents execute their own tools, so there is no OpenCode tool part to
 * render. Show each finished tool call as a compact transcript line instead.
 */
function toolCallLine(update: SessionUpdate, states: Map<string, ToolCallState>) {
  const id = typeof update.toolCallId === "string" ? update.toolCallId : undefined
  if (!id) return ""
  const state = states.get(id) ?? { title: "tool", status: "pending", shown: false }
  if (typeof update.title === "string" && update.title.trim()) state.title = update.title.trim()
  if (typeof update.kind === "string" && update.kind) state.kind = update.kind
  if (typeof update.status === "string" && update.status) state.status = update.status
  states.set(id, state)
  if (state.shown || (state.status !== "completed" && state.status !== "failed")) return ""
  state.shown = true
  const kind = state.kind === "execute" ? "shell" : state.kind ?? "tool"
  const icon = state.status === "failed" ? "✗" : "✓"
  const detail = toolDetail(update) || state.title
  const label = detail.toLowerCase().startsWith(kind.toLowerCase()) ? detail : `${kind}: ${detail}`
  return `\n\n> ${icon} ${label}\n\n`
}

function toolDetail(update: SessionUpdate) {
  const raw = update.rawInput
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const key of ["command", "path", "file_path", "query", "url", "pattern"]) {
      const value = (raw as Record<string, unknown>)[key]
      if (typeof value === "string" && value.trim()) return truncate(value.trim(), 120)
    }
  }
  return ""
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export async function createShim(options: ShimOptions) {
  const { manager, log = () => {} } = options
  const debug = options.debugEnabled === true
  const limits = historyLimits(options)
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const toolCallDisplay = options.toolCallDisplay !== "off"
  const token = options.token
  let loggedRequest = false
  let loggedOneOff = false

  const authorized = (req: IncomingMessage) => {
    if (!token) return true
    const header = req.headers.authorization
    if (typeof header !== "string") return false
    const separator = header.indexOf(" ")
    return separator > 0 && header.slice(0, separator).toLowerCase() === "bearer" && header.slice(separator + 1).trim() === token
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    res.on("error", () => {})
    const url = (req.url ?? "").split("?")[0]

    if (!authorized(req)) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" })
      res.end(JSON.stringify({ error: { message: "Unauthorized", type: "invalid_request_error" } }))
      return
    }

    if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
      const data = manager.list.flatMap((state) =>
        state.models.map((model) => ({ id: model.id, object: "model", owned_by: state.config.id })),
      )
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ object: "list", data }))
      return
    }

    if (req.method !== "POST" || !(url === "/v1/chat/completions" || url === "/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: `Not found: ${req.method} ${url}`, type: "invalid_request_error" } }))
      return
    }

    let raw: string
    try {
      raw = await readBody(req, maxBodyBytes)
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        res.writeHead(413, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            error: { message: `Request body exceeds ${maxBodyBytes} bytes`, type: "invalid_request_error" },
          }),
        )
        req.destroy()
        return
      }
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Could not read request body", type: "invalid_request_error" } }))
      return
    }

    let body: any
    try {
      body = JSON.parse(raw)
    } catch {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }))
      return
    }

    if (debug) {
      if (!loggedRequest) {
        loggedRequest = true
        log("debug", `shim request keys: ${Object.keys(body).join(", ")}; headers: ${Object.keys(req.headers).join(", ")}`)
      }
      log(
        "debug",
        `shim session headers: x-opencode-session=${String(req.headers["x-opencode-session"] ?? "")} x-opencode-session-id=${String(
          req.headers["x-opencode-session-id"] ?? "",
        )}`,
      )
    }

    if (typeof body?.model !== "string" || !body.model) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Missing model", type: "invalid_request_error" } }))
      return
    }
    const modelID: string = body.model
    const target = options.resolveModel(modelID)
    if (!target) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          error: { message: `No ACP server registered for model "${modelID}"`, type: "invalid_request_error" },
        }),
      )
      return
    }

    const stream = body.stream === true
    const messages: ChatMessage[] = Array.isArray(body.messages) ? body.messages : []
    const effort = effortOf(body)
    if (debug) {
      log(
        "debug",
        `shim request: ${messages.length} msg(s) roles=${messages.map((message) => message.role).join(",")} effort=${effort ?? "-"} max_tokens=${body.max_tokens ?? "-"} first=${textOf(
          messages[0] ?? { role: "", content: "" },
        )
          .replace(/\s+/g, " ")
          .slice(0, 90)} last=${textOf(messages[messages.length - 1] ?? { role: "", content: "" })
          .replace(/\s+/g, " ")
          .slice(0, 90)}`,
      )
    }
    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)

    const key = sessionKey(req, body)
    if (!key && !loggedOneOff) {
      loggedOneOff = true
      log("warn", "no OpenCode session header on the shim request; ACP sessions will not be reused and MCP tools are unavailable")
    }
    // The AI SDK provider asks for structured tool events so OpenCode can
    // render native tool cards; the OpenAI-compatible route keeps inline lines.
    const structuredTools = req.headers["x-acp-tool-events"] === "1"
    const fresh = buildPrompt(messages, options.includeSystem === true, limits)
    if (!fresh.trim()) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Empty prompt", type: "invalid_request_error" } }))
      return
    }
    const reused = lastUserPrompt(messages, options.includeSystem === true) || fresh

    // The client may have disconnected while the body was being read.
    if (res.destroyed) return

    const controller = new AbortController()
    res.on("close", () => {
      if (!res.writableEnded) controller.abort()
    })

    const writeChunk = (delta: Record<string, unknown>, reason: string | null = null) => {
      if (!stream || res.destroyed || res.writableEnded) return
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: modelID,
          choices: [{ index: 0, delta, finish_reason: reason }],
        })}\n\n`,
      )
    }

    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      writeChunk({ role: "assistant", content: "" })
    }

    // A silent agent turn can otherwise trip a client-side chunk timeout.
    const heartbeat = stream
      ? setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(": keep-alive\n\n")
        }, 15_000)
      : undefined
    heartbeat?.unref?.()

    let emitted = ""
    let reasoning = ""
    let chunks = 0
    let firstChunkAt: number | undefined
    let firstThoughtAt: number | undefined
    const startedAt = Date.now()
    const toolCalls = new Map<string, ToolCallState>()
    const acpTools = new Map<string, AcpToolState>()
    try {
      const result = await manager.run({
        server: target.server,
        model: target.model,
        effort,
        prompt: { fresh, reused },
        key,
        sessionKey: key,
        signal: controller.signal,
        onUpdate: (update: SessionUpdate) => {
          if (update.sessionUpdate === "agent_thought_chunk" && update.content?.type === "text") {
            chunks += 1
            if (!firstThoughtAt) {
              firstThoughtAt = Date.now()
              if (debug) log("debug", `first ACP thought chunk after ${firstThoughtAt - startedAt}ms`)
            }
            const text = update.content.text ?? ""
            reasoning += text
            writeChunk({ reasoning_content: text })
          } else if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
            chunks += 1
            if (!firstChunkAt) {
              firstChunkAt = Date.now()
              if (debug) log("debug", `first ACP text chunk after ${firstChunkAt - startedAt}ms`)
            }
            const text = update.content.text ?? ""
            emitted += text
            writeChunk({ content: text })
          } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            if (structuredTools) {
              const state = applyToolUpdate(update, acpTools)
              if (state) {
                writeChunk({
                  _acp_tool: {
                    id: state.id,
                    name: state.name,
                    kind: state.kind,
                    title: state.title,
                    status: state.status,
                    input: state.input,
                    output: state.done ? state.output : undefined,
                    isError: state.isError,
                    done: state.done,
                  },
                })
              }
            } else if (toolCallDisplay) {
              const line = toolCallLine(update, toolCalls)
              if (line) {
                emitted += line
                writeChunk({ content: line })
              }
            }
          }
        },
      })

      if (!emitted && result.text) {
        emitted = result.text
        writeChunk({ content: result.text })
      }
      if (debug) {
        log(
          "debug",
          `ACP turn finished for ${target.server}/${target.model}: ${result.stopReason} in ${Date.now() - startedAt}ms (${chunks} chunks, ${reasoning.length} reasoning chars, ${emitted.length} text chars)`,
        )
      }

      const reason = finishReason(result.stopReason)
      if (stream) {
        writeChunk({}, reason)
        if (!res.destroyed && !res.writableEnded) {
          res.write("data: [DONE]\n\n")
          res.end()
        }
      } else {
        if (res.destroyed) return
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model: modelID,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: emitted, ...(reasoning ? { reasoning_content: reasoning } : {}) },
                finish_reason: reason,
              },
            ],
          }),
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log("error", `ACP prompt failed for ${target.server}/${target.model}: ${message}`)
      if (res.destroyed) return
      if (!stream) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message, type: "acp_error" } }))
        return
      }
      writeChunk({ content: `\n\n[ACP error: ${message}]` })
      writeChunk({}, "stop")
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n")
        res.end()
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat)
    }
  }

  const inflight = new Set<Promise<void>>()
  const server = createServer((req, res) => {
    const work = (async () => {
      try {
        await handleRequest(req, res)
      } catch (error) {
        log("error", `shim request failed: ${error instanceof Error ? error.message : String(error)}`)
        if (res.destroyed) return
        if (!res.headersSent) {
          try {
            res.writeHead(500, { "content-type": "application/json" })
          } catch {
            // the connection was closed
          }
        }
        if (!res.writableEnded) {
          try {
            res.end()
          } catch {
            // the connection was closed
          }
        }
      }
    })()
    inflight.add(work)
    void work.finally(() => inflight.delete(work))
  })

  // Bun keeps shim connections alive and reuses them across turns. Node's
  // default 5s idle timeout closes a socket just as Bun picks it up again,
  // which surfaces as an ECONNRESET in the middle of a turn. A local server
  // does not need an idle timeout: `close()` drops the sockets it owns.
  server.keepAliveTimeout = 0

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  log("info", `ACP provider shim listening on http://127.0.0.1:${port}/v1`)
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS

  return {
    url: `http://127.0.0.1:${port}/v1`,
    /**
     * A plugin reload disposes this instance while a turn may still be
     * streaming. Destroying that connection is what the client reports as
     * ECONNRESET, so stop accepting new requests, let the running turn finish,
     * and only then drop the sockets.
     */
    async close() {
      const drained = new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeIdleConnections?.()
      })
      const deadline = Date.now() + Math.max(0, drainTimeoutMs)
      while (inflight.size) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          Promise.allSettled([...inflight]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining)
            timer.unref?.()
          }),
        ])
        if (timer) clearTimeout(timer)
      }
      server.closeAllConnections?.()
      await drained
    },
  }
}

function readBody(req: IncomingMessage, maxBytes: number) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let finished = false
    req.on("data", (chunk) => {
      if (finished) return
      size += chunk.length
      if (size > maxBytes) {
        finished = true
        reject(new BodyTooLargeError(`Request body exceeds ${maxBytes} bytes`))
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    req.on("end", () => {
      if (finished) return
      finished = true
      resolve(Buffer.concat(chunks).toString("utf8"))
    })
    req.on("error", (error) => {
      if (finished) return
      finished = true
      reject(error)
    })
  })
}
