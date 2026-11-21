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
    mcp: { transform: async () => registration, list: async () => ({ data: [] }) },
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
      mcp: { transform: async () => registration, list: async () => ({ data: [] }) },
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
      mcp: { transform: async () => registration, list: async () => ({ data: [] }) },
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
    mcp: { transform: async () => registration, list: async () => ({ data: [] }) },
  } as unknown as Plugin.Context)
  try {
    const request = (providerID: string): Request => ({
      model: { providerID },
      system: [{ type: "text", text: "Title instructions" }],
      messages: [
        {
          role: "user",
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
