/**
 * Expose OpenCode's mirrored skills to `cmd acp`.
 *
 * `cmd acp` accepts the global `--skill` flag, but its ACP action never applies
 * it: only the interactive and print paths call `setSkillLoadOverrides`. Mods,
 * however, are loaded by the ACP path, and `addSkillsPath` feeds the same skill
 * discovery plan. The plugin sets OPENCODE_ACP_PROVIDER_SKILL_DIR for the child and adds
 * this file with `--mod`.
 *
 * Loaded automatically by the plugin (src/agents/cmd/index.ts). A user-supplied mod
 * list keeps working; `--safe-mode` disables all mods, including this one.
 */
interface SkillModApi {
  addSkillsPath?: (path: string) => unknown
}

export default function (cmd: SkillModApi) {
  const directory = process.env.OPENCODE_ACP_PROVIDER_SKILL_DIR
  if (!directory || typeof cmd.addSkillsPath !== "function") return
  cmd.addSkillsPath(directory)
}
