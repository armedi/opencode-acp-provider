import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createReadStream } from "node:fs"
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { createInterface } from "node:readline"

/**
 * Minimal Agent Client Protocol (ACP) client.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over the child's stdio, the transport
 * used by `cmd acp`, Zed, and other ACP agents.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } }

export interface SessionUpdate {
  sessionUpdate: string
  content?: { type?: string; text?: string }
  [key: string]: unknown
}

/**
 * ACP `PromptResponse.usage` (draft): the tokens the finished turn consumed,
 * summed over every model call in it. Agents disagree on whether
 * `inputTokens` includes cached tokens; `totalTokens` tells them apart.
 */
export interface AcpTurnUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  thoughtTokens?: number | null
  cachedReadTokens?: number | null
  cachedWriteTokens?: number | null
}

function turnUsage(result: any): AcpTurnUsage | undefined {
  // Command Code reports session-cumulative `usage` and this turn alone in
  // `_meta.usage`. Its totals show input includes cache reads, so the total
  // here is input + output.
  const own = result?._meta?.usage
  if (own && typeof own === "object" && typeof own.inputTokens === "number") {
    const output = typeof own.outputTokens === "number" ? own.outputTokens : 0
    return {
      inputTokens: own.inputTokens,
      outputTokens: output,
      cachedReadTokens: own.cacheReadTokens,
      cachedWriteTokens: own.cacheWriteTokens,
      totalTokens: own.inputTokens + output,
    }
  }
  return result?.usage && typeof result.usage === "object" ? (result.usage as AcpTurnUsage) : undefined
}

export interface PromptResult {
  stopReason: string
  text: string
  usage?: AcpTurnUsage
}

/** MCP servers the agent should connect to for a session (ACP `session/new`). */
export type AcpMcpServer =
  | {
      name: string
      command: string
      args: string[]
      env?: Array<{ name: string; value: string }>
    }
  | {
      type: "http" | "sse"
      name: string
      url: string
      headers: Array<{ name: string; value: string }>
    }

export interface AcpConfigOption {
  id?: string
  name?: string
  description?: string
  category?: string
  type?: string
  currentValue?: string
  options?: Array<{ value?: string; name?: string; description?: string }>
}

/** A reasoning-effort select advertised by the agent in `session/new`. */
export interface AcpEffortConfig {
  /** Config id to pass to `session/set_config_option` (usually "effort"). */
  configId: string
  name?: string
  currentValue?: string
  values: string[]
}

/** A permission request forwarded from the agent to the client. */
export interface PermissionRequestInfo {
  title: string
  kind?: string
  detail?: string
}

export type PermissionHandler = (request: PermissionRequestInfo) => Promise<boolean>

interface AgentHandshake {
  protocolVersion: number
  agentInfo: unknown
  agentCapabilities: {
    sessionCapabilities?: { close?: boolean }
    [key: string]: unknown
  }
  authMethods: unknown
}

/**
 * Recognise an ask-user prompt that an agent sent through
 * `session/request_permission`. Command Code marks every choice as
 * `allow_once` and numbers the option ids `option_0`, `option_1`, …, so option
 * `kind` cannot tell a question apart from a permission. The raw question text
 * is the reliable signal; numbered ids or option labels keep ordinary tool
 * prompts out.
 *
 * Native question tools must be disabled in the agent's own configuration so
 * agents use OpenCode's MCP `question` tool instead. If one still asks this
 * way, the request is declined rather than answered with the first option.
 */
function readQuestionText(params: any, options: Array<{ optionId?: string }>): string | undefined {
  const raw = params?.toolCall?.rawInput
  const question = typeof raw?.question === "string" ? raw.question.trim() : ""
  if (!question || !options.length) return undefined
  const labels: unknown[] = Array.isArray(raw?.options) ? raw.options : []
  const numbered = options.every(
    (option) => typeof option.optionId === "string" && /^option_\d+$/.test(option.optionId),
  )
  if (!numbered && !labels.length) return undefined
  return question
}

function readEffortConfig(configOptions: AcpConfigOption[]): AcpEffortConfig | undefined {
  const option =
    configOptions.find((candidate) => candidate.id === "effort") ??
    configOptions.find((candidate) => candidate.category === "thought_level")
  if (!option) return undefined
  const values = (option.options ?? [])
    .map((choice) => choice.value)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
  if (!values.length) return undefined
  return {
    configId: option.id ?? "effort",
    name: option.name,
    currentValue: option.currentValue,
    values,
  }
}

