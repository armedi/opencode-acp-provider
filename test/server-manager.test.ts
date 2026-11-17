import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AcpServerManager, type AcpSessionStore } from "../src/server-manager.ts"

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

function store() {
  const entries = new Map<string, string>()
  const sessionStore: AcpSessionStore = {
    async get(key) {
      return entries.get(key)
    },
    async set(key, sessionId) {
      entries.set(key, sessionId)
    },
    async delete(key) {
      entries.delete(key)
    },
  }
  return { entries, sessionStore }
}

function manager(
  options: {
    defaultCwd?: string
    additionalDirectories?: string[]
    agentArgs?: string[]
    sessions?: AcpSessionStore
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
    sessions: options.sessions,
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

test("model and effort changes preserve history and serialize settings with their prompts", async () => {
  const dir = await cwd()
  const rpcLog = join(dir, "rpc.jsonl")
  const { instance } = manager({
    defaultCwd: dir,
    agentArgs: ["--echo-history", "--model-option-id", "engine", "--rpc-log", rpcLog],
  })
  const turn = async (model: string, effort: string | undefined, text: string) =>
    JSON.parse(
      (
        await instance.run({
          server: "fake",
          key: "ses_selection",
          model,
          effort,
          prompt: { fresh: `history replay: ${text}`, reused: text },
        })
      ).text,
    )
  try {
    const first = await turn("fast", "high", "first")
    const [second, third] = await Promise.all([
      turn("slow", "low", "second"),
      turn("fast", "high", "third"),
    ])
    const fourth = await turn("fast", undefined, "fourth")
    const fifth = await turn("fast", undefined, "fifth")
    expect(second).toMatchObject({ sessionId: first.sessionId, model: "slow", effort: "low" })
    expect(third).toMatchObject({ sessionId: first.sessionId, model: "fast", effort: "high" })
    expect(fourth).toMatchObject({ sessionId: first.sessionId, model: "fast", effort: "medium" })
    expect(fifth.prompts).toEqual(["history replay: first", "second", "third", "fourth", "fifth"])
    const requests = (await readFile(rpcLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    const lastPrompt = requests.findLastIndex((request) => request.method === "session/prompt")
    expect(requests[lastPrompt - 1].method).toBe("session/prompt")
  } finally {
    await instance.stop()
  }
})

test("an agent refusing live selection changes gets a fresh session with replayed history", async () => {
  const { instance } = manager({ agentArgs: ["--echo-history", "--no-live-switch"] })
  try {
    const first = JSON.parse((await instance.run({
      server: "fake", key: "ses_switch_fallback", model: "fast", effort: "high", prompt: "first",
    })).text)
    const second = JSON.parse((await instance.run({
      server: "fake", key: "ses_switch_fallback", model: "slow", effort: "low",
      prompt: { fresh: "first plus second", reused: "second" },
    })).text)
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(second).toMatchObject({ model: "slow", effort: "low", prompts: ["first plus second"] })
    const third = JSON.parse((await instance.run({
      server: "fake", key: "ses_switch_fallback", model: "slow", effort: "low",
      prompt: { fresh: "should not replay", reused: "third" },
    })).text)
    expect(third.sessionId).toBe(second.sessionId)
    expect(third.prompts).toEqual(["first plus second", "third"])
  } finally {
    await instance.stop()
  }
})

test("a failed turn keeps the ACP session so the next turn resumes its context", async () => {
  const { instance } = manager()
  try {
    await instance.initialize()
    await expect(
      instance.run({ server: "fake", prompt: "please fail", key: "ses_fail", sessionKey: "ses_fail" }),
    ).rejects.toThrow("scripted failure")

    const recovered = await instance.run({
      server: "fake",
      prompt: { fresh: "fresh after failure", reused: "reused after failure" },
      key: "ses_fail",
      sessionKey: "ses_fail",
    })
    // A fresh ACP session would receive the `fresh` prompt.
    expect(recovered.text).toBe("got:reused after failure")
  } finally {
    await instance.stop()
  }
})

test("runs a turn queued behind a failed one on the same session", async () => {
  const { instance } = manager()
  try {
    await instance.initialize()
    // Open the pool first so both turns below share its session.
    await instance.run({ server: "fake", prompt: "first", key: "ses_queue", sessionKey: "ses_queue" })
    const first = instance.run({
      server: "fake",
      prompt: "please fail",
      key: "ses_queue",
      sessionKey: "ses_queue",
    })
    const second = instance.run({
      server: "fake",
      prompt: { fresh: "fresh prologue", reused: "queued turn" },
      key: "ses_queue",
      sessionKey: "ses_queue",
    })
    const [firstError, secondResult] = await Promise.all([
      first.then(
        () => undefined,
        (error: Error) => error.message,
      ),
      second.then(
        (result) => result,
        (error: Error) => error.message,
      ),
    ])
    expect(firstError).toBe("scripted failure")
    expect(secondResult).toEqual({ stopReason: "end_turn", text: "got:queued turn" })
  } finally {
    await instance.stop()
  }
})

test("a cancelled turn keeps the session for the next prompt", async () => {
  const { instance } = manager()
  try {
    await instance.initialize()
    const controller = new AbortController()
    const turn = instance.run({
      server: "fake",
      prompt: "steer-me",
      key: "ses_cancel",
      sessionKey: "ses_cancel",
      signal: controller.signal,
    })
    await running()
    controller.abort()
    expect(await turn).toEqual({ stopReason: "cancelled", text: "cancelled" })

    const next = await instance.run({
      server: "fake",
      prompt: { fresh: "fresh prologue", reused: "after the cancel" },
      key: "ses_cancel",
      sessionKey: "ses_cancel",
    })
    expect(next.text).toBe("got:after the cancel")
  } finally {
    await instance.stop()
  }
})

test("resumes the stored ACP session in a new agent process", async () => {
  const dir = await cwd()
  const sessionsFile = join(dir, "sessions.json")
  const { entries, sessionStore } = store()
  const first = manager({ defaultCwd: dir, sessions: sessionStore, agentArgs: ["--sessions-file", sessionsFile] })
  await first.instance.initialize()
  const initial = await first.instance.run({
    server: "fake",
    prompt: { fresh: "first turn", reused: "never used" },
    key: "ses_resume",
    sessionKey: "ses_resume",
  })
  expect(initial.text).toBe("got:first turn")
  expect(entries.size).toBe(1)
  await first.instance.stop()

  const second = manager({ defaultCwd: dir, sessions: sessionStore, agentArgs: ["--sessions-file", sessionsFile] })
  try {
    await second.instance.initialize()
    const resumed = await second.instance.run({
      server: "fake",
      prompt: { fresh: "fresh after restart", reused: "resumed after restart" },
      key: "ses_resume",
      sessionKey: "ses_resume",
    })
    expect(resumed.text).toBe("got:resumed after restart")
  } finally {
    await second.instance.stop()
  }
})

test("starts a new session when the agent cannot restore one", async () => {
  const dir = await cwd()
  const sessionsFile = join(dir, "sessions.json")
  const { sessionStore } = store()
  const first = manager({ defaultCwd: dir, sessions: sessionStore, agentArgs: ["--sessions-file", sessionsFile] })
  await first.instance.initialize()
  await first.instance.run({ server: "fake", prompt: "first turn", key: "ses_plain_resume", sessionKey: "ses_plain_resume" })
  await first.instance.stop()

  // Same store and file, but the agent hides loadSession/resume.
  const second = manager({
    defaultCwd: dir,
    sessions: sessionStore,
    agentArgs: ["--sessions-file", sessionsFile, "--no-restore"],
  })
  try {
    await second.instance.initialize()
    const fresh = await second.instance.run({
      server: "fake",
      prompt: { fresh: "fresh after restart", reused: "should not be reused" },
      key: "ses_plain_resume",
      sessionKey: "ses_plain_resume",
    })
    expect(fresh.text).toBe("got:fresh after restart")
  } finally {
    await second.instance.stop()
  }
})

test("falls back to a new session when the agent forgot the stored one", async () => {
  const dir = await cwd()
  const sessionsFile = join(dir, "sessions.json")
  const written: string[] = []
  const sessionStore: AcpSessionStore = {
    async get() {
      return "sess-404"
    },
    async set(_key, sessionId) {
      written.push(sessionId)
    },
    async delete() {},
  }
  const { instance } = manager({ defaultCwd: dir, sessions: sessionStore, agentArgs: ["--sessions-file", sessionsFile] })
  try {
    await instance.initialize()
    const fresh = await instance.run({
      server: "fake",
      prompt: { fresh: "fresh prompt", reused: "should not be reused" },
      key: "ses_lost",
      sessionKey: "ses_lost",
    })
    expect(fresh.text).toBe("got:fresh prompt")
    // The dead id is replaced with the one the agent just created.
    expect(written).toHaveLength(1)
    expect(written[0]).not.toBe("sess-404")
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

/** The fixture holds "steer-me" open, so give it a moment to start before steering. */
const running = () => new Promise((resolve) => setTimeout(resolve, 200))

test("steers the running turn when the agent supports it", async () => {
  const { instance } = manager()
  try {
    await instance.initialize()
    const turn = instance.run({ server: "fake", prompt: "steer-me", key: "ses_steer", sessionKey: "ses_steer" })
    await running()
    expect(await instance.steer({ key: "ses_steer", text: "change of plan" })).toEqual({ status: "steered" })
    expect(await turn).toEqual({ stopReason: "end_turn", text: "steer:change of plan" })
  } finally {
    await instance.stop()
  }
})

test("interrupts the turn when the agent cannot steer", async () => {
  const { instance } = manager({ agentArgs: ["--no-steering"] })
  try {
    await instance.initialize()
    const turn = instance.run({ server: "fake", prompt: "steer-me", key: "ses_fallback", sessionKey: "ses_fallback" })
    await running()
    expect(await instance.steer({ key: "ses_fallback", text: "change of plan" })).toEqual({ status: "interrupted" })
    expect(await turn).toEqual({ stopReason: "cancelled", text: "cancelled" })
  } finally {
    await instance.stop()
  }
})

test("does not steer a session with no turn running", async () => {
  const { instance } = manager()
  try {
    await instance.initialize()
    expect(await instance.steer({ key: "ses_idle", text: "hello" })).toEqual({ status: "unavailable" })
  } finally {
    await instance.stop()
  }
})

test("cancels a turn that is still starting when a message is steered", async () => {
  const { instance } = manager({ agentArgs: ["--no-steering"] })
  try {
    await instance.initialize()
    const turn = instance.run({ server: "fake", prompt: "steer-me", key: "ses_starting", sessionKey: "ses_starting" })
    // No wait: the ACP session is still being negotiated, so no prompt exists yet.
    expect(await instance.steer({ key: "ses_starting", text: "change of plan" })).toEqual({ status: "interrupted" })
    expect(await turn).toEqual({ stopReason: "cancelled", text: "cancelled" })
  } finally {
    await instance.stop()
  }
})

test("interrupts instead of injecting a steer that carries attachments", async () => {
  const { instance } = manager()
  try {
    await instance.initialize()
    const turn = instance.run({ server: "fake", prompt: "steer-me", key: "ses_attached", sessionKey: "ses_attached" })
    await running()
    expect(await instance.steer({ key: "ses_attached", text: "change of plan", plain: false })).toEqual({
      status: "interrupted",
    })
    expect(await turn).toEqual({ stopReason: "cancelled", text: "cancelled" })
  } finally {
    await instance.stop()
  }
})

test("interrupts when the agent rejects the steer", async () => {
  const { instance } = manager()
  try {
    await instance.initialize()
    const turn = instance.run({ server: "fake", prompt: "steer-me", key: "ses_reject", sessionKey: "ses_reject" })
    await running()
    expect(await instance.steer({ key: "ses_reject", text: "please fail" })).toEqual({ status: "interrupted" })
    expect((await turn).stopReason).toBe("cancelled")
  } finally {
    await instance.stop()
  }
})

test("recycles a session that keeps failing", async () => {
  const { entries, sessionStore } = store()
  const { instance } = manager({ sessions: sessionStore })
  try {
    await instance.initialize()
    await instance.run({ server: "fake", prompt: "first", key: "ses_bad", sessionKey: "ses_bad" })
    expect(entries.size).toBe(1)
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(
        instance.run({ server: "fake", prompt: "please fail", key: "ses_bad", sessionKey: "ses_bad" }),
      ).rejects.toThrow("scripted failure")
    }
    // The stored id is dropped too, so the next turn cannot restore the wedge.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(entries.size).toBe(0)
    const next = await instance.run({
      server: "fake",
      prompt: { fresh: "fresh after the failures", reused: "should not be reused" },
      key: "ses_bad",
      sessionKey: "ses_bad",
    })
    expect(next.text).toBe("got:fresh after the failures")
  } finally {
    await instance.stop()
  }
})

test("resumes the stored session after the agent process crashes", async () => {
  const dir = await cwd()
  const sessionsFile = join(dir, "sessions.json")
  const { sessionStore } = store()
  const { instance } = manager({ defaultCwd: dir, sessions: sessionStore, agentArgs: ["--sessions-file", sessionsFile] })
  try {
    await instance.initialize()
    await instance.run({ server: "fake", prompt: "first", key: "ses_crash", sessionKey: "ses_crash" })
    await expect(
      instance.run({ server: "fake", prompt: "please crash", key: "ses_crash", sessionKey: "ses_crash" }),
    ).rejects.toThrow()

    const resumed = await instance.run({
      server: "fake",
      prompt: { fresh: "fresh after restart", reused: "resumed after restart" },
      key: "ses_crash",
      sessionKey: "ses_crash",
    })
    expect(resumed.text).toBe("got:resumed after restart")
  } finally {
    await instance.stop()
  }
})
