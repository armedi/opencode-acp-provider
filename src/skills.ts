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
  count: number
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
}

/**
 * Copy OpenCode's own skills into a throwaway directory that ACP agents already
 * know how to scan. Skills that live in `.agents/skills` or `.claude/skills`
 * belong to the agents, so they are left where they are and each agent keeps
 * loading them through its native discovery. That means the mirror contains
 * only built-in/OpenCode-registered skills, not shared agent skills.
 *
 * Supporting files are copied rather than symlinked so they stay inside the
 * additional directory the agent was granted.
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
  try {
    const { data } = await ctx.skill.list()
    for (const skill of data as readonly MirrorableSkill[]) {
      if (!mirrorable(skill)) continue
      const id = String(skill.id)
      if (include && !include.has(id)) continue
      const source = String(skill.path)
      const virtual = source.startsWith("skill://")
      const sourceDirectory = !virtual && basename(source) === "SKILL.md" ? dirname(source) : undefined

      const targets = [agentsDir, claudeDir]
      if (!virtual && sharedSource(source)) continue

      try {
        for (const target of targets) {
          const destination = join(target, id)
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
      count += 1
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  log("info", `Mirrored ${count} OpenCode skill(s) for ACP agents`)
  return {
    root,
    agentsDir,
    claudeDir,
    count,
    close: async () => {
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