export interface AcpClientOptions {
  command: string
  args?: string[]
  cwd: string
  env?: Record<string, string>
  /** Log stderr and protocol errors through this callback. */
  onLog?: (level: "debug" | "warn" | "error", message: string) => void
  /** Called when the agent process exits unexpectedly, so callers can drop stale sessions. */
  onExit?: (error: Error) => void
  /**
   * Auto-approve real `session/request_permission` requests. Questions that an
   * agent encodes as permission requests are declined instead. Defaults to true.
   */
  autoApprove?: boolean
  /** Timeout for handshake and control calls. Defaults to 15s; 0 disables. */
  requestTimeoutMs?: number
  /** Timeout for one prompt turn. Defaults to 30 minutes; 0 disables. */
  promptTimeoutMs?: number
  /** Allow filesystem methods to touch paths outside the session directory. Defaults to false. */
  allowPathsOutsideCwd?: boolean
  /** Largest file the client will read for the agent. Defaults to 16 MB. */
  maxFileBytes?: number
}

interface RpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: any
  result?: any
  error?: { code: number; message: string; data?: unknown }
}

type Pending = { resolve: (value: any) => void; reject: (reason: Error) => void; method: string }

interface SessionState {
  cwd: string
  onUpdate?: (update: SessionUpdate) => void
  requestPermission?: PermissionHandler
}

interface RequestOptions {
  timeout?: number
  signal?: AbortSignal
  /** Runs when the signal aborts, e.g. to send `session/cancel`. */
  onAbort?: () => void
  /** How long to wait for a reply after abort before rejecting. Defaults to 5s. */
  abortGraceMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000
const DEFAULT_ABORT_GRACE_MS = 5_000
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_PROTOCOL_BUFFER = 64 * 1024 * 1024
const MAX_STDERR_BUFFER = 1024 * 1024
const SIGKILL_DELAY_MS = 2_000

export class AcpError extends Error {
  code: number
  data: unknown
  constructor(message: string, code = -32000, data?: unknown) {
    super(message)
    this.name = "AcpError"
    this.code = code
    this.data = data
  }
}

export class AcpClient {
  private child?: ChildProcessWithoutNullStreams
  private buffer = ""
  private stderrBuffer = ""
  private nextID = 1
  private pending = new Map<number | string, Pending>()
  private sessions = new Map<string, SessionState>()
  private started?: Promise<AgentHandshake>
  private handshake?: AgentHandshake
  private closed = false
  private disposed = false
  private readonly options: AcpClientOptions

  constructor(options: AcpClientOptions) {
    this.options = options
  }

  private log(level: "debug" | "warn" | "error", message: string) {
    this.options.onLog?.(level, message)
  }

  /** Spawn the agent and run the ACP initialize handshake, restarting if it died. */
  start(): Promise<AgentHandshake> {
    if (this.disposed) return Promise.reject(new AcpError("ACP client stopped"))
    if (!this.started) {
      const started = this.doStart()
      this.started = started
      started.catch(() => {
        if (this.started === started) this.started = undefined
      })
    }
    return this.started
  }

  private async doStart(): Promise<AgentHandshake> {
    const detached = process.platform !== "win32"
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX: give the agent its own process group so wrappers such as
      // `npx` can be stopped together with the agent they launch.
      detached,
    })
    this.child = child
    this.closed = false
    this.buffer = ""
    this.stderrBuffer = ""

