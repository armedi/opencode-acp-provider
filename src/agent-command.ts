import { basename } from "node:path"

/**
 * The executable a launch command runs, without its directory or a script
 * suffix, so a Windows shim and the bare name compare the same way.
 */
function executableName(command: string | string[]) {
  const argv = Array.isArray(command) ? command : [command]
  return basename(argv[0] ?? "")
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|js|mjs|cjs)$/, "")
}

/** True when the command starts Command Code. */
export function isCmdCommand(command: string | string[]) {
  const executable = executableName(command)
  if (["cmd", "cmdc", "commandcode", "command-code"].includes(executable)) return true
  if (!["node", "bun"].includes(executable) || !Array.isArray(command)) return false
  return /\/command-code\/dist\/(?:index|cli)\.mjs$/.test((command[1] ?? "").replace(/\\/g, "/"))
}
