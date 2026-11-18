import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import plugin from "../src/index.ts"

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
    mcp: { transform: async () => registration, list: async () => [] },
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
