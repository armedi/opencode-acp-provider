import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { AcpClient, type AcpMcpServer, type SessionUpdate, type PermissionHandler } from "./acp-client.ts"

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
  servers: (sessionKey: string) => McpLease
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
  model?: string
  effort?: string
  cwd: string
  queue: Promise<unknown>
  lastUsed: number
  pending: number
  mcpRelease?: () => void
}

export interface AcpRunResult {
  stopReason: string
  text: string
}

const DEFAULT_MAX_SESSIONS = 32
const DEFAULT_SESSION_IDLE_MS = 30 * 60_000
const DEFAULT_INIT_TIMEOUT_MS = 20_000
const SWEEP_INTERVAL_MS = 60_000

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
  private promptTimeoutMs?: number
  private allowPathsOutsideCwd: boolean
  private maxFileBytes?: number

  constructor(input: {
    servers: AcpServerConfig[]
    defaultCwd: string
    resolveCredential?: CredentialResolver
    requestPermission?: PermissionResolver
    mcp?: McpProvider
    log?: LogFn
    initTimeoutMs?: number
    promptTimeoutMs?: number
    maxSessions?: number
    sessionIdleMs?: number
    allowPathsOutsideCwd?: boolean
    maxFileBytes?: number
  }) {
    this.defaultCwd = input.defaultCwd
    this.resolver = input.resolveCredential ?? (async () => undefined)
    this.permissionResolver = input.requestPermission
    this.mcp = input.mcp
    this.log = input.log ?? (() => {})
    this.initTimeoutMs = input.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS
    this.promptTimeoutMs = input.promptTimeoutMs
    this.maxSessions = Math.max(1, input.maxSessions ?? DEFAULT_MAX_SESSIONS)
    this.sessionIdleMs = Math.max(0, input.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS)
    this.allowPathsOutsideCwd = input.allowPathsOutsideCwd === true
    this.maxFileBytes = input.maxFileBytes

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
    const inFlight = this.preparing.get(state.config.id)
    if (inFlight) await inFlight.catch(() => {})
    if (state.initialized && state.models.length) return
    state.initialized = false
    state.error = undefined
    await this.prepare(state)
  }

  private prepare(state: AcpServerState): Promise<void> {
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
    const { command, args } = normalizeCommand(config.command)
    const env: Record<string, string> = { ...config.env }
    if (config.credential) {
      const name = credentialEnvName(config)
      const value = await this.resolver(config.credential)
      if (value && name) env[name] = value
      if (!value) this.log("warn", `no credential found for integration "${config.credential}"; starting "${config.id}" unauthenticated`)
    }

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

    try {
      const session = await client.newSession(config.cwd ?? this.defaultCwd, {
        model: config.model,
        meta: config.meta,
      })
      let models = session.models
      if (!models.length) models = await this.fallbackModels(config, env)
      if (config.models?.length) models = models.filter((model) => config.models!.includes(model.id))
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
      const session = await client.newSession(cwd, { model, meta: state.config.meta })
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
        const lease = this.mcp?.servers(input.key!)
        let session
        try {
          session = await client.newSession(cwd, {
            model,
            mcpServers: lease?.servers,
            meta: state.config.meta,
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
          model,
          effort,
          cwd,
          queue: Promise.resolve(),
          lastUsed: Date.now(),
          pending: 0,
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

    const prompt =
      typeof input.prompt === "string" ? input.prompt : reused ? input.prompt.reused : input.prompt.fresh
    pooled.lastUsed = Date.now()
    pooled.pending += 1
    const run = pooled.queue.then(() => {
      // The client can be replaced if the agent restarts while this turn is queued.
      const active = state.client
      if (!active) throw new Error(`ACP server "${input.server}" is not ready`)
      return active.prompt(pooled.sessionId, prompt, {
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
      if (this.pools.get(poolKey) === pooled) {
        this.pools.delete(poolKey)
        pooled.mcpRelease?.()
        void client.closeSession(pooled.sessionId).catch(() => {})
      }
    })
    return run
  }

  private permissionHandler(server: string, sessionKey: string | undefined): PermissionHandler | undefined {
    const resolver = this.permissionResolver
    if (!resolver || !sessionKey) return undefined
    return (request) => resolver({ ...request, server, sessionKey })
  }

  private evictForCapacity() {
    if (this.pools.size < this.maxSessions) return
    const candidates = [...this.pools.entries()]
      .filter(([, pooled]) => pooled.pending === 0)
      .sort((left, right) => left[1].lastUsed - right[1].lastUsed)
    for (const [key, pooled] of candidates) {
      if (this.pools.size < this.maxSessions) break
      this.pools.delete(key)
      pooled.mcpRelease?.()
      void this.get(pooled.server)?.client?.closeSession(pooled.sessionId).catch(() => {})
      this.log("debug", `evicted idle ACP session ${pooled.sessionId} (capacity ${this.maxSessions})`)
    }
  }

  private sweepIdleSessions() {
    const cutoff = Date.now() - this.sessionIdleMs
    for (const [key, pooled] of this.pools) {
      if (pooled.pending > 0 || pooled.lastUsed > cutoff) continue
      this.pools.delete(key)
      pooled.mcpRelease?.()
      void this.get(pooled.server)?.client?.closeSession(pooled.sessionId).catch(() => {})
      this.log("debug", `closed idle ACP session ${pooled.sessionId} after ${this.sessionIdleMs}ms`)
    }
  }

  private async closePoolsFor(server: string) {
    const prefix = `${server}\u0000`
    const closed: Array<Promise<unknown>> = []
    for (const [key, pooled] of this.pools) {
      if (!key.startsWith(prefix)) continue
      this.pools.delete(key)
      pooled.mcpRelease?.()
      closed.push(this.get(pooled.server)?.client?.closeSession(pooled.sessionId) ?? Promise.resolve())
    }
    await Promise.allSettled(closed)
  }

  async stop() {
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = undefined
    this.preparing.clear()
    this.negotiating.clear()
    const pools = [...this.pools.values()]
    this.pools.clear()
    // Best effort: the agents are killed below, so do not wait on a close
    // handshake that could hang shutdown.
    for (const pooled of pools) {
      pooled.mcpRelease?.()
      void this.get(pooled.server)?.client?.closeSession(pooled.sessionId).catch(() => {})
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
