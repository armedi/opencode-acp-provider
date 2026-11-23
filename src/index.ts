import { Model, Plugin, Provider } from "@opencode/plugin"
import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  AcpServerManager,
  type AcpCompactResult,
  type AcpModelInfo,
  type AcpServerConfig,
  type AcpServerState,
  type AcpSessionStore,
  type AcpUnsolicitedTurnInfo,
} from "./server-manager.ts"
import { sharedAgentPool } from "./agent-pool.ts"
import { createShim } from "./shim.ts"
import { boundedMessages, historyLimits, recentConversation, textOf } from "./prompt.ts"
import { createAcpLanguageModel } from "./language-model.ts"
import { createMcpServer } from "./mcp-server.ts"
import { createBackgroundHold } from "./background-hold.ts"
import { createSteering, type LocalService } from "./steering.ts"
import { createSkillMirror } from "./skills.ts"
import { createCommandBridge } from "./commands.ts"
import { effortLevels, readInventory, writeInventory, type AcpInventory } from "./inventory.ts"
import { debugLog } from "./debug.ts"
import { agentName, errorMessage } from "./util.ts"

type LogLevel = "debug" | "info" | "warn" | "error"

/** What a compaction did, in the agent's own words where it gave any. */
function compactionOutcome(agent: string, result: AcpCompactResult) {
  if (result.status === "no-session") return `${agent} has no open session for this conversation, so nothing was compacted.`
  if (result.status === "unsupported")
    return `${agent} can't compact on request. It compacts its own context when it fills up, so nothing was compacted.`
  const sizes = result.tokens
    ? ` from ${result.tokens.before.toLocaleString("en-US")} to ${result.tokens.after.toLocaleString("en-US")} tokens`
    : ""
  const said = result.text ? `\n\n${agent}: ${result.text}` : ""
  return `${agent} ran its own /compact${sizes}.${said}`
}

interface AcpPluginOptions {
  servers?: AcpServerConfig[]
  includeSystem?: boolean
  logLevel?: LogLevel
  /** Turns of history replayed into a brand new ACP session. Defaults to 16. */
  historyTurns?: number
  /** Characters of history replayed into a brand new ACP session. Defaults to 8192. */
  historyChars?: number
  /** Most reused ACP sessions kept alive per plugin instance. Defaults to 32. */
  maxSessions?: number
  /** Idle time before a reusable ACP session is closed. Defaults to 30 minutes. */
  sessionIdleMs?: number
  /** Let ACP agents read and write outside the session directory. Defaults to false. */
  allowPathsOutsideCwd?: boolean
  /** Largest file the ACP client will read on the agent's behalf. Defaults to 16 MB. */
  maxFileBytes?: number
  /** Largest chat-completions body accepted by the shim. Defaults to 32 MB. */
  maxBodyBytes?: number
  /** Output limit advertised for ACP models. Defaults to 32000. */
  outputLimit?: number
  /** How long to wait for one agent to initialize. Defaults to 20 seconds. */
  initTimeoutMs?: number
  /** Timeout for ACP handshake and control calls such as `session/new`. Defaults to 15 seconds. */
  requestTimeoutMs?: number
  /** How long one ACP turn may run. Defaults to 30 minutes. */
  promptTimeoutMs?: number
  /** Show ACP tool calls as inline transcript lines when the server cannot render native tool cards. Defaults to "inline"; "off" hides them. */
  toolCallDisplay?: "off" | "inline"
  /** Expose OpenCode tools to ACP agents through an MCP bridge. Defaults to true. */
  mcp?: boolean
  /** Expose the agents' own slash commands as namespaced OpenCode commands. Defaults to true. */
  commands?: boolean
  /** Make OpenCode's skills available to ACP agents through their own discovery. `false` disables it; an array is an allowlist of skill IDs. Defaults to true. */
  skills?: boolean | string[]
  /** MCP transport handed to ACP agents. Defaults to "stdio". */
  mcpTransport?: "stdio" | "http"
  /** Runtime that can execute a JavaScript file for the stdio bridge, e.g. "node". */
  mcpRuntime?: string
}

const RETRY_DELAYS = [2_000, 5_000, 15_000, 30_000, 60_000]

