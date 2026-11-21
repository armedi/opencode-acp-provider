import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import plugin from "../src/index.ts"
import { inventoryKey } from "../src/inventory.ts"

const agent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url))
type ProviderTransform = Parameters<Plugin.Context["provider"]["transform"]>[0]

test("loads without waiting for ACP and publishes each agent's models as it becomes ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-plugin-"))
  const gate = join(directory, "cmd-ready")
  const transforms = new Set<ProviderTransform>()
  const models = () => {
    const ids: string[] = []
    const editor = {
      add: (provider: Parameters<Parameters<ProviderTransform>[0]["add"]>[0]) => {
        ids.push(...provider.models.map((model) => model.modelID))
      },
    } as Parameters<ProviderTransform>[0]
    for (const transform of transforms) transform(editor)
    return ids.sort()
  }
  const waitForModels = async (count: number) => {
    const deadline = performance.now() + 3_000
    while (models().length < count && performance.now() < deadline) await delay(10)
    return models()
  }
  const registration = { dispose: async () => {} }
  const ctx = {
    location: { directory },
    options: {
      skills: false,
      mcp: false,
      commands: false,
      logLevel: "error",
      servers: [
        { id: "cmd", command: [process.execPath, agent, "--initialize-gate", gate] },
        { id: "other", command: [process.execPath, agent] },
      ],
    },
    provider: {
      async transform(transform: ProviderTransform) {
        transforms.add(transform)
        return { dispose: async () => void transforms.delete(transform) }
      },
      async reload() {},
    },
    session: { hook: async () => registration },
  } as unknown as Plugin.Context

  let timer: ReturnType<typeof setTimeout> | undefined
  const setup = Promise.resolve(plugin.setup(ctx))
  try {
    const cleanup = await Promise.race([
      setup,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("plugin setup waited for the blocked agent")), 2_000)
      }),
    ])
    expect(cleanup).toBeFunction()
    expect(await waitForModels(2)).toEqual(["other::fast", "other::slow"])

    await writeFile(gate, "")
    expect(await waitForModels(4)).toEqual(["cmd::fast", "cmd::slow", "other::fast", "other::slow"])
  } finally {
    clearTimeout(timer)
    await writeFile(gate, "")
    const cleanup = await setup.catch(() => undefined)
    await cleanup?.()
    await rm(directory, { recursive: true, force: true })
  }
  expect(models()).toEqual([])
}, 10_000)

