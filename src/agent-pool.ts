import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpClient } from "./acp-client.ts"
import { errorMessage } from "./util.ts"

/**
 * One ACP agent process per distinct launch, shared by every OpenCode location.
 *
 * OpenCode loads this plugin once per directory, and each copy used to spawn its
 * own process per agent, paying memory and startup again for every directory.
 * Claude, Codex and Antigravity accept sessions in many directories from one
 * process because each `session/new` carries its own `cwd`, so those agents are
 * shared: `acquire` keys a client by its launch and hands out leases to it.
 *
 * Command Code (`cmd acp`) instead binds a process to the directory of its first
 * session and refuses the others. Such agents use `dedicated`, which keeps one
 * pre-started spare per template. The expensive part (`initialize`, about three
 * seconds for cmd) happens before that binding, and the skills directory passed
 * at spawn is only read when a session starts, so the spare is adopted by
 * symlinking the caller's skills directory into its temporary directory after
 * `initialize`. The link is reported through the lease's `readRoots` so the
 * caller knows it is available.
 *
 * The pool lives on `globalThis` because every location evaluates its own copy
 * of this module; a module-level singleton would give each copy its own pool.
 * The symbol is keyed by ABI and package version so copies from different
 * plugin versions never share a pool whose `AcpClient` they cannot use.
 */

export interface AgentLaunch {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** Launches with different scopes never share a process. */
  scope?: string
  autoApprove?: boolean
  requestTimeoutMs?: number
  promptTimeoutMs?: number
  allowPathsOutsideCwd?: boolean
  maxFileBytes?: number
}

export interface AgentSubscriber {
  onLog?: (level: "debug" | "warn" | "error", message: string) => void
  onExit?: (error: Error) => void
}

export interface AgentLease {
  readonly client: AcpClient
  /** Extra directories this client's sessions must be allowed to read (an adopted spare's skill link). */
  readonly readRoots: string[]
  /** Give the client back. Idempotent. */
  release(): void
}

export interface DedicatedTemplate {
  /** Build the launch. `skillDir` is where the agent should read skills, or undefined when skills are off. */
  launch: (skillDir: string | undefined) => AgentLaunch
  /** The caller's own skills directory; undefined when skills are off. */
  skillDir?: string
}

export interface AgentPoolOptions {
  /** Keep a shared client running this long after its last lease is released. Default 0 (stop at once). */
  lingerMs?: number
  /** Keep one pre-started spare client per dedicated template. Default false. */
  spares?: boolean
  /** Parent directory for spare skill-link directories. Default os.tmpdir(). */
  tmpDir?: string
}

/** Stands in for any skills directory when keying a template, so only skills-on vs skills-off differ. */
const SKILL_PLACEHOLDER = "\u0000skill-dir\u0000"
/** How long a stopped client stays reachable from the process exit hook. */
const RETIRED_TTL_MS = 5_000
const SPARE_PREFIX = "opencode-acp-provider-spare-"

type LogLevel = "debug" | "warn" | "error"

interface SharedEntry {
  client: AcpClient
  subscribers: Array<{ subscriber: AgentSubscriber }>
  linger?: ReturnType<typeof setTimeout>
}

interface Spare {
  client: AcpClient
  dir: string
  link: string
  owner: { subscriber?: AgentSubscriber }
}

interface DedicatedState {
  /** Live dedicated leases for this template. */
  interest: number
  spare?: Spare
  spareStop?: ReturnType<typeof setTimeout>
}

interface Dispatch {
  onLog?: (level: LogLevel, message: string) => void
  onExit?: (error: Error) => void
}

/** Two launches share a client exactly when this key is equal. */
function launchKey(launch: AgentLaunch) {
  const sortedEnv = Object.keys(launch.env)
    .sort()
    .map((name) => [name, launch.env[name]])
  return JSON.stringify([
    launch.scope ?? null,
    launch.command,
    launch.args,
    launch.cwd,
    sortedEnv,
    launch.autoApprove ?? null,
    launch.requestTimeoutMs ?? null,
    launch.promptTimeoutMs ?? null,
    launch.allowPathsOutsideCwd ?? null,
    launch.maxFileBytes ?? null,
  ])
}

export class AgentPool {
  private readonly lingerMs: number
  private readonly spares: boolean
  private readonly tmpDir: string
  private readonly shared = new Map<string, SharedEntry>()
  private readonly dedicatedStates = new Map<string, DedicatedState>()
  private readonly dedicatedClients = new Set<AcpClient>()
  private readonly retired = new Set<AcpClient>()
  private readonly retireTimers = new Set<ReturnType<typeof setTimeout>>()
  private readonly dirs = new Set<string>()
  private listening = false
  private halted = false

