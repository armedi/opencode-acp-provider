import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { AcpClient, AcpError, isAcpError } from "../src/acp-client.ts"

const agent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url))

function client(
  options: { promptTimeoutMs?: number; requestTimeoutMs?: number; agentArgs?: string[]; autoApprove?: boolean } = {},
) {
  return new AcpClient({
    command: process.execPath,
    args: [agent, ...(options.agentArgs ?? [])],
    cwd: tmpdir(),
    autoApprove: options.autoApprove ?? true,
    promptTimeoutMs: options.promptTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
  })
}

test("recognises an AcpError built by another evaluation of this module", () => {
  class Foreign extends Error {
    name = "AcpError"
    code = -32002
  }
  expect(isAcpError(new AcpError("x", -32002))).toBe(true)
  expect(isAcpError(new Foreign())).toBe(true)
  expect(isAcpError(new Error("x"))).toBe(false)
  expect(isAcpError({ name: "AcpError", code: 1 })).toBe(false)
})

test("runs an ACP session end to end", async () => {
  const acp = client()
  try {
    const session = await acp.newSession(tmpdir())
    expect(session.sessionId).toStartWith("sess-")
    expect(session.models.map((model) => model.id)).toEqual(["fast", "slow"])
    expect(session.efforts).toEqual(["low", "medium", "high"])

    const updates: Array<{ sessionUpdate: string }> = []
    const result = await acp.prompt(session.sessionId, "hello", {
      onUpdate: (update) => updates.push(update as { sessionUpdate: string }),
    })

    expect(result.stopReason).toBe("end_turn")
    expect(result.text).toBe("got:hello")
    expect(updates.some((update) => update.sessionUpdate === "tool_call")).toBe(true)
    expect(updates.some((update) => update.sessionUpdate === "usage_update")).toBe(true)

    await acp.closeSession(session.sessionId)
  } finally {
    await acp.stop()
  }
})

test("declines a native agent question instead of auto-approving its options", async () => {
  // autoApprove is true, but question options must never be picked automatically.
  const acp = client()
  try {
    const session = await acp.newSession(tmpdir())
    const result = await acp.prompt(session.sessionId, "please ask")
    expect(result.text).toBe("question:cancelled")
  } finally {
    await acp.stop()
  }
})

test("still auto-approves ordinary permission requests", async () => {
  const acp = client()
  try {
    const session = await acp.newSession(tmpdir())
    const result = await acp.prompt(session.sessionId, "ask permission")
    expect(result.text).toBe("permission:allow_once")
  } finally {
    await acp.stop()
  }
})

test("shows the tool call's text content in the permission prompt", async () => {
  const acp = client({ autoApprove: false })
  try {
    const session = await acp.newSession(tmpdir())
    const seen: Array<string | undefined> = []
    const result = await acp.prompt(session.sessionId, "ask permission", {
      requestPermission: async (info) => {
        seen.push(info.detail)
        return true
      },
    })
    expect(result.text).toBe("permission:allow_once")
    expect(seen).toEqual(["ls -la"])
  } finally {
    await acp.stop()
  }
})

test("stop rejects a turn that is still running", async () => {
  const acp = client({ promptTimeoutMs: 0 })
  const session = await acp.newSession(tmpdir())
  const pending = acp.prompt(session.sessionId, "hang forever")
  await new Promise((resolve) => setTimeout(resolve, 50))
  await acp.stop()
  await expect(pending).rejects.toThrow("stopped")
})

