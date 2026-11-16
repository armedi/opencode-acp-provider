import type { SessionUpdate } from "./acp-client.ts"

/**
 * ACP agents run their own tools and report the call through the protocol.
 * OpenCode can only draw a native tool card if the tool is named like one of
 * its own tools and carries the matching input shape, so translate the ACP
 * call into that shape here. Anything unknown stays a generic tool.
 */
export interface AcpToolState {
  readonly id: string
  name: string
  kind?: string
  title?: string
  input: Record<string, unknown>
  status: string
  output?: string
  isError: boolean
  done: boolean
  /** Internal calls (for example a "think" tool) that should not become cards. */
  hidden?: boolean
}

const MAX_OUTPUT = 32_000

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** File contents must keep their exact whitespace: the edit card renders a diff. */
function literal(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** codex-acp reports the file path of a read call here instead of in `rawInput`. */
function locationPath(update: SessionUpdate) {
  const locations = Array.isArray(update.locations) ? update.locations : []
  for (const item of locations) {
    const path = firstText(record(item)?.path)
    if (path) return path
  }
  return undefined
}

/** codex-acp streams shell and read output through `_meta` rather than `content`. */
function terminalOutputDelta(update: SessionUpdate) {
  const data = record(record(update._meta)?.terminal_output_delta)?.data
  return typeof data === "string" ? data : undefined
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const found = text(value)
    if (found) return found
  }
  return undefined
}

/** Codex sends `["bash", "-lc", "ls"]`; Claude sends the command as a string. */
function commandOf(value: unknown): string | undefined {
  if (typeof value === "string") return text(value)
  if (!Array.isArray(value)) return undefined
  const parts = value.filter((item): item is string => typeof item === "string")
  if (!parts.length) return undefined
  if (parts.length === 3 && parts[0].endsWith("sh") && parts[1].startsWith("-")) return text(parts[2])
  return text(parts.join(" "))
}

function toolName(kind: string | undefined, title: string | undefined): string {
  switch (kind) {
    case "execute":
      return "shell"
    case "read":
      return "read"
    case "edit":
      if (title && /write|create/i.test(title)) return "write"
      return "edit"
    case "search":
      return title && /glob/i.test(title) ? "glob" : "grep"
    case "fetch":
      return "webfetch"
    default:
      return "tool"
  }
}

function normalize(name: string, raw: Record<string, unknown>, fallbackPath?: string) {
  const input: Record<string, unknown> = { ...raw }
  const path = firstText(raw.path, raw.file_path, raw.filePath, raw.file) ?? fallbackPath
  const command = commandOf(raw.command) ?? firstText(raw.cmd, raw.shell_command)
  const workdir = firstText(raw.workdir, raw.cwd, raw.working_directory)
  switch (name) {
    case "shell":
      if (command) input.command = command
      if (workdir) input.workdir = workdir
      break
    case "read":
    case "edit":
    case "write":
      if (path) input.path = path
      if (name === "edit") {
        const oldString =
          literal(raw.oldString) ?? literal(raw.old_string) ?? literal(raw.oldText) ?? literal(raw.old_text)
        const newString =
          literal(raw.newString) ?? literal(raw.new_string) ?? literal(raw.newText) ?? literal(raw.new_text)
        if (oldString !== undefined) input.oldString = oldString
        if (newString !== undefined) input.newString = newString
      }
      if (name === "write" && input.content === undefined) {
        const content = literal(raw.content)
        if (content !== undefined) input.content = content
      }
      break
    case "grep":
    case "glob": {
      const pattern = firstText(raw.pattern, raw.query, raw.glob)
      if (pattern) input.pattern = pattern
      if (path) input.path = path
      break
    }
    case "webfetch": {
      const url = firstText(raw.url, raw.uri)
      if (url) input.url = url
      break
    }
  }
  return input
}

/** Human-readable output from an ACP tool update, bounded for the card. */
function textFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const item of content) {
    const entry = record(item)
    if (!entry) continue
    const nested = record(entry.content)
    const value = firstText(entry.text, nested?.text, entry.output, entry.stdout)
    if (value) {
      parts.push(value)
      continue
    }
    if (entry.type === "diff") {
      const path = firstText(entry.path)
      const oldText = typeof entry.oldText === "string" ? entry.oldText : undefined
      const newText = typeof entry.newText === "string" ? entry.newText : undefined
      parts.push([path, oldText && `-${oldText}`, newText && `+${newText}`].filter(Boolean).join("\n"))
    }
  }
  return parts.length ? parts.join("\n") : undefined
}