  constructor(options: AgentPoolOptions = {}) {
    this.lingerMs = options.lingerMs ?? 0
    this.spares = options.spares ?? false
    this.tmpDir = options.tmpDir ?? tmpdir()
  }

  get stopped() {
    return this.halted
  }

  /** Agents are spawned detached, so a lingering one must be killed by hand. */
  private readonly onProcessExit = () => {
    for (const client of this.knownClients()) client.killSync()
  }

  acquire(launch: AgentLaunch, subscriber: AgentSubscriber): AgentLease {
    if (this.halted) throw new Error("ACP agent pool is stopped")
    const key = launchKey(launch)
    const shared = this.shared.get(key) ?? this.createSharedEntry(key, launch)
    this.clearLinger(shared)

    const registration = { subscriber }
    shared.subscribers.push(registration)
    let released = false
    return {
      client: shared.client,
      readRoots: [],
      release: () => {
        if (released) return
        released = true
        const index = shared.subscribers.indexOf(registration)
        if (index >= 0) shared.subscribers.splice(index, 1)
        // stop() already retired this client and dropped the entry.
        if (this.shared.get(key) !== shared || shared.subscribers.length) return
        if (this.lingerMs > 0) {
          // Stay in the map so a re-acquire before the timer reuses the client.
          const timer = setTimeout(() => {
            shared.linger = undefined
            if (shared.subscribers.length || this.shared.get(key) !== shared) return
            this.shared.delete(key)
            this.retire(shared.client)
          }, this.lingerMs)
          timer.unref?.()
          shared.linger = timer
        } else {
          this.shared.delete(key)
          this.retire(shared.client)
        }
      },
    }
  }

  private createSharedEntry(key: string, launch: AgentLaunch): SharedEntry {
    let entry: SharedEntry
    const client = this.createClient(launch, {
      onLog: (level, message) => entry.subscribers[0]?.subscriber.onLog?.(level, message),
      onExit: (error) => {
        for (const registration of [...entry.subscribers]) registration.subscriber.onExit?.(error)
      },
    })
    entry = { client, subscribers: [] }
    this.shared.set(key, entry)
    return entry
  }

  dedicated(template: DedicatedTemplate, subscriber: AgentSubscriber): AgentLease {
    if (this.halted) throw new Error("ACP agent pool is stopped")
    const key = this.templateKey(template)
    let state = this.dedicatedStates.get(key)
    if (!state) {
      state = { interest: 0 }
      this.dedicatedStates.set(key, state)
    }
    if (state.spareStop) {
      clearTimeout(state.spareStop)
      state.spareStop = undefined
    }

    let adopted: Spare | undefined
    if (this.spares && state.spare) {
      const spare = state.spare
      state.spare = undefined
      if (template.skillDir === undefined) {
        adopted = spare
      } else {
        try {
          symlinkSync(template.skillDir, spare.link, "dir")
          adopted = spare
        } catch (error) {
          subscriber.onLog?.("warn", `could not adopt a warm agent: ${errorMessage(error)}`)
          this.retire(spare.client)
          this.removeDir(spare.dir)
        }
      }
      if (adopted) adopted.owner.subscriber = subscriber
    }

    const client =
      adopted?.client ??
      this.createClient(template.launch(template.skillDir), {
        onLog: (level, message) => subscriber.onLog?.(level, message),
        onExit: (error) => subscriber.onExit?.(error),
      })
    this.dedicatedClients.add(client)
    state.interest++
    if (this.spares) {
      void client
        .start()
        .catch(() => {})
        .finally(() => this.ensureSpare(key, template))
    }

    const current = state
    let released = false
    return {
      client,
      readRoots: adopted ? [adopted.dir] : [],
      release: () => {
        if (released) return
        released = true
        this.dedicatedClients.delete(client)
        this.retire(client)
        if (adopted) this.removeDir(adopted.dir)
        current.interest = Math.max(0, current.interest - 1)
        if (current.interest === 0) this.stopSpareLater(current)
      },
    }
  }

  async stop(): Promise<void> {
    if (this.halted) return
    this.halted = true
    for (const entry of this.shared.values()) this.clearLinger(entry)
    for (const state of this.dedicatedStates.values()) {
      if (state.spareStop) clearTimeout(state.spareStop)
      state.spareStop = undefined
    }
    for (const timer of this.retireTimers) clearTimeout(timer)
    this.retireTimers.clear()

    const clients = [...this.knownClients()]
    const dirs = [...this.dirs]
    this.shared.clear()
    for (const state of this.dedicatedStates.values()) {
      state.spare = undefined
      state.interest = 0
    }
    this.dedicatedStates.clear()
    this.dedicatedClients.clear()
    this.dirs.clear()

    const stopping = clients.map((client) => this.retire(client))
    await Promise.allSettled(stopping)

    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    if (this.listening) {
      process.off("exit", this.onProcessExit)
      this.listening = false
    }
  }

