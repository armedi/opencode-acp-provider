import { Model, Plugin, Provider } from "@opencode/plugin"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { AcpServerManager, type AcpServerConfig, type AcpServerState } from "./server-manager.ts"
import { createShim } from "./shim.ts"
import { createAcpLanguageModel } from "./language-model.ts"
import { createMcpServer } from "./mcp-server.ts"
import { createSkillMirror } from "./skills.ts"
import { debugLog } from "./debug.ts"

type LogLevel = "debug" | "info" | "warn" | "error"

interface AcpPluginOptions {
  servers?: AcpServerConfig[]
  includeSystem?: boolean
  logLevel?: LogLevel
  /** Answer OpenCode's session-title requests without spending an ACP turn. Defaults to true. */
  localTitles?: boolean
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

interface LocalService {
  url: string
  password: string
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
  id: "acp.client",
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
        skills = await createSkillMirror(ctx, { include: skillFilter, log })
        if (!skills.count) {
          await skills.close()
          skills = undefined
        }
      } catch (error) {
        log("warn", `OpenCode skills mirror disabled: ${error instanceof Error ? error.message : String(error)}`)
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
          version: "0.5.0",
        })
      } catch (error) {
        log("warn", `OpenCode MCP bridge disabled: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const manager = new AcpServerManager({
      servers,
      defaultCwd: ctx.location.directory,
      log,
      mcp: mcp ? { servers: (sessionKey) => mcp!.issue(sessionKey) } : undefined,
      additionalDirectories: skills ? [skills.root] : undefined,
      cmdSkillDir: skills?.agentsDir,
      cmdSkillMod: skills?.modPath,
      initTimeoutMs: options.initTimeoutMs,
      requestTimeoutMs: options.requestTimeoutMs,
      maxSessions: options.maxSessions,
      sessionIdleMs: options.sessionIdleMs,
      allowPathsOutsideCwd: options.allowPathsOutsideCwd === true,
      maxFileBytes: options.maxFileBytes,
      promptTimeoutMs: options.promptTimeoutMs,
      resolveCredential: async (integrationID) => {
        const connection = await ctx.integration.connection.active(integrationID)
        if (!connection) return undefined
        const credential = await ctx.integration.connection.resolve(connection)
        if (!credential) return undefined
        if (credential.type === "key") return credential.key
        if (credential.type === "oauth") return credential.access
        return undefined
      },
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

    let disposed = false
    const retryTimers = new Set<ReturnType<typeof setTimeout>>()
    const registrations: Awaited<ReturnType<typeof ctx.provider.transform>>[] = []
    const registered = new Set<string>()
    const providerIDs = new Map<string, string>()

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

    const registerProvider = async (state: AcpServerState, refresh = false) => {
      if (registered.has(state.config.id)) return true
      if (!state.models.length) return false
      const providerID = Provider.ID.make(providerIDForServer(state.config.id))
      const effortLevels = [...new Set(state.efforts.filter((effort) => effort !== "default" && effort.trim()))]
      const variants = effortLevels.map((effort) => ({
        id: Model.VariantID.make(effort),
        settings: { reasoningEffort: effort },
      }))
      const models: Model.Info[] = state.models.map((model) => ({
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
        variants,
        // The agent keeps the conversation in its reused ACP session and
        // compacts it itself. A known window would let OpenCode auto-compact,
        // which only spends a turn on a summary the agent never reads. OpenCode
        // treats 0 as an unknown window and never auto-compacts it.
        limit: { context: 0, output: outputLimit },
        // Pricing is reported by the ACP agent, not known here. An empty cost
        // list means "unknown" and avoids OpenCode's zero-cost "Free" badge.
        cost: [],
      }))

      registrations.push(
        await ctx.provider.transform((editor) => {
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
            models,
          })
        }),
      )
      registered.add(state.config.id)
      if (refresh) await ctx.provider.reload().catch(() => {})
      return true
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
            if (await registerProvider(state, true)) {
              log("info", `ACP server "${state.config.id}" registered after retry`)
              return
            }
            scheduleRetry(state, attempt + 1)
          } catch (error) {
            log(
              "warn",
              `ACP server "${state.config.id}" retry failed: ${error instanceof Error ? error.message : String(error)}`,
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
        localTitles: options.localTitles !== false,
        toolCallDisplay: options.toolCallDisplay,
        historyTurns: options.historyTurns,
        historyChars: options.historyChars,
        maxBodyBytes: options.maxBodyBytes,
        debugEnabled,
        log,
      })
    } catch (error) {
      await manager.stop().catch(() => {})
      await mcp?.close().catch(() => {})
      await skills?.close().catch(() => {})
      throw error
    }

    const cleanup = async () => {
      disposed = true
      for (const timer of retryTimers) clearTimeout(timer)
      retryTimers.clear()
      for (const registration of registrations) await registration.dispose().catch(() => {})
      // Close the shim first so a late request cannot start an agent while the
      // manager is shutting down.
      await shim.close().catch(() => {})
      await manager.stop().catch(() => {})
      await skills?.close().catch(() => {})
      await mcp?.close().catch(() => {})
    }

    try {
      // Reserve provider ids in configuration order so a server that succeeds
      // late cannot steal the id of one that already registered.
      for (const state of manager.list) providerIDForServer(state.config.id)

      await manager.initialize()

      for (const state of manager.list) {
        if (await registerProvider(state)) continue
        if (state.retryable === false) {
          log("error", `ACP server "${state.config.id}" cannot be registered: ${state.error ?? "no models available"}`)
          continue
        }
        log("warn", `deferring provider for ACP server "${state.config.id}": no models available yet`)
        scheduleRetry(state, 0)
      }

      // Supply the ACP language model to OpenCode's AI SDK layer. Tool calls the
      // agent runs itself come back as provider-executed parts, so the session
      // shows the real shell/read/edit card without routing the tool.
      const acpProviderIDs = new Set(providerIDs.values())
      if (nativeToolParts) {
        registrations.push(
          await ctx.aisdk.hook("sdk", (evt) => {
            if (evt.package !== "acp") return
            if (!acpProviderIDs.has(evt.model.providerID as string)) return
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
                }),
            }
          }),
        )
      }

      log("info", `registered ${registered.size} ACP provider(s) in ${Date.now() - setupStartedAt}ms`)
      return cleanup
    } catch (error) {
      await cleanup()
      throw error
    }
  },
})
