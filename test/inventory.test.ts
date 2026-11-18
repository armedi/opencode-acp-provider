import { expect, test } from "bun:test"
import { effortLevels, inventoryKey, parseInventory, readInventory, writeInventory } from "../src/inventory.ts"
import type { AcpServerConfig } from "../src/server-manager.ts"

function storage(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    async get(key: string) {
      return values.get(key)
    },
    async set(key: string, value: unknown) {
      values.set(key, value)
    },
  }
}

const server: AcpServerConfig = { id: "cmd", command: ["cmd", "acp"] }

test("shares a cache entry across locations but not across different commands or environments", () => {
  const key = inventoryKey(server)
  expect(inventoryKey({ ...server, cwd: "/repo/worktree" })).toBe(key)
  expect(inventoryKey({ ...server, name: "Command Code", mode: "auto-accept" })).toBe(key)
  expect(inventoryKey({ ...server, command: ["cmd2", "acp"] })).not.toBe(key)
  expect(inventoryKey({ ...server, env: { PROFILE: "work" } })).not.toBe(key)
  expect(inventoryKey({ ...server, models: ["fast"] })).not.toBe(key)
})

test("rejects a payload it cannot trust instead of registering a partial inventory", () => {
  expect(parseInventory(undefined)).toBeUndefined()
  expect(parseInventory({ v: 2, models: [{ id: "fast", name: "Fast" }], efforts: [] })).toBeUndefined()
  expect(parseInventory({ v: 1, models: [], efforts: [] })).toBeUndefined()
  expect(parseInventory({ v: 1, models: [{ id: "", name: "Fast" }] })).toBeUndefined()
  expect(parseInventory({ v: 1, models: [{ id: "fast" }] })).toBeUndefined()

  expect(parseInventory({ v: 1, models: [{ id: "fast", name: "Fast", description: "Quick" }], efforts: ["high", "high", "default", " "] })).toEqual({
    models: [{ id: "fast", name: "Fast", description: "Quick" }],
    efforts: ["high"],
  })
})

test("round-trips an inventory and treats unreadable storage as a miss", async () => {
  const store = storage()
  await writeInventory(store, server, { models: [{ id: "fast", name: "Fast" }], efforts: ["low"] })
  expect(await readInventory(store, server)).toEqual({ models: [{ id: "fast", name: "Fast" }], efforts: ["low"] })

  await store.set(inventoryKey(server), { v: 1, models: "nonsense" })
  expect(await readInventory(store, server)).toBeUndefined()

  const failing = {
    async get() {
      throw new Error("storage is down")
    },
    async set() {
      throw new Error("storage is down")
    },
  }
  expect(await readInventory(failing, server)).toBeUndefined()
  await expect(writeInventory(failing, server, { models: [{ id: "fast", name: "Fast" }], efforts: [] })).rejects.toThrow()
})

test("never caches an empty inventory and drops the implicit default effort", async () => {
  const store = storage()
  await writeInventory(store, server, { models: [], efforts: ["high"] })
  expect(store.values.size).toBe(0)
  expect(effortLevels(["default", "low", "low", "", "high"])).toEqual(["low", "high"])
})