function providerIDFor(id: string) {
  return `acp-${id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "server"}`
}

/** Storage key for one pooled ACP session; the manager's key is an opaque tuple. */
function storedSessionKey(poolKey: string) {
  return `acp-session/${createHash("sha256").update(poolKey).digest("hex")}`
}

/**
 * Resolve an ACP continuation token when OpenCode is running a turn prompted by
 * a background-completion synthetic message rather than a new user prompt.
 * A wake queued behind another pending message is left for a normal prompt, so
 * only a lone user message at the turn boundary can attach a continuation.
 */
function continuationTokenOf(
  messages: ReadonlyArray<{
    role: string
    content?: string | ReadonlyArray<{ type?: string; text?: unknown }>
    metadata?: Record<string, unknown>
  }>,
  sessionID: string,
  manager: Pick<AcpServerManager, "findContinuationByText">,
): string | undefined {
  let pending: (typeof messages)[number] | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    if (message.role === "assistant" || message.role === "tool") break
    if (message.role !== "user") continue
    if (!textOf(message).trim()) continue
    // More than one pending message means the turn is not only the wake.
    if (pending) return undefined
    pending = message
  }
  if (!pending) return undefined
  const token = pending.metadata?.source === "acp-background" ? pending.metadata.acpContinuation : undefined
  if (typeof token === "string" && token) return token
  return sessionID ? manager.findContinuationByText(sessionID, textOf(pending)) : undefined
}


/**
 * A `serve --service` server records its address and password next to its
 * state, with the owning pid. Match that pid so the MCP question tool can use
 * the HTTP API of the server that is hosting this plugin. Default CLI servers
 * do not write the file, and the builtin question tool is used instead.
 */
async function readLocalService(): Promise<LocalService | undefined> {
  const candidates = new Set<string>()
  const home = homedir()
  if (process.env.OPENCODE_STATE_HOME) candidates.add(process.env.OPENCODE_STATE_HOME)
  if (process.env.XDG_STATE_HOME) candidates.add(join(process.env.XDG_STATE_HOME, "opencode"))
  candidates.add(join(home, ".local", "state", "opencode"))
  candidates.add(join(home, "Library", "Application Support", "opencode"))
  if (process.env.APPDATA) candidates.add(join(process.env.APPDATA, "opencode"))
  if (process.env.LOCALAPPDATA) candidates.add(join(process.env.LOCALAPPDATA, "opencode"))

  for (const directory of candidates) {
    try {
      const raw = await readFile(join(directory, "service.json"), "utf8")
      const data = JSON.parse(raw) as { pid?: number; url?: unknown; password?: unknown }
      if (data.pid !== process.pid) continue
      if (typeof data.url !== "string" || typeof data.password !== "string") continue
      return { url: data.url, password: data.password }
    } catch {
      // no matching service file here
    }
  }
  return undefined
}