test("registers cached models before the agent starts and refreshes them after discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-plugin-"))
  const gate = join(directory, "cmd-ready")
  try {
    const transforms = new Set<ProviderTransform>()
    const registered = () => {
      const models = new Map<string, string[]>()
      const editor = {
        add: (provider: Parameters<Parameters<ProviderTransform>[0]["add"]>[0]) => {
          for (const model of provider.models) {
            models.set(
              String(model.modelID),
              model.variants.map((variant) => String(variant.id)),
            )
          }
        },
      } as Parameters<ProviderTransform>[0]
      for (const transform of transforms) transform(editor)
      return models
    }
    const waitFor = async (check: () => boolean) => {
      const deadline = performance.now() + 3_000
      while (!check() && performance.now() < deadline) await delay(10)
      return check()
    }

    const values = new Map<string, unknown>()
    const config = { id: "cmd", command: [process.execPath, agent, "--initialize-gate", gate, "--effortless-model", "slow"] }
    // `slow` was selected by an earlier process, which learned it has no efforts.
    values.set(inventoryKey(config), {
      v: 1,
      models: [{ id: "cached", name: "Cached" }, { id: "slow", name: "Slow", efforts: [] }],
      efforts: ["high"],
    })
    const registration = { dispose: async () => {} }
    const ctx = {
      location: { directory },
      options: { skills: false, mcp: false, commands: false, logLevel: "error", servers: [config] },
      provider: {
        async transform(transform: ProviderTransform) {
          transforms.add(transform)
          return { dispose: async () => void transforms.delete(transform) }
        },
        async reload() {},
      },
      session: { hook: async () => registration },
      storage: {
        async get(key: string) {
          return values.get(key)
        },
        async set(key: string, value: unknown) {
          values.set(key, value)
        },
        async remove(key: string) {
          values.delete(key)
        },
      },
    } as unknown as Plugin.Context

    let timer: ReturnType<typeof setTimeout> | undefined
    const setup = Promise.resolve(plugin.setup(ctx))
    const cleanup = await Promise.race([
      setup,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("setup waited for the blocked agent")), 2_000)
      }),
    ])
    clearTimeout(timer)
    try {
      expect(cleanup).toBeFunction()
      // The cached model is selectable before the agent has answered.
      expect([...registered().keys()]).toEqual(["cmd::cached", "cmd::slow"])
      expect(registered().get("cmd::cached")).toEqual(["high"])
      expect(registered().get("cmd::slow")).toEqual([])

      await writeFile(gate, "")
      expect(await waitFor(() => registered().has("cmd::fast") && registered().has("cmd::slow"))).toBe(true)
      expect(registered().has("cmd::cached")).toBe(false)
      // A service restart refreshes the catalog. Other models are learned on selection.
      expect(registered().get("cmd::fast")).toEqual(["low", "medium", "high"])
      expect(registered().get("cmd::slow")).toEqual(["low", "medium", "high"])

      // Discovery replaces the cached entry with what the agent advertises.
      expect(await waitFor(() => {
        const cached = values.get(inventoryKey(config)) as { models?: Array<{ id: string }> } | undefined
        return cached?.models?.some((model) => model.id === "fast") === true
      })).toBe(true)
      const cached = values.get(inventoryKey(config)) as { v: number; models: Array<{ id: string }> }
      expect(cached.v).toBe(1)
      expect(cached.models.map((model) => model.id).sort()).toEqual(["fast", "slow"])
    } finally {
      await writeFile(gate, "")
      await cleanup?.()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

test("keeps cached models when the agent cannot start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-plugin-"))
  try {
    const transforms = new Set<ProviderTransform>()
    const models = () => {
      const ids: string[] = []
      const editor = {
        add: (provider: Parameters<Parameters<ProviderTransform>[0]["add"]>[0]) => {
          ids.push(...provider.models.map((model) => model.modelID))
        },
      } as Parameters<ProviderTransform>[0]
      for (const transform of transforms) transform(editor)
      return ids.sort()
    }
    const values = new Map<string, unknown>()
    const config = { id: "cmd", command: [process.execPath, "-e", "process.exit(1)"] }
    values.set(inventoryKey(config), { v: 1, models: [{ id: "cached", name: "Cached" }], efforts: [] })
    const registration = { dispose: async () => {} }
    const cleanup = await plugin.setup({
      location: { directory },
      options: { skills: false, mcp: false, commands: false, logLevel: "error", servers: [config] },
      provider: {
        async transform(transform: ProviderTransform) {
          transforms.add(transform)
          return { dispose: async () => void transforms.delete(transform) }
        },
        async reload() {},
      },
      session: { hook: async () => registration },
      storage: {
        async get(key: string) {
          return values.get(key)
        },
        async set() {},
        async remove() {},
      },
    } as unknown as Plugin.Context)
    try {
      expect(models()).toEqual(["cmd::cached"])
      // Discovery fails and schedules a retry; the cached provider stays usable.
      await delay(200)
      expect(models()).toEqual(["cmd::cached"])
    } finally {
      await cleanup?.()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

test("bounds fallback provider requests without rewriting other providers' prompts", async () => {
  type Request = {
    model: { providerID: string }
    system: Array<{ type: "text"; text: string }>
    messages: Array<{ role: string; content: Array<{ type: "text"; text: string }> }>
  }
  const hooks = new Map<string, (event: Request) => void>()
  const registration = { dispose: async () => {} }
  const cleanup = await plugin.setup({
    location: { directory: tmpdir() },
    options: {
      skills: false,
      mcp: false,
      commands: false,
      historyChars: 24,
      logLevel: "error",
      servers: [{ id: "fake", command: [process.execPath, agent] }],
    },
    provider: { transform: async () => registration },
    session: {
      async hook(name: string, handler: (event: Request) => void) {
        hooks.set(name, handler)
        return registration
      },
    },
  } as unknown as Plugin.Context)
  try {
    const request = (providerID: string): Request => ({
      model: { providerID },
      system: [{ type: "text", text: "Title instructions" }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: `${"old transcript ".repeat(1_000)}abcdefghijklmnopqrstuvwxyz` }],
        },
        { role: "user", content: [{ type: "text", text: "latest" }] },
      ],
    })
    const other = request("other")
    await hooks.get("context")!(other)
    expect(other).toEqual(request("other"))

    const primary = request("acp-fake")
    await hooks.get("context")!(primary)
    expect(primary.system).toEqual([])
    expect(primary.messages[0].content[0].text).toBe("bcdefghijklmnopqrstuvwxyz")
    expect(primary.messages[1].content[0].text).toBe("latest")

    const title = request("acp-fake")
    await hooks.get("title")!(title)
    expect(title.system).toEqual(request("acp-fake").system)
    expect(title.messages).toEqual(primary.messages)
  } finally {
    await cleanup?.()
  }
})

