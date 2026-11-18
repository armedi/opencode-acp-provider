import { constants } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The default name carries the uid because `os.tmpdir()` is the shared `/tmp`
 * on Linux, where another user could otherwise claim the name first.
 */
const FILE =
  process.env.ACP_PLUGIN_LOG ??
  join(tmpdir(), typeof process.getuid === "function" ? `opencode-acp-${process.getuid()}.log` : "opencode-acp.log")
const MAX_BYTES = 10 * 1024 * 1024
// Agent stderr can contain credentials, so keep the file private to this user.
const FILE_MODE = 0o600
// Never follow a symlink planted at the log path.
const OPEN_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0)

let queue: Promise<void> = Promise.resolve()
let bytes = 0
/** undefined: not opened yet; null: the file is unusable, so logging is off. */
let handle: FileHandle | null | undefined

/**
 * Open the log, refusing a file this user does not own or that is not a
 * regular file. `mode` only applies on creation, so an existing file that
 * others can read is tightened before anything is written to it.
 */
async function openLog(): Promise<FileHandle | null> {
  const file = await open(FILE, OPEN_FLAGS, FILE_MODE).catch(() => undefined)
  if (!file) return null
  try {
    const info = await file.stat()
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined
    if (!info.isFile() || (uid !== undefined && info.uid !== uid)) {
      await file.close().catch(() => {})
      return null
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) await file.chmod(FILE_MODE)
    bytes = info.size
    return file
  } catch {
    await file.close().catch(() => {})
    return null
  }
}

/**
 * Append one line to the debug log without blocking the event loop. Writes are
 * serialized, and the file is truncated once it grows past 10 MB.
 */
export function debugLog(scope: string, message: string) {
  const line = `${new Date().toISOString()} ${scope} ${message}\n`
  queue = queue
    .then(async () => {
      if (handle === undefined) handle = await openLog()
      if (!handle) return
      const size = Buffer.byteLength(line)
      if (bytes + size > MAX_BYTES) {
        // O_APPEND puts the next write at the new end.
        await handle.truncate(0).catch(() => {})
        bytes = 0
      }
      await handle.write(line).catch(() => {})
      bytes += size
    })
    .catch(() => {})
}
