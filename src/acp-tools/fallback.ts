import type { ResolvedTool, ToolContext } from "./shared.ts"
import {
  booleanOf,
  commandOf,
  editInput,
  finiteNumber,
  firstText,
  globInput,
  grepInput,
  literal,
  readInput,
  shellInput,
  webfetchInput,
  writeInput,
} from "./shared.ts"

/**
 * Last resort for agents without a dedicated mapping. It still builds the
 * strict input shape OpenCode's native cards expect, never a generic "tool".
 */
export function resolveFallback(ctx: ToolContext): ResolvedTool {
  const raw = ctx.raw
  const title = ctx.title
  const path = firstText(raw?.path, raw?.file_path, raw?.filePath, raw?.file) ?? ctx.locationPath

  if (ctx.kind === "execute") {
    const command = commandOf(raw?.command) ?? firstText(raw?.cmd, raw?.shell_command)
    if (command || raw === undefined) {
      return {
        agent: "fallback",
        name: "shell",
        input: shellInput({
          command,
          workdir: firstText(raw?.workdir, raw?.cwd, raw?.working_directory),
          timeout: finiteNumber(raw?.timeout),
          background: booleanOf(raw?.run_in_background),
        }),
      }
    }
  }
  if (ctx.kind === "read") {
    return {
      agent: "fallback",
      name: "read",
      input: readInput({ path, offset: finiteNumber(raw?.offset), limit: finiteNumber(raw?.limit) }),
    }
  }
  if (ctx.kind === "edit") {
    if (title && /write|create/i.test(title)) {
      return { agent: "fallback", name: "write", input: writeInput({ path, content: literal(raw?.content) }) }
    }
    return {
      agent: "fallback",
      name: "edit",
      input: editInput({
        path,
        oldString: literal(raw?.oldString) ?? literal(raw?.old_string),
        newString: literal(raw?.newString) ?? literal(raw?.new_string),
        replaceAll: booleanOf(raw?.replaceAll) ?? booleanOf(raw?.replace_all),
      }),
    }
  }
  if (ctx.kind === "search") {
    if (title && /glob/i.test(title)) {
      return {
        agent: "fallback",
        name: "glob",
        input: globInput({
          pattern: firstText(raw?.pattern, raw?.glob),
          path: firstText(raw?.path) ?? ctx.locationPath,
          limit: finiteNumber(raw?.limit),
        }),
      }
    }
    return {
      agent: "fallback",
      name: "grep",
      input: grepInput({
        pattern: firstText(raw?.pattern, raw?.query),
        path: firstText(raw?.path) ?? ctx.locationPath,
      }),
    }
  }
  if (ctx.kind === "fetch") {
    return {
      agent: "fallback",
      name: "webfetch",
      input: webfetchInput({ url: firstText(raw?.url, raw?.uri), format: "markdown" }),
    }
  }
  return { agent: "fallback", name: title ?? ctx.kind ?? "unknown", input: raw ? { ...raw } : {} }
}