  private templateKey(template: DedicatedTemplate) {
    return launchKey(template.launch(template.skillDir === undefined ? undefined : SKILL_PLACEHOLDER))
  }

  private clearLinger(entry: SharedEntry) {
    if (!entry.linger) return
    clearTimeout(entry.linger)
    entry.linger = undefined
  }

  /** Stop the key's spare once nothing needs it, after the shared linger. */
  private stopSpareLater(state: DedicatedState) {
    if (!state.spare) return
    const run = () => {
      state.spareStop = undefined
      if (state.interest !== 0) return
      const spare = state.spare
      if (!spare) return
      state.spare = undefined
      this.retire(spare.client)
      this.removeDir(spare.dir)
    }
    if (this.lingerMs > 0) {
      const timer = setTimeout(run, this.lingerMs)
      timer.unref?.()
      state.spareStop = timer
    } else {
      run()
    }
  }

  private ensureSpare(key: string, template: DedicatedTemplate) {
    if (!this.spares || this.halted) return
    const state = this.dedicatedStates.get(key)
    if (!state || state.interest === 0 || state.spare) return
    let dir: string | undefined
    try {
      dir = mkdtempSync(join(this.tmpDir, SPARE_PREFIX))
      const spareDir = dir
      this.dirs.add(spareDir)
      const link = join(spareDir, "skills")
      const holder: { spare?: Spare } = {}
      const client = this.createClient(
        template.launch(template.skillDir === undefined ? undefined : link),
        {
          onLog: (level, message) => holder.spare?.owner.subscriber?.onLog?.(level, message),
          onExit: (error) => {
            const spare = holder.spare
            if (!spare) return
            const owner = spare.owner.subscriber
            if (owner) {
              owner.onExit?.(error)
              return
            }
            if (state.spare !== spare) return
            state.spare = undefined
            this.retire(spare.client)
            this.removeDir(spare.dir)
          },
        },
      )
      const spare: Spare = { client, dir: spareDir, link, owner: {} }
      holder.spare = spare
      state.spare = spare
      void client.start().catch(() => {
        if (state.spare !== spare) return
        state.spare = undefined
        this.retire(client)
        this.removeDir(spare.dir)
      })
    } catch {
      if (dir) this.removeDir(dir)
    }
  }

  private knownClients() {
    const clients = new Set<AcpClient>()
    for (const entry of this.shared.values()) clients.add(entry.client)
    for (const client of this.dedicatedClients) clients.add(client)
    for (const state of this.dedicatedStates.values()) {
      if (state.spare) clients.add(state.spare.client)
    }
    for (const client of this.retired) clients.add(client)
    return clients
  }

  private createClient(launch: AgentLaunch, dispatch: Dispatch) {
    if (!this.listening) {
      process.on("exit", this.onProcessExit)
      this.listening = true
    }
    return new AcpClient({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      autoApprove: launch.autoApprove,
      requestTimeoutMs: launch.requestTimeoutMs,
      promptTimeoutMs: launch.promptTimeoutMs,
      allowPathsOutsideCwd: launch.allowPathsOutsideCwd,
      maxFileBytes: launch.maxFileBytes,
      onLog: dispatch.onLog,
      onExit: dispatch.onExit,
    })
  }

  /** Stop a client and keep it killable from the exit hook for a while. */
  private retire(client: AcpClient) {
    const stopping = client.stop().catch(() => {})
    this.retired.add(client)
    const timer = setTimeout(() => {
      this.retired.delete(client)
      this.retireTimers.delete(timer)
    }, RETIRED_TTL_MS)
    timer.unref?.()
    this.retireTimers.add(timer)
    return stopping
  }

  private removeDir(dir: string) {
    this.dirs.delete(dir)
    rmSync(dir, { recursive: true, force: true })
  }
}

const POOLS = Symbol.for("opencode-acp-provider.agent-pools")
/** Bump when AgentPool or AcpClient change incompatibly; copies only share a pool with the same ABI and version. */
const AGENT_POOL_ABI = 1

const { version } = createRequire(import.meta.url)("../package.json") as { version: string }

function pools() {
  const scope = globalThis as unknown as Record<symbol, Map<string, AgentPool> | undefined>
  return (scope[POOLS] ??= new Map())
}

export function sharedAgentPool(): AgentPool {
  const key = `${AGENT_POOL_ABI}:${version}`
  const existing = pools().get(key)
  if (existing && !existing.stopped) return existing
  const pool = new AgentPool({ lingerMs: 60_000, spares: true })
  pools().set(key, pool)
  return pool
}
