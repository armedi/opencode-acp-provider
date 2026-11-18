import type { Plugin } from "@opencode/plugin"
import type { AcpCommand } from "./acp-client.ts"
import type { AcpServerManager, LogFn } from "./server-manager.ts"

/**
 * Exposes the slash commands an ACP agent advertises as OpenCode commands.
 *
 * ACP has no "execute command" method: a slash command is prompt text the agent
 * intercepts, so forwarding `/<name> <args>` as a prompt is the whole
 * implementation. Names are namespaced by server (`claude:review`) because
 * commands belong to the agent, not to one of its models.
 */
export interface AcpCommandBridge {
  /** Re-register the commands after one server advertised a new list, or all of them. */
  sync: (server?: string) => Promise<void>
  close: () => Promise<void>
}

export interface CommandBridgeOptions {
  ctx: Plugin.Context
  manager: AcpServerManager
  /** ACP server behind an OpenCode provider id, or undefined for other providers. */
  serverForProvider: (providerID: string) => string | undefined
  log: LogFn
}

interface RegisteredCommand {
  name: string
  description?: string
}

/** Plugin storage key for the last command lists the agents advertised. */
export const COMMAND_CACHE_KEY = "commands.v1"

export async function createCommandBridge(options: CommandBridgeOptions): Promise<AcpCommandBridge> {
  const { ctx, manager, serverForProvider, log } = options
  // Seeded from the previous run so the commands are registered while the
  // plugin is still in setup. See `readCache`.
  const commands = await readCache(ctx, manager, log)

  let closed = false
  // Updates arrive as agents send them; serialize so rebuilds cannot interleave.
  let queue: Promise<void> = Promise.resolve()

  const rebuild = async (server?: string) => {
    if (closed) return
    // Read on every rebuild: OpenCode discovers skills in the background, so a
    // set captured during setup is missing most of them.
    const skills = await skillDescriptions(ctx, log)
    let changed = false
    for (const [id, state] of manager.servers) {
      if (server && id !== server) continue
      if (state.config.disabled) continue
      // Not reported yet: keep the cached list until the agent sends its own.
      if (state.commands === undefined) continue
      const forwarded = forwardable(state.commands, skills)
      const previous = commands.get(id)
      if (forwarded.length) {
        commands.set(id, forwarded)
        if (!previous || !sameRegistered(previous, forwarded)) changed = true
      } else if (previous) {
        commands.delete(id)
        changed = true
      }
    }
    // Reloading republishes the registry, so skip it when nothing moved.
    if (!changed) return
    await ctx.command.reload()
    const cache: Record<string, Array<Record<string, string>>> = Object.fromEntries(
      [...commands].map(([id, list]) => [
        id,
        list.map(({ name, description }): Record<string, string> =>
          description === undefined ? { name } : { name, description },
        ),
      ]),
    )
    await ctx.storage.set(COMMAND_CACHE_KEY, cache).catch((error) => {
      log("warn", `could not cache ACP commands: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * A command can be typed in a session that is not on the server that
   * advertised it, because the command list is per location rather than per
   * model. Refuse rather than send the text to an agent that has no such
   * command.
   */
  const forward = async (input: {
    server: string
    name: string
    sessionID: string
    text: string
    delivery: "steer" | "queue"
  }) => {
    const state = manager.get(input.server)
    if (!state) throw new Error(`ACP server "${input.server}" is no longer configured.`)
    const agent = (state.config.name ?? state.config.id).replace(/\s*\(ACP\)$/, "")

    const session = await ctx.session.get({ sessionID: input.sessionID })
    const providerID = session.model?.providerID
    if (!providerID || serverForProvider(providerID) !== input.server) {
      throw new Error(
        `/${input.server}:${input.name} belongs to ${agent}, but this session is using ` +
          `${providerID ?? "no model"}. Switch the session to ${agent} to run it.`,
      )
    }

    const text = input.text.trim()
    await ctx.session.prompt({
      sessionID: input.sessionID,
      text: text ? `/${input.name} ${text}` : `/${input.name}`,
      delivery: input.delivery,
    })
  }

  const registration = await ctx.command.transform((editor) => {
    for (const [server, list] of commands) {
      for (const command of list) {
        editor.add({
          name: `${server}:${command.name}`,
          description: command.description,
          execute: async ({ sessionID, prompt, delivery }) => {
            await forward({
              server,
              name: command.name,
              sessionID,
              text: typeof prompt.text === "string" ? prompt.text : "",
              delivery,
            })
          },
        })
      }
    }
  })

  const sync = (server?: string) => {
    const next = queue.then(() => rebuild(server)).catch((error) => {
      log("warn", `could not refresh ACP commands: ${error instanceof Error ? error.message : String(error)}`)
    })
    queue = next
    return next
  }

  // Subscribe before the first rebuild: OpenCode finishes skill discovery while
  // this plugin is still starting up, so that event is likely already on its way
  // and a subscription created afterwards would miss it.
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const _ of ctx.event.subscribe({ types: ["skill.updated"], signal: controller.signal })) {
        if (closed) break
        await sync()
      }
    } catch {
      // The stream ends on unsubscribe; the palette keeps its last state.
    }
  })()

  await rebuild()

  // Skill discovery can finish before this plugin subscribes, in which case no
  // event ever arrives and the palette keeps commands the filter would drop.
  // Re-check a few times while skills are still arriving, then stop: past that
  // point `skill.updated` covers new skills as they appear.
  const settle = [250, 1_000, 3_000].map((delay) =>
    setTimeout(() => void sync(), delay),
  )
  for (const timer of settle) timer.unref?.()

  return {
    sync,
    close: async () => {
      closed = true
      for (const timer of settle) clearTimeout(timer)
      controller.abort()
      await queue.catch(() => {})
      await registration.dispose().catch(() => {})
    },
  }
}

/**
 * The command lists stored by the previous run, for servers still configured.
 *
 * Agents start in the background, so their commands normally arrive after
 * setup. OpenCode 2.3 publishes a command change made after setup without a
 * location, and clients only refetch commands for a location-scoped
 * `command.updated`. So a client already connected never sees late commands.
 * Changes made during setup are batched and published with the location, so
 * registering the last known lists here reaches every client. The agent's
 * own list then replaces the cached one, which costs nothing when it is
 * unchanged, the usual case.
 */
async function readCache(
  ctx: Plugin.Context,
  manager: AcpServerManager,
  log: LogFn,
): Promise<Map<string, RegisteredCommand[]>> {
  const commands = new Map<string, RegisteredCommand[]>()
  let stored: unknown
  try {
    stored = await ctx.storage.get(COMMAND_CACHE_KEY)
  } catch (error) {
    log("warn", `could not read cached ACP commands: ${error instanceof Error ? error.message : String(error)}`)
    return commands
  }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return commands
  for (const [id, list] of Object.entries(stored)) {
    const state = manager.get(id)
    if (!state || state.config.disabled || !Array.isArray(list)) continue
    const valid = list.flatMap((entry): RegisteredCommand[] => {
      if (!entry || typeof entry !== "object") return []
      const { name, description } = entry as { name?: unknown; description?: unknown }
      if (typeof name !== "string" || !name) return []
      return [{ name, ...(typeof description === "string" ? { description } : {}) }]
    })
    if (valid.length) commands.set(id, valid)
  }
  return commands
}

/** Whether the registered set for one server already matches a rebuilt one. */
function sameRegistered(left: RegisteredCommand[], right: RegisteredCommand[]) {
  if (left.length !== right.length) return false
  return left.every((command, index) => {
    const other = right[index]
    return command.name === other.name && command.description === other.description
  })
}

/**
 * Drop commands that only restate a skill OpenCode already has. Agents raise
 * their own skills to slash commands, so without this the palette fills with a
 * second copy of every skill.
 */
function forwardable(commands: AcpCommand[], skills: Set<string>) {
  const seen = new Set<string>()
  const forwarded: RegisteredCommand[] = []
  for (const command of commands) {
    if (seen.has(command.name)) continue
    if (isSkill(command, skills)) continue
    seen.add(command.name)
    const hint = command.hint ? `usage: ${command.hint}` : ""
    const description = [command.description?.trim(), hint].filter(Boolean).join(" ")
    forwarded.push({ name: command.name, ...(description ? { description } : {}) })
  }
  return forwarded
}

/**
 * Whether this command duplicates a skill, decided by reading OpenCode's skill
 * registry rather than by keeping a list of names.
 *
 * Agents that mark skills structurally are taken at their word: `cmd` uses a
 * `skill:` prefix and codex a `$` sigil. For the rest, a command is a skill when
 * its description says the same thing as a registered skill's, because some
 * agents advertise a skill under a plain name. Agents append where the skill came
 * from (`(user)`, `(claude.ai sync)`) to that description, so a trailing
 * parenthetical is ignored.
 */
function isSkill(command: AcpCommand, skills: Set<string>) {
  if (/^(skill:|\$)/i.test(command.name)) return true
  const description = normalizeDescription(command.description)
  return description ? skills.has(description) : false
}

/** Normalized descriptions of the skills OpenCode has registered. */
async function skillDescriptions(ctx: Plugin.Context, log: LogFn): Promise<Set<string>> {
  const descriptions = new Set<string>()
  try {
    const { data } = await ctx.skill.list()
    for (const skill of data as ReadonlyArray<{ description?: unknown }>) {
      const description = normalizeDescription(skill.description)
      if (description) descriptions.add(description)
    }
  } catch (error) {
    log(
      "warn",
      `could not read OpenCode skills, so ACP commands may repeat them: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  return descriptions
}

/** Compare prose without the agent's provenance suffix, case, or punctuation. */
function normalizeDescription(description: unknown) {
  if (typeof description !== "string") return ""
  return description
    .trim()
    .replace(/\s*\([^()]*\)\s*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
}
