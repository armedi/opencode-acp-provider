type Log = (level: "debug" | "info" | "warn" | "error", message: string) => void

export interface AcpLanguageModelOptions {
  /** ACP server id, as registered with the manager. */
  server: string
  /** Model id advertised by that server. */
  model: string
  /** Base URL of the chat-completions shim, e.g. `http://127.0.0.1:1234/v1`. */
  url: string
  /** Bearer token required by the shim, when it enforces one. */
  token?: string
  log?: Log
}

/**
 * The AI SDK side of the bridge. OpenCode sees a normal language model; the
 * model turns one ACP turn into AI SDK stream parts, including the agent's own
 * tool calls flagged `providerExecuted` so OpenCode records them as native
 * tool parts instead of running anything itself.
 */
export function createAcpLanguageModel(options: AcpLanguageModelOptions) {
  const model = {
    specificationVersion: "v3" as const,
    provider: "acp",
    modelId: options.model,
    supportedUrls: {},

    async doStream(call: CallOptions) {
      const sessionID = header(call.headers, "x-opencode-session-id")
      const requestKind = header(call.headers, "x-acp-request-kind")
      options.log?.(
        "debug",
        `acp language model ${options.server}/${options.model} session=${sessionID ?? "-"} kind=${requestKind ?? "primary"} messages=${call.prompt?.length ?? 0}`,
      )
      const response = await post(
        `${options.url}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Ask the shim for structured tool events instead of inline markers.
            "x-acp-tool-events": "1",
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
            ...(sessionID ? { "x-opencode-session-id": sessionID } : {}),
            ...(requestKind ? { "x-acp-request-kind": requestKind } : {}),
          },
          body: JSON.stringify({
            model: `${options.server}::${options.model}`,
            stream: true,
            messages: toMessages(call.prompt),
            reasoning_effort: effortOf(call.providerOptions),
          }),
          signal: call.abortSignal ?? undefined,
        },
        options.log,
      )
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "")
        throw new Error(`ACP shim responded ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`)
      }
      return { stream: translate(response.body, options.log) }
    },

    async doGenerate(call: CallOptions) {
      const { stream } = await this.doStream(call)
      const content: any[] = []
      let finishReason = "stop"
      let usage: any = unknownUsage()
      for await (const part of readAll(stream)) {
        if (part.type === "text-delta") content.push({ type: "text", text: part.delta })
        else if (part.type === "reasoning-delta") content.push({ type: "reasoning", text: part.delta })
        else if (part.type === "tool-call")
          content.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            providerExecuted: true,
          })
        else if (part.type === "tool-result")
          content.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: part.result,
          })
        else if (part.type === "finish") {
          finishReason = part.finishReason?.unified ?? "stop"
          usage = part.usage
        } else if (part.type === "error") {
          throw part.error instanceof Error ? part.error : new Error(String(part.error))
        }
      }
      return {
        content,
        finishReason: { unified: finishReason, raw: finishReason },
        usage,
        warnings: [],
      }
    },
  }
  return model
}

interface CallOptions {
  prompt?: PromptMessage[]
  headers?: Record<string, string>
  providerOptions?: Record<string, unknown>
  abortSignal?: AbortSignal
}
interface PromptMessage {
  role: string
  content: string | Array<{ type?: string; text?: string }>
}

/** Transport failures worth one more attempt before the model call fails. */
const RETRYABLE_TRANSPORT = /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|other side closed|fetch failed/i
const RETRY_DELAYS_MS = [150, 600]

function failureText(error: unknown, depth = 0): string {
  if (!error || depth > 4) return ""
  if (typeof error === "string") return error
  if (error instanceof Error) {
    return `${error.name}: ${error.message} ${failureText((error as { cause?: unknown }).cause, depth + 1)}`
  }
  return String(error)
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(signal?.reason ?? new Error("aborted"))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
    const done = () => {
      cleanup()
      resolve()
    }
    const timer = setTimeout(done, ms)
    timer.unref?.()
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * POST to the shim, retrying a connection that died before the response
 * started. A reset on a reused keep-alive socket is transient: the shim never
 * saw the turn, so asking again cannot duplicate it. Once headers arrive the
 * caller owns the stream, so a mid-stream reset is left to OpenCode's retry.
 */
async function post(url: string, init: RequestInit, log?: Log) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init)
    } catch (error) {
      const detail = failureText(error)
      const retryable = !init.signal?.aborted && RETRYABLE_TRANSPORT.test(detail) && attempt < RETRY_DELAYS_MS.length
      if (!retryable) throw error
      log?.("warn", `acp shim request failed (${detail.slice(0, 200)}); retrying`)
      await sleep(RETRY_DELAYS_MS[attempt], init.signal ?? undefined)
    }
  }
}

function header(headers: Record<string, string> | undefined, name: string) {
  if (!headers) return undefined
  const value = headers[name] ?? headers[name.toLowerCase()]
  return typeof value === "string" && value ? value : undefined
}

/**
 * The selected variant arrives as provider options nested under the provider's
 * key. Find the effort anywhere in that tree so the ACP agent still receives
 * the variant the user picked.
 */
function effortOf(providerOptions: unknown): string | undefined {
  const seen = new Set<unknown>()
  const walk = (value: unknown, depth: number): string | undefined => {
    if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return undefined
    seen.add(value)
    const entry = value as Record<string, unknown>
    for (const key of ["reasoningEffort", "reasoning_effort", "effort"]) {
      const found = entry[key]
      if (typeof found === "string" && found.trim()) return found.trim()
    }
    for (const nested of Object.values(entry)) {
      const found = walk(nested, depth + 1)
      if (found) return found
    }
    return undefined
  }
  return walk(providerOptions, 0)
}

function textOf(item: { type?: string; text?: string }) {
  return item?.type === "text" && typeof item.text === "string" ? item.text : ""
}

/**
 * The shim only needs the visible conversation: the ACP session keeps its own
 * history, and tool parts are not replayed into a fresh agent session.
 */
function toMessages(prompt: PromptMessage[] | undefined) {
  const messages: Array<{ role: string; content: string }> = []
  for (const message of prompt ?? []) {
    if (typeof message.content === "string") {
      if (message.content.trim()) messages.push({ role: message.role, content: message.content })
      continue
    }
    if (!Array.isArray(message.content)) continue
    const value = message.content.map(textOf).filter(Boolean).join("\n")
    if (value.trim()) messages.push({ role: message.role, content: value })
  }
  return messages
}

/**
 * Usage is never reported. OpenCode reads a step's tokens both as context size
 * and as spend, and an ACP turn spans many model calls, so no number the agent
 * gives is right for both. Unknown counts beat wrong ones.
 */
function unknownUsage() {
  return {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  }
}

interface ToolProgress {
  name: string
  started: boolean
  called: boolean
  settled: boolean
  title?: string
  output?: string
}

/**
 * Parse the shim's chat-completions SSE into AI SDK v3 stream parts. Text and
 * reasoning fragments are closed around tool calls so the transcript keeps the
 * agent's actual order (text, card, text).
 */
function translate(body: ReadableStream<Uint8Array>, log?: Log) {
  let textID: string | undefined
  let reasoningID: string | undefined
  let textSeq = 0
  let reasoningSeq = 0
  let reason = "stop"
  const usage = unknownUsage()
  const tools = new Map<string, ToolProgress>()
  const reader = body.getReader()
  const decoder = new TextDecoder()

  const pump = async (push: (part: any) => void) => {
    push({ type: "stream-start", warnings: [] })
    let buffer = ""
    const closeText = () => {
      if (textID === undefined) return
      push({ type: "text-end", id: textID })
      textID = undefined
    }
    const closeReasoning = () => {
      if (reasoningID === undefined) return
      push({ type: "reasoning-end", id: reasoningID })
      reasoningID = undefined
    }
    const openText = () => {
      if (textID !== undefined) return
      closeReasoning()
      textID = `text-${textSeq++}`
      push({ type: "text-start", id: textID })
    }
    const openReasoning = () => {
      if (reasoningID !== undefined) return
      closeText()
      reasoningID = `reasoning-${reasoningSeq++}`
      push({ type: "reasoning-start", id: reasoningID })
    }
    const callTool = (id: string, current: { name: string; title?: string }, input: Record<string, unknown>) => {
      // An agent that never sends raw input still gets a readable shell card
      // from its own title instead of an empty command.
      const value =
        Object.keys(input).length === 0 && current.name === "shell" && current.title
          ? { command: current.title }
          : input
      push({
        type: "tool-call",
        toolCallId: id,
        toolName: current.name,
        input: JSON.stringify(value),
        providerExecuted: true,
        dynamic: true,
      })
    }
    const settleTool = (id: string, current: { name: string; output?: string }, isError: boolean) => {
      push({
        type: "tool-result",
        toolCallId: id,
        toolName: current.name,
        result: typeof current.output === "string" ? current.output : "",
        isError,
        dynamic: true,
      })
    }
    const handleTool = (event: any) => {
      if (!event || typeof event.id !== "string") return
      const existing = tools.get(event.id)
      const name = existing?.name ?? (typeof event.name === "string" && event.name ? event.name : "tool")
      const current: ToolProgress = existing ?? { name, started: false, called: false, settled: false }
      if (!existing) tools.set(event.id, current)
      if (typeof event.title === "string" && event.title) current.title = event.title
      if (typeof event.output === "string" && event.output) current.output = event.output
      closeText()
      closeReasoning()
      if (!current.started) {
        push({ type: "tool-input-start", id: event.id, toolName: name, providerExecuted: true })
        current.started = true
      }
      const input = event.input && typeof event.input === "object" && !Array.isArray(event.input) ? event.input : {}
      const done = event.done === true
      const keys = Object.keys(input)
      // Agents stream edit/write input in pieces. Wait for the actual change so
      // the card is created with its diff instead of a path-only placeholder.
      const partial =
        (name === "edit" && (input.oldString === undefined || input.newString === undefined)) ||
        (name === "write" && input.content === undefined)
      if (!current.called && (done || (keys.length > 0 && !partial))) {
        callTool(event.id, current, input)
        current.called = true
      }
      if (done && !current.settled) {
        settleTool(event.id, current, event.isError === true)
        current.settled = true
      }
    }
    const handleDelta = (delta: Record<string, any>) => {
      if (typeof delta.content === "string" && delta.content) {
        openText()
        push({ type: "text-delta", id: textID, delta: delta.content })
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        openReasoning()
        push({ type: "reasoning-delta", id: reasoningID, delta: delta.reasoning_content })
      }
      if (delta._acp_tool) handleTool(delta._acp_tool)
    }
    let failed = false
    let failure: unknown
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf("\n")
        while (index >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, "")
          buffer = buffer.slice(index + 1)
          index = buffer.indexOf("\n")
          if (!line.startsWith("data:")) continue
          const data = line.slice(5).trim()
          if (!data || data === "[DONE]") continue
          let frame: any
          try {
            frame = JSON.parse(data)
          } catch {
            continue
          }
          const choice = frame?.choices?.[0]
          if (choice?.delta) handleDelta(choice.delta)
          if (typeof choice?.finish_reason === "string" && choice.finish_reason) reason = choice.finish_reason
        }
      }
    } catch (error) {
      failed = true
      failure = error
      log?.("warn", `acp language model stream failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      closeText()
      closeReasoning()
      try {
        reader.releaseLock()
      } catch {
        // the stream was already cancelled
      }
    }
    // Settle every tool even when the turn was interrupted, so a cancelled or
    // failed turn cannot leave a card stuck in the streaming state.
    for (const [id, current] of tools) {
      if (current.settled) continue
      if (!current.called) {
        callTool(id, current, {})
        current.called = true
      }
      settleTool(id, current, failed)
      current.settled = true
    }
    if (!failed) {
      push({ type: "finish", finishReason: { unified: unifiedReason(reason), raw: reason }, usage })
    } else {
      push({ type: "error", error: failure })
    }
  }

  let closed = false
  return new ReadableStream<any>({
    start(controller) {
      const push = (part: any) => {
        if (closed) return
        try {
          controller.enqueue(part)
        } catch {
          closed = true
        }
      }
      const finish = () => {
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch {
          // cancelled by the consumer
        }
      }
      void pump(push).then(finish, (error) => {
        if (closed) return
        closed = true
        try {
          controller.error(error)
        } catch {
          // cancelled by the consumer
        }
      })
    },
    cancel(reason) {
      closed = true
      void reader.cancel(reason).catch(() => {})
    },
  })
}

function unifiedReason(reason: string) {
  if (reason === "length") return "length"
  if (reason === "content_filter" || reason === "content-filter") return "content-filter"
  if (reason === "tool_calls" || reason === "tool-calls") return "tool-calls"
  return "stop"
}

async function* readAll(stream: ReadableStream<any>) {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}
