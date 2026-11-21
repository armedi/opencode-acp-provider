import { randomUUID } from "node:crypto"
import type { PromptResult, SessionUpdate } from "./acp-client.ts"
import { commandOf, record, text } from "./acp-tools/shared.ts"

export interface UnsolicitedTimingOptions {
  /** Wait after a background or follow-up tool completes before the model starts responding. */
  awaitingResponseMs?: number
  /** Wait between thought chunks or plan updates. */
  thinkingIdleMs?: number
  /** Wait after a thought-only `usage_update` before concluding no tool or answer follows. */
  thoughtUsageMs?: number
  /** Fallback idle wait after `agent_message_chunk` if the agent emits no `usage_update`. */
  messageIdleMs?: number
  /** Grace window after `agent_message_chunk` + `usage_update` before settling. */
  postUsageMs?: number
  /** Hard safety cap on an unsolicited turn (`0` disables). */
  maxTurnMs?: number
  /** How long a settled unattached turn stays buffered for OpenCode to attach. */
  orphanTtlMs?: number
}

const DEFAULT_TIMING: Required<UnsolicitedTimingOptions> = {
  awaitingResponseMs: 60_000,
  thinkingIdleMs: 30_000,
  thoughtUsageMs: 15_000,
  messageIdleMs: 3_000,
  postUsageMs: 750,
  maxTurnMs: 30 * 60_000,
  orphanTtlMs: 60_000,
}

export interface BackgroundToolRecord {
  name?: string
  title?: string
  command?: string
  rawInput?: Record<string, unknown>
}

export type UnsolicitedPhase =
  | "awaiting-response"
  | "tool-running"
  | "streaming"
  | "post-usage"
  | "settled"

/**
 * Only substantive post-turn agent output or tool progress wakes the OpenCode
 * session. Metadata updates (`session_info_update`, `available_commands_update`,
 * `config_option_update`, `current_mode_update`, standalone `usage_update`) can
 * arrive asynchronously after `end_turn` and must not trigger a synthetic turn.
 */
export function isUnsolicitedActivity(update: SessionUpdate): boolean {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return (
        update.content?.type === "text" &&
        typeof update.content.text === "string" &&
        update.content.text.length > 0
      )
    case "tool_call":
    case "tool_call_update":
      return true
    case "plan":
      return Array.isArray(update.entries)
    default:
      return false
  }
}

function truncateSummary(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** Build the user-visible summary for the synthetic message waking OpenCode. */
export function unsolicitedSummary(
  update: SessionUpdate,
  backgroundTool?: BackgroundToolRecord,
  agentLabel?: string,
): { description: string; text: string } {
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const raw = record(update.rawInput) ?? backgroundTool?.rawInput
    const detail =
      commandOf(raw?.CommandLine ?? raw?.command) ??
      backgroundTool?.command ??
      text(update.title) ??
      backgroundTool?.title
    const prefix = update.status === "failed" ? "Background command failed" : "Background command finished"
    const description = detail ? `${prefix}: ${truncateSummary(detail)}` : prefix
    return { description, text: description }
  }
  const description = agentLabel ? `${agentLabel} background task finished` : "Background task finished"
  return { description, text: description }
}

function isClaudeTaskNotificationEnd(update: SessionUpdate): boolean {
  if (update.cost === undefined) return false
  const origin = record(record(update._meta)?.["_claude/origin"])
  return origin?.kind === "task-notification"
}

export interface UnsolicitedTurnOptions {
  description: string
  text: string
  timing?: UnsolicitedTimingOptions
  onSettled?: (result: PromptResult) => void
  onExpire?: () => void
}

/**
 * Buffers and tracks the lifecycle of one autonomous post-turn ACP continuation
 * (such as a background shell completion and the agent's reaction), because ACP
 * delivers unsolicited `session/update` notifications without a closing RPC reply.
 */
export class UnsolicitedTurn {
  readonly token = randomUUID()
  readonly description: string
  readonly text: string

