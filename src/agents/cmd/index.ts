import { fileURLToPath } from "node:url"
import { isCmdCommand } from "../../agent-command.ts"

const mod = (name: string) => fileURLToPath(new URL(`./mods/${name}`, import.meta.url))

/** Hides cmd's native `agent`/`ask_user_question` tools so the MCP bridge's tools are used. */
export const CMD_ORCHESTRATION_MOD = mod("no-native-orchestration.ts")
/** Registers OPENCODE_ACP_SKILL_DIR with cmd, because `cmd acp` ignores `--skill`. */
export const CMD_SKILL_MOD = mod("opencode-skills.ts")

export interface CmdLaunchOptions {
  /** Load the mod that hides cmd's native orchestration and question tools. */
  orchestration?: boolean
  /** Skills mirror directory to expose to cmd. */
  skillDir?: string
}

/**
 * Add the plugin's companion mods to a `cmd ... acp` launch command.
 *
 * Every mod in `./mods/` is loaded the same way: the plugin appends
 * `--mod <path>` resolved from its own install location, so configs never hold
 * an absolute path into the package. A mod already listed with the same path is
 * not added twice, and `--safe-mode` (which disables all mods) is respected.
 *
 * The skills directory is also passed as `--skill` for cmd builds that apply
 * it on the ACP path; cmd's skill planner de-duplicates the two routes.
 */
export function applyCmdMods(command: string | string[], options: CmdLaunchOptions): string | string[] {
  if (!isCmdCommand(command)) return command
  const argv = Array.isArray(command) ? [...command] : [command]
  if (!argv.some((arg) => arg.toLowerCase() === "acp")) return command
  if (argv.includes("--safe-mode")) return command

  const addMod = (path: string) => {
    if (!hasOption(argv, "--mod", path)) argv.push("--mod", path)
  }
  if (options.orchestration) addMod(CMD_ORCHESTRATION_MOD)
  if (options.skillDir && !argv.includes("--no-skills")) {
    addMod(CMD_SKILL_MOD)
    if (!hasOption(argv, "--skill")) argv.push("--skill", options.skillDir)
  }
  return argv
}

function hasOption(argv: string[], name: string, value?: string) {
  if (value !== undefined) {
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] === name && argv[index + 1] === value) return true
      if (argv[index] === `${name}=${value}`) return true
    }
    return false
  }
  return argv.some((arg) => arg === name || arg.startsWith(`${name}=`))
}
