import { afterEach, expect, test } from "bun:test"
import type { AcpServerManager, AcpSteerResult } from "../src/server-manager.ts"
import { createSteering, type SteeringPrompt } from "../src/steering.ts"

type SteerInput = Parameters<AcpServerManager["steer"]>[0]

const servers: Array<{ stop: () => void }> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

/** The slice of OpenCode's HTTP API steering touches: list and delete inbox rows. */
function opencodeApi() {
  const pending = new Map<string, string>()
  const deleted: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
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
  running?: boolean
}) {
  return createSteering({
    manager: {
      running: () => options.running !== false,
      async steer(input) {
        options.calls.push(input)
        return options.result ?? { status: "steered" }
      },
    },
    localService: async () => options.service,
    directory: "/tmp/project",
    log: () => {},
    admitTimeoutMs: 2_000,
  })
}

test("drops the queued message once the agent has taken it", async () => {
  const api = opencodeApi()
  const calls: SteerInput[] = []
  const steer = steering({ service: api.service, calls })

  const running = steer(promptEvent())
  // Admission happens after the prompt hook returns.
  setTimeout(() => api.admit("msg_1"), 100)
  await running

  expect(calls).toEqual([{ key: "ses_1", text: "change of plan", inPlace: true }])
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
  expect(calls).toEqual([{ key: "ses_1", text: "change of plan", inPlace: false }])
})

test("ignores queued messages, attachments, and empty text", async () => {
  const api = opencodeApi()
  const calls: SteerInput[] = []
  const steer = steering({ service: api.service, calls })

  await steer(promptEvent({ delivery: "queue" }))
  await steer(promptEvent({ prompt: { text: "look at this", files: [{ uri: "file:///a.png" }] } }))
  await steer(promptEvent({ prompt: { text: "   " } }))
  expect(calls).toEqual([])
})

test("does nothing when no ACP turn is running", async () => {
  const api = opencodeApi()
  const calls: SteerInput[] = []
  const steer = steering({ service: api.service, calls, running: false })

  await steer(promptEvent())
  expect(calls).toEqual([])
  expect(api.deleted).toEqual([])
})