  private readonly timing: Required<UnsolicitedTimingOptions>
  private readonly onSettled?: (result: PromptResult) => void
  private readonly onExpire?: () => void
  private readonly buffered: SessionUpdate[] = []
  private readonly activeTools = new Set<string>()
  private readonly donePromise: Promise<PromptResult>
  private doneResolve!: (result: PromptResult) => void
  private doneReject!: (error: Error) => void

  private phase: UnsolicitedPhase = "awaiting-response"
  private currentIdleMs = 0
  private subscriber?: (update: SessionUpdate) => void
  private _attached = false
  private settled = false
  private stopReason = "end_turn"
  private accumulatedText = ""
  private failure?: Error
  private stepHasMessage = false
  private pendingPermissions = 0
  private idleTimer?: ReturnType<typeof setTimeout>
  private maxTimer?: ReturnType<typeof setTimeout>
  private orphanTimer?: ReturnType<typeof setTimeout>

  constructor(options: UnsolicitedTurnOptions) {
    this.description = options.description
    this.text = options.text
    this.timing = { ...DEFAULT_TIMING, ...options.timing }
    this.onSettled = options.onSettled
    this.onExpire = options.onExpire
    this.donePromise = new Promise<PromptResult>((resolve, reject) => {
      this.doneResolve = resolve
      this.doneReject = reject
    })
    // Rejections while unattached are observed on attach() via `this.failure`.
    this.donePromise.catch(() => {})

    if (this.timing.maxTurnMs > 0 && Number.isFinite(this.timing.maxTurnMs)) {
      this.maxTimer = setTimeout(() => this.finish("end_turn"), this.timing.maxTurnMs)
      this.maxTimer.unref?.()
    }
  }

  get attached(): boolean {
    return this._attached
  }

  push(update: SessionUpdate): void {
    if (this.settled) return

    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content?.type === "text" &&
      typeof update.content.text === "string"
    ) {
      this.accumulatedText += update.content.text
    }

    if (this._attached) this.subscriber?.(update)
    else this.buffered.push(update)

