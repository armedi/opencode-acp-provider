import type { AcpServerManager, LogFn } from "./server-manager.ts"
import { basicAuth, errorMessage, sleep } from "./util.ts"

/** Local HTTP API of the OpenCode server hosting this plugin. */
export interface LocalService {
  url: string
  password: string
}

export interface SteeringPrompt {
  readonly sessionID: string
  readonly delivery: "steer" | "queue"
  readonly prompt: {
    readonly text?: string
    readonly files?: readonly unknown[]
    readonly skills?: readonly unknown[]
    readonly agents?: readonly unknown[]
  }
}

export interface SteeringOptions {
  manager: Pick<AcpServerManager, "interrupt" | "running">
  localService: () => Promise<LocalService | undefined>
  directory: string
  log: LogFn
  /** Total budget for checking and waiting on an ACP turn that has not reached the shim. */
  startTimeoutMs?: number
}

const DEFAULT_START_TIMEOUT_MS = 1_500
const ACTIVE_REQUEST_TIMEOUT_MS = 250
const START_POLL_MS = 25

async function sessionRunning(service: LocalService, directory: string, sessionID: string, timeoutMs: number) {
  const response = await fetch(`${service.url.replace(/\/+$/, "")}/api/session/active`, {
    headers: {
      authorization: basicAuth(service.password),
      "x-opencode-directory": encodeURIComponent(directory),
    },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    await response.body?.cancel()
    return false
  }
  const { data } = (await response.json()) as { data?: unknown }
  return Boolean(data && typeof data === "object" && Object.hasOwn(data, sessionID))
}

/**
 * Admission runs before OpenCode durably queues the prompt. Do not send its
 * contents from here: OpenCode must be the only owner of delivery. Interrupt
 * the current ACP turn so OpenCode can deliver the intact message next.
 */
export function createSteering(options: SteeringOptions) {
  return async function steer(event: SteeringPrompt): Promise<void> {
    const { sessionID, delivery, prompt } = event
    if (delivery !== "steer") return
    const hasText = typeof prompt.text === "string" && Boolean(prompt.text.trim())
    if (!hasText && !prompt.files?.length && !prompt.skills?.length && !prompt.agents?.length) return

    try {
      if (!options.manager.running(sessionID)) {
        // Ordinary prompts also arrive as "steer". Only wait if the host is
        // already executing this session and ACP may still be starting up.
        const deadline = performance.now() + (options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS)
        const service = await options.localService()
        const remaining = Math.ceil(deadline - performance.now())
        if (!service || remaining <= 0) return
        if (!(await sessionRunning(service, options.directory, sessionID, Math.min(remaining, ACTIVE_REQUEST_TIMEOUT_MS)))) {
          return
        }
        while (!options.manager.running(sessionID)) {
          const delay = Math.min(START_POLL_MS, deadline - performance.now())
          if (delay <= 0) return
          await sleep(delay)
        }
      }
      options.manager.interrupt(sessionID)
    } catch (error) {
      // A failed lookup must never prevent the host from admitting the prompt.
      options.log("debug", `ACP steering skipped: ${errorMessage(error)}`)
    }
  }
}