test("only a lone background wake attaches its continuation to the turn", async () => {
  const hooks = new Map<string, (event: any) => void>()
  const registration = { dispose: async () => {} }
  const cleanup = await plugin.setup({
    location: { directory: tmpdir() },
    options: {
      skills: false,
      mcp: false,
      commands: false,
      logLevel: "error",
      servers: [{ id: "fake", command: [process.execPath, agent] }],
    },
    provider: { transform: async () => registration },
    session: {
      async hook(name: string, handler: (event: any) => void) {
        hooks.set(name, handler)
        return registration
      },
    },
  } as unknown as Plugin.Context)
  try {
    const context = (messages: unknown[]) => ({
      sessionID: "ses_wake_queue",
      model: { providerID: "acp-fake", modelID: "fake::fast" },
      system: [],
      messages,
    })
    const request = () => ({
      sessionID: "ses_wake_queue",
      model: { providerID: "acp-fake", modelID: "fake::fast" },
      kind: "primary",
      headers: {} as Record<string, string>,
    })

    // A lone wake attaches even with a stripped <system-update> beside it.
    hooks.get("context")!(context([
      { role: "assistant", content: [{ type: "text", text: "waiting" }] },
      {
        role: "user",
        content: [{ type: "text", text: "Background command finished: sleep 1" }],
        metadata: { source: "acp-background", acpContinuation: "cont-1" },
      },
      { role: "user", content: [{ type: "text", text: "<system-update>\nTool catalog changed\n</system-update>" }] },
    ]))
    const lone = request()
    hooks.get("model.request")!(lone)
    expect(lone.headers["x-acp-continuation"]).toBe("cont-1")

    // A wake queued behind another pending message must run as a normal prompt.
    hooks.get("context")!(context([
      { role: "assistant", content: [{ type: "text", text: "waiting" }] },
      { role: "user", content: [{ type: "text", text: "<subagent>\nBackground finding.\n</subagent>" }] },
      {
        role: "user",
        content: [{ type: "text", text: "Background command finished: sleep 1" }],
        metadata: { source: "acp-background", acpContinuation: "cont-2" },
      },
    ]))
    const queued = request()
    hooks.get("model.request")!(queued)
    expect(queued.headers["x-acp-continuation"]).toBeUndefined()
  } finally {
    await cleanup?.()
  }
})