test("killSync ends an agent that is still stopping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-kill-sync-"))
  const log = join(dir, "pids")
  const acp = client({ agentArgs: ["--pid-log", log] })
  try {
    await acp.start()
    const pid = Number((await readFile(log, "utf8")).trim().split("\n")[0])
    void acp.stop()
    acp.killSync()
    let gone = false
    const deadline = Date.now() + 2_000
    while (!gone && Date.now() < deadline) {
      try {
        process.kill(pid, 0)
        await new Promise((resolve) => setTimeout(resolve, 20))
      } catch {
        gone = true
      }
    }
    expect(gone).toBe(true)
  } finally {
    await acp.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test("drops command caches when the agent exits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-command-cache-"))
  const log = join(dir, "pids")
  const acp = client({ agentArgs: ["--pid-log", log] })
  try {
    const session = await acp.newSession(tmpdir())
    expect(await acp.waitForCommands(session.sessionId, 2_000)).toEqual([
      { name: "compact", description: "Summarize the conversation so far" },
    ])
    expect(acp.hasCommand(session.sessionId, "compact")).toBe(true)
    const pid = Number((await readFile(log, "utf8")).trim().split("\n")[0])
    process.kill(pid, "SIGKILL")
    const deadline = Date.now() + 2_000
    while (acp.alive && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(acp.alive).toBe(false)
    expect(acp.hasCommand(session.sessionId, "compact")).toBe(false)
  } finally {
    await acp.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test("terminates an agent whose handshake times out before starting another one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-restart-"))
  const gate = join(dir, "ready")
  const log = join(dir, "pids")
  const acp = client({ agentArgs: ["--initialize-gate", gate, "--pid-log", log], requestTimeoutMs: 1_000 })
  const pids = async () => (await readFile(log, "utf8")).trim().split("\n").map(Number)
  let failedPid: number | undefined
  try {
    await expect(acp.start()).rejects.toMatchObject({ code: -32001 })
    failedPid = (await pids())[0]
    expect(() => process.kill(failedPid!, 0)).toThrow()
    failedPid = undefined
    await writeFile(gate, "ready")
    expect((await acp.newSession(dir)).sessionId).toStartWith("sess-")
    expect(await pids()).toHaveLength(2)
  } finally {
    await acp.stop()
    if (failedPid) {
      try { process.kill(failedPid, "SIGKILL") } catch {}
    }
    await rm(dir, { recursive: true, force: true })
  }
})

test("keeps fs writes inside the session directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "acp-root-"))
  const outside = await mkdtemp(join(tmpdir(), "acp-outside-"))
  await symlink(outside, join(root, "link"))
  const acp = client()
  try {
    const session = await acp.newSession(root)
    const result = await acp.prompt(session.sessionId, "write files")
    expect(result.text).toBe("write:ok/denied")
    expect(await readFile(join(root, "inside.txt"), "utf8")).toBe("inside")
    await expect(readFile(join(outside, "escape.txt"), "utf8")).rejects.toThrow()
  } finally {
    await acp.stop()
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("accepts absolute paths under a symlinked session directory", async () => {
  const real = await realpath(await mkdtemp(join(tmpdir(), "acp-real-")))
  const alias = join(await realpath(await mkdtemp(join(tmpdir(), "acp-alias-"))), "proj")
  await symlink(real, alias)
  await writeFile(join(real, "a.txt"), "a")
  const acp = client()
  try {
    const session = await acp.newSession(alias)
    const probes = [
      ["read", join(alias, "a.txt")],
      ["write", join(alias, "b.txt")],
      ["read", join(real, "a.txt")],
      ["read", "..env"],
      ["read", "../escape.txt"],
    ]
    await writeFile(join(real, "..env"), "x")
    const result = await acp.prompt(session.sessionId, `fs-probe ${JSON.stringify(probes)}`)
    expect(result.text).toBe("fs:ok,ok,ok,ok,denied")
    expect(await readFile(join(real, "b.txt"), "utf8")).toBe("probe")
  } finally {
    await acp.stop()
    await rm(dirname(alias), { recursive: true, force: true })
    await rm(real, { recursive: true, force: true })
  }
})

test("lets reads, but not writes, reach the session's additional directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "acp-root-"))
  const extra = await mkdtemp(join(tmpdir(), "acp-extra-"))
  await mkdir(join(extra, "skills"))
  await writeFile(join(extra, "skills", "SKILL.md"), "skill")
  const acp = client()
  try {
    const session = await acp.newSession(root, { additionalDirectories: [extra] })
    const probes = [
      ["read", join(extra, "skills", "SKILL.md")],
      ["write", join(extra, "skills", "new.md")],
    ]
    const result = await acp.prompt(session.sessionId, `fs-probe ${JSON.stringify(probes)}`)
    expect(result.text).toBe("fs:ok,denied")
  } finally {
    await acp.stop()
    await rm(root, { recursive: true, force: true })
    await rm(extra, { recursive: true, force: true })
  }
})
