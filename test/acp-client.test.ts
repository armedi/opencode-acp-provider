import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AcpClient } from "../src/acp-client.ts"

const agent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url))

function client(options: { promptTimeoutMs?: number; requestTimeoutMs?: number } = {}) {
  return new AcpClient({
    command: process.execPath,
    args: [agent],
    cwd: tmpdir(),
    autoApprove: true,
    ...options,
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

test("forwards additionalDirectories when it creates a session", async () => {
  const acp = client()
  try {
    const session = await acp.newSession(tmpdir(), {
      additionalDirectories: ["/tmp/opencode-skills-a", "/tmp/opencode-skills-b"],
    })
    const result = await acp.prompt(session.sessionId, "directories")
    expect(result.text).toBe("directories:/tmp/opencode-skills-a,/tmp/opencode-skills-b")
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

test("newSession closes the session when the agent rejects a model", async () => {
  const acp = client()
  try {
    await expect(acp.newSession(tmpdir(), { model: "missing" })).rejects.toThrow("unknown model")
    // The client is still usable after the failed session.
    const session = await acp.newSession(tmpdir())
    expect(session.sessionId).toStartWith("sess-")
  } finally {
    await acp.stop()
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
