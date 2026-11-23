/**
 * Keeps an OpenCode session running while its ACP agent still has background
 * work, so the session shows as busy rather than idle.
 *
 * OpenCode awaits the `experimental.idle` hook inside the session's execution
 * and admits input that arrives meanwhile into that same execution. Holding the
 * hook until the agent's background command finishes therefore keeps the
 * session active, and the wake-up message for the finished command continues
 * it without the session ever going idle.
 */

export interface BackgroundHoldOptions {
  /**
   * Ids of the session's ACP background work that has not finished: running
   * background tools, and wake-ups that no turn has picked up yet.
   */
  pending: (sessionID: string) => string[]
  /** Whether the session runs on an ACP provider of this plugin. */
  owns: (sessionID: string) => Promise<boolean>
  /** OpenCode's event stream, to release the hold when the session gets input or is interrupted. */
  subscribe?: (signal: AbortSignal) => AsyncIterable<{ type: string; data?: { sessionID?: unknown } }>
  /** How often to check whether the background work finished. */
  pollMs?: number
  /** Longest one hold may last; `0` disables the cap. */
  maxHoldMs?: number
}

const DEFAULT_POLL_MS = 500
const DEFAULT_MAX_HOLD_MS = 30 * 60_000

/** Input reached the session: a user prompt, a wake-up, or a subagent's result. */
const INBOX_ENQUEUED = "session.inbox.enqueued"
const INTERRUPTED = "session.execution.interrupted"

interface Hold {
  ids: string[]
  release: () => void
}

export function createBackgroundHold(options: BackgroundHoldOptions) {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const maxHoldMs = options.maxHoldMs ?? DEFAULT_MAX_HOLD_MS
  const holds = new Map<string, Set<Hold>>()
  // Work the user chose not to wait for: they interrupted the hold. It is not
  // held for again, so stopping the session sticks.
  const declined = new Map<string, Set<string>>()
  const controller = new AbortController()

  const releaseAll = (sessionID: string, decline: boolean) => {
    const active = holds.get(sessionID)
    if (!active) return
    for (const hold of [...active]) {
      if (decline) {
        const set = declined.get(sessionID) ?? new Set()
        for (const id of hold.ids) set.add(id)
        declined.set(sessionID, set)
      }
      hold.release()
    }
  }

  if (options.subscribe) {
    void (async () => {
      try {
        for await (const event of options.subscribe!(controller.signal)) {
          if (controller.signal.aborted) break
          const sessionID = event.data?.sessionID
          if (typeof sessionID !== "string") continue
          if (event.type === INBOX_ENQUEUED) releaseAll(sessionID, false)
          else if (event.type === INTERRUPTED) releaseAll(sessionID, true)
        }
      } catch {
        // The stream ends on dispose; holds still end by polling or the cap.
      }
    })()
  }

  /** The session's pending work that the user has not declined to wait for. */
  const awaited = (sessionID: string) => {
    const ids = options.pending(sessionID)
    const skip = declined.get(sessionID)
    if (!skip) return ids
    // Forget declined work once it finishes, so the set stays bounded.
    for (const id of skip) if (!ids.includes(id)) skip.delete(id)
    if (skip.size === 0) declined.delete(sessionID)
    return ids.filter((id) => !skip.has(id))
  }

  return {
    /** The `experimental.idle` hook: resolves once the session may go idle. */
    async idle(event: { sessionID: string }): Promise<void> {
      const sessionID = event.sessionID
      if (controller.signal.aborted || awaited(sessionID).length === 0) return
      if (!(await options.owns(sessionID).catch(() => false))) return
      const ids = awaited(sessionID)
      if (ids.length === 0 || controller.signal.aborted) return

      await new Promise<void>((resolve) => {
        let poll: ReturnType<typeof setInterval> | undefined
        let cap: ReturnType<typeof setTimeout> | undefined
        const hold: Hold = {
          ids,
          release: () => {
            clearInterval(poll)
            clearTimeout(cap)
            const active = holds.get(sessionID)
            active?.delete(hold)
            if (active?.size === 0) holds.delete(sessionID)
            resolve()
          },
        }
        const active = holds.get(sessionID) ?? new Set()
        active.add(hold)
        holds.set(sessionID, active)

        poll = setInterval(() => {
          if (controller.signal.aborted || awaited(sessionID).length === 0) hold.release()
        }, pollMs)
        poll.unref?.()
        if (maxHoldMs > 0 && Number.isFinite(maxHoldMs)) {
          cap = setTimeout(() => hold.release(), maxHoldMs)
          cap.unref?.()
        }
      })
    },
    dispose() {
      controller.abort()
      for (const sessionID of [...holds.keys()]) releaseAll(sessionID, false)
    },
  }
}
