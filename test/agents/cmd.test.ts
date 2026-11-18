import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { applyCmdMods, CMD_ORCHESTRATION_MOD, CMD_SKILL_MOD } from "../../src/agents/cmd/index.ts"

const ORCH = CMD_ORCHESTRATION_MOD
const SKILL = CMD_SKILL_MOD
const all = { orchestration: true, skillDir: "/tmp/skills" }

test("companion mod paths resolve to files shipped with the package", () => {
  expect(existsSync(ORCH)).toBe(true)
  expect(existsSync(SKILL)).toBe(true)
})

test("loads every companion mod the same way on cmd acp", () => {
  expect(applyCmdMods(["cmd", "acp"], all)).toEqual(["cmd", "acp", "--mod", ORCH, "--mod", SKILL, "--skill", "/tmp/skills"])
  const runtime = ["bun", "/node_modules/command-code/dist/index.mjs", "acp"]
  expect(applyCmdMods(runtime, all)).toEqual([...runtime, "--mod", ORCH, "--mod", SKILL, "--skill", "/tmp/skills"])
  expect(applyCmdMods(["cmd", "acp"], { orchestration: true })).toEqual(["cmd", "acp", "--mod", ORCH])
  expect(applyCmdMods(["cmd", "acp"], { skillDir: "/tmp/skills" })).toEqual(["cmd", "acp", "--mod", SKILL, "--skill", "/tmp/skills"])
})

test("keeps user mods and does not repeat a mod already listed", () => {
  expect(applyCmdMods(["cmd", "acp", "--mod", "/user.ts", "--mod", ORCH], all)).toEqual([
    "cmd", "acp", "--mod", "/user.ts", "--mod", ORCH, "--mod", SKILL, "--skill", "/tmp/skills",
  ])
  expect(applyCmdMods(["cmd", "acp", `--mod=${SKILL}`, "--skill", "/other"], all)).toEqual([
    "cmd", "acp", `--mod=${SKILL}`, "--skill", "/other", "--mod", ORCH,
  ])
})

test("respects opt-outs and leaves non-cmd commands alone", () => {
  expect(applyCmdMods(["cmd", "acp", "--safe-mode"], all)).toEqual(["cmd", "acp", "--safe-mode"])
  expect(applyCmdMods(["cmd", "acp", "--no-skills"], all)).toEqual(["cmd", "acp", "--no-skills", "--mod", ORCH])
  expect(applyCmdMods(["bun", "/other/dist/index.mjs", "acp"], all)).toEqual(["bun", "/other/dist/index.mjs", "acp"])
  expect(applyCmdMods(["claude-agent-acp"], all)).toEqual(["claude-agent-acp"])
  expect(applyCmdMods(["cmd", "--list-models"], all)).toEqual(["cmd", "--list-models"])
})
