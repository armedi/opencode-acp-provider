import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { AcpClient, type AcpMcpServer, type SessionUpdate, type PermissionHandler } from "./acp-client.ts"
import { applyCmdSkillFlag, isCmdCommand } from "./skills.ts"

const execFileAsync = promisify(execFile)

export interface AcpServerConfig {
  /** Stable id used for the OpenCode provider and tool arguments. */
  id: string
  /** Display name for the provider. Defaults to the id. */
  name?: string
  /** Command and arguments that start the ACP agent, e.g. ["cmd", "acp"]. */
  command: string | string[]
  /** Working directory for the agent process. Defaults to the OpenCode location. */
  cwd?: string
  /** Extra environment variables for the agent process. */
  env?: Record<string, string>
  /** OpenCode integration id whose credential is injected into the agent env. */
  credential?: string
  /** Env var that receives the credential. Defaults from the integration id. */
  credentialEnv?: string
  /** Optional allowlist of ACP model ids to expose. */
  models?: string[]
  /** Default ACP model for direct tool calls. */
  model?: string
  /** ACP reasoning effort for pooled sessions, e.g. "off", "low", "high". */
  effort?: string
  /** ACP session mode applied to pooled sessions, e.g. "auto-accept". */
  mode?: string
  /** ACP `_meta` passed to `session/new`, e.g. Claude's `claudeCode.options`. */
  meta?: Record<string, unknown>
  /** Auto-approve ACP permission requests. Defaults to true. */
  autoApprove?: boolean
  /** Expose OpenCode's skills through the agent's native skill discovery. Defaults to true. */
  skills?: boolean
  /** Disable this server without removing its configuration. */
  disabled?: boolean
}

export interface AcpModelInfo {
  id: string
  name: string
  description?: string
}

export interface AcpServerState {
  config: AcpServerConfig
  client?: AcpClient
  models: AcpModelInfo[]
  defaultModel?: string
  /** Reasoning effort levels advertised by the agent, excluding the implicit default. */
  efforts: string[]
  effortConfigID?: string
  defaultEffort?: string
  error?: string
  /** False when retrying cannot help, e.g. a `models` allowlist that matches nothing. */
  retryable?: boolean
  initialized: boolean
}

export interface CredentialResolver {
  (integrationID: string): Promise<string | undefined>
}

export interface AcpPermissionInput {
  server: string
  sessionKey: string
  title: string
  kind?: string
  detail?: string
}

export type PermissionResolver = (input: AcpPermissionInput) => Promise<boolean>

export type LogFn = (level: "debug" | "info" | "warn" | "error", message: string) => void

export interface McpLease {
  servers: AcpMcpServer[]
  release: () => void
}

export interface McpProvider {
  /** `agent` is the server whose ACP session is being opened. */
  servers: (sessionKey: string, agent: AcpServerConfig) => McpLease
}

const DEFAULT_CREDENTIAL_ENV: Record<string, string> = {
  commandcode: "COMMAND_CODE_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
}

function credentialEnvName(config: AcpServerConfig) {
  if (config.credentialEnv) return config.credentialEnv
  if (!config.credential) return undefined
  return DEFAULT_CREDENTIAL_ENV[config.credential] ?? `${config.credential.toUpperCase()}_API_KEY`
}

function normalizeCommand(command: string | string[]): { command: string; args: string[] } {
  if (Array.isArray(command)) {
    if (!command.length || typeof command[0] !== "string" || !command[0].trim()) {
      throw new Error("command must contain an executable")
    }
    return { command: command[0], args: command.slice(1) }
  }
  if (!command.trim()) throw new Error("command must not be empty")
  if (/\s/.test(command.trim())) {
    throw new Error(`command "${command}" contains whitespace; pass an array such as ["cmd", "acp"] instead`)
  }
  return { command: command.trim(), args: [] }
}

interface PooledSession {
  server: string
  key: string
  sessionId: string
  client: AcpClient
  model?: string
  effort?: string
  cwd: string
  queue: Promise<unknown>
  lastUsed: number
  pending: number
  broken: boolean
  mcpRelease?: () => void
}

export interface AcpRunResult {
  stopReason: string
  text: string
}

