import { createHash } from "node:crypto"
import type { AcpModelInfo, AcpServerConfig } from "./server-manager.ts"

/**
 * A server's last discovered model inventory. Setup registers it before the
 * agent starts so a fresh location (a worktree, for example) has the models
 * immediately instead of waiting out discovery.
 */
export interface AcpInventory {
  models: AcpModelInfo[]
  efforts: string[]
}

/** Bump when the payload shape changes; an older entry is treated as a miss. */
const VERSION = 1
const MAX_MODELS = 1_000

interface Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

/**
 * Two configs with the same command and environment advertise the same models,
 * so the cache is shared across locations. The location is deliberately absent:
 * a worktree resolves its agent exactly like its parent checkout.
 */
function cacheInput(config: AcpServerConfig) {
  return {
    command: Array.isArray(config.command) ? config.command : [config.command],
    env: Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    models: config.models ?? null,
  }
}

export function inventoryKey(config: AcpServerConfig) {
  const digest = createHash("sha256").update(JSON.stringify(cacheInput(config))).digest("hex")
  return `acp-inventory/${digest}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Normalize the effort levels an agent advertised, dropping the implicit default. */
export function effortLevels(values: readonly string[]) {
  return [...new Set(values.filter((value) => typeof value === "string" && value !== "default" && value.trim()))]
}

/**
 * Parse a cached payload. Anything unexpected is a miss: a corrupt entry must
 * never prevent setup from registering the provider after discovery.
 */
export function parseInventory(value: unknown): AcpInventory | undefined {
  if (!isRecord(value) || value.v !== VERSION) return undefined
  if (!Array.isArray(value.models) || !value.models.length || value.models.length > MAX_MODELS) return undefined

  const models: AcpModelInfo[] = []
  for (const entry of value.models) {
    if (!isRecord(entry)) return undefined
    if (typeof entry.id !== "string" || !entry.id) return undefined
    if (typeof entry.name !== "string" || !entry.name) return undefined
    const model: AcpModelInfo = { id: entry.id, name: entry.name }
    if (typeof entry.description === "string" && entry.description) model.description = entry.description
    models.push(model)
  }

  const efforts = Array.isArray(value.efforts)
    ? effortLevels(value.efforts.filter((effort): effort is string => typeof effort === "string"))
    : []
  return { models, efforts }
}

export async function readInventory(storage: Storage | undefined, config: AcpServerConfig) {
  if (!storage) return undefined
  try {
    return parseInventory(await storage.get(inventoryKey(config)))
  } catch {
    return undefined
  }
}

export async function writeInventory(storage: Storage | undefined, config: AcpServerConfig, inventory: AcpInventory) {
  if (!storage || !inventory.models.length) return
  await storage.set(inventoryKey(config), {
    v: VERSION,
    models: inventory.models,
    efforts: inventory.efforts,
  })
}
