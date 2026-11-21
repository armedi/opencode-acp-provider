import type { IncomingMessage, Server, ServerResponse } from "node:http"

export class BodyTooLargeError extends Error {}

/**
 * Read a request body as UTF-8, rejecting with `BodyTooLargeError` past
 * `maxBytes`. The request is left open so the caller can send its 413 before
 * destroying it; destroying here would take the response down with it.
 */
export function readBody(req: IncomingMessage, maxBytes: number) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    req.on("data", (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        settled = true
        reject(new BodyTooLargeError(`Request body exceeds ${maxBytes} bytes`))
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    req.on("end", () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString("utf8"))
    })
    req.on("error", (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

/** Wait `ms`, rejecting with the signal's reason if it aborts first. */
export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"))
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error("aborted"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** Authorization header for OpenCode's local server. */
export function basicAuth(password: string) {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`
}

/** The agent's display name without the " (ACP)" provider suffix. */
export function agentName(config: { name?: string; id: string }) {
  return (config.name ?? config.id).replace(/\s*\(ACP\)$/, "")
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function extractErrorMessage(error: unknown, seen: Set<unknown>): string | undefined {
  if (error === null || error === undefined) return undefined
  if (typeof error === "string") return nonEmptyString(error)
  if (typeof error !== "object") return String(error)
  if (seen.has(error)) return undefined
  seen.add(error)

  const record = error as Record<string, unknown>
  const direct = nonEmptyString(record.message)
  if (direct) return direct

  const data = record.data
  if (data && typeof data === "object") {
    const nested = nonEmptyString((data as Record<string, unknown>).message)
    if (nested) return nested
  }

  if ("cause" in record && record.cause !== undefined) {
    const caused = extractErrorMessage(record.cause, seen)
    if (caused) return caused
  }

  if ("error" in record && record.error !== undefined) {
    const inner = extractErrorMessage(record.error, seen)
    if (inner) return inner
  }

  if (Array.isArray(record.errors)) {
    const parts = record.errors
      .map((item) => extractErrorMessage(item, seen))
      .filter((item): item is string => Boolean(item))
    if (parts.length) return parts.join("; ")
  }

  const tag = nonEmptyString(record._tag) ?? nonEmptyString(record.name)
  if (tag) return tag

  try {
    const text = String(error).trim()
    if (text && text !== "[object Object]") return text
  } catch {
    // null-prototype or otherwise unconvertible
  }

  try {
    const json = JSON.stringify(error)
    if (json && json !== "{}") return json
  } catch {
    // circular or otherwise unserializable
  }

  return undefined
}

/** The message of a thrown value, whatever was thrown. */
export function errorMessage(error: unknown): string {
  return extractErrorMessage(error, new Set()) ?? "Unknown error"
}

/** Listen on an ephemeral loopback port and return it. */
export async function listenLocal(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  return typeof address === "object" && address ? address.port : 0
}

/** End a response whose handler threw, with a 500 when nothing was sent yet. */
export function endFailedResponse(res: ServerResponse) {
  if (res.destroyed) return
  try {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
  } catch {
    // the connection was closed
  }
  try {
    if (!res.writableEnded) res.end()
  } catch {
    // the connection was closed
  }

}
