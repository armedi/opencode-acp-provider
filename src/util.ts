import type { IncomingMessage } from "node:http"

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
