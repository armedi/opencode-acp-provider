import type { Mcp, Plugin } from "@opencode/plugin"
import type { AcpMcpServer } from "./acp-client.ts"
import type { AcpServerConfig, LogFn } from "./server-manager.ts"

type Ctx = Plugin.Context
type ServerConfig = Mcp.ServerConfig

export interface OpenCodeMcpSource {
  /** Servers to add to an ACP `session/new`, read from the current config. */
  servers: (agent: AcpServerConfig) => AcpMcpServer[]
  close: () => Promise<void>
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
    servers(_agent) {
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
          warnOnce(
            `${name}:oauth`,
            `MCP server "${name}" signs in through OpenCode, whose login is not shared; the ACP agent authenticates on its own`,
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
