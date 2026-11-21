import { homedir } from "node:os"
import { isAbsolute } from "node:path"
import {
  ACP_REQUEST_CANCELLED,
  AcpClient,
  isAcpError,
  type AcpCommand,
  type AcpMcpServer,
  type SessionUpdate,
  type PermissionHandler,
} from "./acp-client.ts"
import { AgentPool, type AgentLaunch, type AgentLease, type AgentSubscriber } from "./agent-pool.ts"
import { applyCmdMods } from "./agents/cmd/index.ts"
import { isCmdCommand } from "./agent-command.ts"
import { commandOf, record, text } from "./acp-tools/shared.ts"
import { effortLevels, inventoryKey, type AcpCatalog } from "./inventory.ts"
import { runSetup } from "./setup.ts"
import {
  isUnsolicitedActivity,
  unsolicitedSummary,
  UnsolicitedTurn,
  type BackgroundToolRecord,
  type UnsolicitedTimingOptions,
} from "./unsolicited.ts"
import { agentName, errorMessage } from "./util.ts"

export interface AcpServerConfig {
  /** Stable id used for the OpenCode provider and tool arguments. */
  id: string
  /** Display name for the provider. Defaults to the id. */
  name?: string
  /** Command and arguments that start the ACP agent, e.g. ["cmd", "acp"]. */
  command: string | string[]
  /**
   * Shell command run once before the agent is first spawned. Not limited to
   * installation, e.g. `"vp add -g command-code@latest"` installs while a login
   * or config-write command works too. Runs once per plugin-module lifetime; a
   * failure is logged and the agent still starts.
   */
  setup?: string
  /**
   * Working directory for the agent process and its sessions. When unset,
   * sessions use the OpenCode location, and the process starts in the home
   * directory if it is shared across directories (else in the OpenCode location).
   */
  cwd?: string
  /** Extra environment variables for the agent process. */
  env?: Record<string, string>
  /**
   * Share one agent process across OpenCode directories. Defaults to true,
   * except for Command Code (`cmd`), which binds a process to one directory and
   * always gets its own process with a warm spare. Set false for other agents
   * that serve one directory per process.
   */
  share?: boolean
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
  /**
   * Effort levels this model offers, excluding the implicit default. Agents such
   * as Antigravity offer different levels per model, and some models none at
   * all. Learned when the model is first selected; until then it is undefined
   * and the server-wide list applies.
   */
  efforts?: string[]
  /** The agent's own effort for this model, as reported before any effort was set. */
  defaultEffort?: string
}

export interface AcpServerState {
  config: AcpServerConfig
  client?: AcpClient
  models: AcpModelInfo[]
  defaultModel?: string
  modelConfigID?: string
  /** Reasoning effort levels advertised by the agent, excluding the implicit default. */
  efforts: string[]
  effortConfigID?: string
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
  servers: (sessionKey: string, agent: AcpServerConfig) => Promise<McpLease>
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

interface AcpSelection {
  model?: string
  effort?: string
}

interface PooledSession {
  server: string
  key: string
  sessionKey: string
  sessionId: string
  client: AcpClient
  /** Undefined after a refused/uncertain config write; never assume it applied. */
  selection?: AcpSelection
  history: "fresh" | "retained"
  mcpServers?: AcpMcpServer[]
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
  /** Tools started in an earlier turn that had not settled when that turn returned. */
  backgroundTools: Map<string, TrackedBackgroundTool>
  /** Autonomous post-turn continuation currently streaming for this session, if any. */
  activeUnsolicited?: UnsolicitedTurn
  activeUnsolicitedTools?: Map<string, TurnToolRecord>
  /** Buffered/live unsolicited turns keyed by their continuation token. */
  pendingContinuations: Map<string, UnsolicitedTurn>
}

interface TrackedBackgroundTool extends BackgroundToolRecord {
  kind?: string
  meta?: Record<string, unknown>
}

interface TurnToolRecord extends TrackedBackgroundTool {
  terminal: boolean
}

export interface AcpUnsolicitedTurnInfo {
  readonly server: string
  readonly sessionKey: string
  readonly token: string
  readonly description: string
  readonly text: string
}

interface AcpRunResult {
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

/** ACP's "resource not found": the agent no longer knows the session. */
const ACP_UNKNOWN_SESSION = -32002
/** Failed turns in a row before the pooled session is recycled. */
const MAX_TURN_FAILURES = 3
/** How long to wait for the command list an agent sends after `session/new`. */
const COMMAND_SNAPSHOT_TIMEOUT_MS = 2_000
const SWEEP_INTERVAL_MS = 60_000
const MAX_BACKGROUND_TOOLS = 64

export class AcpServerManager {
  readonly servers = new Map<string, AcpServerState>()
  private permissionResolver?: PermissionResolver
  private log: LogFn
  private defaultCwd: string
  private pools = new Map<string, PooledSession>()
  private negotiating = new Map<string, Promise<PooledSession>>()
  private preparing = new Map<string, Promise<void>>()
  /** Keys whose ACP turn is still being negotiated, before a prompt is in flight. */
  private starting = new Map<string, number>()
  /** Keys whose starting turn must be cancelled as soon as its prompt is sent. */
  private startCancels = new Set<string>()
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
  private cmdOrchestration: boolean
  private onCommands?: (server: string) => void
  private onModels?: (server: string) => void
  private onUnsolicited?: (turn: AcpUnsolicitedTurnInfo) => void
  private unsolicitedTiming?: UnsolicitedTimingOptions
  private discoverCommands: boolean
  private catalogs = new Map<string, { catalog: AcpCatalog; onModels: () => void }>()
  /** Pool that owns agent processes; shared with other OpenCode directories when passed in. */
  private agents: AgentPool
  private ownsAgents: boolean
  /** The pool lease each server's client came from, so released sessions do not outlive it. */
  private leases = new Map<string, AgentLease>()
  private disposed = false

