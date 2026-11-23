import { randomUUID } from "node:crypto"
import type { SessionUpdate } from "./acp-client.ts"
import { resolveAntigravity } from "./acp-tools/antigravity.ts"
import { resolveClaude } from "./acp-tools/claude.ts"
import { resolveCodex } from "./acp-tools/codex.ts"
import { resolveCommandCode } from "./acp-tools/command-code.ts"
import { resolveFallback } from "./acp-tools/fallback.ts"
import {
  clip,
  diffsOf,
  extractOutput,
  locationPath,
  record,
  terminalEvents,
  terminalOutputChunk,
  text,
  todowriteTodos,
  toolUpdateStatus,
  type AgentId,
  type ToolContext,
} from "./acp-tools/shared.ts"

/**
 * ACP agents run their own tools and report the call through the protocol.
 * OpenCode can only draw a native tool card if the tool is named like one of
 * its own tools and carries the matching input shape, so each agent's resolver
 * translates the ACP call into that shape. Anything unknown stays a generic card.
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

/** What the first update of a call told us, so later updates keep the mapping. */
interface CallMeta {
  agent: AgentId
  rawName?: string
  rawInput?: Record<string, unknown>
  /** The call streamed terminal output, which outranks a structured `rawOutput`. */
  streamedTerminal?: boolean
  /** The call's display terminal is open: its command still runs, even after a `completed` status. */
  terminalOpen?: boolean
}

const callMeta = new WeakMap<Map<string, AcpToolState>, Map<string, CallMeta>>()

function metaFor(states: Map<string, AcpToolState>): Map<string, CallMeta> {
  let meta = callMeta.get(states)
  if (!meta) {
    meta = new Map()
    callMeta.set(states, meta)
  }
  return meta
}

/** Agents report their todo list as a `plan` session update. */
export function planToToolState(update: SessionUpdate): AcpToolState | undefined {
  if (update.sessionUpdate !== "plan") return undefined
  const todos = todowriteTodos(update.entries)
  if (!todos) return undefined
  return {
    id: `plan-${randomUUID()}`,
    name: "todowrite",
    kind: "think",
    title: "Update todos",
    input: { todos },
    status: "completed",
    isError: false,
    done: true,
  }
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
  if (existing?.hidden) return undefined

  const meta = metaFor(states).get(id)
  const kind = text(update.kind) ?? existing?.kind
  const title = text(update.title) ?? existing?.title
  const incomingRaw = record(update.rawInput)
  const hasIncomingRaw = incomingRaw !== undefined && Object.keys(incomingRaw).length > 0
  const effectiveRaw = hasIncomingRaw ? incomingRaw : meta?.rawInput ?? incomingRaw
  const diffs = diffsOf(update)
  const ctx: ToolContext = {
    update,
    raw: effectiveRaw,
    kind,
    title,
    topName: text(update.name),
    locationPath: locationPath(update),
    diffs,
    priorAgent: meta?.agent,
    priorRawName: meta?.rawName,
  }

  let resolved = resolveClaude(ctx) ?? resolveCodex(ctx) ?? resolveAntigravity(ctx) ?? resolveCommandCode(ctx)
  if (!resolved && !existing && kind === "think") {
    // `think` calls (for example codex's Guardian Review) are internal reasoning,
    // not actions on the workspace, and their raw input is not card-friendly.
    // Remember the id so later updates cannot surface the call as a generic card.
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
  if (!resolved) {
    if (existing && !hasIncomingRaw && diffs.length === 0) {
      resolved = {
        agent: meta?.agent ?? "fallback",
        rawName: meta?.rawName,
        name: existing.name,
        input: { ...existing.input },
      }
    } else {
      resolved = resolveFallback(ctx)
    }
  } else if (
    existing &&
    !hasIncomingRaw &&
    diffs.length === 0 &&
    Object.keys(resolved.input).length === 0 &&
    Object.keys(existing.input).length > 0
  ) {
    // A status/output-only update can hit a resolver path with no fields (for
    // example a bare `webfetch` name); keep the input of the first call.
    resolved = { ...resolved, name: existing.name, input: { ...existing.input } }
  }

  const name = resolved.name
  const input = { ...resolved.input }
  if (name === "edit" && input.oldString === undefined && diffs[0]) {
    // Agents that send no edit fields in `rawInput` still report the change as
    // a diff, which is what the edit card renders.
    const diff = diffs[0]
    if (diff.path && !input.path) input.path = diff.path
    input.oldString = diff.oldText === null ? "" : diff.oldText
    input.newString = diff.newText
  }

  const chunk = terminalOutputChunk(update)
  const streamedTerminal = Boolean(meta?.streamedTerminal || chunk !== undefined)
  const streamed =
    chunk === undefined
      ? existing?.output
      : clip(chunk.replace ? chunk.data : `${existing?.output ?? ""}${chunk.data}`)
  const terminal = terminalEvents(update)
  const terminalOpen = (Boolean(meta?.terminalOpen) || terminal.opened) && !terminal.exited

  metaFor(states).set(id, {
    agent: resolved.agent,
    rawName: resolved.rawName,
    rawInput: effectiveRaw,
    streamedTerminal,
    terminalOpen,
  })

  const reported = toolUpdateStatus(update) ?? existing?.status ?? "pending"
  // A completed call whose terminal is still open went to the background: it
  // runs on until the terminal exits.
  const status = reported === "completed" && terminalOpen ? "in_progress" : reported
  const state: AcpToolState = {
    id,
    name,
    kind,
    title,
    input,
    status,
    isError: status === "failed",
    done: status === "completed" || status === "failed",
    output: extractOutput(update, {
      streamed,
      streamedTerminal,
      stripAntigravityHeader: resolved.agent === "antigravity" && resolved.rawName === "run_command",
    }),
  }
  states.set(id, state)
  return state
}
