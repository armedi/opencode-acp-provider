import type { ResolvedTool, ToolContext } from "./shared.ts"
import {
  booleanOf,
  commandOf,
  editInput,
  finiteNumber,
  firstText,
  globInput,
  grepInput,
  isOpencodeQuestionName,
  literal,
  questionInput,
  readInput,
  record,
  shellInput,
  skillInput,
  text,
  webfetchInput,
  websearchInput,
  writeInput,
} from "./shared.ts"

export function resolveClaude(ctx: ToolContext): ResolvedTool | undefined {
  const raw = ctx.raw
  const toolName =
    text(record(record(ctx.update._meta)?.claudeCode)?.toolName) ??
    (ctx.priorAgent === "claude" ? ctx.priorRawName : undefined)
  if (!toolName) return undefined

  const resolved = (name: string, input: Record<string, unknown>): ResolvedTool => ({
    agent: "claude",
    rawName: toolName,
    name,
    input,
  })

  const path = firstText(raw?.file_path, raw?.path) ?? ctx.locationPath
  const headLimit = finiteNumber(raw?.head_limit)
  const caseInsensitive = raw?.["-i"]

  switch (toolName) {
    case "Bash":
    case "PowerShell":
      return resolved(
        "shell",
        shellInput({
          command: commandOf(raw?.command),
          timeout: finiteNumber(raw?.timeout),
          background: booleanOf(raw?.run_in_background),
        }),
      )
    case "Read":
      return resolved(
        "read",
        readInput({
          path,
          offset: finiteNumber(raw?.offset),
          limit: finiteNumber(raw?.limit),
        }),
      )
    case "Grep":
      return resolved(
        "grep",
        grepInput({
          pattern: text(raw?.pattern),
          path: firstText(raw?.path, raw?.file_path) ?? ctx.locationPath,
          include: text(raw?.glob),
          caseSensitive: typeof caseInsensitive === "boolean" ? !caseInsensitive : undefined,
          limit: headLimit !== undefined && headLimit > 0 ? headLimit : undefined,
        }),
      )
    case "Glob":
      return resolved(
        "glob",
        globInput({ pattern: text(raw?.pattern), path: firstText(raw?.path) ?? ctx.locationPath }),
      )
    case "WebFetch":
      return resolved("webfetch", webfetchInput({ url: text(raw?.url), format: "markdown" }))
    case "WebSearch":
      return resolved("websearch", websearchInput({ query: text(raw?.query) }))
    case "Write":
      return resolved(
        "write",
        writeInput({
          path,
          content: literal(raw?.content) ?? literal(raw?.file_text) ?? literal(raw?.file_content),
        }),
      )
    case "Edit":
      return resolved(
        "edit",
        editInput({
          path,
          oldString: literal(raw?.old_string),
          newString: literal(raw?.new_string),
          replaceAll: booleanOf(raw?.replace_all),
        }),
      )
    case "Skill":
      return resolved("skill", skillInput({ id: text(raw?.skill) }))
    default:
      if (isOpencodeQuestionName(toolName)) return resolved("question", questionInput(raw))
      return { agent: "claude", rawName: toolName, name: toolName, input: raw ? { ...raw } : {} }
  }
}