    const current = () => this.child === child && !this.disposed
    const exitWith = (error: Error) => {
      if (this.child !== child) return
      this.handleExit(error)
    }

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (current()) this.onData(chunk)
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      if (current()) this.onStderr(chunk)
    })
    child.on("exit", (code, signal) => {
      exitWith(new AcpError(`ACP agent exited (code=${code ?? "null"}, signal=${signal ?? "null"})`))
    })
    child.on("error", (error) => exitWith(error))
    // Writing to an agent that closed stdin emits EPIPE asynchronously; without
    // a listener that becomes an uncaught exception in the OpenCode process.
    child.stdin.on("error", (error) => {
      this.log("warn", `ACP agent stdin failed: ${error.message}`)
      exitWith(new AcpError(`ACP agent stdin failed: ${error.message}`))
    })
    child.stdout.on("error", (error) => exitWith(error))
    child.stderr.on("error", (error) => this.log("warn", `ACP agent stderr failed: ${error.message}`))

    const result = await this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: false,
        },
        clientInfo: { name: "opencode", version: "2" },
      },
      { timeout: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
    )

    if (this.disposed) throw new AcpError("ACP client stopped")
    this.handshake = {
      protocolVersion: result?.protocolVersion ?? 1,
      agentInfo: result?.agentInfo,
      agentCapabilities: result?.agentCapabilities ?? {},
      authMethods: result?.authMethods ?? [],
    }
    this.log("debug", `initialized ACP agent ${JSON.stringify(this.handshake.agentInfo ?? {})}`)
    return this.handshake
  }

  private handleExit(error: Error) {
    const report = !this.closed && !this.disposed
    this.closed = true
    this.child = undefined
    this.started = undefined
    this.handshake = undefined
    this.buffer = ""
    this.stderrBuffer = ""
    this.sessions.clear()
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(error)
    if (report) {
      this.log("warn", error.message)
      this.options.onExit?.(error)
    }
  }

  private onData(chunk: string) {
    this.buffer += chunk
    if (this.buffer.length > MAX_PROTOCOL_BUFFER && this.buffer.lastIndexOf("\n") < 0) {
      this.log("error", `dropping oversized ACP output (${this.buffer.length} bytes without a newline)`)
      this.buffer = ""
      return
    }
    let index: number
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message: RpcMessage
      try {
        message = JSON.parse(line)
      } catch {
        this.log("warn", `ignoring non-JSON ACP output: ${line.slice(0, 200)}`)
        continue
      }
      this.onMessage(message)
    }
  }

  private onStderr(chunk: string) {
    this.stderrBuffer += chunk
    if (this.stderrBuffer.length > MAX_STDERR_BUFFER && this.stderrBuffer.lastIndexOf("\n") < 0) {
      this.log("debug", this.stderrBuffer.slice(0, 2_000))
      this.log("debug", `dropping oversized ACP stderr (${this.stderrBuffer.length} bytes without a newline)`)
      this.stderrBuffer = ""
      return
    }
    let index: number
    while ((index = this.stderrBuffer.indexOf("\n")) >= 0) {
      const line = this.stderrBuffer.slice(0, index).trim()
      this.stderrBuffer = this.stderrBuffer.slice(index + 1)
      if (line) this.log("debug", line)
    }
  }

  private onMessage(message: RpcMessage) {
    if (message.method && message.id !== undefined) {
      void this.onRequest(message).catch((error) => {
        this.log("error", `ACP request handler failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
    if (message.method) {
      this.onNotification(message)
      return
    }
    if (message.id === undefined) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) {
      pending.reject(new AcpError(message.error.message, message.error.code, message.error.data))
    } else {
      pending.resolve(message.result ?? {})
    }
  }

  private onNotification(message: RpcMessage) {
    if (message.method !== "session/update") {
      this.log("debug", `ACP notification ${message.method}`)
      return
    }
    const sessionId = message.params?.sessionId
    const update = message.params?.update as SessionUpdate | undefined
    if (!sessionId || !update) return
    this.sessions.get(sessionId)?.onUpdate?.(update)
  }

  private async onRequest(message: RpcMessage) {
    const method = message.method!
    try {
      if (method === "session/request_permission") {
        const params = message.params ?? {}
        const options: Array<{ optionId?: string; kind?: string }> = params.options ?? []

        const question = readQuestionText(params, options)
        if (question) {
          // Native ask-user tools are supposed to be disabled in favour of the
          // MCP `question` tool. Never auto-approve one: the first option is an
          // answer, not permission.
          this.log("debug", `declining native ACP question: ${question}`)
          this.reply(message.id!, { outcome: { outcome: "cancelled" } })
          return
        }

        const allow =
          options.find((option) => option.optionId === "allow_once") ??
          options.find((option) => option.optionId?.startsWith("allow")) ??
          options.find((option) => option.kind?.startsWith("allow")) ??
          options[0]
        const info: PermissionRequestInfo = {
          title: params.toolCall?.title ?? allow?.optionId ?? "ACP tool",
          kind: params.toolCall?.kind,
          detail: params.toolCall?.content?.[0]?.text,
        }
        const handler = this.sessions.get(params.sessionId)?.requestPermission
        const approved =
          this.options.autoApprove !== false
            ? Boolean(allow)
            : handler
              ? await handler(info).catch(() => false)
              : false
        if (!approved || !allow?.optionId) {
          this.reply(message.id!, { outcome: { outcome: "cancelled" } })
          return
        }
        this.log("debug", `approving ACP permission: ${info.title}`)
        this.reply(message.id!, { outcome: { outcome: "selected", optionId: allow.optionId } })
        return
      }

      if (method === "fs/read_text_file") {
        const content = await this.readTextFile(message.params ?? {})
        this.reply(message.id!, { content })
        return
      }

      if (method === "fs/write_text_file") {
        await this.writeTextFile(message.params ?? {})
        this.reply(message.id!, {})
        return
      }

      this.log("warn", `unsupported ACP client method: ${method}`)
      this.reply(message.id!, undefined, -32601, `Method not supported by client: ${method}`)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      const code = error instanceof AcpError ? error.code : -32603
      this.reply(message.id!, undefined, code, text)
    }
  }

  private reply(id: number | string, result: any, errorCode?: number, errorMessage?: string) {
    try {
      if (errorCode !== undefined) {
        this.write({ jsonrpc: "2.0", id, error: { code: errorCode, message: errorMessage ?? "error" } })
      } else {
        this.write({ jsonrpc: "2.0", id, result })
      }
    } catch {
      // The agent is gone; there is nobody left to answer.
    }
  }

  private write(message: RpcMessage) {
    const child = this.child
    if (!child || this.closed || !child.stdin.writable) throw new AcpError("ACP agent is not running")
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(method: string, params?: unknown, options: RequestOptions = {}) {
    const id = this.nextID++
    return new Promise<any>((resolveValue, rejectValue) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let graceTimer: ReturnType<typeof setTimeout> | undefined
      let abortListener: (() => void) | undefined

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        if (graceTimer) clearTimeout(graceTimer)
        if (abortListener) options.signal?.removeEventListener("abort", abortListener)
        this.pending.delete(id)
      }
      const succeed = (value: any) => {
        cleanup()
        resolveValue(value)
      }
      const fail = (error: Error) => {
        cleanup()
        rejectValue(error)
      }

      this.pending.set(id, { resolve: succeed, reject: fail, method })

      const timeout = options.timeout ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
      if (timeout > 0 && Number.isFinite(timeout)) {
        timer = setTimeout(
          () => fail(new AcpError(`ACP request "${method}" timed out after ${timeout}ms`, -32001)),
          timeout,
        )
        timer.unref?.()
      }

      if (options.signal) {
        const onAbort = () => {
          try {
            options.onAbort?.()
          } catch {
            // the agent may already be gone
          }
          const grace = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS
          graceTimer = setTimeout(
            () => fail(new AcpError(`ACP request "${method}" was cancelled`, -32800)),
            Math.max(0, grace),
          )
          graceTimer.unref?.()
        }
        if (options.signal.aborted) onAbort()
        else {
          abortListener = onAbort
          options.signal.addEventListener("abort", abortListener, { once: true })
        }
      }

      try {
        this.write({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: unknown) {
    this.write({ jsonrpc: "2.0", method, params })
  }

  /**
   * Create a session and return its id plus the selectable models and reasoning
   * effort levels advertised by the agent through `configOptions`.
   */
  async newSession(
    cwd: string,
    options: {
      model?: string
      effort?: string
      mcpServers?: AcpMcpServer[]
      additionalDirectories?: string[]
      meta?: Record<string, unknown>
    } = {},
  ) {
    await this.start()
    const result = await this.request(
      "session/new",
      {
        cwd,
        mcpServers: options.mcpServers ?? [],
        ...(options.additionalDirectories?.length ? { additionalDirectories: options.additionalDirectories } : {}),
        ...(options.meta ? { _meta: options.meta } : {}),
      },
      { timeout: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
    )
    const sessionId: string = result.sessionId
    if (!sessionId) throw new AcpError("ACP agent did not return a session id", -32603)
    const configOptions: AcpConfigOption[] = result.configOptions ?? []
    const modelOption = configOptions.find((option) => option.category === "model")
    const models: Array<{ id: string; name: string; description?: string }> = (modelOption?.options ?? [])
      .filter((option): option is { value: string; name?: string; description?: string } => {
        return typeof option.value === "string" && option.value.length > 0
      })
      .map((option) => ({
        id: option.value,
        name: option.name || option.value,
        description: option.description,
      }))
    const effort = readEffortConfig(configOptions)

    this.sessions.set(sessionId, { cwd })

    try {
      if (options.model && modelOption && options.model !== modelOption.currentValue) {
        await this.setModel(sessionId, options.model, modelOption.id ?? "model")
      }
      if (options.effort && effort && options.effort !== effort.currentValue) {
        await this.setEffort(sessionId, options.effort, effort.configId)
      }
    } catch (error) {
      // The agent already created the session; close it so a rejected model or
      // effort does not leak an ACP session that nobody can address anymore.
      await this.closeSession(sessionId).catch(() => {})
      throw error
    }

    return {
      sessionId,
      configOptions,
      models,
      currentModel: options.model ?? modelOption?.currentValue,
      efforts: effort?.values ?? [],
      effort,
      modes: result.modes,
    }
  }

  async setModel(sessionId: string, modelId: string, configId = "model") {
    return this.setConfigOption(sessionId, configId, modelId)
  }

  /** Set the agent's reasoning effort for a session. */
  async setEffort(sessionId: string, effort: string, configId = "effort") {
    return this.setConfigOption(sessionId, configId, effort)
  }

  /** Set any agent-advertised session config option, e.g. "model" or "effort". */
  async setConfigOption(sessionId: string, configId: string, value: string) {
    return this.request(
      "session/set_config_option",
      { sessionId, configId, value },
      { timeout: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
    )
  }

  async setMode(sessionId: string, modeId: string) {
    return this.request(
      "session/set_mode",
      { sessionId, modeId },
      { timeout: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
    )
  }

  /** Send a prompt turn and stream `session/update` notifications. */
  async prompt(
    sessionId: string,
    prompt: string | ContentBlock[],
    handlers: {
      onUpdate?: (update: SessionUpdate) => void
      signal?: AbortSignal
      requestPermission?: PermissionHandler
    } = {},
  ): Promise<PromptResult> {
    if (handlers.signal?.aborted) return { stopReason: "cancelled", text: "" }
    const blocks: ContentBlock[] = typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt
    const session = this.sessions.get(sessionId)
    if (!session) throw new AcpError(`Unknown ACP session: ${sessionId}`)
    session.requestPermission = handlers.requestPermission

    let text = ""
    const onUpdate = (update: SessionUpdate) => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        text += update.content.text ?? ""
      }
      handlers.onUpdate?.(update)
    }
    session.onUpdate = onUpdate

    const promptTimeout = this.options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
    try {
      const result = await this.request(
        "session/prompt",
        { sessionId, prompt: blocks },
        {
          timeout: promptTimeout,
          signal: handlers.signal,
          onAbort: () => {
            try {
              this.notify("session/cancel", { sessionId })
            } catch {
              // the agent is already gone
            }
          },
        },
      )
      const usage = turnUsage(result)
      return { stopReason: result?.stopReason ?? "end_turn", text, ...(usage ? { usage } : {}) }
    } finally {
      if (this.sessions.get(sessionId)?.onUpdate === onUpdate) {
        const current = this.sessions.get(sessionId)
        if (current) {
          current.onUpdate = undefined
          current.requestPermission = undefined
        }
      }
    }
  }

  async closeSession(sessionId: string) {
    this.sessions.delete(sessionId)
    if (this.handshake?.agentCapabilities?.sessionCapabilities?.close === false) {
      // The agent has no close method; dropping our side is all we can do.
      this.log("debug", `dropping ACP session ${sessionId} (agent does not support session/close)`)
      return
    }
    try {
      await this.request(
        "session/close",
        { sessionId },
        { timeout: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS },
      )
    } catch {
      // close is best effort
    }
  }

  async stop() {
    if (this.disposed) return
    this.disposed = true
    this.closed = true
    this.started = undefined
    this.handshake = undefined
    this.sessions.clear()
    this.buffer = ""
    this.stderrBuffer = ""
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(new AcpError("ACP client stopped"))
    const child = this.child
    this.child = undefined
    if (child) {
      this.killChild(child, "SIGTERM")
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) this.killChild(child, "SIGKILL")
      }, SIGKILL_DELAY_MS)
      timer.unref?.()
    }
  }

  /** Kill the agent and, on POSIX, any wrapper it launched in its process group. */
  private killChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal)
        return
      } catch {
        // no process group (not detached, or it already exited)
      }
    }
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }

  // ---- filesystem methods -------------------------------------------------

  private async readTextFile(params: { sessionId?: string; path?: string; line?: number; limit?: number }) {
    const target = await this.resolveTarget(params.sessionId, String(params.path ?? ""))
    if (!target) throw new AcpError("fs/read_text_file requires a path", -32602)
    const line = typeof params.line === "number" && params.line > 0 ? Math.floor(params.line) : undefined
    const limit = typeof params.limit === "number" && params.limit > 0 ? Math.floor(params.limit) : undefined
    const maxBytes = this.options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    if (line !== undefined || limit !== undefined) {
      return (await readLines(target, line ? line - 1 : 0, limit ?? Infinity, maxBytes)).join("\n")
    }
    const info = await stat(target).catch(() => undefined)
    if (info && info.size > maxBytes) {
      throw new AcpError(`File is larger than ${maxBytes} bytes; request a line range instead`, -32603)
    }
    return await readFile(target, "utf8")
  }

  private async writeTextFile(params: { sessionId?: string; path?: string; content?: string }) {
    const target = await this.resolveTarget(params.sessionId, String(params.path ?? ""))
    if (!target) throw new AcpError("fs/write_text_file requires a path", -32602)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, params.content ?? "", "utf8")
  }

  /**
   * Resolve a path from the agent against the session directory and enforce the
   * sandbox. Returning the resolved path matters: checking one path and then
   * reading a relative one would touch the process cwd instead.
   */
  private async resolveTarget(sessionId: string | undefined, target: string): Promise<string> {
    const raw = target.trim()
    if (!raw) return ""
    const root = sessionId ? this.sessions.get(sessionId)?.cwd : undefined
    if (this.options.allowPathsOutsideCwd) {
      return resolve(root ?? process.cwd(), raw)
    }
    if (!root) {
      throw new AcpError("filesystem access requires a known session root", -32602)
    }
    const resolvedRoot = await realpath(root).catch(() => resolve(root))
    const resolvedTarget = resolve(resolvedRoot, raw)
    if (!isInside(resolvedRoot, resolvedTarget)) {
      throw new AcpError(`Path is outside the session directory: ${target}`, -32602)
    }
    // Refuse to follow a symlink out of the root. For a path that does not exist
    // yet, check the deepest existing ancestor: a symlinked parent directory
    // would otherwise let a write escape even though the file itself is new.
    const real = (await realpath(resolvedTarget).catch(() => undefined)) ?? (await realpathExistingAncestor(resolvedTarget))
    if (real && !isInside(resolvedRoot, real)) {
      throw new AcpError(`Path resolves outside the session directory: ${target}`, -32602)
    }
    return resolvedTarget
  }
}

function isInside(root: string, target: string) {
  const rel = relative(root, target)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Resolve the real path of the closest ancestor that exists. */
async function realpathExistingAncestor(target: string): Promise<string | undefined> {
  let current = target
  for (;;) {
    const real = await realpath(current).catch(() => undefined)
    if (real) return real
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function readLines(path: string, offset: number, limit: number, maxBytes: number) {
  const stream = createReadStream(path, { encoding: "utf8" })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  const lines: string[] = []
  let index = 0
  let bytes = 0
  try {
    for await (const line of reader) {
      if (index++ < offset) continue
      lines.push(line)
      bytes += line.length + 1
      if (bytes > maxBytes) throw new AcpError(`Requested range is larger than ${maxBytes} bytes`, -32603)
      if (lines.length >= limit) break
    }
  } finally {
    reader.close()
    stream.destroy()
  }
  return lines
}
