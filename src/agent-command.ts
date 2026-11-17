import { basename } from "node:path"

/**
 * The executable a launch command runs, without its directory or a script
 * suffix, so a Windows shim and the bare name compare the same way.
 */
export function executableName(command: string | string[]) {
  const argv = Array.isArray(command) ? command : [command]
  return basename(argv[0] ?? "")
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|js|mjs|cjs)$/, "")
}

/** True when the command starts Command Code. */
export function isCmdCommand(command: string | string[]) {
  return ["cmd", "cmdc", "commandcode"].includes(executableName(command))
}
