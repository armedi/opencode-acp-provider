import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AcpServerManager } from "../src/server-manager.ts"

const agent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url))
const dirs: string[] = []

async function cwd() {
  const dir = await mkdtemp(join(tmpdir(), "acp-manager-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function manager(
  options: {
    defaultCwd?: string
    additionalDirectories?: string[]
    agentArgs?: string[]
  } = {},
) {
  const instance = new AcpServerManager({
    servers: [
      {
        id: "fake",
        command: [process.execPath, agent, ...(options.agentArgs ?? [])],
        autoApprove: true,
      },
    ],
    defaultCwd: options.defaultCwd ?? tmpdir(),
    additionalDirectories: options.additionalDirectories,
  })
  return { instance }
}

test("discovers models and reuses a pooled session", async () => {
  const dir = await cwd()
  const { instance } = manager({ defaultCwd: dir })
  try {
    await instance.initialize()
    const state = instance.get("fake")
    expect(state?.initialized).toBe(true)
    expect(state?.models.map((model) => model.id)).toEqual(["fast", "slow"])
    expect(state?.efforts).toEqual(["low", "medium", "high"])

    const first = await instance.run({
      server: "fake",
      prompt: { fresh: "first", reused: "first-reused" },
      key: "ses_test",
      sessionKey: "ses_test",
    })
    expect(first.text).toBe("got:first")

    const second = await instance.run({
      server: "fake",
      prompt: { fresh: "second", reused: "second-reused" },
      key: "ses_test",
      sessionKey: "ses_test",
    })
    expect(second.text).toBe("got:second-reused")
  } finally {
    await instance.stop()
  }
})

test("passes additionalDirectories to fresh and pooled sessions", async () => {
  const dir = await cwd()
  const { instance } = manager({ defaultCwd: dir, additionalDirectories: ["/tmp/opencode-skills"] })
  try {
    await instance.initialize()
    const fresh = await instance.run({
      server: "fake",
      prompt: "directories",
      sessionKey: "ses_dirs",
    })
    expect(fresh.text).toBe("directories:/tmp/opencode-skills")

    const pooled = await instance.run({
      server: "fake",
      prompt: "directories",
      key: "ses_dirs",
      sessionKey: "ses_dirs",
    })
    expect(pooled.text).toBe("directories:/tmp/opencode-skills")
  } finally {
    await instance.stop()
  }
})

test("a failed turn drops the pool and the next turn starts a new session", async () => {
  const { instance } = manager()
  try {
    await instance.initialize()
    await expect(
      instance.run({ server: "fake", prompt: "please fail", key: "ses_fail", sessionKey: "ses_fail" }),
    ).rejects.toThrow("scripted failure")

    const recovered = await instance.run({
      server: "fake",
      prompt: "after failure",
      key: "ses_fail",
      sessionKey: "ses_fail",
    })
    expect(recovered.text).toBe("got:after failure")
  } finally {
    await instance.stop()
  }
})

test("a failed turn refuses the turns queued behind it", async () => {
  const { instance } = manager()
  try {
    await instance.initialize()
    const first = instance.run({
      server: "fake",
      prompt: "please fail",
      key: "ses_queue",
      sessionKey: "ses_queue",
    })
    const second = instance.run({
      server: "fake",
      prompt: "queued behind the failure",
      key: "ses_queue",
      sessionKey: "ses_queue",
    })
    // Capture both rejections without relying on matcher timing: the queued
    // turn rejects as soon as the first turn fails.
    const errors = Promise.all([
      first.then(
        () => undefined,
        (error: Error) => error.message,
      ),
      second.then(
        () => undefined,
        (error: Error) => error.message,
      ),
    ])
    const [firstError, secondError] = await errors
    expect(firstError).toBe("scripted failure")
    expect(secondError).toContain("no longer usable")
  } finally {
    await instance.stop()
  }
})

test("compacts the session's own ACP session with the agent's /compact", async () => {
  const { instance } = manager()
  try {
    await instance.initialize()
    await instance.run({ server: "fake", prompt: "first", key: "ses_compact", sessionKey: "ses_compact" })
    // sess-1 is the discovery session initialize() opens and closes; sess-2 holds the turn.
    expect(await instance.compact({ server: "fake", key: "ses_compact" })).toEqual({
      status: "compacted",
      text: "Compacted sess-2.",
    })
    const next = await instance.run({ server: "fake", prompt: { fresh: "f", reused: "r" }, key: "ses_compact" })
    expect(next.text).toBe("got:r")
  } finally {
    await instance.stop()
  }
})

test("never prompts /compact when the agent does not offer it", async () => {
  const { instance } = manager({ agentArgs: ["--no-commands"] })
  try {
    await instance.initialize()
    await instance.run({ server: "fake", prompt: "first", key: "ses_plain", sessionKey: "ses_plain" })
    expect(await instance.compact({ server: "fake", key: "ses_plain" })).toEqual({ status: "unsupported" })
  } finally {
    await instance.stop()
  }
})

test("does not open an ACP session just to compact it", async () => {
  const { instance } = manager()
  try {
    await instance.initialize()
    // Opening a session here would let the agent answer /compact and report "compacted".
    expect(await instance.compact({ server: "fake", key: "ses_none" })).toEqual({ status: "no-session" })
  } finally {
    await instance.stop()
  }
})
