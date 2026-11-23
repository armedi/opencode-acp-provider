import type { SessionUpdate } from "../acp-client.ts"

/** The agent that produced a tool call, so a status-only update keeps its mapping. */
export type AgentId = "claude" | "antigravity" | "codex" | "command-code" | "fallback"

/** The file-level diff an ACP agent reports for an edit. */
export interface DiffItem {
  path?: string
  oldText: string | null | undefined
  newText: string | undefined
  kind?: "add" | "delete" | "update"
}

export interface ToolContext {
  update: SessionUpdate
  raw?: Record<string, unknown>
  kind?: string
  title?: string
  topName?: string
  locationPath?: string
  diffs: DiffItem[]
  priorAgent?: AgentId
  priorRawName?: string
}

export interface ResolvedTool {
  agent: AgentId
  rawName?: string
  name: string
  input: Record<string, unknown>
}

export type PatchEntry =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; chunks: Array<{ oldText: string; newText: string }> }

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** File contents must keep their exact whitespace: the edit card renders a diff. */
export function literal(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const found = text(value)
    if (found) return found
  }
  return undefined
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function booleanOf(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

/** Codex sends `["bash", "-lc", "ls"]`; Claude sends the command as a string. */
export function commandOf(value: unknown): string | undefined {
  if (typeof value === "string") return text(value)
  if (!Array.isArray(value)) return undefined
  const parts = value.filter((item): item is string => typeof item === "string")
  if (!parts.length) return undefined
  if (parts.length === 3 && parts[0].endsWith("sh") && parts[1].startsWith("-")) return text(parts[2])
  return text(parts.join(" "))
}

/** codex-acp reports the file path of a read call here instead of in `rawInput`. */
export function locationPath(update: SessionUpdate): string | undefined {
  const locations = Array.isArray(update.locations) ? update.locations : []
  for (const item of locations) {
    const path = firstText(record(item)?.path)
    if (path) return path
  }
  return undefined
}

export function diffsOf(update: SessionUpdate): DiffItem[] {
  if (!Array.isArray(update.content)) return []
  const diffs: DiffItem[] = []
  for (const item of update.content) {
    const entry = record(item)
    if (!entry || entry.type !== "diff") continue
    const kind = record(entry._meta)?.kind
    diffs.push({
      path: text(entry.path),
      oldText: entry.oldText === null ? null : literal(entry.oldText),
      newText: literal(entry.newText),
      kind: kind === "add" || kind === "delete" || kind === "update" ? kind : undefined,
    })
  }
  return diffs
}

/**
 * Agents stream command output through the `_meta` terminal extension rather
 * than `content`: `terminal_output_delta` appends to what the terminal showed,
 * and `terminal_output` replaces it.
 */
export function terminalOutputChunk(update: SessionUpdate): { data: string; replace: boolean } | undefined {
  const meta = record(update._meta)
  const delta = literal(record(meta?.terminal_output_delta)?.data)
  if (delta !== undefined) return { data: delta, replace: false }
  const whole = literal(record(meta?.terminal_output)?.data)
  return whole === undefined ? undefined : { data: whole, replace: true }
}

/**
 * Whether the update opens (`terminal_info`) or closes (`terminal_exit`) the
 * call's display terminal. A command that went to the background reports its
 * tool call `completed` but keeps its terminal open until the command ends.
 */
export function terminalEvents(update: SessionUpdate): { opened: boolean; exited: boolean } {
  const meta = record(update._meta)
  return { opened: record(meta?.terminal_info) !== undefined, exited: record(meta?.terminal_exit) !== undefined }
}

/**
 * The call's status, including the end of a background command: claude-agent-acp
 * reports it as a bare `terminal_exit` on the original call, with no status.
 */
export function toolUpdateStatus(update: SessionUpdate): string | undefined {
  const status = text(update.status)
  if (status) return status
  const exit = record(record(update._meta)?.terminal_exit)
  if (!exit) return undefined
  const code = exit.exit_code
  return typeof code === "number" && code !== 0 ? "failed" : "completed"
}

/** OpenCode's question tool is the only ACP tool name with a known native card. */
export function isOpencodeQuestionName(name: string | undefined): boolean {
  return (
    name === "mcp__opencode__question" ||
    name === "mcp.opencode.question" ||
    name === "mcp_opencode_question" ||
    name === "opencode.question"
  )
}

function compact(fields: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) input[key] = value
  }
  return input
}

export function shellInput(fields: {
  command?: string
  workdir?: string
  timeout?: number
  background?: boolean
}): Record<string, unknown> {
  return compact({ command: fields.command, workdir: fields.workdir, timeout: fields.timeout, background: fields.background })
}

export function readInput(fields: { path?: string; offset?: number; limit?: number }): Record<string, unknown> {
  return compact({ path: fields.path, offset: fields.offset, limit: fields.limit })
}

