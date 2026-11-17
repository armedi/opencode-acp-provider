import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"
import type { AcpServerManager } from "./server-manager.ts"
import type { AcpTurnUsage, SessionUpdate } from "./acp-client.ts"
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
  /** Answer OpenCode's session-title requests locally. Defaults to true. */
  localTitles?: boolean
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
}

interface ChatMessage {
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
const COMPACTION_LIMITS: HistoryLimits = { turns: 10_000, chars: 4_000_000 }

class BodyTooLargeError extends Error {}

function textOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
}

function buildPrompt(messages: ChatMessage[], includeSystem: boolean, limits: HistoryLimits) {
  const system = messages.filter((message) => message.role === "system").map(textOf).filter(Boolean)
  const turns = messages.filter(
    (message) => (message.role === "user" || message.role === "assistant") && textOf(message).trim(),
  )
  const last = turns.pop()
  const history = limits.turns > 0 && limits.chars > 0 ? turns.slice(-limits.turns) : []
  let historyText = history
    .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${textOf(message)}`)
    .join("\n\n")
  if (historyText.length > limits.chars) {
    historyText = `[...earlier history omitted...]\n\n${historyText.slice(-limits.chars)}`
  }
  const parts: string[] = []
  if (includeSystem && system.length) parts.push(`System instructions:\n${system.join("\n\n")}`)
  if (history.length) parts.push(`Conversation so far:\n\n${historyText}`)
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

/** OpenCode asks the same model to name a session; answer locally to keep ACP turns focused. */
function isTitleRequest(messages: ChatMessage[]) {
  const system = messages.find((message) => message.role === "system")
  return typeof system?.content === "string" && /name conversations|conversation title/i.test(system.content)
}

/** Compaction asks for a summary of the whole transcript and must not be truncated. */
function isCompactionRequest(messages: ChatMessage[]) {
  return messages.some((message) =>
    /summarize the conversation above into a structured summary/i.test(textOf(message)),
  )
}



function deriveTitle(messages: ChatMessage[]) {
  const last = messages[messages.length - 1]
  const raw = textOf(last ?? { role: "", content: "" })
  const match = raw.match(/<message>([\s\S]*?)<\/message>/i)
  const text = (match?.[1] ?? raw).replace(/\s+/g, " ").trim()
  if (!text) return "New session"
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

function finishReason(stopReason: string) {
  if (stopReason === "max_tokens" || stopReason === "max_turn_requests") return "length"
  if (stopReason === "refusal") return "content_filter"
  return "stop"
}

/**
 * Chat-completions `usage` for an ACP turn. `prompt_tokens` includes cached
 * tokens and `completion_tokens` includes reasoning, as in OpenAI's API;
 * `cache_write_tokens` carries Anthropic-style cache writes.
 *
 * Codex counts cache reads inside `inputTokens` (total = input + output);
 * Claude counts them beside it (total = input + output + cache), so the total
 * decides which convention a report uses.
 */
function completionUsage(usage: AcpTurnUsage | undefined) {
  if (!usage) return undefined
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0)
  const input = count(usage.inputTokens)
  const output = count(usage.outputTokens)
  const thought = count(usage.thoughtTokens)
  const cacheRead = count(usage.cachedReadTokens)
  const cacheWrite = count(usage.cachedWriteTokens)
  const total = typeof usage.totalTokens === "number" ? usage.totalTokens : undefined
  const cached = cacheRead + cacheWrite
  const cacheBeside = cached > 0 && (total === undefined ? cached > input : total >= input + output + cached)
  const prompt = input + (cacheBeside ? cached : 0)
  const thoughtBeside = thought > 0 && total !== undefined && total >= prompt + output + thought
  const completion = output + (thoughtBeside ? thought : 0)
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite },
    completion_tokens_details: { reasoning_tokens: Math.min(thought, completion) },
  }
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
  const limits: HistoryLimits = {
    turns: Math.max(0, options.historyTurns ?? DEFAULT_HISTORY_TURNS),
    chars: Math.max(0, options.historyChars ?? DEFAULT_HISTORY_CHARS),
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const localTitles = options.localTitles !== false
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

    if (localTitles && isTitleRequest(messages)) {
      const title = deriveTitle(messages)
      log("debug", `answering session-title request locally: ${title}`)
      if (stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        })
        const chunk = (delta: Record<string, unknown>, reason: string | null = null) =>
          `data: ${JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: modelID,
            choices: [{ index: 0, delta, finish_reason: reason }],
          })}\n\n`
        res.write(chunk({ role: "assistant", content: title }))
        res.write(chunk({}, "stop"))
        res.write("data: [DONE]\n\n")
      } else {
        res.writeHead(200, { "content-type": "application/json" })
        res.write(
          JSON.stringify({
            id,
            object: "chat.completion",
            created,
            model: modelID,
            choices: [{ index: 0, message: { role: "assistant", content: title }, finish_reason: "stop" }],
          }),
        )
      }
      res.end()
      return
    }

    const key = sessionKey(req, body)
    if (!key && !loggedOneOff) {
      loggedOneOff = true
      log("warn", "no OpenCode session header on the shim request; ACP sessions will not be reused and MCP tools are unavailable")
    }
    // The AI SDK provider asks for structured tool events so OpenCode can
    // render native tool cards; the OpenAI-compatible route keeps inline lines.
    const structuredTools = req.headers["x-acp-tool-events"] === "1"
    // A compaction request needs the full transcript; truncating it would
    // produce a summary of the wrong slice of the conversation.
    const promptLimits = isCompactionRequest(messages) ? COMPACTION_LIMITS : limits
    const fresh = buildPrompt(messages, options.includeSystem === true, promptLimits)
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

    const writeChunk = (delta: Record<string, unknown>, reason: string | null = null, usage?: unknown) => {
      if (!stream || res.destroyed || res.writableEnded) return
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: modelID,
          choices: [{ index: 0, delta, finish_reason: reason }],
          ...(usage ? { usage } : {}),
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
      // Only the turn's own accounting is billed usage. `usage_update.used` is
      // context occupancy (and session-cumulative in codex-acp), never input.
      const usage = completionUsage(result.usage)
      if (stream) {
        writeChunk({}, reason, usage)
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
            ...(usage ? { usage } : {}),
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

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
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
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  log("info", `ACP provider shim listening on http://127.0.0.1:${port}/v1`)

  return {
    url: `http://127.0.0.1:${port}/v1`,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
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

export type { ServerResponse }
