import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AcpClient } from "../src/acp-client.ts"
import { createCommandBridge } from "../src/commands.ts"
import { AcpServerManager } from "../src/server-manager.ts"

const agent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url))
const dirs: string[] = []

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "acp-commands-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A plugin context with just the domains the command bridge touches. */
function context(options: {
  skills?: Array<{ id: string; description?: string }>
  sessionModel?: { providerID: string; id: string }
}) {
  const added: Array<{ name: string; description?: string; execute: (input: any) => Promise<void> }> = []
  const prompts: Array<{ sessionID: string; text: string; delivery: string }> = []
  let currentSkills = options.skills ?? []
  // OpenCode replays every transform on `reload()`, which is how a rebuild
  // replaces the registered set. The fake has to do the same.
  let transform: ((editor: { add: (definition: any) => void }) => void) | undefined
  let emitSkillUpdate: (() => void) | undefined

  const replay = () => {
    added.length = 0
    transform?.({
      add: (definition) => {
        added.push(definition)
      },
    })
  }

  const ctx = {
    skill: {
      async list() {
        return { data: currentSkills }
      },
    },
    event: {
      subscribe(options: { signal?: AbortSignal }) {
        // A push-driven stream: the test emits `skill.updated` on demand.
        const pending: Array<(value: { type: string }) => void> = []
        const buffered: Array<{ type: string }> = []
        emitSkillUpdate = () => {
          const next = pending.shift()
          if (next) next({ type: "skill.updated" })
          else buffered.push({ type: "skill.updated" })
        }
        options.signal?.addEventListener("abort", () => {
          for (const resolve of pending.splice(0)) resolve({ type: "closed" })
        })
        return {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              if (buffered.length) {
                yield buffered.shift()!
                continue
              }
              const event = await new Promise<{ type: string }>((resolve) => pending.push(resolve))
              if (event.type === "closed") return
              yield event
            }
          },
        }
      },
    },
    command: {
      async transform(callback: (editor: { add: (definition: any) => void }) => void) {
        transform = callback
        replay()
        return { dispose: async () => {} }
      },
      async reload() {
        replay()
      },
    },
    session: {
      async get() {
        return { model: options.sessionModel }
      },
      async prompt(input: { sessionID: string; text: string; delivery: string }) {
        prompts.push(input)
      },
    },
  }

  /** Simulate background skill discovery finishing. */
  const lateSkills = (skills: Array<{ id: string; description?: string }>) => {
    currentSkills = skills
    emitSkillUpdate?.()
  }

  return {
    ctx: ctx as unknown as Parameters<typeof createCommandBridge>[0]["ctx"],
    added,
    prompts,
    lateSkills,
  }
}

/** A manager wired to the scripted agent, with no OpenCode sidelining it. */
async function managerWithCommands(agentArgs: string[] = []) {
  const manager = new AcpServerManager({
    servers: [{ id: "fake", command: [process.execPath, agent, ...agentArgs], autoApprove: true }],
    defaultCwd: await tempDir(),
  })
  await manager.initialize()
  return manager
}

test("captures and reports the advertised command list", async () => {
  const seen: Array<{ sessionId: string; names: string[] }> = []
  const acp = new AcpClient({
    command: process.execPath,
    args: [agent],
    cwd: tmpdir(),
    autoApprove: true,
    onCommands: (sessionId, commands) => seen.push({ sessionId, names: commands.map((c) => c.name) }),
  })
  try {
    const session = await acp.newSession(tmpdir())
    expect(await acp.waitForCommands(session.sessionId, 2_000)).toEqual([
      { name: "compact", description: "Summarize the conversation so far" },
    ])
    expect(acp.hasCommand(session.sessionId, "compact")).toBe(true)
    expect(acp.hasCommand(session.sessionId, "missing")).toBe(false)
    expect(seen).toEqual([{ sessionId: session.sessionId, names: ["compact"] }])
  } finally {
    await acp.stop()
  }
})

test("skips advertising nothing when the agent has no commands", async () => {
  const seen: string[][] = []
  const acp = new AcpClient({
    command: process.execPath,
    args: [agent, "--no-commands"],
    cwd: tmpdir(),
    autoApprove: true,
    onCommands: (_sessionId, commands) => seen.push(commands.map((c) => c.name)),
  })
  try {
    const session = await acp.newSession(tmpdir())
    expect(await acp.waitForCommands(session.sessionId, 300)).toBeUndefined()
    expect(acp.hasCommand(session.sessionId, "compact")).toBe(false)
    expect(seen).toEqual([])
  } finally {
    await acp.stop()
  }
})

