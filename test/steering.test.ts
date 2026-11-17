import { afterEach, expect, test } from "bun:test"
import type { AcpServerManager, AcpSteerResult } from "../src/server-manager.ts"
import { createSteering, type SteeringPrompt } from "../src/steering.ts"

type SteerInput = Parameters<AcpServerManager["steer"]>[0]

const servers: Array<{ stop: () => void }> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

/** The slice of OpenCode's HTTP API steering touches: inbox rows and active sessions. */
function opencodeApi() {
  const pending = new Map<string, string>()
  const active = new Set<string>()
  const deleted: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/session/active") {
        return Response.json({ data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) })
      }
      const match = url.pathname.match(/^\/api\/session\/([^/]+)\/inbox(?:\/([^/]+))?$/)
      if (!match) return new Response("not found", { status: 404 })
      const inboxID = match[2] ? decodeURIComponent(match[2]) : undefined
      if (request.method === "DELETE" && inboxID) {
        deleted.push(inboxID)
        pending.delete(inboxID)
        return new Response(null, { status: 204 })
      }
      return Response.json({ data: [...pending.keys()].map((id) => ({ id })) })
    },
  })
  servers.push({ stop: () => server.stop(true) })
  return {
    service: { url: `http://127.0.0.1:${server.port}`, password: "secret" },
    admit(inboxID: string) {
      pending.set(inboxID, "change of plan")
    },
    activate(sessionID: string) {
      active.add(sessionID)
    },
    deleted,
  }
}

function promptEvent(overrides: Partial<SteeringPrompt> = {}): SteeringPrompt {
  return {
    sessionID: "ses_1",
    messageID: "msg_1",
    delivery: "steer",
    prompt: { text: "change of plan" },
    ...overrides,
  }
}

function steering(options: {
  result?: AcpSteerResult
  service?: { url: string; password: string }
  calls: SteerInput[]
  running?: boolean | (() => boolean)
}) {
  return createSteering({
    manager: {
      running: () => (typeof options.running === "function" ? options.running() : options.running !== false),
      async steer(input) {
        options.calls.push(input)
        return options.result ?? { status: "steered" }
      },
    },
    localService: async () => options.service,
    directory: "/tmp/project",
    log: () => {},
    admitTimeoutMs: 2_000,
    startTimeoutMs: 1_000,
  })
}

test("drops the queued message once the agent has taken it", async () => {
  const api = opencodeApi()
  const calls: SteerInput[] = []
  const steer = steering({ service: api.service, calls })

  // Admission happens after the prompt hook returns.
  await steer(promptEvent())
  api.admit("msg_1")
  for (let attempt = 0; attempt < 50 && api.deleted.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  expect(calls).toEqual([{ key: "ses_1", text: "change of plan", inPlace: true, plain: true }])
  expect(api.deleted).toEqual(["msg_1"])
})

test("leaves the message queued when the agent is interrupted instead", async () => {
  const api = opencodeApi()
  const calls: SteerInput[] = []
  const steer = steering({ service: api.service, calls, result: { status: "interrupted" } })

  await steer(promptEvent())
  expect(calls).toHaveLength(1)
  expect(api.deleted).toEqual([])
})

test("interrupts instead when the local API is unavailable", async () => {
  const calls: SteerInput[] = []
  const steer = steering({ calls })

  await steer(promptEvent())
  expect(calls).toEqual([{ key: "ses_1", text: "change of plan", inPlace: false, plain: true }])
})

test("ignores queued messages and empty prompts", async () => {
  const api = opencodeApi()
  const calls: SteerInput[] = []
  const steer = steering({ service: api.service, calls })

  await steer(promptEvent({ delivery: "queue" }))
  await steer(promptEvent({ prompt: { text: "   " } }))
  expect(calls).toEqual([])
})

test("interrupts a steer that carries attachments or skills", async () => {
  const api = opencodeApi()
  const calls: SteerInput[] = []
  // The text alone is not the whole prompt, so the turn is interrupted rather
  // than injected; OpenCode delivers the full message at the boundary.
  const steer = steering({ service: api.service, calls, result: { status: "interrupted" } })

  await steer(promptEvent({ prompt: { text: "look at this", files: [{ uri: "file:///a.png" }] } }))
  await steer(promptEvent({ prompt: { text: "", skills: [{ id: "review" }] } }))

  expect(calls).toEqual([
    { key: "ses_1", text: "look at this", inPlace: true, plain: false },
    { key: "ses_1", text: "", inPlace: true, plain: false },
  ])
  expect(api.deleted).toEqual([])
})

test("waits for the ACP turn of a session that is already executing", async () => {
  const api = opencodeApi()
  api.activate("ses_1")
  const calls: SteerInput[] = []
  let turnRunning = false
  // The prompt hook can run before the ACP prompt reaches the shim, while
  // OpenCode is already executing the session.
  const steer = steering({
    service: api.service,
    calls,
    running: () => turnRunning,
    result: { status: "interrupted" },
  })

  const work = steer(promptEvent())
  setTimeout(() => {
    turnRunning = true
  }, 100)
  await work

  expect(calls).toEqual([{ key: "ses_1", text: "change of plan", inPlace: true, plain: true }])
})

test("does nothing when the session is neither running nor executing", async () => {
  const api = opencodeApi()
  const calls: SteerInput[] = []
  const steer = steering({ service: api.service, calls, running: false })

  await steer(promptEvent())
  expect(calls).toEqual([])
  expect(api.deleted).toEqual([])
})
