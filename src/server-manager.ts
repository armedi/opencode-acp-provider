import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  AcpClient,
  AcpError,
  type AcpCommand,
  type AcpMcpServer,
  type SessionUpdate,
  type PermissionHandler,
} from "./acp-client.ts"
import { applyCmdSkillFlag } from "./skills.ts"
import { isCmdCommand } from "./agent-command.ts"

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
  /**
   * Slash commands the agent has advertised. The setup session is closed after
   * discovery, so this starts as a snapshot and is replaced whenever a live
   * session advertises a newer list.
   */
  commands?: AcpCommand[]
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

/**
 * Remembers which ACP session belongs to an OpenCode session. A plugin reload
 * or a crashed agent starts a new process with no in-memory sessions; looking
 * the id up lets it reattach with `session/resume` instead of starting over
 * with no context. Implementations are expected to persist across processes.
 */
export interface AcpSessionStore {
  get(key: string): Promise<string | undefined>
  set(key: string, sessionId: string): Promise<void>
  delete(key: string): Promise<void>
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
  /** Prompts actually being streamed right now, as opposed to queued behind them. */
  active: number
  /** Consecutive turns that failed; the session is recycled after a few. */
  failures: number
  broken: boolean
  mcpRelease?: () => void
}

export interface AcpRunResult {
  stopReason: string
  text: string
}