export type AcpCompactResult =
  /** `text` is what the agent said; `tokens` is its context size before and after, when it reports them. */
  | { status: "compacted"; text: string; tokens?: { before: number; after: number } }
  /** The agent has no `/compact` command; it manages its context on its own. */
  | { status: "unsupported" }
  /** No live ACP session holds this conversation, so there is nothing to compact. */
  | { status: "no-session" }

const DEFAULT_MAX_SESSIONS = 32
const DEFAULT_SESSION_IDLE_MS = 30 * 60_000
const DEFAULT_INIT_TIMEOUT_MS = 20_000
const SWEEP_INTERVAL_MS = 60_000
/** Do not evict a session that was created or used this recently, so a turn that is
 * between negotiation and its first `pending` increment cannot be closed under it. */
const EVICT_MIN_IDLE_MS = 1_000

export class AcpServerManager {
  readonly servers = new Map<string, AcpServerState>()
  private resolver: CredentialResolver
  private permissionResolver?: PermissionResolver
  private log: LogFn
  private defaultCwd: string
  private pools = new Map<string, PooledSession>()
  private negotiating = new Map<string, Promise<{ pooled: PooledSession; reused: boolean }>>()
  private preparing = new Map<string, Promise<void>>()
  private mcp?: McpProvider
  private sweeper?: ReturnType<typeof setInterval>
  private maxSessions: number
  private sessionIdleMs: number
  private initTimeoutMs: number
  private requestTimeoutMs?: number
  private promptTimeoutMs?: number
  private allowPathsOutsideCwd: boolean
  private maxFileBytes?: number
  private additionalDirectories?: string[]
  private cmdSkillDir?: string
  private cmdSkillMod?: string
  private disposed = false