  constructor(input: {
    servers: AcpServerConfig[]
    defaultCwd: string
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
    /** Load the cmd mod that hides native orchestration tools (set when the MCP bridge is on). */
    cmdOrchestration?: boolean
    /** Called when a server's advertised command list changes. */
    onCommands?: (server: string) => void
    /** Open a local session to discover this location's slash commands. */
    discoverCommands?: boolean
    /** Called when a model's effort levels are learned, which changes its variants. */
    onModels?: (server: string) => void
    /** Called when an idle pooled session emits unsolicited post-turn agent activity. */
    onUnsolicited?: (turn: AcpUnsolicitedTurnInfo) => void
    /** Override idle timers for unsolicited turns (primarily for testing). */
    unsolicitedTiming?: UnsolicitedTimingOptions
    /**
     * Pool that owns agent processes. Pass `sharedAgentPool()` to share them
     * across OpenCode directories; defaults to a private pool.
     */
    agents?: AgentPool
  }) {
    this.defaultCwd = input.defaultCwd
    this.permissionResolver = input.requestPermission
    this.mcp = input.mcp
    this.sessions = input.sessions
    this.log = input.log ?? (() => {})
    this.initTimeoutMs = input.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS
    this.requestTimeoutMs = input.requestTimeoutMs
    this.promptTimeoutMs = input.promptTimeoutMs
    const maxSessions = input.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.maxSessions = Number.isFinite(maxSessions) ? Math.max(1, Math.floor(maxSessions)) : DEFAULT_MAX_SESSIONS
    this.sessionIdleMs = Math.max(0, input.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS)
    this.allowPathsOutsideCwd = input.allowPathsOutsideCwd === true
    this.maxFileBytes = input.maxFileBytes
    this.additionalDirectories = input.additionalDirectories?.filter((directory) => directory.trim())
    this.cmdSkillDir = input.cmdSkillDir
    this.cmdOrchestration = input.cmdOrchestration === true
    this.onCommands = input.onCommands
    this.discoverCommands = input.discoverCommands !== false
    this.onModels = input.onModels
    this.onUnsolicited = input.onUnsolicited
    this.unsolicitedTiming = input.unsolicitedTiming
    this.agents = input.agents ?? new AgentPool()
    this.ownsAgents = input.agents === undefined

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
          `ignoring ACP server "${config.id}": ${errorMessage(error)}`,
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

  private assertLive() {
    if (this.disposed) throw new Error("ACP server manager is stopped")
  }

  get list() {
    return [...this.servers.values()].filter((state) => !state.config.disabled)
  }

  get(id: string) {
    const state = this.servers.get(id)
    return state && !state.config.disabled ? state : undefined
  }

  private poolKey(server: string, key: string, cwd: string) {
    return `${server}\u0000${key}\u0000${cwd}`
  }

  private async storedSession(poolKey: string) {
    if (!this.sessions) return undefined
    try {
      return await this.sessions.get(poolKey)
    } catch (error) {
      this.log("warn", `could not read a stored ACP session: ${errorMessage(error)}`)
      return undefined
    }
  }

  private async rememberSession(poolKey: string, sessionId: string) {
    if (!this.sessions) return
    try {
      await this.sessions.set(poolKey, sessionId)
    } catch (error) {
      this.log("warn", `could not store ACP session ${sessionId}: ${errorMessage(error)}`)
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

  /** Effort levels and default for a model, falling back to the server-wide list until it is learned. */
  private effortsFor(state: AcpServerState, model: string | undefined) {
    const info = state.models.find((candidate) => candidate.id === (model ?? state.defaultModel))
    if (info?.efforts) return { values: info.efforts, defaultValue: info.defaultEffort, known: true }
    return { values: state.efforts, defaultValue: undefined, known: false }
  }

  /** The effort a run asks for: the request, then the server config. Nothing means the agent's default. */
  private requestedEffort(state: AcpServerState, requested?: string) {
    const effort = requested ?? state.config.effort
    return effort && effort !== "default" ? effort : undefined
  }

  /**
   * Record what the session reports for its current model's effort select.
   * Efforts are learned per model on first selection rather than by switching
   * through every model at discovery.
   */
  private learnEfforts(state: AcpServerState, model: string | undefined, client: AcpClient, sessionId: string) {
    const id = model ?? state.defaultModel
    const catalog = this.catalogs.get(state.config.id)?.catalog
    const current = catalog?.models.find((candidate) => candidate.id === id)
    if (!catalog || !current || current.efforts !== undefined) return
    const observed = client.observedEffort(sessionId)
    if (!observed) return
    const efforts = effortLevels(observed.config?.values ?? [])
    catalog.models = catalog.models.map((candidate) =>
      candidate === current ? { ...current, efforts, ...(observed.defaultValue ? { defaultEffort: observed.defaultValue } : {}) } : candidate,
    )
    this.log("debug", `ACP model "${id}" offers effort levels: ${efforts.join(", ") || "none"}`)
    for (const onModels of catalog.onModels) onModels()
  }

  private forgetCatalog(server: string) {
    const subscription = this.catalogs.get(server)
    subscription?.catalog.onModels.delete(subscription.onModels)
    this.catalogs.delete(server)
  }

  private sessionDirectories(config: AcpServerConfig, client?: AcpClient) {
    const directories = [...(config.skills === false ? [] : (this.additionalDirectories ?? []))]
    const lease = this.leases.get(config.id)
    if (client && lease?.client === client) directories.push(...lease.readRoots)
    return directories.length ? directories : undefined
  }

  private launchFor(config: AcpServerConfig, skillDir: string | undefined): AgentLaunch {
    const { command, args } = normalizeCommand(
      applyCmdMods(config.command, { orchestration: this.cmdOrchestration, skillDir }),
    )
    const env: Record<string, string> = { ...config.env }
    if (skillDir !== undefined && isCmdCommand(config.command)) {
      // Read by agents/cmd/mods/opencode-skills.ts, which registers the directory
      // because `cmd acp` does not apply the global `--skill` flag.
      env.OPENCODE_ACP_PROVIDER_SKILL_DIR = skillDir
    }
    return {
      command,
      args,
      env,
      cwd:
        config.cwd ??
        (this.ownsAgents || (!isAbsolute(command) && /[\\/]/.test(command)) ? this.defaultCwd : homedir()),
      scope: this.ownsAgents ? config.id : undefined,
      autoApprove: config.autoApprove !== false,
      requestTimeoutMs: this.requestTimeoutMs,
      promptTimeoutMs: this.promptTimeoutMs,
      allowPathsOutsideCwd: this.allowPathsOutsideCwd,
      maxFileBytes: this.maxFileBytes,
    }
  }

  /** Install or update the agent before it is spawned; memoized per script. */
  private setupFor(state: AcpServerState) {
    const setup = state.config.setup?.trim()
    return setup ? runSetup(setup, this.log) : Promise.resolve()
  }

  /**
   * Set a requested effort once the session's model is selected. Learns the
   * model's levels first, and sends nothing to a model that has no effort
   * select or does not offer the level.
   */
  private async applyEffort(
    state: AcpServerState,
    client: AcpClient,
    sessionId: string,
    model: string | undefined,
    effort: string | undefined,
  ) {
    this.learnEfforts(state, model, client, sessionId)
    if (!effort) return
    const { values, known } = this.effortsFor(state, model)
    if (known && !values.includes(effort) && effort !== "default") {
      this.log(
        "debug",
        `ACP model "${model ?? state.defaultModel ?? "default"}" does not offer effort "${effort}"` +
          (values.length ? ` (available: ${values.join(", ")})` : "; it has no effort levels"),
      )
      return
    }
    await client.setEffort(sessionId, effort, state.effortConfigID)
    this.log("debug", `ACP effort set to ${effort}`)
  }

  /** Called only inside the conversation's queue, before its next prompt. */
  private async select(
    state: AcpServerState,
    pooled: PooledSession,
    selection: AcpSelection,
    poolKey: string,
  ) {
    const previous = pooled.selection
    if (previous && previous.model === selection.model && previous.effort === selection.effort) return
    pooled.selection = undefined
    if (previous && (selection.model || previous.model === undefined)) {
      try {
        const modelChanged = previous.model !== selection.model
        if (modelChanged && selection.model) {
          await pooled.client.setModel(pooled.sessionId, selection.model, state.modelConfigID)
        }
        // After a model switch the agent picks the new model's effort itself.
        // Going back to the default on the same model needs that default.
        let effort = selection.effort
        let live = true
        if (!effort && !modelChanged && previous.effort) {
          this.learnEfforts(state, selection.model, pooled.client, pooled.sessionId)
          const { values, defaultValue, known } = this.effortsFor(state, selection.model)
          if (defaultValue) effort = defaultValue
          else live = known && !values.length
        }
        if (live) {
          await this.applyEffort(state, pooled.client, pooled.sessionId, selection.model, effort)
          pooled.selection = selection
          return
        }
      } catch (error) {
        if (!isAcpError(error) || ![-32601, -32602].includes(error.code)) throw error
        this.log("debug", `ACP session refused a selection change; replaying in a fresh session: ${error.message}`)
      }
    }

    // Some agents cannot change a live selection or reset to the provider default.
    // Keep the conversation queue, but replay history into a new ACP session.
    // Issue a fresh MCP bridge lease for the replacement ACP session so it
    // starts with its own lease before the old session releases its token.
    const lease = this.mcp
      ? await this.mcp.servers(pooled.key, state.config).catch((error) => {
          this.log("warn", `could not refresh MCP servers for ${state.config.id}: ${errorMessage(error)}`)
          return undefined
        })
      : undefined
    const sessionIdRef = { id: "" }
    const callbacks = this.sessionCallbacks(state, poolKey, pooled.sessionKey, sessionIdRef)
    const session = await pooled.client
      .newSession(pooled.cwd, {
        model: selection.model,
        mcpServers: lease?.servers ?? pooled.mcpServers,
        meta: state.config.meta,
        additionalDirectories: this.sessionDirectories(state.config, pooled.client),
        owner: this,
        onCommands: (commands) => this.recordCommands(state, commands),
        ...callbacks,
      })
      .catch((error) => {
        lease?.release()
        throw error
      })
    sessionIdRef.id = session.sessionId
    if (this.disposed) {
      await pooled.client.closeSession(session.sessionId, this).catch(() => {})
      lease?.release()
      throw new Error("ACP server manager is stopped")
    }
    try {
      if (state.config.mode) await pooled.client.setMode(session.sessionId, state.config.mode).catch(() => {})
      await this.applyEffort(state, pooled.client, session.sessionId, selection.model, selection.effort)
    } catch (error) {
      lease?.release()
      await pooled.client.closeSession(session.sessionId, this).catch(() => {})
      throw error
    }
    // The pool may have been closed while the new session was being prepared
    // (an agent reload or shutdown does not wait for this queue). Releasing the
    // fresh lease here keeps its bridge token from outliving a dead pool.
    if (pooled.broken) {
      lease?.release()
      await pooled.client.closeSession(session.sessionId, this).catch(() => {})
      throw new Error(`ACP session for key ${pooled.key.slice(0, 24)} was closed while changing selection`)
    }
    const oldSession = pooled.sessionId
    pooled.sessionId = session.sessionId
    pooled.history = "fresh"
    pooled.selection = selection
    pooled.backgroundTools.clear()
    if (lease) {
      pooled.mcpRelease?.()
      pooled.mcpServers = lease.servers
      pooled.mcpRelease = lease.release
    }
    await this.rememberSession(poolKey, session.sessionId)
    await pooled.client.closeSession(oldSession, this).catch(() => {})
  }

  /** Discover enabled agents in parallel and report each result independently. */
  async initialize(onSettled?: (state: AcpServerState) => Promise<void>) {
    if (this.disposed) return
    await Promise.all(
      this.list.map(async (state) => {
        try {
          // Installing or updating the agent is not part of the timed handshake.
          await this.setupFor(state)
          if (this.disposed) return
          await withTimeout(
            this.prepare(state),
            this.initTimeoutMs,
            `ACP server "${state.config.id}" did not initialize within ${this.initTimeoutMs}ms`,
          )
        } catch (error) {
          if (this.disposed) return
          state.error = errorMessage(error)
          this.log("error", `ACP server "${state.config.id}" failed to initialize: ${state.error}`)
          // Do not stop the client here: a timed-out prepare may still finish.
          // It stops its own client on failure, and a success is still usable.
        }
        if (!this.disposed) await onSettled?.(state)
      }),
    )
  }

  /** Re-run discovery, e.g. after a server failed to start during setup. */
  async refresh(state: AcpServerState) {
    this.assertLive()
    const id = state.config.id
    // Setup runs outside the timed work: a slow install is not an init timeout.
    await this.setupFor(state)
    this.assertLive()
    const work = (async () => {
      const inFlight = this.preparing.get(id)
      if (inFlight) await inFlight.catch(() => {})
      if (state.initialized && state.models.length) return
      this.assertLive()
      state.initialized = false
      state.error = undefined
      await this.prepare(state)
    })()
    try {
      await withTimeout(work, this.initTimeoutMs, `ACP server "${id}" did not initialize within ${this.initTimeoutMs}ms`)
    } catch (error) {
      state.error = errorMessage(error)
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

  private async withDiscoverySession<T>(
    state: AcpServerState,
    client: AcpClient,
    read: (session: Awaited<ReturnType<AcpClient["newSession"]>>) => T,
  ) {
    const config = state.config
    const session = await client.newSession(config.cwd ?? this.defaultCwd, {
      meta: config.meta,
      additionalDirectories: this.sessionDirectories(config, client),
      owner: this,
      onCommands: this.discoverCommands ? (commands) => this.recordCommands(state, commands) : undefined,
    })
    try {
      this.assertLive()
      const result = read(session)
      if (this.discoverCommands) {
        // Commands are location-specific and may arrive just after session/new.
        const commands = await client.waitForCommands(session.sessionId, COMMAND_SNAPSHOT_TIMEOUT_MS)
        if (commands) this.recordCommands(state, commands)
      }
      return result
    } finally {
      await client.closeSession(session.sessionId, this).catch(() => {})
    }
  }

  private async doPrepare(state: AcpServerState) {
    const config = state.config
    this.assertLive()
    // The lazy path through `prepare()` waits for setup too; the memo makes it
    // instant when discovery already ran it.
    await this.setupFor(state)
    this.assertLive()

    const previous = state.client
    if (previous) {
      await this.closePoolsFor(config.id)
      this.leases.get(config.id)?.release()
      this.leases.delete(config.id)
    }
    this.assertLive()

    const skillDir = config.skills === false ? undefined : this.cmdSkillDir
    const launch = this.launchFor(config, skillDir)
    const subscriber: AgentSubscriber = {
      onLog: (level, message) => this.log(level, `[${config.id}] ${message}`),
      onExit: (error) => {
        this.log("warn", `ACP agent "${config.id}" exited; pooled sessions were dropped: ${error.message}`)
        void this.closePoolsFor(config.id)
      },
    }
    const dedicated = isCmdCommand(config.command) || config.share === false
    const lease = dedicated
      ? this.agents.dedicated({ launch: (dir) => this.launchFor(config, dir), skillDir }, subscriber)
      : this.agents.acquire(launch, subscriber)
    this.leases.set(config.id, lease)
    const client = lease.client
    state.client = client
    state.retryable = true

    try {
      // The allowlist is a local view, not part of what the agent advertises.
      const { command, args } = normalizeCommand(config.command)
      const agent = inventoryKey({ ...config, command: [command, ...args], models: undefined })
      const commandCwd = !isAbsolute(launch.command) && /[\\/]/.test(launch.command) ? launch.cwd : undefined
      const key = JSON.stringify([agent, config.cwd ?? commandCwd])
      const cached = this.agents.catalogs.get(key)
      let discovery = cached
      if (!discovery) {
        discovery = this.withDiscoverySession(state, client, (session): AcpCatalog => {
          const defaultModel = session.currentModel ?? (session.modelConfigID ? undefined : "default")
          const models = session.models.length
            ? session.models
            : defaultModel ? [{ id: defaultModel, name: session.currentModel ?? "Agent default" }] : []
          if (!models.length) throw new Error(`ACP server "${config.id}" advertised no models`)
          const observed = client.observedEffort(session.sessionId)
          return {
            models: models.map((model) => observed && model.id === defaultModel
              ? { ...model, efforts: effortLevels(observed.config?.values ?? []), defaultEffort: observed.defaultValue }
              : model),
            defaultModel,
            modelConfigID: session.modelConfigID,
            efforts: effortLevels(session.efforts ?? []),
            effortConfigID: session.effort?.configId,
            onModels: new Set(),
          }
        })
        this.agents.catalogs.set(key, discovery)
        void discovery.catch(() => {
          if (this.agents.catalogs.get(key) === discovery) this.agents.catalogs.delete(key)
        })
      }
      const catalog = await discovery
      this.assertLive()
      const allow = config.models?.length ? new Set(config.models) : undefined
      const visible = () => allow ? catalog.models.filter((model) => allow.has(model.id)) : catalog.models
      const models = visible()
      if (!catalog.modelConfigID && config.model && config.model !== catalog.defaultModel) {
        state.retryable = false
        throw new Error(`ACP server "${config.id}" does not expose an ACP model selector; use "default" or omit "model"`)
      }
      if (!models.length) {
        state.retryable = false
        throw new Error(`ACP server "${config.id}" advertised no model matching "models" (${config.models?.join(", ")})`)
      }
      if (config.model && !models.some((model) => model.id === config.model)) {
        this.log(
          "warn",
          `ACP server "${config.id}" does not advertise the configured model "${config.model}"; it will be sent anyway`,
        )
      }
      if (cached && this.discoverCommands) {
        await this.withDiscoverySession(state, client, () => {}).catch((error) => {
          this.log("debug", `could not discover ACP commands for "${config.id}": ${errorMessage(error)}`)
        })
        this.assertLive()
      }
      state.models = visible()
      state.defaultModel = catalog.defaultModel
      state.modelConfigID = catalog.modelConfigID
      state.efforts = catalog.efforts
      state.effortConfigID = catalog.effortConfigID
      const onModels = () => {
        state.models = visible()
        this.onModels?.(config.id)
      }
      this.forgetCatalog(config.id)
      catalog.onModels.add(onModels)
      this.catalogs.set(config.id, { catalog, onModels })
      state.initialized = true
      state.error = undefined
      this.log("info", `ACP server "${config.id}" ready with ${models.length} model(s)`)
    } catch (error) {
      if (this.leases.get(config.id) === lease) {
        lease.release()
        this.leases.delete(config.id)
      }
      if (state.client === client) state.client = undefined
      throw error
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
    continuation?: string
    signal?: AbortSignal
    onUpdate?: (update: SessionUpdate) => void
  }): Promise<AcpRunResult> {
    if (input.signal?.aborted) return { stopReason: "cancelled", text: "" }
    // Negotiating a cold or restored ACP session takes a moment. Mark the turn
    // as starting before the first await so a steer that arrives in that window
    // is not mistaken for an idle session.
    const key = input.key
    let starting = false
    if (key) {
      starting = true
      this.starting.set(key, (this.starting.get(key) ?? 0) + 1)
    }
    const finishStarting = () => {
      if (!starting || !key) return
      starting = false
      const remaining = (this.starting.get(key) ?? 1) - 1
      if (remaining > 0) this.starting.set(key, remaining)
      else this.starting.delete(key)
    }

    try {
      const state = this.get(input.server)
      if (!state) throw new Error(`Unknown ACP server: ${input.server}`)
      await this.prepare(state)
      const client = state.client
      if (!client) throw new Error(`ACP server "${input.server}" is not ready`)

      const cwd = state.config.cwd ?? this.defaultCwd
      const requestedModel = input.model ?? state.config.model ?? state.defaultModel
      if (!state.modelConfigID && requestedModel !== state.defaultModel) {
        throw new Error(`ACP server "${input.server}" does not expose an ACP model selector`)
      }
      const model = state.modelConfigID ? requestedModel : undefined
      const mode = state.config.mode
      const effort = this.requestedEffort(state, input.effort)
      const onPermission = this.permissionHandler(input.server, input.sessionKey)

      if (!input.key) {
        const prompt = typeof input.prompt === "string" ? input.prompt : input.prompt.fresh
        const session = await client.newSession(cwd, {
          model,
          meta: state.config.meta,
          additionalDirectories: this.sessionDirectories(state.config, client),
          owner: this,
          onCommands: (commands) => this.recordCommands(state, commands),
        })
        if (this.disposed) {
          await client.closeSession(session.sessionId, this).catch(() => {})
          throw new Error("ACP server manager is stopped")
        }
        try {
          if (mode) await client.setMode(session.sessionId, mode).catch(() => {})
          await this.applyEffort(state, client, session.sessionId, model, effort)
          return await client.prompt(session.sessionId, prompt, {
            owner: this,
            onUpdate: input.onUpdate,
            signal: input.signal,
            requestPermission: onPermission,
          })
        } finally {
          await client.closeSession(session.sessionId, this)
        }
      }

      const poolKey = this.poolKey(input.server, input.key, cwd)
      const existing = this.pools.get(poolKey)
      if (input.continuation) {
        const turn = existing && !existing.broken ? existing.pendingContinuations.get(input.continuation) : undefined
        if (!existing || existing.broken || !turn) {
          this.log("debug", `ignoring expired ACP continuation ${input.continuation} for key ${input.key.slice(0, 24)}`)
          return { stopReason: "end_turn", text: "" }
        }
        existing.pendingContinuations.delete(input.continuation)
        existing.lastUsed = Date.now()
        existing.pending += 1
        const run = existing.queue.then(async () => {
          if (existing.broken) throw new Error(`ACP session ${existing.sessionId} is no longer usable`)
          if (input.signal?.aborted) {
            turn.cancel()
            return { stopReason: "cancelled", text: "" }
          }
          existing.active += 1
          finishStarting()
          try {
            if (key && this.startCancels.delete(key)) {
              existing.client.cancelTurn(existing.sessionId, this)
              turn.cancel()
            }
            return await turn.attach(input.onUpdate, input.signal, () => {
              existing.client.cancelTurn(existing.sessionId, this)
            })
          } finally {
            existing.active = Math.max(0, existing.active - 1)
          }
        })
        existing.queue = run.catch(() => {})
        void run
          .then(
            () => {
              existing.failures = 0
            },
            (error: unknown) => this.onTurnFailed(poolKey, existing, error),
          )
          .finally(() => {
            existing.pending = Math.max(0, existing.pending - 1)
            existing.lastUsed = Date.now()
          })
        return await run
      }

      let negotiating = this.negotiating.get(poolKey)
      if (!existing && !negotiating) {
        const eviction = this.reserveCapacity()
        // Install this reservation before the negotiation can open a session.
        negotiating = Promise.resolve().then(async () => {
          if (eviction) await eviction
          this.assertLive()
          const sessionStartedAt = Date.now()
          const resolvedSessionKey = input.sessionKey ?? input.key!
          const sessionIdRef = { id: "" }
          const callbacks = this.sessionCallbacks(state, poolKey, resolvedSessionKey, sessionIdRef)
          const lease = await this.mcp?.servers(input.key!, state.config)
          let session: { sessionId: string } | undefined
          let reused = false
          try {
            // A plugin reload or an agent crash leaves a fresh process with no
            // sessions. Reattach to the one this OpenCode session had instead of
            // starting over and losing the conversation.
            // Migrate the previously variant-keyed store without losing an
            // existing conversation on the first run after upgrading.
            const legacyKey = `${input.server}\u0000${input.key}\u0000${model ?? ""}\u0000${cwd}\u0000${effort ?? ""}`
            const stored = (await this.storedSession(poolKey)) ?? (await this.storedSession(legacyKey))
            if (stored) {
              const restored = await client
                .restoreSession(stored, {
                  cwd,
                  mcpServers: lease?.servers,
                  meta: state.config.meta,
                  additionalDirectories: this.sessionDirectories(state.config, client),
                  owner: this,
                  onCommands: (commands) => this.recordCommands(state, commands),
                  ...callbacks,
                })
                .catch(async (error) => {
                  this.log(
                    "warn",
                    `could not restore ACP session ${stored} for key ${input.key!.slice(0, 24)}: ${errorMessage(error)}; starting a new one`,
                  )
                  await this.forgetSession(poolKey)
                  return undefined
                })
              if (this.disposed) {
                if (restored) await client.closeSession(stored, this).catch(() => {})
                lease?.release()
                throw new Error("ACP server manager is stopped")
              }
              if (restored) {
                session = { sessionId: stored }
                sessionIdRef.id = stored
                reused = true
                await this.rememberSession(poolKey, stored)
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
                additionalDirectories: this.sessionDirectories(state.config, client),
                owner: this,
                onCommands: (commands) => this.recordCommands(state, commands),
                ...callbacks,
              })
              sessionIdRef.id = session.sessionId
              if (this.disposed) {
                await client.closeSession(session.sessionId, this).catch(() => {})
                lease?.release()
                throw new Error("ACP server manager is stopped")
              }
              await this.rememberSession(poolKey, session.sessionId)
            }
            if (mode) await client.setMode(session.sessionId, mode).catch(() => {})
            // A restored session keeps its old model, so put the requested one back.
            if (reused && model) {
              await client.setModel(session.sessionId, model, state.modelConfigID)
            }
            // Set effort after model: changing models can reset it.
            await this.applyEffort(state, client, session.sessionId, model, effort)
          } catch (error) {
            lease?.release()
            if (session) await client.closeSession(session.sessionId, this).catch(() => {})
            throw error
          }
          if (this.disposed) {
            await client.closeSession(session.sessionId, this).catch(() => {})
            lease?.release()
            throw new Error("ACP server manager is stopped")
          }
          const created: PooledSession = {
            server: input.server,
            key: input.key!,
            sessionKey: resolvedSessionKey,
            sessionId: session.sessionId,
            client,
            selection: { model, effort },
            history: reused ? "retained" : "fresh",
            mcpServers: lease?.servers,
            cwd,
            queue: Promise.resolve(),
            lastUsed: Date.now(),
            pending: 0,
            active: 0,
            failures: 0,
            broken: false,
            mcpRelease: lease?.release,
            backgroundTools: new Map(),
            pendingContinuations: new Map(),
          }
          this.pools.set(poolKey, created)
          this.log(
            "debug",
            `opened ACP session ${session.sessionId} for key ${input.key!.slice(0, 24)} in ${Date.now() - sessionStartedAt}ms`,
          )
          return created
        })
        this.negotiating.set(poolKey, negotiating)
      }
      let pooled: PooledSession
      if (existing) {
        pooled = existing
        this.log("debug", `reusing ACP session ${pooled.sessionId} for key ${input.key.slice(0, 24)}`)
      } else {
        try {
          pooled = await negotiating!
        } finally {
          if (this.negotiating.get(poolKey) === negotiating) this.negotiating.delete(poolKey)
        }
      }
      if (pooled.broken || this.pools.get(poolKey) !== pooled) {
        throw new Error(`ACP session for key ${input.key.slice(0, 24)} was closed after an earlier turn failed`)
      }

      pooled.lastUsed = Date.now()
      pooled.pending += 1
      const run = pooled.queue.then(async () => {
        if (pooled.broken) throw new Error(`ACP session ${pooled.sessionId} is no longer usable`)
        if (input.signal?.aborted) return { stopReason: "cancelled", text: "" }
        if (pooled.activeUnsolicited && !pooled.activeUnsolicited.attached) {
          pooled.activeUnsolicited.finish("end_turn")
        }
        await this.select(state, pooled, { model, effort }, poolKey)
        if (pooled.broken) throw new Error(`ACP session ${pooled.sessionId} is no longer usable`)
        if (input.signal?.aborted) return { stopReason: "cancelled", text: "" }
        const prompt =
          typeof input.prompt === "string"
            ? input.prompt
            : pooled.history === "retained" ? input.prompt.reused : input.prompt.fresh
        pooled.active += 1
        finishStarting()
        pooled.history = "retained"
        const turnTools = new Map<string, TurnToolRecord>()
        const turn = pooled.client
          .prompt(pooled.sessionId, prompt, {
            owner: this,
            onUpdate: (update) => {
              const mapped = this.trackAndRemapUpdate(pooled, update, turnTools)
              input.onUpdate?.(mapped)
            },
            signal: input.signal,
            requestPermission: onPermission,
          })
          .then((result) => {
            this.recordUnfinishedTools(pooled, turnTools, result.stopReason)
            return result
          })
          .finally(() => {
            pooled.active = Math.max(0, pooled.active - 1)
          })
        // `prompt` has already written the request, so the agent sees the cancel
        // after the prompt it belongs to.
        if (key && this.startCancels.delete(key)) {
          pooled.client.cancelTurn(pooled.sessionId, this)
          this.log("debug", `cancelled ACP session ${pooled.sessionId} for a steer that arrived while it was starting`)
        }
        return turn
      })
      pooled.queue = run.catch(() => {})
      void run.then(
        () => {
          pooled.failures = 0
        },
        (error: unknown) => this.onTurnFailed(poolKey, pooled, error),
      ).finally(() => {
        pooled.pending = Math.max(0, pooled.pending - 1)
        pooled.lastUsed = Date.now()
      })
      return await run
    } finally {
      finishStarting()
      if (key && !this.starting.has(key)) this.startCancels.delete(key)
    }
  }

  private onTurnFailed(poolKey: string, pooled: PooledSession, error: unknown) {
    // A failed turn does not necessarily invalidate the ACP session. The
    // process dying or the agent forgetting the session does; everything else
    // (cancel, timeout, reset) keeps the context, so a retry resumes the same
    // conversation instead of starting a new one.
    if (this.pools.get(poolKey) !== pooled) return
    const message = errorMessage(error)
    const unknown = isUnknownSession(error)
    if (unknown || !pooled.client.alive || !pooled.client.hasSession(pooled.sessionId, this)) {
      void this.dropPool(poolKey, pooled)
      if (unknown) void this.forgetSession(poolKey)
      return
    }
    pooled.failures += 1
    if (isAcpError(error) && error.code === ACP_REQUEST_CANCELLED) {
      // A stopped turn is normal; the agent already ended it, so the session
      // is intact and the next prompt picks up the same conversation.
      pooled.failures = 0
      this.log("debug", `kept ACP session ${pooled.sessionId} after a cancelled turn`)
      return
    }
    if (pooled.failures >= MAX_TURN_FAILURES) {
      this.log("warn", `dropping ACP session ${pooled.sessionId} after ${pooled.failures} failed turns: ${message}`)
      void this.dropPool(poolKey, pooled)
      // A session that failed this many times in a row should not be restored
      // into the same state on the next turn.
      void this.forgetSession(poolKey)
      return
    }
    // Ask the agent to end whatever it is still running so the queued or next
    // prompt enters the same context at a clean boundary.
    pooled.client.cancelTurn(pooled.sessionId, this)
    this.log("debug", `keeping ACP session ${pooled.sessionId} after a failed turn: ${message}`)
  }

  /** Drop a pooled session on our side, leaving its stored id unless callers forget it. */
  private async dropPool(poolKey: string, pooled: PooledSession) {
    pooled.broken = true
    if (this.pools.get(poolKey) === pooled) this.pools.delete(poolKey)
    const turns = new Set(pooled.pendingContinuations.values())
    if (pooled.activeUnsolicited) turns.add(pooled.activeUnsolicited)
    pooled.pendingContinuations.clear()
    pooled.activeUnsolicited = undefined
    pooled.activeUnsolicitedTools = undefined
    pooled.backgroundTools.clear()
    const error = new Error(`ACP session ${pooled.sessionId} was closed`)
    for (const turn of turns) turn.fail(error)
    pooled.mcpRelease?.()
    await pooled.client.closeSession(pooled.sessionId, this).catch(() => {})
  }

  /** Whether an unattached or active continuation exists for this OpenCode session and token. */
  hasContinuation(sessionKey: string, token: string): boolean {
    return [...this.pools.values()].some(
      (pooled) => pooled.key === sessionKey && !pooled.broken && pooled.pendingContinuations.has(token),
    )
  }

  /** Find an unattached continuation token matching a synthetic wake-up message's text. */
  findContinuationByText(sessionKey: string, promptText: string): string | undefined {
    for (const pooled of this.pools.values()) {
      if (pooled.key !== sessionKey || pooled.broken) continue
      for (const turn of pooled.pendingContinuations.values()) {
        if (!turn.attached && turn.text === promptText) return turn.token
      }
    }
    return undefined
  }

  /** Cancel and discard a pending continuation whose OpenCode wake-up could not proceed. */
  dropContinuation(sessionKey: string, token: string): void {
    for (const pooled of this.pools.values()) {
      if (pooled.key !== sessionKey) continue
      const turn = pooled.pendingContinuations.get(token)
      if (!turn) continue
      pooled.pendingContinuations.delete(token)
      if (pooled.activeUnsolicited === turn) {
        pooled.activeUnsolicited = undefined
        pooled.activeUnsolicitedTools = undefined
      }
      turn.dispose()
      return
    }
  }

  private sessionCallbacks(
    state: AcpServerState,
    poolKey: string,
    sessionKey: string,
    sessionIdRef: { id: string },
  ) {
    return {
      onUnsolicitedUpdate: (update: SessionUpdate) => {
        const pooled = this.pools.get(poolKey)
        if (!pooled || pooled.broken || pooled.sessionId !== sessionIdRef.id) return
        this.handleUnsolicitedUpdate(state, pooled, update)
      },
      requestPermission: this.permissionHandler(state.config.id, sessionKey),
      onPermissionChange: (delta: 1 | -1) => {
        const pooled = this.pools.get(poolKey)
        const active = pooled?.activeUnsolicited
        if (!active || pooled.sessionId !== sessionIdRef.id) return
        if (delta === 1) active.permissionStarted()
        else active.permissionEnded()
      },
    }
  }

  private trackAndRemapUpdate(
    pooled: PooledSession,
    update: SessionUpdate,
    turnTools: Map<string, TurnToolRecord>,
  ): SessionUpdate {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return update
    const rawId = text(update.toolCallId)
    if (!rawId) return update

    const status = text(update.status)
    const terminal = status === "completed" || status === "failed"
    const incomingRaw = record(update.rawInput)
    const hasIncomingRaw = incomingRaw !== undefined && Object.keys(incomingRaw).length > 0
    const name = text(update.name)
    const title = text(update.title)
    const kind = text(update.kind)
    const meta = record(update._meta)
    const command = commandOf(incomingRaw?.CommandLine ?? incomingRaw?.command)

    const background = pooled.backgroundTools.get(rawId)
    if (background) {
      const mergedRaw = hasIncomingRaw ? incomingRaw : background.rawInput
      const remapped: SessionUpdate = {
        ...update,
        toolCallId: `${rawId}:result`,
        ...(!name && background.name ? { name: background.name } : {}),
        ...(!title && background.title ? { title: background.title } : {}),
        ...(!kind && background.kind ? { kind: background.kind } : {}),
        ...(!meta && background.meta ? { _meta: background.meta } : {}),
        ...(mergedRaw ? { rawInput: mergedRaw } : {}),
      }
      if (terminal) pooled.backgroundTools.delete(rawId)
      return remapped
    }

    const prior = turnTools.get(rawId)
    turnTools.set(rawId, {
      name: name ?? prior?.name,
      title: title ?? prior?.title,
      kind: kind ?? prior?.kind,
      meta: meta ?? prior?.meta,
      command: command ?? prior?.command,
      rawInput: hasIncomingRaw ? incomingRaw : prior?.rawInput,
      terminal: terminal || Boolean(prior?.terminal),
    })
    return update
  }

  private recordUnfinishedTools(
    pooled: PooledSession,
    turnTools: Map<string, TurnToolRecord>,
    stopReason: string,
  ) {
    if (stopReason === "cancelled") return
    for (const [id, info] of turnTools) {
      if (info.terminal) {
        pooled.backgroundTools.delete(id)
        continue
      }
      if (pooled.backgroundTools.has(id)) pooled.backgroundTools.delete(id)
      while (pooled.backgroundTools.size >= MAX_BACKGROUND_TOOLS) {
        const oldest = pooled.backgroundTools.keys().next().value
        if (oldest === undefined) break
        pooled.backgroundTools.delete(oldest)
      }
      pooled.backgroundTools.set(id, {
        name: info.name,
        title: info.title,
        command: info.command,
        rawInput: info.rawInput,
        kind: info.kind,
        meta: info.meta,
      })
    }
  }

  private handleUnsolicitedUpdate(state: AcpServerState, pooled: PooledSession, update: SessionUpdate) {
    if (this.disposed || pooled.broken) return

    if (pooled.activeUnsolicited && pooled.activeUnsolicitedTools) {
      pooled.lastUsed = Date.now()
      const mapped = this.trackAndRemapUpdate(pooled, update, pooled.activeUnsolicitedTools)
      pooled.activeUnsolicited.push(mapped)
      return
    }

    if (!isUnsolicitedActivity(update)) return

    const rawId = text(update.toolCallId)
    const background = rawId ? pooled.backgroundTools.get(rawId) : undefined
    const { description, text: summaryText } = unsolicitedSummary(update, background, agentName(state.config))
    const turnTools = new Map<string, TurnToolRecord>()
    const turn = new UnsolicitedTurn({
      description,
      text: summaryText,
      timing: { maxTurnMs: this.promptTimeoutMs, ...this.unsolicitedTiming },
      onSettled: (result) => {
        if (pooled.activeUnsolicited === turn) {
          pooled.activeUnsolicited = undefined
          pooled.activeUnsolicitedTools = undefined
        }
        this.recordUnfinishedTools(pooled, turnTools, result.stopReason)
        pooled.lastUsed = Date.now()
      },
      onExpire: () => {
        if (pooled.pendingContinuations.get(turn.token) === turn) {
          pooled.pendingContinuations.delete(turn.token)
        }
      },
    })

    pooled.activeUnsolicited = turn
    pooled.activeUnsolicitedTools = turnTools
    pooled.pendingContinuations.set(turn.token, turn)
    pooled.lastUsed = Date.now()

    turn.push(this.trackAndRemapUpdate(pooled, update, turnTools))
    this.onUnsolicited?.({
      server: state.config.id,
      sessionKey: pooled.key,
      token: turn.token,
      description: turn.description,
      text: turn.text,
    })
  }

  /**
   * Whether an ACP turn is streaming for this OpenCode session right now.
   * A turn still negotiating its ACP session counts too: a message sent in that
   * window has to be steered even though no prompt is in flight yet.
   */
  running(key: string) {
    if (this.starting.has(key)) return true
    return [...this.pools.values()].some((entry) => entry.key === key && entry.active > 0 && !entry.broken)
  }

  /** End the current ACP turn so OpenCode can deliver its queued steer next. */
  interrupt(key: string) {
    const pooled = [...this.pools.values()]
      .filter((entry) => entry.key === key && entry.active > 0 && !entry.broken)
      .sort((left, right) => right.lastUsed - left.lastUsed)[0]
    if (!pooled) {
      if (this.starting.has(key)) this.startCancels.add(key)
      return
    }

    pooled.client.cancelTurn(pooled.sessionId, this)
    if (pooled.activeUnsolicited?.attached) pooled.activeUnsolicited.cancel()
    this.log("debug", `interrupted ACP session ${pooled.sessionId} so the queued message can be delivered`)
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
        owner: this,
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

  private reserveCapacity(): Promise<void> | undefined {
    let reserved = this.pools.size
    for (const key of this.negotiating.keys()) if (!this.pools.has(key)) reserved++
    if (reserved < this.maxSessions) return
    let oldest: [string, PooledSession] | undefined
    for (const entry of this.pools) {
      const [key, pooled] = entry
      if (
        pooled.pending > 0 ||
        this.negotiating.has(key) ||
        pooled.activeUnsolicited !== undefined ||
        pooled.pendingContinuations.size > 0
      ) {
        continue
      }
      if (!oldest || pooled.lastUsed < oldest[1].lastUsed) oldest = entry
    }
    if (!oldest) throw new Error(`ACP session pool at capacity (${this.maxSessions}); retry after a turn finishes`)
    this.log("debug", `evicting idle ACP session ${oldest[1].sessionId} (capacity ${this.maxSessions})`)
    return this.dropPool(...oldest)
  }

  private sweepIdleSessions() {
    const cutoff = Date.now() - this.sessionIdleMs
    for (const [key, pooled] of this.pools) {
      if (
        pooled.pending > 0 ||
        this.negotiating.has(key) ||
        pooled.lastUsed > cutoff ||
        pooled.activeUnsolicited !== undefined ||
        pooled.pendingContinuations.size > 0
      ) {
        continue
      }
      void this.dropPool(key, pooled)
      this.log("debug", `closed idle ACP session ${pooled.sessionId} after ${this.sessionIdleMs}ms`)
    }
  }

  private async closePoolsFor(server: string) {
    const prefix = `${server}\u0000`
    const closed: Array<Promise<unknown>> = []
    for (const [key, pooled] of this.pools) {
      if (key.startsWith(prefix)) closed.push(this.dropPool(key, pooled))
    }

    await Promise.allSettled(closed)
  }

  async stop() {
    this.disposed = true
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = undefined
    this.preparing.clear()
    this.negotiating.clear()
    for (const server of this.catalogs.keys()) this.forgetCatalog(server)
    const pools = [...this.pools.values()]
    this.pools.clear()
    // Best effort: the agent may be shared with another directory, so do not
    // wait on a close handshake that could hang shutdown. Closing drops the
    // session from the client, so its owner loop below can no longer see it:
    // end the turn here, or a shared agent would keep running one nobody reads.
    for (const pooled of pools) {
      pooled.broken = true
      const turns = new Set(pooled.pendingContinuations.values())
      if (pooled.activeUnsolicited) turns.add(pooled.activeUnsolicited)
      pooled.pendingContinuations.clear()
      pooled.activeUnsolicited = undefined
      pooled.activeUnsolicitedTools = undefined
      pooled.backgroundTools.clear()
      for (const turn of turns) turn.dispose()
      pooled.mcpRelease?.()
      pooled.client.cancelTurn(pooled.sessionId, this)
      void pooled.client.closeSession(pooled.sessionId, this).catch(() => {})
    }
    // Only this manager's sessions close; another directory's stay on the client.
    for (const lease of this.leases.values()) {
      for (const sessionId of lease.client.sessionsOwnedBy(this)) {
        lease.client.cancelTurn(sessionId, this)
        void lease.client.closeSession(sessionId, this).catch(() => {})
      }
    }
    for (const lease of this.leases.values()) lease.release()
    this.leases.clear()
    for (const state of this.servers.values()) state.client = undefined
    if (this.ownsAgents) await this.agents.stop()
  }
}

function isUnknownSession(error: unknown) {
  if (!isAcpError(error)) return false
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