/** What happened to a mid-turn message handed to `AcpServerManager.steer`. */
export type AcpSteerResult =
  /** The agent took the text into the turn that was already running. */
  | { status: "steered" }
  /** The agent cannot steer, so the running turn was cancelled to let the message land next. */
  | { status: "interrupted" }
  /** No ACP turn is running for this session, so there is nothing to steer. */
  | { status: "unavailable" }

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
/** `AcpClient` uses this code when a request exceeded its timeout. */
const ACP_REQUEST_TIMEOUT = -32001
/** `AcpClient` uses this code when a request was cancelled. */
const ACP_REQUEST_CANCELLED = -32800
/** ACP's "resource not found": the agent no longer knows the session. */
const ACP_UNKNOWN_SESSION = -32002
/** Failed turns in a row before the pooled session is recycled. */
const MAX_TURN_FAILURES = 3
/** How long to wait for the command list an agent sends after `session/new`. */
const COMMAND_SNAPSHOT_TIMEOUT_MS = 2_000
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
  private sessions?: AcpSessionStore
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
  private onCommands?: (server: string) => void
  private disposed = false

  constructor(input: {
    servers: AcpServerConfig[]
    defaultCwd: string
    resolveCredential?: CredentialResolver
    requestPermission?: PermissionResolver
    mcp?: McpProvider
    /** Persisted ACP session ids, so a restarted agent can resume its conversation. */
    sessions?: AcpSessionStore
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
    /** Called when a server's advertised command list changes. */
    onCommands?: (server: string) => void
  }) {
    this.defaultCwd = input.defaultCwd
    this.resolver = input.resolveCredential ?? (async () => undefined)
    this.permissionResolver = input.requestPermission
    this.mcp = input.mcp
    this.sessions = input.sessions
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
    this.onCommands = input.onCommands

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

  private async storedSession(poolKey: string) {
    if (!this.sessions) return undefined
    try {
      return await this.sessions.get(poolKey)
    } catch (error) {
      this.log("warn", `could not read a stored ACP session: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private async rememberSession(poolKey: string, sessionId: string) {
    if (!this.sessions) return
    try {
      await this.sessions.set(poolKey, sessionId)
    } catch (error) {
      this.log("warn", `could not store ACP session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async forgetSession(poolKey: string) {
    if (!this.sessions) return
    try {
      await this.sessions.delete(poolKey)
    } catch {
      // a stale id only costs one failed resume
    }
  }

  /**
   * Keep the newest command list the agent advertised. Agents send this during
   * `session/new` and can replace it later in the life of a session, so the
   * snapshot taken at setup goes stale; listeners are told so they can rebuild.
   */
  private recordCommands(state: AcpServerState, commands: AcpCommand[]) {
    const previous = state.commands
    if (previous && sameCommands(previous, commands)) return
    state.commands = commands
    this.log("debug", `ACP server "${state.config.id}" advertised ${commands.length} command(s)`)
    this.onCommands?.(state.config.id)
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
      onCommands: (_sessionId, commands) => this.recordCommands(state, commands),
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
      // The command list arrives as a notification just after `session/new`, so
      // wait for it before this discovery session is closed: once it is gone,
      // the only way to learn the list is to open another session.
      const commands = await client.waitForCommands(session.sessionId, COMMAND_SNAPSHOT_TIMEOUT_MS)
      if (commands) this.recordCommands(state, commands)
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
          // A plugin reload or an agent crash leaves a fresh process with no
          // sessions. Reattach to the one this OpenCode session had instead of
          // starting over and losing the conversation.
          const stored = await this.storedSession(poolKey)
          if (stored) {
            const restored = await client
              .restoreSession(stored, {
                cwd,
                mcpServers: lease?.servers,
                meta: state.config.meta,
                additionalDirectories: this.sessionDirectories(state.config),
              })
              .catch(async (error) => {
                this.log(
                  "warn",
                  `could not restore ACP session ${stored} for key ${input.key!.slice(0, 24)}: ${
                    error instanceof Error ? error.message : String(error)
                  }; starting a new one`,
                )
                await this.forgetSession(poolKey)
                return undefined
              })
            if (restored) {
              session = { sessionId: stored }
              reused = true
              this.log(
                "debug",
                `restored ACP session ${stored} (${restored}) for key ${input.key!.slice(0, 24)}`,
              )
            }
          }
          if (!session) {
            session = await client.newSession(cwd, {
              model,
              mcpServers: lease?.servers,
              meta: state.config.meta,
              additionalDirectories: this.sessionDirectories(state.config),
            })
            await this.rememberSession(poolKey, session.sessionId)
          }
          if (mode) await client.setMode(session.sessionId, mode).catch(() => {})
          await this.applyEffort(state, client, session.sessionId, effort)
          // A restored session keeps its old model, so put the requested one back.
          if (reused && model) {
            await client.setModel(session.sessionId, model).catch((error) => {
              this.log(
                "warn",
                `could not set model "${model}" on restored ACP session: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              )
            })
          }
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
          active: 0,
          failures: 0,
          broken: false,
          mcpRelease: lease?.release,
        }
        this.pools.set(poolKey, created)
        this.log(
          "debug",
          `opened ACP session ${session.sessionId} for key ${input.key!.slice(0, 24)} in ${Date.now() - sessionStartedAt}ms`,
        )
        return { pooled: created, reused }
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
      pooled.active += 1
      return pooled.client
        .prompt(pooled.sessionId, prompt, {
          onUpdate: input.onUpdate,
          signal: input.signal,
          requestPermission: onPermission,
        })
        .finally(() => {
          pooled.active = Math.max(0, pooled.active - 1)
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
    run.then(
      () => {
        pooled.failures = 0
      },
      () => {},
    ).catch(() => {})
    run.catch((error: unknown) => {
      // A failed turn does not necessarily invalidate the ACP session. The
      // process dying or the agent forgetting the session does; everything else
      // (cancel, timeout, reset) keeps the context, so a retry resumes the same
      // conversation instead of starting a new one.
      if (this.pools.get(poolKey) !== pooled) return
      const message = error instanceof Error ? error.message : String(error)
      const unknown = isUnknownSession(error)
      if (unknown || !pooled.client.alive || !pooled.client.hasSession(pooled.sessionId)) {
        this.dropPool(poolKey, pooled)
        if (unknown) void this.forgetSession(poolKey)
        return
      }
      pooled.failures += 1
      if (error instanceof AcpError && error.code === ACP_REQUEST_CANCELLED) {
        // A stopped turn is normal; the agent already ended it, so the session
        // is intact and the next prompt picks up the same conversation.
        pooled.failures = 0
        this.log("debug", `kept ACP session ${pooled.sessionId} after a cancelled turn`)
        return
      }
      if (pooled.failures >= MAX_TURN_FAILURES) {
        this.log("warn", `dropping ACP session ${pooled.sessionId} after ${pooled.failures} failed turns: ${message}`)
        this.dropPool(poolKey, pooled)
        // A session that failed this many times in a row should not be restored
        // into the same state on the next turn.
        void this.forgetSession(poolKey)
        return
      }
      // Ask the agent to end whatever it is still running so the queued or next
      // prompt enters the same context at a clean boundary.
      pooled.client.cancelTurn(pooled.sessionId)
      this.log("debug", `keeping ACP session ${pooled.sessionId} after a failed turn: ${message}`)
    })
    return run
  }

  /** Drop a pooled session on our side, leaving its stored id unless callers forget it. */
  private dropPool(poolKey: string, pooled: PooledSession) {
    pooled.broken = true
    if (this.pools.get(poolKey) === pooled) this.pools.delete(poolKey)
    pooled.mcpRelease?.()
    void pooled.client.closeSession(pooled.sessionId).catch(() => {})
  }

  /** Whether an ACP turn is streaming for this OpenCode session right now. */
  running(key: string) {
    return [...this.pools.values()].some((entry) => entry.key === key && entry.active > 0 && !entry.broken)
  }

  /**
   * Deliver a message into the turn that is running for an OpenCode session.
   *
   * An agent that advertises `_session/steering` takes the text where it is, so
   * the caller can drop the queued OpenCode message and avoid delivering it
   * twice. Every other agent is interrupted instead: the turn ends at its next
   * safe point and OpenCode delivers the queued message as its own prompt, which
   * resumes the same ACP session with its context intact.
   */
  async steer(input: { key: string; text: string; inPlace?: boolean }): Promise<AcpSteerResult> {
    const pooled = [...this.pools.values()]
      .filter((entry) => entry.key === input.key && entry.active > 0 && !entry.broken)
      .sort((left, right) => right.lastUsed - left.lastUsed)[0]
    if (!pooled) return { status: "unavailable" }

    const client = pooled.client
    pooled.lastUsed = Date.now()
    if (input.inPlace !== false && client.supportsSteering) {
      try {
        const result = await client.steer(pooled.sessionId, input.text)
        if (result.outcome === "injected" || result.outcome === "startedNewTurn") {
          this.log("debug", `steered ACP session ${pooled.sessionId} (${result.outcome})`)
          return { status: "steered" }
        }
        this.log(
          "debug",
          `ACP session ${pooled.sessionId} did not take the steer: ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`,
        )
      } catch (error) {
        if (error instanceof AcpError && error.code === ACP_REQUEST_TIMEOUT) {
          // The steer may or may not have landed. Interrupting now could undo
          // work the agent already accepted, so leave the queued message for
          // OpenCode's normal delivery instead.
          this.log("warn", `steering ACP session ${pooled.sessionId} timed out; leaving the message queued`)
          return { status: "unavailable" }
        }
        this.log(
          "warn",
          `could not steer ACP session ${pooled.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    client.cancelTurn(pooled.sessionId)
    this.log("debug", `interrupted ACP session ${pooled.sessionId} so the queued message can be delivered`)
    return { status: "interrupted" }
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

function isUnknownSession(error: unknown) {
  if (!(error instanceof AcpError)) return false
  if (error.code === ACP_UNKNOWN_SESSION) return true
  return /unknown (acp )?session|session .*not found|session .*does not exist/i.test(error.message)
}

/** Whether two advertised command lists are the same, so a rebuild can be skipped. */
function sameCommands(left: AcpCommand[], right: AcpCommand[]) {
  if (left.length !== right.length) return false
  return left.every((command, index) => {
    const other = right[index]
    return command.name === other.name && command.description === other.description && command.hint === other.hint
  })
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
