/**
 * Disable Command Code's native tools that OpenCode replaces or cannot host inside `cmd acp`.
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
 * The rest have no place under an ACP host:
 * - Plan mode (`enter_plan_mode`, `exit_plan_mode`, `plan_review`): approval
 *   becomes an auto-approved permission request and the review panel lives in
 *   cmd's own TUI. OpenCode has its own plan agent.
 * - Worktrees (`enter_worktree`, `exit_worktree`): moving the session out of
 *   the OpenCode location hides its edits from OpenCode's snapshots. The host
 *   exposes `worktree_create` instead.
 * - Scheduling (`cron_*`, `schedule_wakeup`): pooled ACP sessions and agent
 *   processes close when idle, so schedules die silently, and a firing one
 *   starts a turn the user never sent.
 * - Artifacts (`artifact_publish`, `artifact_manage`): publish to Command
 *   Code's hosting, unrelated to OpenCode.
 *
 * Loaded automatically by the plugin (src/agents/cmd/index.ts) on any `cmd ... acp`
 * command while the MCP bridge is enabled. `--safe-mode` disables it.
 */
import type { ModApi } from "@commandcode/harness"

const REASONS: Record<string, string> = {
  agent: "Native subagents are disabled. Use the host's own subagent tool instead.",
  agent_output: "Native subagents are disabled. Use the host's own subagent tool instead.",
  ask_user_question: "Native questions are disabled. Use the host's MCP `question` tool instead.",
  enter_plan_mode: "Plan mode is disabled inside OpenCode. Plan in the conversation instead.",
  exit_plan_mode: "Plan mode is disabled inside OpenCode. Plan in the conversation instead.",
  plan_review: "Plan mode is disabled inside OpenCode. Plan in the conversation instead.",
  enter_worktree: "Native worktrees are disabled. Use the host's MCP `worktree_create` tool instead.",
  exit_worktree: "Native worktrees are disabled. Use the host's MCP `worktree_create` tool instead.",
  cron_create: "Scheduling is disabled inside OpenCode.",
  cron_delete: "Scheduling is disabled inside OpenCode.",
  cron_list: "Scheduling is disabled inside OpenCode.",
  schedule_wakeup: "Scheduling is disabled inside OpenCode.",
  artifact_publish: "Artifact publishing is disabled inside OpenCode.",
  artifact_manage: "Artifact publishing is disabled inside OpenCode.",
}

export default function (cmd: ModApi) {
  const hide = () => {
    // Base the filter on the *active* tools, not every registered tool: another
    // mod may already have disabled something, and getAllTools would re-enable it.
    const active = cmd.getActiveTools()
    const next = active.filter((name) => !Object.hasOwn(REASONS, name))
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
      if (!Object.hasOwn(REASONS, toolName)) return undefined
      return { block: true, additionalContext: REASONS[toolName] }
    },
  })
}