export function grepInput(fields: {
  pattern?: string
  path?: string
  include?: string
  literal?: boolean
  caseSensitive?: boolean
  limit?: number
}): Record<string, unknown> {
  return compact({
    pattern: fields.pattern,
    path: fields.path,
    include: fields.include,
    literal: fields.literal,
    caseSensitive: fields.caseSensitive,
    limit: fields.limit,
  })
}

export function globInput(fields: {
  pattern?: string
  path?: string
  hidden?: boolean
  limit?: number
}): Record<string, unknown> {
  return compact({ pattern: fields.pattern, path: fields.path, hidden: fields.hidden, limit: fields.limit })
}

export function webfetchInput(fields: {
  url?: string
  format?: "text" | "markdown" | "html"
  timeout?: number
}): Record<string, unknown> {
  // A webfetch card without a URL has nothing to show, and emitting `format`
  // alone would draw an empty card for a streamed `rawInput: {}`.
  if (fields.url === undefined) return {}
  return compact({ url: fields.url, format: fields.format ?? "markdown", timeout: fields.timeout })
}

export function websearchInput(fields: { query?: string }): Record<string, unknown> {
  return compact({ query: fields.query })
}

export function writeInput(fields: { path?: string; content?: string }): Record<string, unknown> {
  return compact({ path: fields.path, content: fields.content })
}

export function editInput(fields: {
  path?: string
  oldString?: string
  newString?: string
  replaceAll?: boolean
}): Record<string, unknown> {
  return compact({
    path: fields.path,
    oldString: fields.oldString,
    newString: fields.newString,
    replaceAll: fields.replaceAll,
  })
}

export function patchInput(entries: PatchEntry[]): Record<string, unknown> {
  return entries.length > 0 ? { patchText: buildPatchText(entries) } : {}
}

export function skillInput(fields: { id?: string }): Record<string, unknown> {
  return compact({ id: fields.id })
}

export function questionInput(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  const questions = record(raw?.arguments)?.questions ?? raw?.questions
  return questions !== undefined ? { questions } : {}
}

export function executeInput(fields: { code?: string }): Record<string, unknown> {
  return compact({ code: fields.code })
}

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

/** Keep only the fields OpenCode's todowrite card renders. */
export function todowriteTodos(entries: unknown): Array<{ content: string; status: TodoStatus }> | undefined {
  if (!Array.isArray(entries)) return undefined
  const todos: Array<{ content: string; status: TodoStatus }> = []
  for (const entry of entries) {
    const item = record(entry)
    if (!item || typeof item.content !== "string") continue
    const status = item.status === "canceled" ? "cancelled" : item.status
    todos.push({
      content: item.content,
      status:
        status === "in_progress" || status === "completed" || status === "cancelled" ? status : "pending",
    })
  }
  return todos
}

export function patchLines(value: string): string[] {
  if (!value) return []
  const normalized = value.replace(/\r\n/g, "\n")
  return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n")
}

/** Build the patch text OpenCode's patch tool parses. */
export function buildPatchText(entries: PatchEntry[]): string {
  const lines = ["*** Begin Patch"]
  for (const entry of entries) {
    if (entry.kind === "add") {
      lines.push(`*** Add File: ${entry.path}`)
      for (const line of patchLines(entry.content)) lines.push(`+${line}`)
      continue
    }
    if (entry.kind === "delete") {
      lines.push(`*** Delete File: ${entry.path}`)
      continue
    }
    lines.push(`*** Update File: ${entry.path}`)
    if (entry.moveTo) lines.push(`*** Move to: ${entry.moveTo}`)
    let emitted = 0
    for (const chunk of entry.chunks) {
      const oldLines = patchLines(chunk.oldText)
      const newLines = patchLines(chunk.newText)
      if (!oldLines.length && !newLines.length) continue
      lines.push("@@")
      for (const line of oldLines) lines.push(`-${line}`)
      for (const line of newLines) lines.push(`+${line}`)
      emitted += 1
    }
    // A hunk whose sides are both empty still needs a body line, otherwise
    // OpenCode's parser rejects the whole update.
    if (!emitted) {
      lines.push("@@")
      lines.push(" ")
    }
  }
  lines.push("*** End Patch")
  return lines.join("\n")
}

export const MAX_OUTPUT = 32_000

