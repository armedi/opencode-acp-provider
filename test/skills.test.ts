import { afterEach, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyCmdSkillFlag, createSkillMirror } from "../src/skills.ts"

const dirs: string[] = []

async function temp(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  )
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function context(skills: unknown[]) {
  return { skill: { list: async () => ({ location: {}, data: skills }) } } as any
}

test("mirrors OpenCode skills into the agent-native skill trees", async () => {
  const source = await temp("skill-source-")
  await mkdir(join(source, "review", "references"), { recursive: true })
  await writeFile(join(source, "review", "SKILL.md"), "---\nname: Review\ndescription: Review code\n---\n# Review\n")
  await writeFile(join(source, "review", "references", "guide.md"), "guide")
  const flat = join(source, "flat.md")
  await writeFile(flat, "---\nname: Flat\ndescription: Flat skill\n---\n# Flat\n")

  const mirror = await createSkillMirror(
    context([
      {
        id: "opencode",
        name: "OpenCode",
        description: "OpenCode help",
        path: "skill://opencode/SKILL.md",
        content: "# OpenCode\n",
      },
      {
        id: "review",
        name: "Review",
        description: "Review code",
        path: join(source, "review", "SKILL.md"),
        content: "# Review\n",
      },
      { id: "flat", name: "Flat", description: "Flat skill", path: flat, content: "# Flat\n" },
      { id: "hidden", name: "Hidden", description: "Hidden", autoinvoke: false, path: flat, content: "# Hidden\n" },
      { id: "no-description", name: "No description", path: flat, content: "# No description\n" },
      { id: "Bad_ID", name: "Bad", description: "Bad id", path: flat, content: "# Bad\n" },
    ]),
  )

  try {
    expect(mirror.count).toBe(3)
    for (const root of [mirror.agentsDir, mirror.claudeDir]) {
      const builtin = await readFile(join(root, "opencode", "SKILL.md"), "utf8")
      expect(builtin).toContain('name: "opencode"')
      expect(builtin).toContain('description: "OpenCode help"')
      expect(builtin).toContain("# OpenCode")
      // Supporting files move with the skill.
      expect(await readFile(join(root, "review", "references", "guide.md"), "utf8")).toBe("guide")
      expect(await exists(join(root, "flat", "SKILL.md"))).toBe(true)
      expect(await exists(join(root, "hidden"))).toBe(false)
      expect(await exists(join(root, "no-description"))).toBe(false)
      expect(await exists(join(root, "Bad_ID"))).toBe(false)
    }
  } finally {
    await mirror.close()
  }
  expect(await exists(mirror.root)).toBe(false)
})

test("leaves shared agent skills where the agents already load them", async () => {
  const source = await temp("skill-native-")
  const agentsOnly = join(source, ".agents", "skills", "agents-only")
  const claudeOnly = join(source, ".claude", "skills", "claude-only")
  await mkdir(agentsOnly, { recursive: true })
  await mkdir(claudeOnly, { recursive: true })
  const body = "---\nname: x\ndescription: x\n---\n# x\n"
  await writeFile(join(agentsOnly, "SKILL.md"), body)
  await writeFile(join(claudeOnly, "SKILL.md"), body)

  const mirror = await createSkillMirror(
    context([
      { id: "agents-only", description: "x", path: join(agentsOnly, "SKILL.md"), content: "# x\n" },
      { id: "claude-only", description: "x", path: join(claudeOnly, "SKILL.md"), content: "# x\n" },
    ]),
  )
  try {
    expect(mirror.count).toBe(0)
    expect(await exists(join(mirror.agentsDir, "agents-only"))).toBe(false)
    expect(await exists(join(mirror.claudeDir, "agents-only"))).toBe(false)
    expect(await exists(join(mirror.agentsDir, "claude-only"))).toBe(false)
    expect(await exists(join(mirror.claudeDir, "claude-only"))).toBe(false)
  } finally {
    await mirror.close()
  }
})

test("adds the skills root to cmd without overriding an explicit choice", () => {
  const runtimeCommand = ["bun", "/node_modules/command-code/dist/index.mjs", "acp"]
  expect(applyCmdSkillFlag(runtimeCommand, "/tmp/skills", "/mod.ts")).toEqual([
    ...runtimeCommand, "--mod", "/mod.ts", "--skill", "/tmp/skills",
  ])
  const otherRuntimeCommand = ["bun", "/other/dist/index.mjs", "acp"]
  expect(applyCmdSkillFlag(otherRuntimeCommand, "/tmp/skills", "/mod.ts")).toEqual(otherRuntimeCommand)
  expect(applyCmdSkillFlag(["cmd", "acp"], "/tmp/skills", "/mod.ts")).toEqual([
    "cmd",
    "acp",
    "--mod",
    "/mod.ts",
    "--skill",
    "/tmp/skills",
  ])
  expect(applyCmdSkillFlag(["/usr/local/bin/cmd", "acp", "--mod", "x"], "/tmp/skills", "/mod.ts")).toEqual([
    "/usr/local/bin/cmd",
    "acp",
    "--mod",
    "x",
    "--mod",
    "/mod.ts",
    "--skill",
    "/tmp/skills",
  ])
  expect(applyCmdSkillFlag(["cmd", "acp", "--mod", "/mod.ts"], "/tmp/skills", "/mod.ts")).toEqual([
    "cmd",
    "acp",
    "--mod",
    "/mod.ts",
    "--skill",
    "/tmp/skills",
  ])
  expect(applyCmdSkillFlag(["cmd", "acp", "--skill", "/other"], "/tmp/skills", "/mod.ts")).toEqual([
    "cmd",
    "acp",
    "--skill",
    "/other",
    "--mod",
    "/mod.ts",
  ])
  expect(applyCmdSkillFlag(["cmd", "acp", "--no-skills"], "/tmp/skills", "/mod.ts")).toEqual([
    "cmd",
    "acp",
    "--no-skills",
  ])
  expect(applyCmdSkillFlag(["cmd", "acp", "--safe-mode"], "/tmp/skills", "/mod.ts")).toEqual([
    "cmd",
    "acp",
    "--safe-mode",
  ])
  expect(applyCmdSkillFlag(["claude-agent-acp"], "/tmp/skills", "/mod.ts")).toEqual(["claude-agent-acp"])
  expect(applyCmdSkillFlag(["cmd", "--list-models"], "/tmp/skills", "/mod.ts")).toEqual(["cmd", "--list-models"])
})