export default Plugin.define({
  id: "acp-provider",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as AcpPluginOptions
    const servers = Array.isArray(options.servers) ? options.servers : []
    if (!servers.length) return

    const levels: LogLevel[] = ["debug", "info", "warn", "error"]
    const minLevel =
      options.logLevel && levels.includes(options.logLevel) ? levels.indexOf(options.logLevel) : 1
    const debugEnabled = levels.indexOf("debug") >= minLevel
    const log = (level: LogLevel, message: string) => {
      if (levels.indexOf(level) < minLevel) return
      debugLog(level, message)
      const write = level === "error" ? console.error : console.log
      write(`[acp] ${level}: ${message}`)
    }
    debugLog("info", "setup started")
    const setupStartedAt = Date.now()

    // Servers with the AI SDK hook can show the agent's own tools as native
    // cards; older servers fall back to the chat-completions route and the
    // inline transcript markers.
    const nativeToolParts = typeof ctx.aisdk?.hook === "function"

    let skills: Awaited<ReturnType<typeof createSkillMirror>> | undefined
    const skillFilter = Array.isArray(options.skills) ? options.skills : undefined
    const skillsEnabled = options.skills !== false && skillFilter?.length !== 0
    if (skillsEnabled && servers.some((server) => server.skills !== false)) {
      try {
        // Kept even when empty: OpenCode discovers skills in the background,
        // and the mirror picks them up on `skill.updated`.
        skills = await createSkillMirror(ctx, { include: skillFilter, log })
      } catch (error) {
        log("warn", `OpenCode skills mirror disabled: ${errorMessage(error)}`)
      }
    }

    let mcp: Awaited<ReturnType<typeof createMcpServer>> | undefined
    if (options.mcp !== false) {
      try {
        mcp = await createMcpServer({
          ctx,
          log,
          localService: () => readLocalService(),
          transport: options.mcpTransport === "http" ? "http" : "stdio",
          runtime: options.mcpRuntime,
        })
      } catch (error) {
        log("warn", `OpenCode MCP bridge disabled: ${errorMessage(error)}`)
      }
    }

    // A plugin reload or a crashed agent starts a new process with no in-memory
    // sessions. Persist which ACP session belongs to each OpenCode session so
    // the next process can resume it instead of losing the conversation.
    const sessionStore: AcpSessionStore | undefined = ctx.storage
      ? {
          async get(key) {
            const value = await ctx.storage.get(storedSessionKey(key))
            return typeof value === "string" && value ? value : undefined
          },
          async set(key, sessionId) {
            await ctx.storage.set(storedSessionKey(key), sessionId)
          },
          async delete(key) {
            await ctx.storage.remove(storedSessionKey(key))
          },
        }
      : undefined

    // Assigned once the agents are up and their skills are known, but the
    // manager reports command updates from the first `session/new` onward.
    let commandBridge: Awaited<ReturnType<typeof createCommandBridge>> | undefined
    const continuations = new Map<string, string>()
    let disposed = false
    let manager: AcpServerManager
    let serverForProvider = new Map<string, string>()

    const wakeSessionForUnsolicited = async (turn: AcpUnsolicitedTurnInfo) => {
      if (disposed || typeof ctx.session?.synthetic !== "function") {
        manager.dropContinuation(turn.sessionKey, turn.token)
        return
      }
      try {
        if (typeof ctx.session.get === "function") {
          const session = await ctx.session.get({ sessionID: turn.sessionKey as any }).catch(() => undefined)
          const providerID = session?.model?.providerID
          if (providerID && serverForProvider.get(providerID) !== turn.server) {
            log(
              "debug",
              `skipping ACP background wake for ${turn.sessionKey}: session switched to provider ${providerID}`,
            )
            manager.dropContinuation(turn.sessionKey, turn.token)
            return
          }
        }
        await ctx.session.synthetic({
          sessionID: turn.sessionKey as any,
          text: turn.text,
          description: turn.description,
          metadata: {
            source: "acp-background",
            server: turn.server,
            acpContinuation: turn.token,
          },
          delivery: "queue",
          resume: true,
        })
      } catch (error) {
        log("warn", `could not wake OpenCode session ${turn.sessionKey} for ACP background task: ${errorMessage(error)}`)
        manager.dropContinuation(turn.sessionKey, turn.token)
      }
    }

    manager = new AcpServerManager({
      servers,
      defaultCwd: ctx.location.directory,
      log,
      sessions: sessionStore,
      agents: sharedAgentPool(),
      discoverCommands: options.commands !== false,
      onCommands: (server) => void commandBridge?.sync(server),
      // A model's effort levels are learned when it is first selected; refresh its variants.
      onModels: (server) => {
        const state = manager.get(server)
        if (!state || disposed || !registered.has(server)) return
        void publishInventory(state).then(() => persistInventory(state))
      },
      onUnsolicited: (turn) => {
        if (!disposed) void wakeSessionForUnsolicited(turn)
      },
      mcp: mcp
        ? {
            servers: async (sessionKey) => mcp.issue(sessionKey),
          }
        : undefined,
      additionalDirectories: skills ? [skills.root] : undefined,
      cmdSkillDir: skills?.agentsDir,
      cmdOrchestration: mcp !== undefined,
      initTimeoutMs: options.initTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      maxSessions: options.maxSessions,
      sessionIdleMs: options.sessionIdleMs,
      allowPathsOutsideCwd: options.allowPathsOutsideCwd === true,
      maxFileBytes: options.maxFileBytes,
      promptTimeoutMs: options.promptTimeoutMs,
      // Only consulted when a server sets `autoApprove: false`.
      requestPermission: async (input) => {
        const sessionID = input.sessionKey as Parameters<typeof ctx.permission.assert>[0]["sessionID"]
        await ctx.permission.assert({
          sessionID,
          action: "acp_tool",
          resources: [input.title],
          metadata: {
            server: input.server,
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.detail ? { detail: input.detail } : {}),
          },
        })
        return true
      },
    })

    const outputLimit = options.outputLimit ?? 32_000
    const shimToken = randomUUID()

    const retryTimers = new Set<ReturnType<typeof setTimeout>>()
    const registrations: Awaited<ReturnType<typeof ctx.provider.transform>>[] = []
    const registered = new Set<string>()
    const providerIDs = new Map<string, string>()
    /** The inventory a registered provider currently exposes, keyed by server id. */
    const inventories = new Map<string, AcpInventory>()

    const providerIDForServer = (serverID: string) => {
      const existing = providerIDs.get(serverID)
      if (existing) return existing
      const base = providerIDFor(serverID)
      const used = new Set(providerIDs.values())
      let id = base
      let suffix = 2
      while (used.has(id)) id = `${base}-${suffix++}`
      providerIDs.set(serverID, id)
      return id
    }

    const providerModels = (state: AcpServerState, providerID: ReturnType<typeof Provider.ID.make>, inventory: AcpInventory) => {
      // Efforts can differ per model, and a model may offer none at all.
      const variantsFor = (model: AcpModelInfo) =>
        effortLevels(model.efforts ?? inventory.efforts).map((effort) => ({
          id: Model.VariantID.make(effort),
          settings: { reasoningEffort: effort },
        }))
      return inventory.models.map((model) => ({
        ...Model.Info.default(providerID, Model.ID.make(model.id)),
        modelID: Model.ID.make(`${state.config.id}::${model.id}`),
        // Codex advertises names such as "6.1 Sol"; keep the GPT branding in
        // OpenCode's picker without changing the wire model id.
        name: /^gpt-/i.test(model.id) && /^[0-9]/.test(model.name) ? `GPT-${model.name}` : model.name,
        status: "active" as const,
        enabled: true,
        capabilities: {
          tools: false,
          input: ["text"],
          output: ["text"],
          temperature: false,
        },
        variants: variantsFor(model),
        // The agent keeps the conversation in its reused ACP session and
        // compacts it itself. A known window would let OpenCode auto-compact,
        // which only spends a turn on a summary the agent never reads. OpenCode
        // treats 0 as an unknown window and never auto-compacts it.
        limit: { context: 0, output: outputLimit },
        // Pricing is reported by the ACP agent, not known here. An empty cost
        // list means "unknown" and avoids OpenCode's zero-cost "Free" badge.
        cost: [],
      })) as Model.Info[]
    }

    const registerProvider = async (state: AcpServerState) => {
      if (disposed) return false
      if (registered.has(state.config.id)) return true
      if (!inventories.get(state.config.id)?.models.length) return false
      const providerID = Provider.ID.make(providerIDForServer(state.config.id))
      const registration = await ctx.provider.transform((editor) => {
        // Transforms replay on every rebuild, so read the current inventory
        // rather than capturing the one known when this registration was made.
        const inventory = inventories.get(state.config.id)
        if (!inventory?.models.length) return
        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            name: state.config.name ?? `${state.config.id} (ACP)`,
            activation: "enabled",
            // The AI SDK route lets the plugin supply the language model, so
            // ACP tool calls can surface as native OpenCode tool parts.
            package: nativeToolParts ? "aisdk:acp" : "@opencode/ai/providers/openai-compatible",
            compatibility: { reasoningField: "reasoning_content" },
            settings: { baseURL: shim.url, apiKey: shimToken },
          },
          models: providerModels(state, providerID, inventory),
        })
      })
      // The plugin can unload while OpenCode is registering this provider.
      if (disposed) {
        await registration.dispose().catch(() => {})
        return false
      }
      registrations.push(registration)
      registered.add(state.config.id)
      return true
    }

    const sameInventory = (left: AcpInventory | undefined, right: AcpInventory) => {
      if (!left) return false
      if (left.models.length !== right.models.length || left.efforts.length !== right.efforts.length) return false
      const modelsMatch = left.models.every((model, index) => {
        const other = right.models[index]
        return (
          other !== undefined &&
          model.id === other.id &&
          model.name === other.name &&
          model.description === other.description &&
          model.defaultEffort === other.defaultEffort &&
          (model.efforts ?? []).join("\u0000") === (other.efforts ?? []).join("\u0000") &&
          (model.efforts === undefined) === (other.efforts === undefined)
        )
      })
      return modelsMatch && left.efforts.every((effort, index) => effort === right.efforts[index])
    }

    /** Register or refresh a server's models from what discovery reported. */
    const publishInventory = async (state: AcpServerState) => {
      const id = state.config.id
      if (!state.models.length) return false
      const next: AcpInventory = { models: state.models, efforts: effortLevels(state.efforts) }
      const previous = inventories.get(id)
      inventories.set(id, next)
      if (!registered.has(id)) return registerProvider(state)
      if (sameInventory(previous, next)) return true
      try {
        await ctx.provider.reload()
      } catch (error) {
        log(
          "warn",
          `could not refresh models for ACP server "${id}": ${errorMessage(error)}`,
        )
      }
      return true
    }

    const persistInventory = async (state: AcpServerState) => {
      const inventory = inventories.get(state.config.id)
      if (!inventory) return
      try {
        await writeInventory(ctx.storage, state.config, inventory)
      } catch (error) {
        log(
          "debug",
          `could not cache models for ACP server "${state.config.id}": ${errorMessage(error)}`,
        )
      }
    }

    const scheduleRetry = (state: AcpServerState, attempt: number) => {
      if (attempt >= RETRY_DELAYS.length || disposed || state.retryable === false) return
      const timer = setTimeout(() => {
        retryTimers.delete(timer)
        void (async () => {
          if (disposed) return
          try {
            await manager.refresh(state)
            if (disposed) return
            if (state.models.length) {
              await publishInventory(state)
              await persistInventory(state)
              log("info", `ACP server "${state.config.id}" refreshed after retry`)
              return
            }
            scheduleRetry(state, attempt + 1)
          } catch (error) {
            if (disposed) return
            log(
              "warn",
              `ACP server "${state.config.id}" retry failed: ${errorMessage(error)}`,
            )
            scheduleRetry(state, attempt + 1)
          }
        })()
      }, RETRY_DELAYS[attempt])
      timer.unref?.()
      retryTimers.add(timer)
    }

    const resolveModel = (modelID: string) => {
      const separator = modelID.indexOf("::")
      if (separator < 0) return undefined
      const server = modelID.slice(0, separator)
      const model = modelID.slice(separator + 2)
      if (!manager.get(server)) return undefined
      return { server, model }
    }

    let shim: Awaited<ReturnType<typeof createShim>>
    try {
      shim = await createShim({
        manager,
        resolveModel,
        token: shimToken,
        includeSystem: options.includeSystem === true,
        toolCallDisplay: options.toolCallDisplay,
        historyTurns: options.historyTurns,
        historyChars: options.historyChars,
        maxBodyBytes: options.maxBodyBytes,
        debugEnabled,
        log,
        // A turn can run for as long as an ACP prompt is allowed to.
        drainTimeoutMs: options.promptTimeoutMs,
      })
    } catch (error) {
      await manager.stop().catch(() => {})
      await mcp?.close().catch(() => {})
      await skills?.close().catch(() => {})
      throw error
    }

    let backgroundHold: ReturnType<typeof createBackgroundHold> | undefined
    const cleanup = async () => {
      disposed = true
      backgroundHold?.dispose()
      continuations.clear()
      for (const timer of retryTimers) clearTimeout(timer)
      retryTimers.clear()
      for (const registration of registrations) await registration.dispose().catch(() => {})
      // A turn may still be streaming. Tearing down its connection here is what
      // OpenCode reports as ECONNRESET, so let the shim drain first. Do not
      // await it: a reload must stay responsive, and a shutdown does not need
      // to wait for the old turn either.
      void (async () => {
        await commandBridge?.close().catch(() => {})
        await shim.close().catch(() => {})
        await manager.stop().catch(() => {})
        await skills?.close().catch(() => {})
        await mcp?.close().catch(() => {})
      })()
    }

    try {
      // Reserve provider ids in configuration order so a server that succeeds
      // late cannot steal the id of one that already registered.
      for (const state of manager.list) providerIDForServer(state.config.id)
      // Every provider id is reserved above, so this reverse map is complete.
      serverForProvider = new Map([...providerIDs].map(([server, providerID]) => [providerID, server]))

      // A server whose models were discovered before, in another location or an
      // earlier process, is registered now, so this location resolves them
      // without waiting for its agent. Discovery still runs and refreshes the
      // list when it lands.
      await Promise.all(
        manager.list.map(async (state) => {
          const inventory = await readInventory(ctx.storage, state.config)
          if (inventory) inventories.set(state.config.id, inventory)
        }),
      )
      for (const state of manager.list) {
        if (await registerProvider(state)) {
          log("debug", `ACP server "${state.config.id}" registered from cached models`)
        }
      }

      // Expose the agents' own slash commands. Created before the agents start
      // so the first `available_commands_update` from each setup session is
      // recorded instead of dropped, and so the `skill.updated` event that
      // fires while they initialize is already being watched.
      if (options.commands !== false) {
        try {
          commandBridge = await createCommandBridge({
            ctx,
            manager,
            serverForProvider: (providerID) => serverForProvider.get(providerID),
            log,
          })
        } catch (error) {
          commandBridge = undefined
          log("warn", `ACP commands disabled: ${errorMessage(error)}`)
        }
      }

      // Supply the ACP language model to OpenCode's AI SDK layer. Tool calls the
      // agent runs itself come back as provider-executed parts, so the session
      // shows the real shell/read/edit card without routing the tool.

      // Auxiliary calls share the OpenCode session id, but must not write to
      // the ACP agent's conversation. Carry the typed request kind to the shim
      // through both the AI SDK and OpenAI-compatible provider routes.
      registrations.push(
        await ctx.session.hook("model.request", (event) => {
          if (!serverForProvider.has(event.model.providerID)) return
          event.headers["x-acp-request-kind"] = event.kind
          if (event.kind === "primary" && event.sessionID) {
            const token = continuations.get(event.sessionID)
            if (token) {
              continuations.delete(event.sessionID)
              event.headers["x-acp-continuation"] = token
            }
          }
        }),
      )
      const limits = historyLimits(options)
      // Detect background continuation turns on every route, and trim fallback
      // HTTP requests when the server cannot register an AI SDK provider.
      registrations.push(
        await ctx.session.hook("context", (event) => {
          if (!serverForProvider.has(event.model.providerID)) return
          if (event.sessionID) {
            const token = continuationTokenOf(event.messages, event.sessionID, manager)
            if (token) continuations.set(event.sessionID, token)
            else continuations.delete(event.sessionID)
          }
          if (!nativeToolParts) {
            const includeSystem = options.includeSystem === true
            if (!includeSystem) event.system = []
            const messages: typeof event.messages = []
            for (const { message, text } of boundedMessages(event.messages, limits, includeSystem)) {
              if (message.role !== "tool") messages.push({ ...message, content: [{ type: "text", text }] })
            }
            event.messages = messages
          }
        }),
      )
      if (nativeToolParts) {
        registrations.push(
          await ctx.aisdk.hook("sdk", (evt) => {
            if (evt.package !== "acp") return
            if (!serverForProvider.has(evt.model.providerID as string)) return
            const target = resolveModel(String(evt.model.modelID ?? ""))
            if (!target) return
            evt.sdk = {
              languageModel: () =>
                createAcpLanguageModel({
                  server: target.server,
                  model: target.model,
                  url: shim.url,
                  token: shimToken,
                  log,
                  includeSystem: options.includeSystem,
                  historyTurns: options.historyTurns,
                  historyChars: options.historyChars,
                }),
            }
          }),
        )
      } else {
        // The native HTTP provider serializes these messages itself. Trim
        // its model request before that happens, without changing the transcript.
        for (const kind of ["generate", "title"] as const) {
          registrations.push(await ctx.session.hook(kind, (event) => {
            if (!serverForProvider.has(event.model.providerID)) return
            const messages: typeof event.messages = []
            for (const { message, text } of boundedMessages(event.messages, limits, true)) {
              if (message.role !== "tool") messages.push({ ...message, content: [{ type: "text", text }] })
            }
            event.messages = messages
          }))
        }
      }

      // The agent holds the conversation in its reused ACP session, so an
      // OpenCode summary turn would cost a full prompt and never be read.
      // Compaction goes to the agent's own /compact instead, and the summary
      // keeps the recent conversation for a new ACP session to replay.
      registrations.push(
        await ctx.session.hook("compaction", async (evt) => {
          const server = serverForProvider.get(evt.model.providerID)

          const state = server ? manager.get(server) : undefined
          if (!server || !state) return
          const agent = agentName(state.config)
          let outcome: string
          try {
            const result = await manager.compact({ server, key: evt.sessionID })
            outcome = compactionOutcome(agent, result)
          } catch (error) {
            const message = errorMessage(error)
            log("warn", `ACP /compact failed for ${server}: ${message}`)
            outcome = `${agent} could not compact its context: ${message}`
          }
          const recent = recentConversation(evt.messages, limits)
          evt.result = { summary: recent ? `${outcome}\n\nRecent conversation:\n\n${recent}` : outcome }
        }),
      )

      // An ACP turn is one OpenCode step. Interrupt it on a steer and let the
      // host deliver the complete message at the next step boundary.
      const steer = createSteering({
        manager,
        localService: () => readLocalService(),
        directory: ctx.location.directory,
        log,
      })
      registrations.push(await ctx.session.hook("prompt", steer))

      // The session stays busy while its agent's background command runs, and
      // the command's wake-up continues that same execution.
      backgroundHold = createBackgroundHold({
        pending: (sessionID) => manager.pendingBackgroundWork(sessionID),
        owns: async (sessionID) => {
          if (typeof ctx.session.get !== "function") return true
          const session = await ctx.session.get({ sessionID: sessionID as any })
          return serverForProvider.has(session?.model?.providerID ?? "")
        },
        subscribe:
          typeof ctx.event?.subscribe === "function"
            ? (signal) =>
                ctx.event.subscribe({
                  types: ["session.inbox.enqueued", "session.execution.interrupted"],
                  signal,
                }) as AsyncIterable<{ type: string; data?: { sessionID?: unknown } }>
            : undefined,
        maxHoldMs: options.promptTimeoutMs,
      })
      const hold = backgroundHold
      registrations.push(await ctx.session.hook("experimental.idle", (event) => hold.idle(event)))

      // Hooks must be in place before models become selectable. Discovery then
      // runs in parallel without holding up OpenCode or neighboring providers.
      // A cached provider keeps its registration when an attempt fails; the
      // retry below refreshes it once the agent answers.
      void manager.initialize(async (state) => {
        try {
          if (state.models.length) {
            await publishInventory(state)
            await persistInventory(state)
            return
          }
          if (disposed) return
          if (registered.has(state.config.id)) {
            log(
              "warn",
              `ACP server "${state.config.id}" could not refresh its models: ${state.error ?? "no models available"}; keeping the cached list`,
            )
          } else if (state.retryable === false) {
            log("error", `ACP server "${state.config.id}" cannot be registered: ${state.error ?? "no models available"}`)
            return
          } else {
            log("warn", `deferring provider for ACP server "${state.config.id}": no models available yet`)
          }
        } catch (error) {
          if (disposed) return
          log("warn", `could not register ACP server "${state.config.id}": ${errorMessage(error)}`)
        }
        scheduleRetry(state, 0)
      }).then(() => {
        if (!disposed) log("info", `registered ${registered.size} ACP provider(s) in ${Date.now() - setupStartedAt}ms`)
      }).catch((error) => {
        if (!disposed) log("error", `ACP discovery failed: ${errorMessage(error)}`)
      })
      return cleanup
    } catch (error) {
      await cleanup()
      throw error
    }
  },
})
