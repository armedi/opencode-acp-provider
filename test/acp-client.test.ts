import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AcpClient } from "../src/acp-client.ts"

const agent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url))

function client(options: { promptTimeoutMs?: number; requestTimeoutMs?: number; agentArgs?: string[] } = {}) {
  return new AcpClient({
    command: process.execPath,
    args: [agent, ...(options.agentArgs ?? [])],
    cwd: tmpdir(),
    autoApprove: true,
    promptTimeoutMs: options.promptTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
  })
}

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

test("stop rejects a turn that is still running", async () => {
  const acp = client({ promptTimeoutMs: 0 })
  const session = await acp.newSession(tmpdir())
  const pending = acp.prompt(session.sessionId, "hang forever")
  await new Promise((resolve) => setTimeout(resolve, 50))
  await acp.stop()
  await expect(pending).rejects.toThrow("stopped")
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

test("restores a session in a fresh agent process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "acp-restore-"))
  const sessionsFile = join(dir, "sessions.json")
  const first = client({ agentArgs: ["--sessions-file", sessionsFile] })
  let sessionId = ""
  try {
    const session = await first.newSession(dir)
    sessionId = session.sessionId
    expect(first.canRestoreSessions).toBe(true)
    expect((await first.prompt(sessionId, "hello")).text).toBe("got:hello")
  } finally {
    await first.stop()
  }

  const second = client({ agentArgs: ["--sessions-file", sessionsFile] })
  try {
    expect(await second.restoreSession(sessionId, { cwd: dir })).toBe("resumed")
    expect(second.hasSession(sessionId)).toBe(true)
    expect((await second.prompt(sessionId, "again")).text).toBe("got:again")
    await expect(second.restoreSession("sess-999", { cwd: dir })).rejects.toThrow("unknown session")
  } finally {
    await second.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test("does not offer session restore when the agent cannot do it", async () => {
  const acp = client({ agentArgs: ["--no-restore"] })
  try {
    const handshake = await acp.start()
    expect(handshake.agentCapabilities.loadSession).toBeUndefined()
    expect(acp.canRestoreSessions).toBe(false)
    expect(await acp.restoreSession("sess-1", { cwd: tmpdir() })).toBeUndefined()
  } finally {
    await acp.stop()
  }
})