  constructor(input: {
    servers: AcpServerConfig[]
    defaultCwd: string
    resolveCredential?: CredentialResolver
    requestPermission?: PermissionResolver
    mcp?: McpProvider
    log?: LogFn
    initTimeoutMs?: number
    requestTimeoutMs?: number
    promptTimeoutMs?: number
    maxSessions?: number
    sessionIdleMs?: number
    allowPathsOutsideCwd?: boolean
    maxFileBytes?: number
    /** Extra roots offered to ACP agents, e.g. the generated skills mirror. */
    additionalDirectories?: string[]
    /** Directory passed to cmd through its global `--skill` flag. */
    cmdSkillDir?: string
    /** Mod that registers the skills directory with `cmd acp`. */
    cmdSkillMod?: string
  }) {
    this.defaultCwd = input.defaultCwd
    this.resolver = input.resolveCredential ?? (async () => undefined)
    this.permissionResolver = input.requestPermission
    this.mcp = input.mcp
    this.log = input.log ?? (() => {})
    this.initTimeoutMs = input.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS
    this.requestTimeoutMs = input.requestTimeoutMs
    this.promptTimeoutMs = input.promptTimeoutMs
    this.maxSessions = Math.max(1, input.maxSessions ?? DEFAULT_MAX_SESSIONS)
    this.sessionIdleMs = Math.max(0, input.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS)
    this.allowPathsOutsideCwd = input.allowPathsOutsideCwd === true
    this.maxFileBytes = input.maxFileBytes
    this.additionalDirectories = input.additionalDirectories?.filter((directory) => directory.trim())
    this.cmdSkillDir = input.cmdSkillDir
    this.cmdSkillMod = input.cmdSkillMod

    for (const config of input.servers) {
      if (!config?.id || !config.command) continue
      if (this.servers.has(config.id)) {
        this.log("warn", `ignoring duplicate ACP server id "${config.id}"`)
        continue
      }
      try {
        normalizeCommand(config.command)
      } catch (error) {
        this.log(
          "error",
          `ignoring ACP server "${config.id}": ${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }
      this.servers.set(config.id, {
        config,
        models: [],
        efforts: [],
        initialized: false,
      })
    }

    if (this.sessionIdleMs > 0) {
      this.sweeper = setInterval(() => this.sweepIdleSessions(), SWEEP_INTERVAL_MS)
      this.sweeper.unref?.()
    }
  }

  get list() {
    return [...this.servers.values()].filter((state) => !state.config.disabled)
  }

  get(id: string) {
    const state = this.servers.get(id)
    return state && !state.config.disabled ? state : undefined
  }

  private poolKey(server: string, key: string, model: string | undefined, effort: string | undefined, cwd: string) {
    return `${server}\u0000${key}\u0000${model ?? ""}\u0000${cwd}\u0000${effort ?? ""}`
  }

  /** Effort to apply for a run: explicit request, then server config, then agent default. */
  private resolveEffort(state: AcpServerState, requested?: string) {
    const effort = requested ?? state.config.effort ?? state.defaultEffort
    return effort && effort !== "default" ? effort : undefined
  }

  private sessionDirectories(config: AcpServerConfig) {
    return config.skills === false ? undefined : this.additionalDirectories
  }

  private commandFor(config: AcpServerConfig) {
    if (config.skills === false || !this.cmdSkillDir) return config.command
    return applyCmdSkillFlag(config.command, this.cmdSkillDir, this.cmdSkillMod)
  }

  private async applyEffort(
    state: AcpServerState,
    client: AcpClient,
    sessionId: string,
    effort: string | undefined,
  ) {
    if (!effort) return
    if (state.efforts.length && !state.efforts.includes(effort)) {
      this.log("warn", `ACP server "${state.config.id}" does not support effort "${effort}" (available: ${state.efforts.join(", ")})`)
      return
    }
    await client
      .setEffort(sessionId, effort, state.effortConfigID)
      .then(() => this.log("info", `ACP effort set to ${effort}`))
      .catch((error) =>
        this.log("warn", `could not set effort "${effort}": ${error instanceof Error ? error.message : String(error)}`),
      )
  }

  /** Start every enabled agent, read its model inventory, and keep it ready. */
  async initialize() {
    if (this.disposed) return
    await Promise.all(
      this.list.map(async (state) => {
        try {
          await withTimeout(
            this.prepare(state),
            this.initTimeoutMs,
            `ACP server "${state.config.id}" did not initialize within ${this.initTimeoutMs}ms`,
          )
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error)
          this.log("error", `ACP server "${state.config.id}" failed to initialize: ${state.error}`)
          // Do not stop the client here: a timed-out prepare may still finish.
          // It stops its own client on failure, and a success is still usable.
        }
      }),
    )
  }

  /** Re-run discovery, e.g. after a server failed to start during setup. */
  async refresh(state: AcpServerState) {
    if (this.disposed) throw new Error("ACP server manager is stopped")
    const id = state.config.id
    const work = (async () => {
      const inFlight = this.preparing.get(id)
      if (inFlight) await inFlight.catch(() => {})
      if (state.initialized && state.models.length) return
      if (this.disposed) throw new Error("ACP server manager is stopped")
      state.initialized = false
      state.error = undefined
      await this.prepare(state)
    })()
    try {
      await withTimeout(work, this.initTimeoutMs, `ACP server "${id}" did not initialize within ${this.initTimeoutMs}ms`)
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  private prepare(state: AcpServerState): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("ACP server manager is stopped"))
    if (state.initialized) return Promise.resolve()
    const id = state.config.id
    const existing = this.preparing.get(id)
    if (existing) return existing
    let promise: Promise<void>
    promise = this.doPrepare(state).finally(() => {
      if (this.preparing.get(id) === promise) this.preparing.delete(id)
    })
    this.preparing.set(id, promise)
    return promise
  }

  private async doPrepare(state: AcpServerState) {
    const config = state.config
    if (this.disposed) throw new Error("ACP server manager is stopped")
    const { command, args } = normalizeCommand(this.commandFor(config))
    const env: Record<string, string> = { ...config.env }
    if (config.skills !== false && this.cmdSkillDir && isCmdCommand(config.command)) {
      // Read by agents/cmd/opencode-skills.ts, which registers the directory
      // because `cmd acp` does not apply the global `--skill` flag.
      env.OPENCODE_ACP_SKILL_DIR = this.cmdSkillDir
    }
    if (config.credential) {
      const name = credentialEnvName(config)
      const value = await this.resolver(config.credential)
      if (value && name) env[name] = value
      if (!value) this.log("warn", `no credential found for integration "${config.credential}"; starting "${config.id}" unauthenticated`)
    }
    if (this.disposed) throw new Error("ACP server manager is stopped")

    const previous = state.client
    if (previous) {
      await this.closePoolsFor(config.id)
      await previous.stop().catch(() => {})
    }

    const client = new AcpClient({
      command,
      args,
      cwd: config.cwd ?? this.defaultCwd,
      env,
      autoApprove: config.autoApprove !== false,
      requestTimeoutMs: this.requestTimeoutMs,
      promptTimeoutMs: this.promptTimeoutMs,
      allowPathsOutsideCwd: this.allowPathsOutsideCwd,
      maxFileBytes: this.maxFileBytes,
      onLog: (level, message) => this.log(level === "debug" ? "debug" : level, `[${config.id}] ${message}`),
      onExit: (error) => {
        this.log("warn", `ACP agent "${config.id}" exited; pooled sessions were dropped: ${error.message}`)
        void this.closePoolsFor(config.id)
      },
    })
    state.client = client
    state.retryable = true

    try {
      const session = await client.newSession(config.cwd ?? this.defaultCwd, {
        model: config.model,
        meta: config.meta,
        additionalDirectories: this.sessionDirectories(config),
      })
      if (this.disposed) throw new Error("ACP server manager is stopped")
      let models = session.models
      if (!models.length) models = await this.fallbackModels(config, env)
      if (config.models?.length) {
        const allow = new Set(config.models)
        models = models.filter((model) => allow.has(model.id))
        if (!models.length) {
          state.retryable = false
          throw new Error(
            `ACP server "${config.id}" advertised no model matching "models" (${config.models.join(", ")})`,
          )
        }
      }
      if (config.model && models.length && !models.some((model) => model.id === config.model)) {
        this.log(
          "warn",
          `ACP server "${config.id}" does not advertise the configured model "${config.model}"; it will be sent anyway`,
        )
      }
      state.models = models
      state.defaultModel = session.currentModel
      state.efforts = (session.efforts ?? []).filter((value) => value !== "default")
      state.effortConfigID = session.effort?.configId
      state.defaultEffort = session.effort?.currentValue
      state.initialized = true
      state.error = undefined
      await client.closeSession(session.sessionId).catch(() => {})
      this.log(
        "info",
        `ACP server "${config.id}" ready with ${models.length} model(s)` +
          (state.efforts.length ? ` and effort levels: ${state.efforts.join(", ")}` : ""),
      )
    } catch (error) {
      await client.stop().catch(() => {})
      if (state.client === client) state.client = undefined
      throw error
    }
  }

  private async fallbackModels(config: AcpServerConfig, env: Record<string, string>): Promise<AcpModelInfo[]> {
    const { command, args } = normalizeCommand(config.command)
    try {
      const { stdout } = await execFileAsync(command, [...args, "--list-models"], {
        timeout: 15_000,
        cwd: config.cwd ?? this.defaultCwd,
        env: { ...process.env, ...env },
      })
      const models: AcpModelInfo[] = []
      for (const line of stdout.split("\n")) {
        const match = line.trim().match(/^([A-Za-z0-9][\w./:-]*)\s{2,}(.+)$/)
        if (match) models.push({ id: match[1], name: match[2].trim() })
      }
      return models
    } catch (error) {
      this.log("warn", `could not list models for "${config.id}": ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /**
   * Run one prompt. When `key` is supplied the ACP session is reused across
   * calls, which keeps the agent's context (and cost) down; otherwise a fresh
   * session is created and closed.
   *
   * `prompt.fresh` is used when a new ACP session is created; `prompt.reused`
   * is used when an existing one is resumed. The decision is made inside the
   * pool so it cannot race with eviction or failure cleanup.
   */
  async run(input: {
    server: string
    prompt: string | { fresh: string; reused: string }
    model?: string
    effort?: string
    key?: string
    sessionKey?: string
    signal?: AbortSignal
    onUpdate?: (update: SessionUpdate) => void
  }): Promise<AcpRunResult> {
    if (input.signal?.aborted) return { stopReason: "cancelled", text: "" }
    const state = this.get(input.server)
    if (!state) throw new Error(`Unknown ACP server: ${input.server}`)
    await this.prepare(state)
    const client = state.client
    if (!client) throw new Error(`ACP server "${input.server}" is not ready`)

    const cwd = state.config.cwd ?? this.defaultCwd
    const model = input.model ?? state.config.model ?? state.defaultModel
    const mode = state.config.mode
    const effort = this.resolveEffort(state, input.effort)
    const onPermission = this.permissionHandler(input.server, input.sessionKey)

    if (!input.key) {
      const prompt = typeof input.prompt === "string" ? input.prompt : input.prompt.fresh
      const session = await client.newSession(cwd, {
        model,
        meta: state.config.meta,
        additionalDirectories: this.sessionDirectories(state.config),
      })
      try {
        if (mode) await client.setMode(session.sessionId, mode).catch(() => {})
        await this.applyEffort(state, client, session.sessionId, effort)
        return await client.prompt(session.sessionId, prompt, {
          onUpdate: input.onUpdate,
          signal: input.signal,
          requestPermission: onPermission,
        })
      } finally {
        await client.closeSession(session.sessionId)
      }
    }

    const poolKey = this.poolKey(input.server, input.key, model, effort, cwd)
    let negotiating = this.negotiating.get(poolKey)
    if (!negotiating) {
      negotiating = (async () => {
        const existing = this.pools.get(poolKey)
        if (existing) {
          this.log("debug", `reusing ACP session ${existing.sessionId} for key ${input.key!.slice(0, 24)}`)
          return { pooled: existing, reused: true }
        }
        const sessionStartedAt = Date.now()
        this.evictForCapacity()
        const lease = this.mcp?.servers(input.key!, state.config)
        let session: { sessionId: string } | undefined
        let reused = false
        try {
          session = await client.newSession(cwd, {
            model,
            mcpServers: lease?.servers,
            meta: state.config.meta,
            additionalDirectories: this.sessionDirectories(state.config),
          })
          if (mode) await client.setMode(session.sessionId, mode).catch(() => {})
          await this.applyEffort(state, client, session.sessionId, effort)
        } catch (error) {
          lease?.release()
          if (session) await client.closeSession(session.sessionId).catch(() => {})
          throw error
        }
        const created: PooledSession = {
          server: input.server,
          key: input.key!,
          sessionId: session.sessionId,
          client,
          model,
          effort,
          cwd,
          queue: Promise.resolve(),
          lastUsed: Date.now(),
          pending: 0,
          broken: false,
          mcpRelease: lease?.release,
        }
        this.pools.set(poolKey, created)
        this.log(
          "debug",
          `opened ACP session ${session.sessionId} for key ${input.key!.slice(0, 24)} in ${Date.now() - sessionStartedAt}ms`,
        )
        return { pooled: created, reused: false }
      })()
      this.negotiating.set(poolKey, negotiating)
      negotiating.finally(() => this.negotiating.delete(poolKey)).catch(() => {})
    }
    const { pooled, reused } = await negotiating
    if (pooled.broken || this.pools.get(poolKey) !== pooled) {
      throw new Error(`ACP session for key ${input.key.slice(0, 24)} was closed after an earlier turn failed`)
    }

    const prompt =
      typeof input.prompt === "string" ? input.prompt : reused ? input.prompt.reused : input.prompt.fresh
    pooled.lastUsed = Date.now()
    pooled.pending += 1
    const run = pooled.queue.then(() => {
      if (pooled.broken) throw new Error(`ACP session ${pooled.sessionId} is no longer usable`)
      return pooled.client.prompt(pooled.sessionId, prompt, {
        onUpdate: input.onUpdate,
        signal: input.signal,
        requestPermission: onPermission,
      })
    })
    pooled.queue = run.catch(() => {})
    const settled = run.then(
      () => {},
      () => {},
    )
    settled
      .finally(() => {
        pooled.pending = Math.max(0, pooled.pending - 1)
        pooled.lastUsed = Date.now()
      })
      .catch(() => {})
    run.catch(() => {
      // A failed turn can leave the ACP session unusable; recreate it next time.
      // Queued turns on this pool notice `broken` and fail instead of prompting
      // a session that has already been closed.
      pooled.broken = true
      if (this.pools.get(poolKey) !== pooled) return
      this.pools.delete(poolKey)
      pooled.mcpRelease?.()
      void pooled.client.closeSession(pooled.sessionId).catch(() => {})
    })
    return run
  }

  /**
   * Compact the agent's own context for an OpenCode session with the agent's
   * `/compact` command. Only an existing pooled session is compacted; opening
   * one would compact nothing. The command waits behind any running turn.
   */
  async compact(input: { server: string; key: string }): Promise<AcpCompactResult> {
    const prefix = `${input.server}\u0000${input.key}\u0000`
    const pooled = [...this.pools.entries()]
      .filter(([poolKey, entry]) => poolKey.startsWith(prefix) && !entry.broken)
      .map(([, entry]) => entry)
      .sort((left, right) => right.lastUsed - left.lastUsed)[0]
    if (!pooled) return { status: "no-session" }
    if (!pooled.client.hasCommand(pooled.sessionId, "compact")) return { status: "unsupported" }

    let tokens: { before: number; after: number } | undefined
    pooled.pending += 1
    const run = pooled.queue.then(() => {
      if (pooled.broken) throw new Error(`ACP session ${pooled.sessionId} is no longer usable`)
      return pooled.client.prompt(pooled.sessionId, "/compact", {
        onUpdate: (update) => {
          // Claude Code reports a compaction as a tool call with its context size before and after.
          const output = update.rawOutput as { preTokens?: unknown; postTokens?: unknown } | undefined
          if (typeof output?.preTokens === "number" && typeof output.postTokens === "number") {
            tokens = { before: output.preTokens, after: output.postTokens }
          }
        },
      })
    })
    pooled.queue = run.catch(() => {})
    try {
      const result = await run
      return { status: "compacted", text: result.text.trim(), ...(tokens ? { tokens } : {}) }
    } finally {
      pooled.pending = Math.max(0, pooled.pending - 1)
      pooled.lastUsed = Date.now()
    }
  }

  private permissionHandler(server: string, sessionKey: string | undefined): PermissionHandler | undefined {
    const resolver = this.permissionResolver
    if (!resolver || !sessionKey) return undefined
    return (request) => resolver({ ...request, server, sessionKey })
  }

  private evictForCapacity() {
    if (this.pools.size < this.maxSessions) return
    const cutoff = Date.now() - EVICT_MIN_IDLE_MS
    const candidates = [...this.pools.entries()]
      .filter(([, pooled]) => pooled.pending === 0 && pooled.lastUsed <= cutoff)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed)
    for (const [key, pooled] of candidates) {
      if (this.pools.size < this.maxSessions) break
      this.pools.delete(key)
      pooled.broken = true
      pooled.mcpRelease?.()
      void pooled.client.closeSession(pooled.sessionId).catch(() => {})
      this.log("debug", `evicted idle ACP session ${pooled.sessionId} (capacity ${this.maxSessions})`)
    }
  }

  private sweepIdleSessions() {
    const cutoff = Date.now() - this.sessionIdleMs
    for (const [key, pooled] of this.pools) {
      if (pooled.pending > 0 || pooled.lastUsed > cutoff) continue
      this.pools.delete(key)
      pooled.broken = true
      pooled.mcpRelease?.()
      void pooled.client.closeSession(pooled.sessionId).catch(() => {})
      this.log("debug", `closed idle ACP session ${pooled.sessionId} after ${this.sessionIdleMs}ms`)
    }
  }

  private async closePoolsFor(server: string) {
    const prefix = `${server}\u0000`
    const closed: Array<Promise<unknown>> = []
    for (const [key, pooled] of this.pools) {
      if (!key.startsWith(prefix)) continue
      this.pools.delete(key)
      pooled.broken = true
      pooled.mcpRelease?.()
      closed.push(pooled.client.closeSession(pooled.sessionId))
    }
    await Promise.allSettled(closed)
  }

  async stop() {
    this.disposed = true
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = undefined
    this.preparing.clear()
    this.negotiating.clear()
    const pools = [...this.pools.values()]
    this.pools.clear()
    // Best effort: the agents are killed below, so do not wait on a close
    // handshake that could hang shutdown.
    for (const pooled of pools) {
      pooled.broken = true
      pooled.mcpRelease?.()
      void pooled.client.closeSession(pooled.sessionId).catch(() => {})
    }
    await Promise.allSettled([...this.servers.values()].map((state) => state.client?.stop()))
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  if (!(ms > 0) || !Number.isFinite(ms)) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
