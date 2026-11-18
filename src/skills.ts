import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { LogFn } from "./server-manager.ts"

/** Agent Skills IDs are portable only as lowercase kebab-case. */
const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SKILL_ID = 64

/**
 * A temporary, agent-owned skill tree. The root is handed to ACP agents as an
 * `additionalDirectories` entry; Codex looks in `<root>/.agents/skills` and
 * Claude Code looks in `<root>/.claude/skills`.
 */
export interface SkillMirror {
  root: string
  /** Locations a `--skill` flag can take (cmd). */
  agentsDir: string
  claudeDir: string
  /** Skills mirrored by the latest sync. */
  readonly count: number
  /** Re-read OpenCode's skills and bring the mirror in line with them. */
  sync: () => Promise<void>
  close: () => Promise<void>
}

interface MirrorableSkill {
  id: unknown
  description?: unknown
  autoinvoke?: unknown
  path: unknown
  content?: unknown
}

export interface SkillMirrorOptions {
  /** When set, only mirror these skill IDs. */
  include?: readonly string[]
  log?: LogFn
  /**
   * Follow `skill.updated` and re-check shortly after creation. OpenCode
   * discovers skills in the background, so the first list is often partial.
   * Defaults to true.
   */
  watch?: boolean
}

/** Delays for re-reading skills after setup, in case discovery finished before the subscription. */
const SETTLE_DELAYS_MS = [250, 1_000, 3_000]

/**
 * Copy OpenCode's own skills into a throwaway directory that ACP agents already
 * know how to scan. Skills that live in `.agents/skills` or `.claude/skills`
 * belong to the agents, so they are left where they are and each agent keeps
 * loading them through its native discovery. That means the mirror contains
 * only built-in/OpenCode-registered skills, not shared agent skills.
 *
 * Supporting files are copied rather than symlinked so they stay inside the
 * additional directory the agent was granted.
 *
 * The mirror stays up even while it is empty: skills that OpenCode discovers
 * later are added on `skill.updated`, and agents see them in their next session.
 */
export async function createSkillMirror(
  ctx: Plugin.Context,
  options: SkillMirrorOptions = {},
): Promise<SkillMirror> {
  const log = options.log ?? (() => {})
  const include = options.include ? new Set(options.include) : undefined
  const root = await mkdtemp(join(tmpdir(), "opencode-acp-skills-"))
  const agentsDir = join(root, ".agents", "skills")
  const claudeDir = join(root, ".claude", "skills")
  await mkdir(agentsDir, { recursive: true })
  await mkdir(claudeDir, { recursive: true })

  let count = 0
  let closed = false
  let mirrored = new Set<string>()

  const rebuild = async () => {
    if (closed) return
    const { data } = await ctx.skill.list()
    const next = new Set<string>()
    for (const skill of data as readonly MirrorableSkill[]) {
      if (closed) return
      if (!mirrorable(skill)) continue
      const id = String(skill.id)
      if (include && !include.has(id)) continue
      const source = String(skill.path)
      const virtual = source.startsWith("skill://")
      if (!virtual && sharedSource(source)) continue
      const sourceDirectory = !virtual && basename(source) === "SKILL.md" ? dirname(source) : undefined

      try {
        for (const target of [agentsDir, claudeDir]) {
          const destination = join(target, id)
          // Start clean so files removed from the source do not linger.
          await rm(destination, { recursive: true, force: true })
          if (sourceDirectory)
            await cp(sourceDirectory, destination, {
              recursive: true,
              dereference: true,
              force: true,
              filter: copyFilter,
            })
          else await mkdir(destination, { recursive: true })
          await writeFile(join(destination, "SKILL.md"), renderSkill(skill), "utf8")
        }
      } catch (error) {
        log("warn", `could not mirror skill "${id}": ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      next.add(id)
    }
    for (const id of mirrored) {
      if (next.has(id)) continue
      for (const target of [agentsDir, claudeDir]) {
        await rm(join(target, id), { recursive: true, force: true }).catch(() => {})
      }
    }
    if (next.size !== count) log("info", `Mirrored ${next.size} OpenCode skill(s) for ACP agents`)
    mirrored = next
    count = next.size
  }

  let queue: Promise<void> = Promise.resolve()
  const sync = () => {
    const run = queue.then(rebuild).catch((error) => {
      log("warn", `could not refresh OpenCode skills mirror: ${error instanceof Error ? error.message : String(error)}`)
    })
    queue = run
    return run
  }

  // Subscribe before the first read so a `skill.updated` fired meanwhile is not lost.
  const controller = new AbortController()
  const timers: ReturnType<typeof setTimeout>[] = []
  if (options.watch !== false) {
    const subscribe = ctx.event?.subscribe
    if (typeof subscribe === "function") {
      void (async () => {
        try {
          for await (const _ of ctx.event.subscribe({ types: ["skill.updated"], signal: controller.signal })) {
            if (closed) break
            await sync()
          }
        } catch {
          // The stream ends on close; the mirror keeps its last state.
        }
      })()
    }
  }

  try {
    await rebuild()
  } catch (error) {
    controller.abort()
    await rm(root, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  if (count === 0) log("info", "Mirrored 0 OpenCode skill(s) for ACP agents; watching for more")

  if (options.watch !== false) {
    for (const delay of SETTLE_DELAYS_MS) {
      const timer = setTimeout(() => void sync(), delay)
      timer.unref?.()
      timers.push(timer)
    }
  }

  return {
    root,
    agentsDir,
    claudeDir,
    get count() {
      return count
    },
    sync,
    close: async () => {
      closed = true
      for (const timer of timers) clearTimeout(timer)
      controller.abort()
      await queue.catch(() => {})
      await rm(root, { recursive: true, force: true }).catch(() => {})
    },
  }
}

function mirrorable(skill: MirrorableSkill) {
  const id = typeof skill.id === "string" ? skill.id : ""
  if (!id || id.length > MAX_SKILL_ID || !SKILL_ID.test(id)) return false
  if (typeof skill.description !== "string" || !skill.description.trim()) return false
  if (skill.autoinvoke === false) return false
  if (typeof skill.path !== "string" || !skill.path) return false
  return typeof skill.content === "string"
}

/** Skills in `.agents/skills` or `.claude/skills` are owned by the agents, not OpenCode. */
function sharedSource(source: string) {
  const normalized = source.replaceAll(sep, "/").replaceAll("\\", "/")
  return normalized.includes("/.agents/skills/") || normalized.includes("/.claude/skills/")
}

function copyFilter(path: string) {
  const name = basename(path)
  return name !== ".git" && name !== "node_modules"
}

function renderSkill(skill: MirrorableSkill) {
  const id = String(skill.id)
  const description =
    typeof skill.description === "string" ? skill.description.trim().slice(0, 1024) : ""
  const body = String(skill.content ?? "").replace(/^\s*\n/, "").trimEnd()
  // JSON strings are valid YAML flow scalars. `name` is the directory id so
  // strict loaders (cmd) accept the skill, and tools that display a label fall
  // back to the description.
  return `---\nname: ${JSON.stringify(id)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`
}
