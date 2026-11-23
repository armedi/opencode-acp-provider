import type { SessionUpdate } from "../acp-client.ts"
import type { ResolvedTool, ToolContext } from "./shared.ts"
import {
  booleanOf,
  commandOf,
  editInput,
  executeInput,
  extractOutput,
  finiteNumber,
  firstText,
  globInput,
  grepInput,
  isOpencodeQuestionName,
  literal,
  questionInput,
  readInput,
  shellInput,
  skillInput,
  text,
  webfetchInput,
  websearchInput,
  writeInput,
} from "./shared.ts"

/** Command Code titles a card with its tool label, sometimes followed by detail. */
function hasLabel(title: string | undefined, label: string): boolean {
  return title === label || Boolean(title?.startsWith(`${label}:`))
}

export function resolveCommandCode(ctx: ToolContext): ResolvedTool | undefined {
  const raw = ctx.raw
  const title = ctx.title
  const resolved = (name: string, input: Record<string, unknown>): ResolvedTool => ({
    agent: "command-code",
    name,
    input,
  })
  const unchanged = (name: string): ResolvedTool => resolved(name, raw ? { ...raw } : {})

  if (
    hasLabel(title, "Shell") ||
    hasLabel(title, "Monitor") ||
    hasLabel(title, "Command") ||
    title === "shell_command" ||
    title === "monitor_command" ||
    title === "run_command" ||
    title === "powershell" ||
    hasLabel(title, "powershell") ||
    hasLabel(title, "PowerShell")
  ) {
    return resolved(
      "shell",
      shellInput({
        command: commandOf(raw?.command),
        workdir: firstText(raw?.cwd, raw?.workdir),
        timeout: finiteNumber(raw?.timeout),
        background: booleanOf(raw?.run_in_background),
      }),
    )
  }
  if (hasLabel(title, "Kill") || title === "kill_shell") return unchanged("kill_shell")
  if (title === "monitor_events" || title === "shell_tasks" || title === "bash_output") return unchanged(title)
  if (
    title === "read_multiple_files" ||
    (hasLabel(title, "Read") &&
      (Array.isArray(raw?.paths) || (Array.isArray(raw?.include) && typeof raw?.file_path !== "string")))
  ) {
    return unchanged("read_multiple_files")
  }
  if (title === "Diagnostics" || title === "get_diagnostics") return unchanged("get_diagnostics")
  if (hasLabel(title, "Read") || hasLabel(title, "List") || title === "read_file" || title === "read_directory") {
    const path = firstText(raw?.file_path, raw?.path) ?? ctx.locationPath
    const offset = finiteNumber(raw?.offset)
    const limit = finiteNumber(raw?.limit)
    // A negative offset asks OpenCode's read tool for the tail of the file;
    // sending it would reject the card, so keep only the path and read it whole.
    return resolved("read", offset !== undefined && offset < 0 ? readInput({ path }) : readInput({ path, offset, limit }))
  }
  if (hasLabel(title, "Edit") || title === "edit_file") {
    return resolved(
      "edit",
      editInput({
        path: firstText(raw?.file_path, raw?.path) ?? ctx.locationPath,
        oldString: literal(raw?.old_string),
        newString: literal(raw?.new_string),
        replaceAll: booleanOf(raw?.replace_all),
      }),
    )
  }
  if (hasLabel(title, "Write") || title === "write_file") {
    return resolved(
      "write",
      writeInput({ path: firstText(raw?.file_path, raw?.path) ?? ctx.locationPath, content: literal(raw?.content) }),
    )
  }
  if (hasLabel(title, "Search") || title === "grep" || title === "web_search") {
    if (title === "web_search" || (text(raw?.query) !== undefined && raw?.pattern === undefined)) {
      return resolved("websearch", websearchInput({ query: text(raw?.query) }))
    }
    const headLimit = finiteNumber(raw?.head_limit)
    const caseInsensitive = raw?.["-i"]
    return resolved(
      "grep",
      grepInput({
        pattern: text(raw?.pattern),
        path: firstText(raw?.path) ?? ctx.locationPath,
        include: text(raw?.glob),
        caseSensitive: typeof caseInsensitive === "boolean" ? !caseInsensitive : undefined,
        limit: headLimit !== undefined && headLimit > 0 ? headLimit : undefined,
      }),
    )
  }
  if (hasLabel(title, "Glob") || title === "glob") {
    return resolved(
      "glob",
      globInput({ pattern: text(raw?.pattern), path: firstText(raw?.path) ?? ctx.locationPath, limit: finiteNumber(raw?.limit) }),
    )
  }
  if (hasLabel(title, "Fetch") || title === "web_fetch") {
    const format =
      raw?.format === "text" || raw?.format === "markdown" || raw?.format === "html" ? raw.format : "markdown"
    return resolved(
      "webfetch",
      webfetchInput({ url: text(raw?.url), format, timeout: finiteNumber(raw?.timeout) }),
    )
  }
  if (title === "activate_skill") return resolved("skill", skillInput({ id: text(raw?.name) }))
  if (title === "codemode") return resolved("execute", executeInput({ code: literal(raw?.code) }))
  if (isOpencodeQuestionName(title)) return resolved("question", questionInput(raw))
  // MCP tools stay generic even when they carry a shell-like `command` field
  // or arrive with an execute/think kind.
  if (title?.startsWith("mcp__")) return unchanged(title)
  // Command Code subagent calls keep their own label and stay visible.
  if (title && (hasLabel(title, "Agent") || title === "task" || title === "agent")) return unchanged(title)
  if (title === "ask_user_question") return unchanged("ask_user_question")
  return undefined
}

const BACKGROUND_STARTED = "Started shell command in the background."

/**
 * The task a Command Code shell call left running in the background. Command
 * Code reports the start only as result text (`Task: …` and `PID: …` lines)
 * and sends nothing when the command ends, so the process id is the only way
 * to tell that it still runs.
 */
export function commandCodeBackgroundTask(update: SessionUpdate): { taskId: string; pid: number } | undefined {
  if (text(update.status) !== "completed") return undefined
  const output = extractOutput(update)
  if (!output?.startsWith(BACKGROUND_STARTED)) return undefined
  const taskId = /^Task: (\S+)$/m.exec(output)?.[1]
  const pid = Number(/^PID: (\d+)$/m.exec(output)?.[1])
  return taskId && Number.isInteger(pid) && pid > 0 ? { taskId, pid } : undefined
}