    this.advance(update)
  }

  permissionStarted(): void {
    if (this.settled) return
    this.pendingPermissions += 1
    this.clearIdleTimer()
  }

  permissionEnded(): void {
    this.pendingPermissions = Math.max(0, this.pendingPermissions - 1)
    if (this.settled || this.pendingPermissions > 0 || this.activeTools.size > 0) return
    this.armIdleTimer(this.currentIdleMs)
  }

  async attach(
    onUpdate?: (update: SessionUpdate) => void,
    signal?: AbortSignal,
    onAbort?: () => void,
  ): Promise<PromptResult> {
    this._attached = true
    this.clearOrphanTimer()

    for (const update of this.buffered.splice(0)) onUpdate?.(update)

    if (this.settled) {
      if (this.failure) throw this.failure
      return { stopReason: this.stopReason, text: this.accumulatedText }
    }

    if (signal?.aborted) {
      onAbort?.()
      this.cancel()
      return { stopReason: "cancelled", text: this.accumulatedText }
    }

    this.subscriber = onUpdate
    return await new Promise<PromptResult>((resolve, reject) => {
      const onSignalAbort = () => {
        onAbort?.()
        this.cancel()
      }
      signal?.addEventListener("abort", onSignalAbort, { once: true })
      this.donePromise.then(
        (result) => {
          signal?.removeEventListener("abort", onSignalAbort)
          resolve(result)
        },
        (error) => {
          signal?.removeEventListener("abort", onSignalAbort)
          reject(error)
        },
      )
    })
  }

  finish(stopReason = "end_turn"): void {
    if (this.settled) return
    this.settled = true
    this.phase = "settled"
    this.stopReason = stopReason
    this.clearTimers()
    this.subscriber = undefined
    const result: PromptResult = { stopReason, text: this.accumulatedText }
    this.onSettled?.(result)
    this.doneResolve(result)
    if (!this._attached && this.timing.orphanTtlMs > 0 && Number.isFinite(this.timing.orphanTtlMs)) {
      this.orphanTimer = setTimeout(() => {
        this.orphanTimer = undefined
        this.onExpire?.()
      }, this.timing.orphanTtlMs)
      this.orphanTimer.unref?.()
    }
  }

  cancel(): void {
    this.finish("cancelled")
  }

  fail(error: Error): void {
    if (this.settled) return
    this.settled = true
    this.phase = "settled"
    this.failure = error
    this.clearTimers()
    this.subscriber = undefined
    this.onSettled?.({ stopReason: "end_turn", text: this.accumulatedText })
    if (this._attached) {
      this.doneReject(error)
    } else if (this.timing.orphanTtlMs > 0 && Number.isFinite(this.timing.orphanTtlMs)) {
      this.orphanTimer = setTimeout(() => {
        this.orphanTimer = undefined
        this.onExpire?.()
      }, this.timing.orphanTtlMs)
      this.orphanTimer.unref?.()
    }
  }

  dispose(): void {
    this.clearTimers()
    this.clearOrphanTimer()
    this.subscriber = undefined
    if (this.settled) return
    this.settled = true
    this.phase = "settled"
    this.stopReason = "cancelled"
    this.doneResolve({ stopReason: "cancelled", text: this.accumulatedText })
  }

  private advance(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "tool_call":
      case "tool_call_update": {
        const id = typeof update.toolCallId === "string" ? update.toolCallId : undefined
        const status = typeof update.status === "string" ? update.status : undefined
        const terminal = status === "completed" || status === "failed"
        if (terminal) {
          if (id) this.activeTools.delete(id)
          this.stepHasMessage = false
          if (this.activeTools.size > 0 || this.pendingPermissions > 0) {
            this.enterPhase("tool-running", 0)
          } else {
            this.enterPhase("awaiting-response", this.timing.awaitingResponseMs)
          }
        } else {
          if (id) this.activeTools.add(id)
          this.stepHasMessage = false
          this.enterPhase("tool-running", 0)
        }
        return
      }
      case "agent_thought_chunk": {
        if (
          update.content?.type === "text" &&
          typeof update.content.text === "string" &&
          update.content.text.length > 0
        ) {
          this.activeTools.clear()
          this.enterPhase("streaming", this.pendingPermissions > 0 ? 0 : this.timing.thinkingIdleMs)
        }
        return
      }
      case "agent_message_chunk": {
        if (
          update.content?.type === "text" &&
          typeof update.content.text === "string" &&
          update.content.text.length > 0
        ) {
          this.activeTools.clear()
          this.stepHasMessage = true
          this.enterPhase("streaming", this.pendingPermissions > 0 ? 0 : this.timing.messageIdleMs)
        }
        return
      }
      case "plan": {
        if (Array.isArray(update.entries) && this.activeTools.size === 0 && this.pendingPermissions === 0) {
          this.enterPhase("streaming", this.timing.thinkingIdleMs)
        }
        return
      }
      case "usage_update": {
        if (this.activeTools.size > 0 || this.pendingPermissions > 0) return
        if (isClaudeTaskNotificationEnd(update)) {
          this.enterPhase("post-usage", Math.min(50, this.timing.postUsageMs))
        } else if (this.stepHasMessage) {
          this.enterPhase("post-usage", this.timing.postUsageMs)
        } else {
          this.enterPhase("awaiting-response", this.timing.thoughtUsageMs)
        }
        return
      }
      default:
        return
    }
  }

  private enterPhase(phase: UnsolicitedPhase, idleMs: number): void {
    this.phase = phase
    this.currentIdleMs = idleMs
    this.armIdleTimer(idleMs)
  }

  private armIdleTimer(ms: number): void {
    this.clearIdleTimer()
    if (this.settled || !(ms > 0) || !Number.isFinite(ms)) return
    this.idleTimer = setTimeout(() => this.finish("end_turn"), ms)
    this.idleTimer.unref?.()
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private clearOrphanTimer(): void {
    if (!this.orphanTimer) return
    clearTimeout(this.orphanTimer)
    this.orphanTimer = undefined
  }

  private clearTimers(): void {
    this.clearIdleTimer()
    if (this.maxTimer) {
      clearTimeout(this.maxTimer)
      this.maxTimer = undefined
    }
  }
}