test("wakes OpenCode via session.synthetic when a background task completes and streams the continuation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "acp-plugin-bg-"))
  const registration = { dispose: async () => {} }
  const hooks = new Map<string, (event: any) => Promise<void> | void>()
  let sdkHook: ((event: any) => void) | undefined
  const synthetics: Array<Record<string, unknown>> = []
  let activeProviderID = "acp-fake"

  const cleanup = await plugin.setup({
    location: { directory },
    options: {
      skills: false,
      mcp: false,
      commands: false,
      logLevel: "error",
      servers: [{ id: "fake", command: [process.execPath, agent] }],
    },
    provider: {
      async transform() {
        return registration
      },
      async reload() {},
    },
    aisdk: {
      async hook(_name: string, handler: (event: any) => void) {
        sdkHook = handler
        return registration
      },
    },
    session: {
      async hook(name: string, handler: (event: any) => Promise<void> | void) {
        hooks.set(name, handler)
        return registration
      },
      async get() {
        return { model: { providerID: activeProviderID, modelID: "fast" } }
      },
      async synthetic(input: Record<string, unknown>) {
        synthetics.push(input)
      },
    },
  } as unknown as Plugin.Context)

  try {
    expect(sdkHook).toBeFunction()
    const sdkEvent: any = {
      package: "acp",
      model: { providerID: "acp-fake", modelID: "fake::fast" },
    }
    sdkHook!(sdkEvent)
    const model = sdkEvent.sdk.languageModel()

    const readStream = async (stream: ReadableStream<any>) => {
      const reader = stream.getReader()
      const parts: any[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return parts
        parts.push(value)
      }
    }

    const first = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "background-shell" }] }],
      headers: { "x-opencode-session-id": "ses_e2e_bg" },
    })
    const firstParts = await readStream(first.stream)
    expect(firstParts.find((part) => part.type === "tool-result")).toMatchObject({
      toolCallId: "bg-1",
      toolName: "shell",
      result: "Running in background.",
    })

    const deadline = Date.now() + 2_000
    while (synthetics.length === 0 && Date.now() < deadline) await delay(15)
    expect(synthetics).toHaveLength(1)
    const wake = synthetics[0]!
    expect(wake.sessionID).toBe("ses_e2e_bg")
    expect(wake.description).toBe("Background command finished: sleep 1 && echo bg-ok")
    expect(wake.delivery).toBe("queue")
    expect(wake.resume).toBe(true)

    // Simulate OpenCode running the woken turn through context -> model.request -> doStream.
    await hooks.get("context")!({
      sessionID: "ses_e2e_bg",
      model: { providerID: "acp-fake", modelID: "fake::fast" },
      system: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "background-shell" }] },
        { role: "assistant", content: [{ type: "text", text: "waiting" }] },
        {
          role: "user",
          content: [{ type: "text", text: String(wake.text) }],
          metadata: wake.metadata,
        },
      ],
    })
    const reqEvent: any = {
      sessionID: "ses_e2e_bg",
      model: { providerID: "acp-fake", modelID: "fake::fast" },
      kind: "primary",
      headers: {},
    }
    await hooks.get("model.request")!(reqEvent)
    expect(reqEvent.headers["x-acp-continuation"]).toBeString()

    const second = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: String(wake.text) }] }],
      headers: {
        "x-opencode-session-id": "ses_e2e_bg",
        ...reqEvent.headers,
      },
    })
    const secondParts = await readStream(second.stream)
    expect(secondParts.find((part) => part.type === "tool-result")).toMatchObject({
      toolCallId: "bg-1:result",
      toolName: "shell",
      result: "bg-ok",
    })
    const textDeltas = secondParts
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join("")
    expect(textDeltas).toBe("background done")

    // Switching providers skips waking the session for late ACP updates.
    activeProviderID = "openai"
    const switched = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "background-shell" }] }],
      headers: { "x-opencode-session-id": "ses_e2e_switched" },
    })
    await readStream(switched.stream)
    await delay(150)
    expect(synthetics).toHaveLength(1)
  } finally {
    await cleanup?.()
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)
