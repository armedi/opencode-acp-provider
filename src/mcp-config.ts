import type { Mcp, Plugin } from "@opencode/plugin"
import type { AcpMcpServer } from "./acp-client.ts"
import type { AcpServerConfig, LogFn } from "./server-manager.ts"
import { executableName, isCmdCommand } from "./skills.ts"

type Ctx = Plugin.Context
type ServerConfig = Mcp.ServerConfig

export interface OpenCodeMcpSource {
  /** Servers to add to an ACP `session/new`, read from the current config. */
  servers: (agent: AcpServerConfig) => AcpMcpServer[]
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

/**
 * OpenCode's own MCP servers, converted to the shape ACP accepts, so an agent
 * connects to exactly the servers OpenCode is configured with instead of a
 * second list maintained next to it.
 *
 * Only an MCP transform exposes the full configuration; `ctx.mcp.list()` reports
 * connection status alone. The transform only reads, and it is replayed whenever
 * the registry is rebuilt, which keeps the capture current for later sessions.
 */
export async function createOpenCodeMcpSource(ctx: Ctx, log: LogFn): Promise<OpenCodeMcpSource> {
  let configs: ReadonlyArray<readonly [string, ServerConfig]> = []
  let captured = false
  const registration = await ctx.mcp.transform((editor) => {
    configs = editor.list()
    captured = true
  })
  // A registry read replays the registered transforms, so this also captures the
  // configuration for plugin setups that read nothing else.
  await ctx.mcp.list().catch((error) => {
    log("warn", `could not read OpenCode's MCP configuration: ${error instanceof Error ? error.message : String(error)}`)
  })

  const warned = new Set<string>()
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return
    warned.add(key)
    log("warn", message)
  }

  return {
    servers(agent) {
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
          servers.push({ name, command, args, ...(env.length ? { env } : {}) })
          continue
        }
        if (config.oauth) {
          const hint = oauthHint(agent, name, config.url)
          const steps = hint.steps.length ? ` Run ${hint.steps.join(" then ")} to sign in first.` : ""
          // Keyed by agent: each one signs in on its own, so each needs its own
          // commands, and a warning logged for one says nothing about another.
          warnOnce(
            `${agent.id}:${name}:oauth`,
            `MCP server "${name}" signs in through OpenCode, whose login is not shared; ${hint.label} signs in on its own.${steps}`,
          )
        }
        servers.push({ type: "http", name, url: config.url, headers: pairs(config.headers) })
      }
      return servers
    },
    close: () => registration.dispose(),
  }
}

function pairs(input: Record<string, string> | undefined) {
  return Object.entries(input ?? {}).map(([name, value]) => ({ name, value }))
}