test("registers a namespaced command and forwards its arguments to the session", async () => {
  const manager = await managerWithCommands()
  const { ctx, added, prompts } = context({
    sessionModel: { providerID: "acp-fake", id: "fast" },
  })
  const bridge = await createCommandBridge({
    ctx,
    manager,
    serverForProvider: (providerID) => (providerID === "acp-fake" ? "fake" : undefined),
    log: () => {},
  })
  try {
    expect(added.map((command) => command.name)).toEqual(["fake:compact"])
    expect(added[0].description).toBe("Summarize the conversation so far")
    await added[0].execute({ sessionID: "ses-1", prompt: { text: "extra detail" }, delivery: "queue" })
    expect(prompts).toEqual([
      { sessionID: "ses-1", text: "/compact extra detail", delivery: "queue" },
    ])
  } finally {
    await bridge.close()
    await manager.stop()
  }
})

test("refuses a command whose server is not the session's model", async () => {
  const manager = await managerWithCommands()
  const { ctx, added, prompts } = context({
    sessionModel: { providerID: "acp-other", id: "fast" },
  })
  const bridge = await createCommandBridge({
    ctx,
    manager,
    serverForProvider: (providerID) => (providerID === "acp-fake" ? "fake" : undefined),
    log: () => {},
  })
  try {
    await expect(
      added[0].execute({ sessionID: "ses-1", prompt: { text: "" }, delivery: "queue" }),
    ).rejects.toThrow("belongs to fake")
    expect(prompts).toEqual([])
  } finally {
    await bridge.close()
    await manager.stop()
  }
})

test("filters commands that restate a skill, matched by description", async () => {
  const manager = await managerWithCommands()
  const { ctx, added } = context({
    // Same text the agent advertises, without the provenance the plugin strips.
    skills: [{ id: "compact", description: "Summarize the conversation so far" }],
  })
  const bridge = await createCommandBridge({
    ctx,
    manager,
    serverForProvider: () => undefined,
    log: () => {},
  })
  try {
    expect(added).toEqual([])
  } finally {
    await bridge.close()
    await manager.stop()
  }
})

test("keeps a command whose description differs from every skill", async () => {
  const manager = await managerWithCommands()
  const { ctx, added } = context({
    // A skill that happens to share the command's name must not hide it.
    skills: [{ id: "compact", description: "Something else entirely" }],
  })
  const bridge = await createCommandBridge({
    ctx,
    manager,
    serverForProvider: () => undefined,
    log: () => {},
  })
  try {
    expect(added.map((command) => command.name)).toEqual(["fake:compact"])
  } finally {
    await bridge.close()
    await manager.stop()
  }
})

test("filters a skill the agent marks with its own sigil", async () => {
  // codex advertises its bundled skills as `$name`, and their descriptions do
  // not match any OpenCode skill, so the marker is the only signal.
  const manager = await managerWithCommands()
  manager.get("fake")!.commands = [
    { name: "$skill-creator", description: "Create or update a skill" },
    { name: "status", description: "Show the current status" },
  ]
  const { ctx, added } = context({})
  const bridge = await createCommandBridge({
    ctx,
    manager,
    serverForProvider: () => undefined,
    log: () => {},
  })
  try {
    expect(added.map((command) => command.name)).toEqual(["fake:status"])
  } finally {
    await bridge.close()
    await manager.stop()
  }
})

test("rebuilds the registered commands when the agent advertises a new list", async () => {
  const manager = await managerWithCommands()
  const state = manager.get("fake")!
  const { ctx, added } = context({})
  const bridge = await createCommandBridge({
    ctx,
    manager,
    serverForProvider: () => undefined,
    log: () => {},
  })
  try {
    expect(added.map((command) => command.name)).toEqual(["fake:compact"])

    state.commands = [
      { name: "compact", description: "Summarize the conversation so far" },
      { name: "review", description: "Review the current diff" },
    ]
    await bridge.sync("fake")

    expect(added.map((command) => command.name)).toEqual(["fake:compact", "fake:review"])
  } finally {
    await bridge.close()
    await manager.stop()
  }
})

test("filters skills that OpenCode discovers after the bridge starts", async () => {
  // Skills are loaded in the background, so they are missing from the list the
  // bridge reads at setup. The command must drop out once they arrive.
  const manager = await managerWithCommands()
  const { ctx, added, lateSkills } = context({})
  const bridge = await createCommandBridge({
    ctx,
    manager,
    serverForProvider: () => undefined,
    log: () => {},
  })
  try {
    expect(added.map((command) => command.name)).toEqual(["fake:compact"])

    lateSkills([{ id: "compact", description: "Summarize the conversation so far" }])
    await waitFor(() => added.length === 0)

    expect(added).toEqual([])
  } finally {
    await bridge.close()
    await manager.stop()
  }
})

/** Let the skill.updated stream deliver and its rebuild settle. */
async function waitFor(predicate: () => boolean, attempts = 50) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
