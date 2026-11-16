import { appendFile, chmod, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const FILE = process.env.ACP_PLUGIN_LOG ?? join(tmpdir(), "opencode-acp.log")
const MAX_BYTES = 10 * 1024 * 1024
// Agent stderr can contain credentials, so keep the file private to this user.
const FILE_MODE = 0o600

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
        await chmod(FILE, FILE_MODE).catch(() => {})
      }
      if (bytes + line.length > MAX_BYTES) {
        await writeFile(FILE, "", { mode: FILE_MODE }).catch(() => {})
        bytes = 0
      }
      await appendFile(FILE, line, { mode: FILE_MODE }).catch(() => {})
      bytes += line.length
    })
    .catch(() => {})
}
