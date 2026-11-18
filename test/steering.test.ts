import { expect, test } from "bun:test"
import { createSteering } from "../src/steering.ts"

test("interrupts a running turn without looking up the inbox or changing the prompt", async () => {
  const interrupted: string[] = []
  let lookups = 0
  const steer = createSteering({
    manager: { running: () => true, interrupt: (key) => { interrupted.push(key) } },
    localService: async () => { lookups += 1; return undefined },
    directory: "/tmp/project",
    log: () => {},
  })
  const prompt = { text: "change of plan", files: [{ uri: "file:///attachment.png" }] }
  await steer({ sessionID: "chat", delivery: "steer", prompt })
  await steer({ sessionID: "text-chat", delivery: "steer", prompt: { text: "change of plan" } })
  await steer({ sessionID: "skill-chat", delivery: "steer", prompt: { skills: [{ id: "review" }] } })
  await steer({ sessionID: "queued", delivery: "queue", prompt })
  await steer({ sessionID: "empty", delivery: "steer", prompt: { text: " " } })
  expect(interrupted).toEqual(["chat", "text-chat", "skill-chat"])
  expect(lookups).toBe(0)
  expect(prompt).toEqual({ text: "change of plan", files: [{ uri: "file:///attachment.png" }] })
})

test("interrupts a starting turn only if the host is already executing the session", async () => {
  const interrupted: string[] = []
  const checked = Promise.withResolvers<void>()
  let running = false
  let requests = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/api/session/active")
      if (++requests === 2) checked.resolve()
      return Response.json({ data: { starting: { type: "running" } } })
    },
  })
  try {
    const steer = createSteering({
      manager: { running: (key) => key === "starting" && running, interrupt: (key) => { interrupted.push(key) } },
      localService: async () => ({ url: server.url.href, password: "secret" }),
      directory: "/tmp/project",
      log: () => {},
    })
    const prompt = { text: "hi" }
    await steer({ sessionID: "idle", delivery: "steer", prompt })
    expect(interrupted).toEqual([])
    const work = steer({ sessionID: "starting", delivery: "steer", prompt })
    await checked.promise
    running = true
    await work
    expect(interrupted).toEqual(["starting"])
  } finally {
    server.stop(true)
  }
})

test("allows prompt admission when the active-session response body stalls", async () => {
  let requests = 0
  const interrupted: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      requests += 1
      return new Response(new ReadableStream({
        start: (controller) => controller.enqueue(new TextEncoder().encode('{"data":')),
      }))
    },
  })
  try {
    const steer = createSteering({
      manager: { running: () => false, interrupt: (key) => { interrupted.push(key) } },
      localService: async () => ({ url: server.url.href, password: "secret" }),
      directory: "/tmp/project",
      log: () => {},
    })
    await steer({ sessionID: "chat", delivery: "steer", prompt: { text: "hi" } })
    expect(requests).toBe(1)
    expect(interrupted).toEqual([])
  } finally {
    server.stop(true)
  }
}, 1_500)
