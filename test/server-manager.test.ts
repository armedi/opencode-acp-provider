import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { AcpServerManager, type AcpSessionStore, type AcpUnsolicitedTurnInfo, type McpProvider } from "../src/server-manager.ts"
import { AgentPool } from "../src/agent-pool.ts"
import type { UnsolicitedTimingOptions } from "../src/unsolicited.ts"

const agent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url))
const dirs: string[] = []
const pools: AgentPool[] = []

async function cwd() {
  const dir = await mkdtemp(join(tmpdir(), "acp-manager-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.stop()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A pool a test can hand to several managers, stopped with the test. */
function agentPool() {
  const instance = new AgentPool()
  pools.push(instance)
  return instance
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Every request the fixture logged, in the order it received them. */
async function rpcRequests(file: string) {
  const text = await readFile(file, "utf8").catch(() => "")
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params?: Record<string, any> })
}

/** The sessions `session/new` opened, numbered the way the fixture numbers them. */
function newSessions(requests: Array<{ method: string; params?: Record<string, any> }>) {
  const sessions: Array<{ id: string; cwd?: string }> = []
  for (const request of requests) {
    if (request.method !== "session/new") continue
    sessions.push({ id: `sess-${sessions.length + 1}`, cwd: request.params?.cwd })
  }
  return sessions
}

/** Session ids closed in the log so far. */
async function closedSessions(file: string) {
  return (await rpcRequests(file))
    .filter((request) => request.method === "session/close")
    .map((request) => request.params?.sessionId)
}

async function pids(file: string) {
  const text = await readFile(file, "utf8").catch(() => "")
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
    maxSessions?: number
    mcp?: McpProvider
    agents?: AgentPool
    onModels?: (server: string) => void
    onUnsolicited?: (turn: AcpUnsolicitedTurnInfo) => void
    unsolicitedTiming?: UnsolicitedTimingOptions
    discoverCommands?: boolean
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
    maxSessions: options.maxSessions,
    mcp: options.mcp,
    agents: options.agents,
    onModels: options.onModels,
    onUnsolicited: options.onUnsolicited,
    unsolicitedTiming: options.unsolicitedTiming,
    discoverCommands: options.discoverCommands,
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

test("an agent without an ACP model selector only exposes its default", async () => {
  const { instance } = manager({ agentArgs: ["--echo-history", "--no-model-selector"] })
  try {
    await instance.initialize()
    expect(instance.get("fake")?.models.map((model) => model.id)).toEqual(["default"])
    const turn = await instance.run({ server: "fake", model: "default", key: "chat", prompt: "hello" })
    expect(JSON.parse(turn.text)).toMatchObject({ model: "fast", prompts: ["hello"] })
    await expect(instance.run({ server: "fake", model: "slow", key: "chat", prompt: "wrong model" })).rejects.toThrow(
      "does not expose an ACP model selector",
    )
  } finally {
    await instance.stop()
  }
})

test("reserves capacity for a starting session, then evicts it only when idle", async () => {
  const { instance } = manager({ maxSessions: 1 })
  const ready = Promise.withResolvers<void>()
  try {
    await instance.initialize()
    const first = instance.run({
      server: "fake", key: "first", prompt: "steer-me",
      onUpdate: (update) => { if (update.sessionUpdate === "agent_thought_chunk") ready.resolve() },
    })
    void first.catch(() => {})
    await expect(instance.run({ server: "fake", key: "next", prompt: "not yet" })).rejects.toThrow("capacity")
    await ready.promise
    instance.interrupt("first")
    expect((await first).stopReason).toBe("cancelled")
    expect((await instance.run({ server: "fake", key: "next", prompt: "now" })).text).toBe("got:now")
    expect((await instance.run({
      server: "fake", key: "first", prompt: { fresh: "replay", reused: "warm" },
    })).text).toBe("got:replay")
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

test("awaits the MCP provider and passes its servers to session/new", async () => {
  const calls: string[] = []
  let releases = 0
  const { instance } = manager({
    mcp: {
      async servers(_sessionKey, agent) {
        calls.push(agent.id)
        await Promise.resolve()
        return {
          servers: [{ type: "http", name: "remote", url: "https://example.test/mcp", headers: [] }],
          release: () => {
            releases++
          },
        }
      },
    },
  })
  try {
    await instance.initialize()
    const fresh = await instance.run({ server: "fake", prompt: "mcp servers", key: "chat", sessionKey: "ses_mcp" })
    expect(fresh.text).toBe("mcp:remote")
    expect(calls).toEqual(["fake"])

    // A pooled session keeps the servers it opened with and is not re-leased.
    const pooled = await instance.run({ server: "fake", prompt: "mcp servers", key: "chat", sessionKey: "ses_mcp" })
    expect(pooled.text).toBe("mcp:remote")
    expect(calls).toEqual(["fake"])
  } finally {
    await instance.stop()
  }
  expect(releases).toBe(1)
})

test("re-resolves MCP servers when replaying into a fresh ACP session", async () => {
  let calls = 0
  let releases = 0
  const { instance } = manager({
    agentArgs: ["--no-live-switch", "--echo-history"],
    mcp: {
      async servers() {
        calls++
        return {
          servers: [
            { type: "http", name: `remote-${calls}`, url: "https://example.test/mcp", headers: [] },
          ],
          release: () => {
            releases++
          },
        }
      },
    },
  })
  try {
    await instance.initialize()
    const first = JSON.parse((await instance.run({ server: "fake", key: "chat", prompt: "first" })).text)
    expect(first.mcpServers).toEqual(["remote-1"])
    expect(calls).toBe(1)

    const second = JSON.parse(
      (await instance.run({ server: "fake", model: "slow", key: "chat", prompt: "second" })).text,
    )
    expect(second.mcpServers).toEqual(["remote-2"])
    expect(calls).toBe(2)
    expect(releases).toBe(1)
  } finally {
    await instance.stop()
  }
  expect(releases).toBe(2)
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

test("a model without an effort select gets no effort, even the server default", async () => {
  const dir = await cwd()
  const rpcLog = join(dir, "rpc.jsonl")
  const learned: string[] = []
  const { instance } = manager({
    defaultCwd: dir,
    agentArgs: ["--echo-history", "--effortless-model", "slow", "--rpc-log", rpcLog],
    onModels: (server) => learned.push(server),
  })
  try {
    await instance.initialize()
    // Discovery reads only the default model; it does not switch through the others.
    expect(instance.get("fake")?.models).toEqual([
      { id: "fast", name: "Fast", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { id: "slow", name: "Slow" },
    ])
    const discovery = (await readFile(rpcLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    expect(discovery.some((request) => request.method === "session/set_config_option")).toBe(false)
    const turn = async (key: string, model: string, effort: string | undefined, text: string) =>
      JSON.parse((await instance.run({ server: "fake", key, model, effort, prompt: text })).text)

    expect(await turn("ses_plain", "slow", undefined, "plain")).toMatchObject({ model: "slow" })
    // Selecting the model reveals that it has no effort levels.
    expect(instance.get("fake")?.models[1]).toEqual({ id: "slow", name: "Slow", efforts: [] })
    expect(learned).toEqual(["fake"])
    // A variant carried over from another model is dropped, not sent.
    expect(await turn("ses_carried", "slow", "high", "carried")).toMatchObject({ model: "slow" })
    // Switching a live session onto the model keeps the session instead of replaying it.
    const first = await turn("ses_switch", "fast", "high", "first")
    const second = await turn("ses_switch", "slow", undefined, "second")
    expect(second).toMatchObject({ sessionId: first.sessionId, model: "slow", prompts: ["first", "second"] })

    const requests = (await readFile(rpcLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    const sessions = new Set([first.sessionId])
    const effortSets = requests.filter(
      (request) => request.method === "session/set_config_option" && request.params.configId === "effort",
    )
    expect(effortSets.map((request) => [sessions.has(request.params.sessionId), request.params.value])).toEqual([
      [true, "high"],
    ])
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

/** Give the fixture's held turn a moment to start before cancelling. */
const running = () => new Promise((resolve) => setTimeout(resolve, 200))

test("interrupts a running turn so OpenCode can deliver its follow-up", async () => {
  const { instance } = manager()
  try {
    await instance.initialize()
    const ready = Promise.withResolvers<void>()
    const turn = instance.run({
      server: "fake", prompt: "steer-me", key: "ses_fallback", sessionKey: "ses_fallback",
      onUpdate: (update) => { if (update.sessionUpdate === "agent_thought_chunk") ready.resolve() },
    })
    await ready.promise
    instance.interrupt("ses_fallback")
    expect(await turn).toEqual({ stopReason: "cancelled", text: "cancelled" })
    const next = await instance.run({
      server: "fake", key: "ses_fallback", prompt: { fresh: "replayed history", reused: "change of plan" },
    })
    expect(next.text).toBe("got:change of plan")
  } finally {
    await instance.stop()
  }
})

test("cancels a turn that is still starting when a message is steered", async () => {
  const { instance } = manager()
  try {
    await instance.initialize()
    const turn = instance.run({ server: "fake", prompt: "steer-me", key: "ses_starting", sessionKey: "ses_starting" })
    // No wait: the ACP session is still being negotiated, so no prompt exists yet.
    instance.interrupt("ses_starting")
    expect(await turn).toEqual({ stopReason: "cancelled", text: "cancelled" })
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

test("runs a server's setup before starting its agent", async () => {
  const dir = await cwd()
  const order = join(dir, "order.log")
  const instance = new AcpServerManager({
    servers: [
      {
        id: "fake",
        setup: `printf 'setup\\n' >> '${order}'`,
        command: ["sh", "-c", `printf 'agent\\n' >> '${order}'; exec '${process.execPath}' '${agent}'`],
        autoApprove: true,
      },
    ],
    defaultCwd: dir,
  })
  try {
    await instance.initialize()
    expect(instance.get("fake")?.initialized).toBe(true)
    expect((await readFile(order, "utf8")).trim().split("\n")).toEqual(["setup", "agent"])
  } finally {
    await instance.stop()
  }
})

test("does not count setup time against initTimeoutMs", async () => {
  const dir = await cwd()
  const marker = join(dir, "setup-marker")
  const instance = new AcpServerManager({
    servers: [
      {
        id: "fake",
        setup: `sleep 1; printf ready > '${marker}'`,
        command: [process.execPath, agent],
        autoApprove: true,
      },
    ],
    defaultCwd: dir,
    initTimeoutMs: 500,
  })
  try {
    await instance.initialize()
    const state = instance.get("fake")
    expect(state?.initialized).toBe(true)
    expect(state?.error).toBeUndefined()
    expect(await readFile(marker, "utf8")).toBe("ready")
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

test("shares agent discovery and learned variants across locations and reloads", async () => {
  const root = await cwd()
  const pidFile = join(root, "pids")
  const rpcFile = join(root, "rpc.jsonl")
  const dirOne = await cwd()
  const dirTwo = await cwd()
  const shared = agentPool()
  const agentArgs = ["--pid-log", pidFile, "--rpc-log", rpcFile, "--effortless-model", "slow"]
  const options = { agentArgs, agents: shared, discoverCommands: false }
  const first = manager({ ...options, defaultCwd: dirOne })
  const second = manager({ ...options, defaultCwd: dirTwo })
  const reloaded = manager({ ...options, defaultCwd: dirOne })
  try {
    await Promise.all([first.instance.initialize(), second.instance.initialize()])
    expect(newSessions(await rpcRequests(rpcFile))).toHaveLength(1)
    await first.instance.run({ server: "fake", model: "slow", prompt: "hi", key: "k1" })
    expect(second.instance.get("fake")?.models.find((model) => model.id === "slow")?.efforts).toEqual([])
    await second.instance.run({ server: "fake", prompt: "hi", key: "k1" })

    expect(await pids(pidFile)).toHaveLength(1)
    // Conversation sessions still open in each manager's own directory.
    const directories = new Set(newSessions(await rpcRequests(rpcFile)).map((session) => session.cwd))
    expect([...directories].sort()).toEqual([dirOne, dirTwo].sort())

    await first.instance.stop()
    const again = await second.instance.run({ server: "fake", prompt: "again", key: "k1" })
    expect(again.text).toBe("got:again")
    expect(await pids(pidFile)).toHaveLength(1)
    await second.instance.stop()

    await reloaded.instance.initialize()
    expect(reloaded.instance.get("fake")?.models.find((model) => model.id === "slow")?.efforts).toEqual([])
    expect(newSessions(await rpcRequests(rpcFile))).toHaveLength(3)
    expect((await reloaded.instance.run({ server: "fake", prompt: "after reload" })).text).toBe("got:after reload")
    expect(await pids(pidFile)).toHaveLength(2)
  } finally {
    await first.instance.stop()
    await second.instance.stop()
    await reloaded.instance.stop()
    await shared.stop()
  }
})

test("keeps command lists per manager", async () => {
  const dirOne = await cwd()
  const dirTwo = await cwd()
  const shared = agentPool()
  const agentArgs = ["--cwd-commands"]
  const first = manager({ defaultCwd: dirOne, agentArgs, agents: shared })
  const second = manager({ defaultCwd: dirTwo, agentArgs, agents: shared })
  try {
    await Promise.all([first.instance.initialize(), second.instance.initialize()])
    expect(first.instance.servers.get("fake")?.commands?.map((command) => command.name)).toEqual([
      "compact",
      `cwd-${basename(dirOne)}`,
    ])
    expect(second.instance.servers.get("fake")?.commands?.map((command) => command.name)).toEqual([
      "compact",
      `cwd-${basename(dirTwo)}`,
    ])
  } finally {
    await first.instance.stop()
    await second.instance.stop()
    await shared.stop()
  }
})

test("stopping one manager closes only its sessions", async () => {
  const root = await cwd()
  const pidFile = join(root, "pids")
  const sessionsFile = join(root, "sessions.json")
  const rpcFile = join(root, "rpc.jsonl")
  const dirOne = await cwd()
  const dirTwo = await cwd()
  const shared = agentPool()
  const agentArgs = ["--pid-log", pidFile, "--rpc-log", rpcFile, "--sessions-file", sessionsFile]
  const first = manager({ defaultCwd: dirOne, agentArgs, agents: shared })
  const second = manager({ defaultCwd: dirTwo, agentArgs, agents: shared })
  try {
    await first.instance.initialize()
    await second.instance.initialize()
    await first.instance.run({ server: "fake", prompt: "first", key: "k1" })
    await second.instance.run({ server: "fake", prompt: "second", key: "k1" })
    const sessions = newSessions(await rpcRequests(rpcFile))
    const firstTurn = sessions.filter((session) => session.cwd === dirOne).at(-1)!
    const secondTurn = sessions.filter((session) => session.cwd === dirTwo).at(-1)!

    await first.instance.stop()
    expect(await until(async () => (await closedSessions(rpcFile)).includes(firstTurn.id))).toBe(true)
    expect(await closedSessions(rpcFile)).not.toContain(secondTurn.id)

    // Manager 2 still holds its session on the shared process and reuses it.
    const opened = (await rpcRequests(rpcFile)).filter((request) => request.method === "session/new").length
    const next = await second.instance.run({ server: "fake", prompt: "next", key: "k1" })
    expect(next.text).toBe("got:next")
    expect((await rpcRequests(rpcFile)).filter((request) => request.method === "session/new")).toHaveLength(opened)
    expect(await pids(pidFile)).toHaveLength(1)
  } finally {
    await first.instance.stop()
    await second.instance.stop()
    await shared.stop()
  }
})

test("a late session/new after stop is closed", async () => {
  const root = await cwd()
  const gate = join(root, "ready")
  const rpcFile = join(root, "rpc.jsonl")
  const dirOne = await cwd()
  const dirTwo = await cwd()
  const shared = agentPool()
  const agentArgs = ["--initialize-gate", gate, "--rpc-log", rpcFile]
  const first = manager({ defaultCwd: dirOne, agentArgs, agents: shared })
  const second = manager({ defaultCwd: dirTwo, agentArgs, agents: shared })
  try {
    // The second manager keeps the shared process alive after the first releases it.
    const secondReady = second.instance.initialize()
    const pending = first.instance.run({ server: "fake", prompt: "hi", key: "k" }).then(
      () => "resolved",
      (error: Error) => error.message,
    )
    await wait(200)
    await first.instance.stop()
    await writeFile(gate, "")

    expect(await pending).toBe("ACP server manager is stopped")
    await secondReady
    expect(
      await until(async () => {
        const sessions = newSessions(await rpcRequests(rpcFile)).filter((session) => session.cwd === dirOne)
        const closed = await closedSessions(rpcFile)
        return sessions.length > 0 && sessions.every((session) => closed.includes(session.id))
      }),
    ).toBe(true)
  } finally {
    await first.instance.stop()
    await second.instance.stop()
    await shared.stop()
  }
})

test("hands a running conversation to the reloaded manager", async () => {
  const root = await cwd()
  const sessionsFile = join(root, "sessions.json")
  const rpcFile = join(root, "rpc.jsonl")
  const dir = await cwd()
  const shared = agentPool()
  const { entries, sessionStore } = store()
  const agentArgs = ["--sessions-file", sessionsFile, "--rpc-log", rpcFile]
  const old = manager({ defaultCwd: dir, agentArgs, agents: shared, sessions: sessionStore })
  const fresh = manager({ defaultCwd: dir, agentArgs, agents: shared, sessions: sessionStore })
  try {
    await old.instance.initialize()
    const oldTurn = old.instance.run({ server: "fake", prompt: "hang", key: "k" })
    // The fixture holds a `hang` turn open, so the prompt reaches it and stays there.
    expect(
      await until(async () => (await rpcRequests(rpcFile)).some((request) => request.method === "session/prompt")),
    ).toBe(true)

    let freshSettled = false
    const freshRun = fresh.instance.run({ server: "fake", prompt: "next", key: "k" }).finally(() => {
      freshSettled = true
    })
    void freshRun.catch(() => {})
    await wait(200)
    expect(freshSettled).toBe(false)

    old.instance.interrupt("k")
    expect(await oldTurn).toEqual({ stopReason: "cancelled", text: "cancelled" })
    expect((await freshRun).text).toBe("got:next")

    const stored = [...entries.values()][0]
    const requests = await rpcRequests(rpcFile)
    const resume = requests.findIndex(
      (request) => request.method === "session/resume" && request.params?.sessionId === stored,
    )
    const close = requests.findIndex(
      (request) => request.method === "session/close" && request.params?.sessionId === stored,
    )
    expect(close).toBeGreaterThan(-1)
    expect(resume).toBeGreaterThan(close)

    const closes = (await closedSessions(rpcFile)).filter((sessionId) => sessionId === stored).length
    await old.instance.stop()
    await wait(200)
    expect((await closedSessions(rpcFile)).filter((sessionId) => sessionId === stored)).toHaveLength(closes)

    expect((await fresh.instance.run({ server: "fake", prompt: "later", key: "k" })).text).toBe("got:later")
  } finally {
    await old.instance.stop()
    await fresh.instance.stop()
    await shared.stop()
  }
})

test("stops a running turn when its manager stops", async () => {
  const root = await cwd()
  const rpcFile = join(root, "rpc.jsonl")
  const dirOne = await cwd()
  const dirTwo = await cwd()
  const shared = agentPool()
  const agentArgs = ["--rpc-log", rpcFile]
  const first = manager({ defaultCwd: dirOne, agentArgs, agents: shared })
  const second = manager({ defaultCwd: dirTwo, agentArgs, agents: shared })
  try {
    await first.instance.initialize()
    await second.instance.initialize()
    // The second manager keeps the shared process alive after the first releases it.
    const turn = first.instance.run({ server: "fake", prompt: "hang", key: "k" })
    const settled = turn.then(
      (result) => result,
      (error: Error) => error.message,
    )
    expect(
      await until(async () => (await rpcRequests(rpcFile)).some((request) => request.method === "session/prompt")),
    ).toBe(true)

    await first.instance.stop()
    const outcome = await Promise.race([settled, wait(2_000).then(() => "pending" as const)])
    expect(outcome).not.toBe("pending")
    expect(outcome).toMatchObject({ stopReason: "cancelled" })
  } finally {
    await first.instance.stop()
    await second.instance.stop()
    await shared.stop()
  }
})

test("captures background shell completion, remaps toolCallId, and streams without duplicate session/prompt", async () => {
  const dir = await cwd()
  const rpcFile = join(dir, "rpc.jsonl")
  const woken: AcpUnsolicitedTurnInfo[] = []
  const { instance } = manager({
    defaultCwd: dir,
    agentArgs: ["--rpc-log", rpcFile],
    onUnsolicited: (turn) => woken.push(turn),
    unsolicitedTiming: { awaitingResponseMs: 300, postUsageMs: 50, messageIdleMs: 150 },
  })
  try {
    await instance.initialize()
    const turn1Updates: Array<{ sessionUpdate: string; toolCallId?: unknown; status?: unknown }> = []
    const turn1 = await instance.run({
      server: "fake",
      key: "ses_bg",
      sessionKey: "ses_bg",
      prompt: "background-shell",
      onUpdate: (update) =>
        turn1Updates.push({
          sessionUpdate: update.sessionUpdate,
          toolCallId: update.toolCallId,
          status: update.status,
        }),
    })
    expect(turn1).toEqual({ stopReason: "end_turn", text: "waiting" })
    expect(turn1Updates).toContainEqual({
      sessionUpdate: "tool_call",
      toolCallId: "bg-1",
      status: "in_progress",
    })

    expect(await until(() => woken.length === 1)).toBe(true)
    const wake = woken[0]!
    expect(wake.sessionKey).toBe("ses_bg")
    expect(wake.description).toBe("Background command finished: sleep 1 && echo bg-ok")
    expect(instance.hasContinuation("ses_bg", wake.token)).toBe(true)
    expect(instance.findContinuationByText("ses_bg", wake.text)).toBe(wake.token)

    const turn2Updates: Array<{ sessionUpdate: string; toolCallId?: unknown; status?: unknown; rawOutput?: unknown }> = []
    const turn2 = await instance.run({
      server: "fake",
      key: "ses_bg",
      sessionKey: "ses_bg",
      prompt: { fresh: wake.text, reused: wake.text },
      continuation: wake.token,
      onUpdate: (update) =>
        turn2Updates.push({
          sessionUpdate: update.sessionUpdate,
          toolCallId: update.toolCallId,
          status: update.status,
          rawOutput: update.rawOutput,
        }),
    })
    expect(turn2).toEqual({ stopReason: "end_turn", text: "background done" })
    expect(turn2Updates.find((item) => item.sessionUpdate === "tool_call_update")).toMatchObject({
      toolCallId: "bg-1:result",
      status: "completed",
    })

    const promptCalls = (await rpcRequests(rpcFile)).filter((request) => request.method === "session/prompt")
    expect(promptCalls).toHaveLength(1)

    // Expired or unknown continuation tokens never issue a fallback session/prompt.
    const orphan = await instance.run({
      server: "fake",
      key: "ses_bg",
      sessionKey: "ses_bg",
      prompt: { fresh: "orphan", reused: "orphan" },
      continuation: wake.token,
    })
    expect(orphan).toEqual({ stopReason: "end_turn", text: "" })
    expect((await rpcRequests(rpcFile)).filter((request) => request.method === "session/prompt")).toHaveLength(1)
  } finally {
    await instance.stop()
  }
})

test("interrupts an attached unsolicited continuation and notifies the agent", async () => {
  const dir = await cwd()
  const rpcFile = join(dir, "rpc.jsonl")
  const woken: AcpUnsolicitedTurnInfo[] = []
  const { instance } = manager({
    defaultCwd: dir,
    agentArgs: ["--rpc-log", rpcFile],
    onUnsolicited: (turn) => woken.push(turn),
    unsolicitedTiming: { awaitingResponseMs: 5_000, postUsageMs: 5_000 },
  })
  try {
    await instance.initialize()
    await instance.run({
      server: "fake",
      key: "ses_bg_int",
      sessionKey: "ses_bg_int",
      prompt: "background-shell",
    })
    expect(await until(() => woken.length === 1)).toBe(true)

    const attached = instance.run({
      server: "fake",
      key: "ses_bg_int",
      sessionKey: "ses_bg_int",
      prompt: { fresh: woken[0]!.text, reused: woken[0]!.text },
      continuation: woken[0]!.token,
    })
    await wait(30)
    expect(instance.running("ses_bg_int")).toBe(true)
    instance.interrupt("ses_bg_int")
    const result = await attached
    expect(result.stopReason).toBe("cancelled")
  } finally {
    await instance.stop()
  }
})