export function clip(value: string): string {
  return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT - 1)}…` : value
}

const ANTIGRAVITY_STATUS_PATTERNS = [
  /^Command exited with code (\d+)\.?$/,
  /^No output from the command\.?$/,
  /^Background command is still running after /,
  /^Command timed out:/,
  /^Step was canceled/i,
]

function isAntigravityStatusLine(line: string): boolean {
  return ANTIGRAVITY_STATUS_PATTERNS.some((pattern) => pattern.test(line))
}

/**
 * Antigravity foreground commands prefix output with `Created At:`, whereas
 * late background completions begin directly with the status line (for
 * example `Command exited with code 0.`).
 */
export function hasAntigravityOutputHeader(raw: string): boolean {
  const normalized = raw.replace(/\r\n/g, "\n")
  if (normalized.startsWith("Created At:")) return true
  const firstLine = normalized.split("\n", 1)[0]?.trim() ?? ""
  return isAntigravityStatusLine(firstLine)
}

/**
 * Antigravity prefixes command output with a "Created At:" header and a status
 * line that belongs to the tool card, not the output. Strip it so the card shows
 * only the command's own text.
 */
export function stripAntigravityOutputHeader(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  let index = 0
  if (normalized.startsWith("Created At:")) {
    index = 1
    if (lines[index]?.startsWith("Completed At:")) index++
  } else if (!isAntigravityStatusLine(lines[0]?.trim() ?? "")) {
    return raw
  }

  let statusLine: string | undefined
  let isZeroExit = false
  const candidate = lines[index]?.trim() ?? ""
  const exit = candidate.match(/^Command exited with code (\d+)\.?$/)
  if (exit) {
    statusLine = candidate
    isZeroExit = exit[1] === "0"
    index++
  } else if (isAntigravityStatusLine(candidate)) {
    statusLine = candidate
    index++
  }

  while (index < lines.length && lines[index].trim() === "") index++
  const label = lines[index]?.trim()
  if (label === "Command output:" || label === "Output:" || label === "Stdout:" || label === "Stderr:") index++

  const body = lines.slice(index).join("\n").replace(/\n+$/, "")
  if (statusLine && !isZeroExit) return body ? `${statusLine}\n${body}` : statusLine
  return body
}

function textFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const item of content) {
    const entry = record(item)
    if (!entry || entry.type === "diff") continue
    const nested = record(entry.content)
    const value = firstText(entry.text, nested?.text, entry.output, entry.stdout)
    if (value) parts.push(value)
  }
  return parts.length ? parts.join("\n") : undefined
}

/** Human-readable output from an ACP tool update, bounded for the card. */
export function extractOutput(
  update: SessionUpdate,
  options: { streamed?: string; streamedTerminal?: boolean; stripAntigravityHeader?: boolean } = {},
): string | undefined {
  const raw = update.rawOutput
  const rawRecord = record(raw)
  let resolved: string | undefined

  if (typeof raw === "string") {
    if (options.stripAntigravityHeader && hasAntigravityOutputHeader(raw)) {
      return clip(stripAntigravityOutputHeader(raw))
    }
    if (raw.length > 0) return clip(raw)
  }

  if (rawRecord) {
    if (
      options.stripAntigravityHeader &&
      typeof rawRecord.output === "string" &&
      hasAntigravityOutputHeader(rawRecord.output)
    ) {
      return clip(stripAntigravityOutputHeader(rawRecord.output))
    }
    const direct =
      text(rawRecord.output) ??
      ([text(rawRecord.stdout), text(rawRecord.stderr)].filter(Boolean).join("\n") || undefined) ??
      firstText(rawRecord.text, rawRecord.result, rawRecord.content) ??
      textFromContent(rawRecord.content)
    // MCP tool results arrive as `{ result: { content: [{ type: "text", text }] } }`.
    const result = record(rawRecord.result)
    const nested = result
      ? firstText(result.output, result.text) ??
        ([text(result.stdout), text(result.stderr)].filter(Boolean).join("\n") || undefined) ??
        textFromContent(result.content)
      : undefined
    resolved =
      direct ??
      nested ??
      (rawRecord.error !== undefined && rawRecord.error !== null
        ? firstText(rawRecord.error, record(rawRecord.error)?.message)
        : undefined)
  }

  if (Array.isArray(raw)) resolved = textFromContent(raw)
  resolved ??= textFromContent(update.content)

  if (resolved) {
    const value = options.stripAntigravityHeader ? stripAntigravityOutputHeader(resolved) : resolved
    return clip(value)
  }

  // Codex streams a command's stdout through terminal deltas, so a completion
  // that only reports `{ exit_code: 0 }` must not replace the real output.
  if (options.streamed !== undefined && options.streamedTerminal) return options.streamed

  if (raw !== undefined && raw !== null && raw !== "") {
    const target =
      rawRecord &&
      "result" in rawRecord &&
      rawRecord.result !== undefined &&
      rawRecord.result !== null &&
      rawRecord.error == null
        ? rawRecord.result
        : raw
    const targetRecord = record(target)
    if (!targetRecord || Object.keys(targetRecord).length > 0) {
      try {
        const json = JSON.stringify(target, null, 2)
        if (json) return clip(json)
      } catch {
        // fall through to the streamed output
      }
    }
  }
  if (options.streamed !== undefined) return options.streamed
  return undefined
}
