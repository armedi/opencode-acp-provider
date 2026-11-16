/**
 * Disable Command Code's native subagent tools inside `cmd acp`.
 *
 * Command Code exposes `agent` and `agent_output` to the main loop. Inside an
 * ACP host such as OpenCode those duplicate the orchestrator, which already
 * exposes its own `subagent` tool through the MCP bridge. Permission rules
 * cannot block `agent` (the docs mark it as always allowed), so this mod
 * removes it from the tool surface and fails closed if a call still arrives.
 *
 * Loaded by the `cmd` server entry in opencode.jsonc:
 *   "command": ["cmd", "acp", "--mod", "/absolute/path/to/agents/cmd/no-native-subagent.ts"]
 *
 * Add "ask_user_question" to DISABLED if questions should also route through
 * the ACP host instead of Command Code's own question tool.
 */
import type { ModApi } from "@commandcode/harness"

const DISABLED = new Set(["agent", "agent_output"])

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
          "Native subagents are disabled. Use the host's own subagent tool instead.",
      }
    },
  })
}
