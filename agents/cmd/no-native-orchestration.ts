/**
 * Disable Command Code's native orchestration and question tools inside `cmd acp`.
 *
 * Command Code exposes `agent` and `agent_output` to the main loop. Inside an
 * ACP host such as OpenCode those duplicate the orchestrator, which already
 * exposes its own `subagent` tool through the MCP bridge. Permission rules
 * cannot block `agent` (the docs mark it as always allowed), so this mod
 * removes it from the tool surface and fails closed if a call still arrives.
 *
 * `ask_user_question` is removed for the same reason: ACP has no question
 * method, so `cmd acp` would relay it as a permission request instead of
 * showing OpenCode's question UI. The agent should call the host's MCP
 * `question` tool instead.
 *
 * Loaded automatically by the plugin (src/cmd-mods.ts) on any `cmd ... acp`
 * command while the MCP bridge is enabled. `--safe-mode` disables it.
 */
import type { ModApi } from "@commandcode/harness"

const DISABLED = new Set(["agent", "agent_output", "ask_user_question"])

export default function (cmd: ModApi) {
  const hide = () => {
    // Base the filter on the *active* tools, not every registered tool: another
    // mod may already have disabled something, and getAllTools would re-enable it.
    const active = cmd.getActiveTools()
    const next = active.filter((name) => !DISABLED.has(name))
    if (next.length !== active.length) cmd.setActiveTools(next)
  }

  cmd.hooks({
    // setActiveTools needs a bound session.
    onSessionStart() {
      hide()
    },
    // Re-assert before every model request: MCP tools can connect after
    // session start, and the tool schemas are built for this request.
    beforeModelRequest() {
      hide()
      return undefined
    },
    // Fail closed if a call slips through the schema filter.
    beforeToolCall({ toolName }) {
      if (!DISABLED.has(toolName)) return undefined
      return {
        block: true,
        additionalContext:
          toolName === "ask_user_question"
            ? "Native questions are disabled. Use the host's MCP `question` tool instead."
            : "Native subagents are disabled. Use the host's own subagent tool instead.",
      }
    },
  })
}
