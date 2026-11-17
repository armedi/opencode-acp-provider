import type { AcpServerManager, LogFn } from "./server-manager.ts"

/**
 * Steering: a message the user sends while a turn is already running.
 *
 * OpenCode parks it in the session inbox and delivers it at the next step
 * boundary. An ACP turn is a single step no matter how many tools the agent
 * runs, so without help the message waits for the whole turn. An agent that
 * advertises `_session/steering` takes it mid-turn instead; the queued copy is
 * then dropped so it is not delivered twice. Agents without the extension are
 * interrupted, and OpenCode's normal step boundary delivers the message as a
 * prompt that resumes the same ACP session.
 */

/** Local HTTP API of the OpenCode server hosting this plugin. */
export interface LocalService {
  url: string
  password: string
}

/** The part of OpenCode's `prompt` hook a steer needs. */
export interface SteeringPrompt {
  readonly sessionID: string
  readonly messageID: string
  readonly delivery: "steer" | "queue"
  readonly prompt: {
    readonly text?: string
    readonly files?: readonly unknown[]
    readonly skills?: readonly unknown[]
  }
}

export interface SteeringOptions {
  manager: Pick<AcpServerManager, "steer" | "running">
  /** Discovered lazily: the server may register its HTTP address after setup. */
  localService: () => Promise<LocalService | undefined>
  /** Directory the session belongs to, sent to the HTTP API. */
  directory: string
  log: LogFn
  /** How long to wait for OpenCode to admit the message. Defaults to 5s. */
  admitTimeoutMs?: number
}

const DEFAULT_ADMIT_TIMEOUT_MS = 5_000
const INBOX_POLL_MS = 50

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function basicAuth(password: string) {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`
}

/**
 * The inbox route for one session, or undefined when the local API is not
 * reachable. Steering in place without a way to drop the queued copy would
 * deliver the user's message twice, so callers fall back to an interrupt.
 */
async function openInbox(service: LocalService, directory: string, sessionID: string) {
  const base = service.url.replace(/\/+$/, "")
  const endpoint = `${base}/api/session/${encodeURIComponent(sessionID)}/inbox`
  const headers = {
    authorization: basicAuth(service.password),
    "x-opencode-directory": encodeURIComponent(directory),
  }

  const list = async (): Promise<Set<string> | undefined> => {
    try {
      const response = await fetch(endpoint, { headers })
      if (!response.ok) return undefined
      const body = (await response.json()) as { data?: unknown }
      const items = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
      return new Set(
        items
          .map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : undefined))
          .filter((id): id is string => typeof id === "string"),
      )
    } catch {
      return undefined
    }
  }

  if (!(await list())) return undefined

  return {
    list,
    async remove(id: string) {
      try {
        const response = await fetch(`${endpoint}/${encodeURIComponent(id)}`, { method: "DELETE", headers })
        return response.ok
      } catch {
        return false
      }
    },
  }
}

/**
 * Drop the queued message once the agent has taken it. Admission happens after
 * the prompt hook returns, so the row may not exist yet; poll until it does.
 */
async function dropAdmitted(
  inbox: NonNullable<Awaited<ReturnType<typeof openInbox>>>,
  inboxID: string,
  timeoutMs: number,
  log: LogFn,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pending = await inbox.list()
    if (pending === undefined) break
    if (pending.has(inboxID)) {
      if (await inbox.remove(inboxID)) return
      // The row appeared but the delete did not land; try the next round.
    }
    await sleep(INBOX_POLL_MS)
  }
  log("warn", `steered message ${inboxID} is still queued in OpenCode; it may be delivered twice`)
}

/** Builds the `prompt` hook handler for one plugin instance. */
export function createSteering(options: SteeringOptions) {
  const log = options.log
  return async function steer(event: SteeringPrompt): Promise<void> {
    try {
      if (event.delivery !== "steer") return
      const text = typeof event.prompt?.text === "string" ? event.prompt.text.trim() : ""
      // Attachments and skill expansions are materialized after this hook, so
      // only a plain message can be handed to the agent in place. Anything else
      // keeps OpenCode's normal delivery, which carries the full prompt.
      if (!text || event.prompt.files?.length || event.prompt.skills?.length) return
      // Ordinary prompts also arrive as "steer"; only a running ACP turn has
      // anything to steer, and checking that first keeps this hook off the
      // common path.
      if (!options.manager.running(event.sessionID)) return

      const service = await options.localService()
      const inbox = service ? await openInbox(service, options.directory, event.sessionID) : undefined

      const result = await options.manager.steer({ key: event.sessionID, text, inPlace: inbox !== undefined })
      if (result.status !== "steered" || !inbox) {
        if (result.status !== "unavailable") log("debug", `steering fell back to ${result.status} for ${event.sessionID}`)
        return
      }
      await dropAdmitted(inbox, event.messageID, options.admitTimeoutMs ?? DEFAULT_ADMIT_TIMEOUT_MS, log)
    } catch (error) {
      // A steer must never break the prompt it belongs to.
      log("warn", `steering failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