function outputOf(update: SessionUpdate): string | undefined {
  const raw = update.rawOutput
  if (typeof raw === "string") return clip(raw)
  const rawRecord = record(raw)
  if (rawRecord) {
    const value = firstText(rawRecord.output, rawRecord.stdout, rawRecord.text, rawRecord.result, rawRecord.content)
    if (value) return clip(value)
    // MCP tool results arrive as `{ result: { content: [{ type: "text", text }] } }`.
    const result = record(rawRecord.result)
    if (result) {
      const nested = firstText(result.output, result.stdout, result.text) ?? textFromContent(result.content)
      if (nested) return clip(nested)
    }
  }
  const content = textFromContent(update.content)
  return content ? clip(content) : undefined
}

function clip(value: string) {
  return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT - 1)}…` : value
}

/** The file-level diff an ACP agent reports for an edit. */
function diffOf(update: SessionUpdate) {
  if (!Array.isArray(update.content)) return undefined
  for (const item of update.content) {
    const entry = record(item)
    if (!entry || entry.type !== "diff") continue
    return {
      path: text(entry.path),
      oldText: literal(entry.oldText),
      newText: literal(entry.newText),
    }
  }
  return undefined
}

/**
 * Fold one ACP `tool_call` / `tool_call_update` into the state of that call.
 * Returns undefined for a call that already finished, so late updates cannot
 * reopen a settled tool.
 */
export function applyToolUpdate(update: SessionUpdate, states: Map<string, AcpToolState>): AcpToolState | undefined {
  const id = text(update.toolCallId)
  if (!id) return undefined
  const existing = states.get(id)
  if (existing?.done) return undefined
  const kind = text(update.kind) ?? existing?.kind
  // `think` calls (for example codex's Guardian Review) are internal reasoning,
  // not actions on the workspace, and their raw input is not card-friendly.
  // Remember the id so later updates cannot surface the call as a generic card.
  if (existing?.hidden) return undefined
  if (!existing && kind === "think") {
    states.set(id, {
      id,
      name: "tool",
      kind,
      input: {},
      status: "completed",
      isError: false,
      done: true,
      hidden: true,
    })
    return undefined
  }
  const title = text(update.title) ?? existing?.title
  const status = text(update.status) ?? existing?.status ?? "pending"
  const raw = record(update.rawInput)
  const isMcpCall = record(update._meta)?.is_mcp_tool_call === true
  const name = existing?.name ?? (isMcpCall ? "shell" : toolName(kind, title))
  const path = locationPath(update)
  const input = raw ? normalize(name, raw, path) : { ...(existing?.input ?? {}) }
  if (path && !input.path) input.path = path
  if (isMcpCall && raw) {
    // OpenCode's generic tool card has no detail view, so render the bridge call
    // as a console card where the command names the MCP tool and its arguments.
    const server = firstText(raw.server) ?? "mcp"
    const tool = firstText(raw.tool) ?? title ?? "tool"
    const args = record(raw.arguments)
    const rendered = args && Object.keys(args).length ? ` ${JSON.stringify(args)}` : ""
    input.command = `mcp.${server}.${tool}${rendered}`
  }
  if (name === "edit" && input.oldString === undefined) {
    // Agents that send no edit fields in `rawInput` still report the change as
    // a diff, which is what the edit card renders.
    const diff = diffOf(update)
    if (diff) {
      if (diff.path && !input.path) input.path = diff.path
      if (diff.oldText !== undefined) input.oldString = diff.oldText
      if (diff.newText !== undefined) input.newString = diff.newText
    }
  }
  const delta = terminalOutputDelta(update)
  const streamed = delta === undefined ? existing?.output : clip(`${existing?.output ?? ""}${delta}`)
  const state: AcpToolState = {
    id,
    name,
    kind,
    title,
    input,
    status,
    isError: status === "failed",
    done: status === "completed" || status === "failed",
    output: outputOf(update) ?? streamed,
  }
  states.set(id, state)
  return state
}
