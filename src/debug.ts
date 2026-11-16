import { appendFile, stat, writeFile } from "node:fs/promises"

const FILE = process.env.ACP_PLUGIN_LOG ?? "/tmp/opencode-acp.log"
const MAX_BYTES = 10 * 1024 * 1024

let queue: Promise<void> = Promise.resolve()
let bytes = 0
let measured = false

/**
 * Append one line to the debug log without blocking the event loop. Writes are
 * serialized, and the file is truncated once it grows past 10 MB.
 */
export function debugLog(scope: string, message: string) {
  const line = `${new Date().toISOString()} ${scope} ${message}\n`
  queue = queue
    .then(async () => {
      if (!measured) {
        measured = true
        bytes = await stat(FILE).then((info) => info.size).catch(() => 0)
      }
      if (bytes + line.length > MAX_BYTES) {
        await writeFile(FILE, "").catch(() => {})
        bytes = 0
      }
      await appendFile(FILE, line).catch(() => {})
      bytes += line.length
    })
    .catch(() => {})
}
