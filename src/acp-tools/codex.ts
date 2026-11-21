import type { DiffItem, PatchEntry, ResolvedTool, ToolContext } from "./shared.ts"
import {
  commandOf,
  editInput,
  firstText,
  grepInput,
  isOpencodeQuestionName,
  patchInput,
  questionInput,
  readInput,
  record,
  shellInput,
  text,
  websearchInput,
  writeInput,
} from "./shared.ts"

const CODEX_NAMES = new Set(["exec_command", "write_stdin", "view_image", "request_permissions"])

function diffKind(diff: DiffItem) {
  return diff.kind ?? (diff.oldText === null ? "add" : diff.newText === "" ? "delete" : "update")
}

function patchEntries(diffs: DiffItem[]): PatchEntry[] {
  const entries: PatchEntry[] = []
  const updates = new Map<string, Extract<PatchEntry, { kind: "update" }>>()
  for (const diff of diffs) {
    const kind = diffKind(diff)
    const path = diff.path ?? ""
    if (kind === "add") {
      entries.push({ kind: "add", path, content: diff.newText ?? "" })
      continue
    }
    if (kind === "delete") {
      entries.push({ kind: "delete", path })
      continue
    }
    let entry = updates.get(path)
    if (!entry) {
      entry = { kind: "update", path, chunks: [] }
      updates.set(path, entry)
      entries.push(entry)
    }
    entry.chunks.push({ oldText: diff.oldText ?? "", newText: diff.newText ?? "" })
  }
  return entries
}

export function resolveCodex(ctx: ToolContext): ResolvedTool | undefined {
  const raw = ctx.raw
  const title = ctx.title
  const meta = record(ctx.update._meta)

  if (meta?.is_mcp_tool_call === true || title?.startsWith("mcp.")) {
    if (isOpencodeQuestionName(title) || (raw?.server === "opencode" && raw?.tool === "question")) {
      return {
        agent: "codex",
        rawName: title ?? "mcp.opencode.question",
        name: "question",
        input: questionInput(raw),
      }
    }
    const server = firstText(raw?.server)
    const tool = firstText(raw?.tool)
    const mcpName = title ?? (server && tool ? `mcp.${server}.${tool}` : "mcp")
    return { agent: "codex", rawName: mcpName, name: mcpName, input: raw ? { ...raw } : {} }
  }

  const webSearchTitle = title?.match(/^Web search(?::\s*(.*))?$/)
  const action = record(raw?.action)
  const actionQueries = action?.queries
  if (
    raw?.type === "webSearch" ||
    (ctx.kind === "search" && ((raw !== undefined && "action" in raw) || Boolean(webSearchTitle)))
  ) {
    const query =
      firstText(
        raw?.query,
        action?.query,
        Array.isArray(actionQueries)
          ? actionQueries.find((value) => typeof value === "string" && value.trim())
          : undefined,
      ) ?? text(webSearchTitle?.[1])
    return { agent: "codex", rawName: "webSearch", name: "websearch", input: websearchInput({ query }) }
  }

  if (ctx.topName && !CODEX_NAMES.has(ctx.topName)) {
    // A dynamic tool call arrives as `{ arguments }` and keeps its own name.
    if (ctx.kind === "execute" && raw && Object.keys(raw).length === 1 && "arguments" in raw) {
      const name = title ?? ctx.topName
      return { agent: "codex", rawName: name, name, input: { ...raw } }
    }
    return undefined
  }

  const imageTitle = title?.match(/^View Image\s+(.+)$/)
  if (ctx.topName === "view_image" || (ctx.kind === "read" && imageTitle)) {
    return {
      agent: "codex",
      rawName: "view_image",
      name: "read",
      input: readInput({ path: firstText(raw?.path) ?? ctx.locationPath ?? text(imageTitle?.[1]) }),
    }
  }

  if (
    ctx.kind === "edit" &&
    (title === "Editing files" ||
      title === "Edit files" ||
      (ctx.priorAgent === "codex" && ctx.priorRawName === "fileChange"))
  ) {
    const diffs = ctx.diffs
    if (diffs.length === 0) return { agent: "codex", rawName: "fileChange", name: "edit", input: {} }
    if (diffs.length === 1) {
      const diff = diffs[0]
      const kind = diffKind(diff)
      if (kind === "add") {
        return {
          agent: "codex",
          rawName: "fileChange",
          name: "write",
          input: writeInput({ path: diff.path, content: diff.newText ?? "" }),
        }
      }
      if (kind === "delete") {
        return {
          agent: "codex",
          rawName: "fileChange",
          name: "patch",
          input: patchInput(diff.path ? [{ kind: "delete", path: diff.path }] : []),
        }
      }
      return {
        agent: "codex",
        rawName: "fileChange",
        name: "edit",
        input: editInput({ path: diff.path, oldString: diff.oldText ?? "", newString: diff.newText ?? "" }),
      }
    }
    return { agent: "codex", rawName: "fileChange", name: "patch", input: patchInput(patchEntries(diffs)) }
  }

  const readPath =
    text(title?.match(/^Read file '(.+)'$/)?.[1]) ?? text(title?.match(/^List files in '(.+)'$/)?.[1])
  if (
    ctx.kind === "read" &&
    (ctx.topName === "exec_command" || title === "Read file" || title === "List files" || Boolean(readPath))
  ) {
    return {
      agent: "codex",
      rawName: ctx.topName ?? "read",
      name: "read",
      input: readInput({ path: ctx.locationPath ?? firstText(raw?.path) ?? readPath }),
    }
  }

  if (
    ctx.kind === "search" &&
    !title?.startsWith("Search:") &&
    (ctx.topName === "exec_command" || title === "Search" || Boolean(title?.match(/^Search (?:for|in) /)))
  ) {
    const forIn = title?.match(/^Search for '(.+)' in (.+)$/)
    const forOnly = title?.match(/^Search for '(.+)'$/)
    const inOnly = title?.match(/^Search in '(.+)'$/)
    const query = text(forIn?.[1]) ?? text(forOnly?.[1])
    const searchPath = text(forIn?.[2]) ?? text(inOnly?.[1])
    return {
      agent: "codex",
      rawName: ctx.topName ?? "search",
      name: "grep",
      input: grepInput({
        pattern: firstText(raw?.query, raw?.pattern) ?? query,
        path: firstText(raw?.path) ?? ctx.locationPath ?? searchPath,
      }),
    }
  }

  const commandCodeShell =
    title?.startsWith("Shell:") ||
    title?.startsWith("Monitor:") ||
    title?.startsWith("Command:") ||
    title?.toLowerCase().startsWith("powershell")
  if (
    ctx.kind === "execute" &&
    !commandCodeShell &&
    !(raw && ("timeout" in raw || "run_in_background" in raw)) &&
    (ctx.topName === "exec_command" ||
      ctx.topName === "write_stdin" ||
      (raw !== undefined && "command" in raw))
  ) {
    return {
      agent: "codex",
      rawName: ctx.topName ?? "exec_command",
      name: "shell",
      input: shellInput({ command: commandOf(raw?.command), workdir: firstText(raw?.cwd, raw?.workdir) }),
    }
  }

  if (ctx.kind === "execute" && raw && Object.keys(raw).length === 1 && "arguments" in raw && title) {
    return { agent: "codex", rawName: title, name: title, input: { ...raw } }
  }
  return undefined
}
