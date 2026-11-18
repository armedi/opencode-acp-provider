import type { Mcp, Plugin } from "@opencode/plugin"
import type { AcpMcpServer } from "./acp-client.ts"
import type { AcpServerConfig, LogFn } from "./server-manager.ts"
import { executableName, isCmdCommand } from "./agent-command.ts"
import { errorMessage } from "./util.ts"

type Ctx = Plugin.Context
type ServerConfig = Mcp.ServerConfig

export interface OpenCodeMcpSource {
  /** Servers to add to an ACP `session/new`, read from the current config. */
  servers: (agent: AcpServerConfig) => Promise<AcpMcpServer[]>
  close: () => Promise<void>
}

interface OauthHint {
  /** How the agent is named in the warning. */
  label: string
  /** Commands that give it a grant; empty when its CLI is not recognized. */
  steps: string[]
}

/**
 * How one agent signs in to a remote MCP server, when its executable is
 * recognizable. Each CLI keys credentials by a server it already has in its own
 * config, so a login command alone fails with "no MCP server named ...": the
 * server has to be registered with the agent first.
 *
 * Syntax checked against `cmd`, `codex`, and `claude` (`mcp --help`).
 */
function oauthHint(agent: AcpServerConfig, name: string, url: string): OauthHint {
  const server = JSON.stringify(name)
  const target = JSON.stringify(url)
  if (isCmdCommand(agent.command))
    return {
      label: "Command Code",
      steps: [`cmd mcp add --transport http ${server} ${target}`, `cmd mcp auth ${server}`],
    }
  const executable = executableName(agent.command)
  if (executable.startsWith("codex"))
    return {
      label: "Codex",
      steps: [`codex mcp add ${server} --url ${target}`, `codex mcp login ${server}`],
    }
  if (executable.startsWith("claude"))
    return {
      label: "Claude Code",
      steps: [`claude mcp add --transport http ${server} ${target}`, `claude mcp login ${server}`],
    }
  return { label: executable || "the ACP agent", steps: [] }
}

/** How OpenCode records a remote server's sign-in, as reported by `mcp.list()`. */
interface McpAuth {
  /** Set while OpenCode has a credential for this server. */
  integrationID?: string
  /** OpenCode says the server is reachable but needs the user to sign in. */
  needsAuth: boolean
}

/**
 * OpenCode's own MCP servers, converted to the shape ACP accepts, so an agent
 * connects to exactly the servers OpenCode is configured with instead of a
 * second list maintained next to it.
 *
 * Only an MCP transform exposes the full configuration; `ctx.mcp.list()` reports
 * connection status and the integration holding a remote server's sign-in. The
 * transform only reads, and it is replayed whenever the registry is rebuilt,
 * which keeps the capture current for later sessions.
 */
export async function createOpenCodeMcpSource(ctx: Ctx, log: LogFn): Promise<OpenCodeMcpSource> {
  let configs: ReadonlyArray<readonly [string, ServerConfig]> = []
  const registration = await ctx.mcp.transform((editor) => {
    configs = editor.list()
  })

  let auth = new Map<string, McpAuth>()
  const warned = new Set<string>()
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return
    warned.add(key)
    log("warn", message)
  }
  let reading: Promise<void> | undefined
  /** Read each server's runtime status and sign-in integration from OpenCode. */
  const readAuth = () => {
    if (reading) return reading
    reading = (async () => {
      try {
        const listing = await ctx.mcp.list()
        auth = new Map(
          listing.data.map((server) => [
            server.name,
            {
              ...(server.integrationID ? { integrationID: server.integrationID } : {}),
              needsAuth: server.status.status === "needs_auth",
            },
          ]),
        )
      } catch (error) {
        warnOnce("mcp:auth", `could not read OpenCode's MCP authentication: ${errorMessage(error)}`)
      }
    })().finally(() => {
      reading = undefined
    })
    return reading
  }
  // A registry read replays the registered transforms, so this also captures the
  // configuration for plugin setups that read nothing else.
  await readAuth()

  const warnSignedIn = (agent: AcpServerConfig, name: string, url: string) => {
    const hint = oauthHint(agent, name, url)
    const own = hint.steps.length ? ` Or run ${hint.steps.join(" then ")} to sign in ${hint.label} separately.` : ""
    // Keyed by agent: each one needs its own grant when OpenCode's cannot be
    // forwarded, and a warning logged for one says nothing about another.
    warnOnce(
      `${agent.id}:${name}:oauth`,
      `MCP server "${name}" has no OpenCode OAuth sign-in to forward; ${hint.label} cannot use it until it is authenticated. Run opencode mcp auth ${JSON.stringify(name)} to sign in through OpenCode.${own}`,
    )
  }

  /** A static ACP header carrying OpenCode's active OAuth grant for a server. */
  const signInHeader = async (integrationID: string) => {
    const connection = await ctx.integration.connection.active(integrationID)
    if (!connection) return undefined
    const credential = await ctx.integration.connection.resolve(connection)
    if (!credential || credential.type !== "oauth" || !credential.access) return undefined
    return `Bearer ${credential.access}`
  }

  return {
    async servers(agent) {
      // Read on every session open, not just at setup: a sign-in can arrive
      // later, and a credential can be refreshed between sessions.
      if (configs.some(([, config]) => config.type === "remote" && !config.disabled)) await readAuth()

      const servers: AcpMcpServer[] = []
      for (const [name, config] of configs) {
        if (config.disabled) continue
        if (config.type === "local") {
          const [command, ...args] = config.command ?? []
          if (!command) {
            warnOnce(`${name}:command`, `MCP server "${name}" has no command; skipping it for ACP agents`)
            continue
          }
          if (config.cwd) {
            warnOnce(
              `${name}:cwd`,
              `MCP server "${name}" sets cwd, which ACP cannot forward; the agent starts it in its own directory`,
            )
          }
          const env = pairs(config.environment)
          // Codex ACP's stdio variant requires the ACP transport tag. Other ACP
          // agents accept the standard untagged v1 form too, but the tagged
          // shape survives v1/v2 adapters that normalize by transport.
          servers.push({ type: "stdio", name, command, args, ...(env.length ? { env } : {}) })
          continue
        }

        const headers = pairs(config.headers)
        const entry = auth.get(name)
        const wantsOAuth = config.oauth !== false
        let signedIn = hasHeader(headers, "authorization")
        if (entry?.integrationID && !signedIn && wantsOAuth) {
          try {
            const header = await signInHeader(entry.integrationID)
            if (header) {
              headers.push({ name: "Authorization", value: header })
              signedIn = true
            }
          } catch (error) {
            warnOnce(
              `${agent.id}:${name}:credential`,
              `could not read the OpenCode sign-in for MCP server "${name}": ${errorMessage(error)}`,
            )
          }
        }
        // Config headers can carry a key the user set up explicitly; only fall
        // back to a warning when nothing at all authenticates the server.
        if (!signedIn && wantsOAuth && (config.oauth || entry?.integrationID || entry?.needsAuth)) {
          warnSignedIn(agent, name, config.url)
        }
        servers.push({ type: "http", name, url: config.url, headers })
      }
      return servers
    },
    close: () => registration.dispose(),
  }
}

function hasHeader(headers: Array<{ name: string; value: string }>, name: string) {
  return headers.some((header) => header.name.toLowerCase() === name)
}

function pairs(input: Record<string, string> | undefined) {
  return Object.entries(input ?? {}).map(([name, value]) => ({ name, value }))
}
