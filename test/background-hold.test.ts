import { expect, test } from "bun:test"
import { createBackgroundHold } from "../src/background-hold.ts"

type HoldEvent = { type: string; data?: { sessionID?: unknown } }

/** A stand-in for OpenCode's event stream that the test pushes events into. */
function events() {
  const queue: HoldEvent[] = []
  let wake: (() => void) | undefined
  return {
    emit(event: HoldEvent) {
      queue.push(event)
      wake?.()
    },
    async *subscribe(signal: AbortSignal): AsyncIterable<HoldEvent> {
      while (!signal.aborted) {
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }
    },
  }
}

const settledWithin = async (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), Bun.sleep(ms).then(() => false)])

test("holds the session until input reaches its inbox, ignoring other sessions", async () => {
  const stream = events()
  const hold = createBackgroundHold({
    pending: () => ["bg-1"],
    owns: async () => true,
    subscribe: (signal) => stream.subscribe(signal),
  })
  try {
    const idle = hold.idle({ sessionID: "ses_a" })
    stream.emit({ type: "session.inbox.enqueued", data: { sessionID: "ses_b" } })
    expect(await settledWithin(idle, 50)).toBe(false)

    stream.emit({ type: "session.inbox.enqueued", data: { sessionID: "ses_a" } })
    expect(await settledWithin(idle, 200)).toBe(true)

    // The work still runs, so the next idle point holds again.
    expect(await settledWithin(hold.idle({ sessionID: "ses_a" }), 50)).toBe(false)
  } finally {
    hold.dispose()
  }
})

test("goes idle at once without pending work or for a session on another provider", async () => {
  const hold = createBackgroundHold({
    pending: (sessionID) => (sessionID === "ses_acp" || sessionID === "ses_other" ? ["bg-1"] : []),
    owns: async (sessionID) => sessionID === "ses_acp",
  })
  try {
    expect(await settledWithin(hold.idle({ sessionID: "ses_idle" }), 50)).toBe(true)
    expect(await settledWithin(hold.idle({ sessionID: "ses_other" }), 50)).toBe(true)
  } finally {
    hold.dispose()
  }
})

test("releases when the background work finishes", async () => {
  let pending = ["bg-1"]
  const hold = createBackgroundHold({ pending: () => pending, owns: async () => true, pollMs: 10 })
  try {
    const idle = hold.idle({ sessionID: "ses_a" })
    expect(await settledWithin(idle, 50)).toBe(false)
    pending = []
    expect(await settledWithin(idle, 200)).toBe(true)
  } finally {
    hold.dispose()
  }
})

test("an interrupt stops waiting for that work but not for work started later", async () => {
  const stream = events()
  let pending = ["bg-1"]
  const hold = createBackgroundHold({
    pending: () => pending,
    owns: async () => true,
    subscribe: (signal) => stream.subscribe(signal),
  })
  try {
    const idle = hold.idle({ sessionID: "ses_a" })
    stream.emit({ type: "session.execution.interrupted", data: { sessionID: "ses_a" } })
    expect(await settledWithin(idle, 200)).toBe(true)
    expect(await settledWithin(hold.idle({ sessionID: "ses_a" }), 50)).toBe(true)

    pending = ["bg-1", "bg-2"]
    expect(await settledWithin(hold.idle({ sessionID: "ses_a" }), 50)).toBe(false)
  } finally {
    hold.dispose()
  }
})

test("releases at the hold cap", async () => {
  const hold = createBackgroundHold({ pending: () => ["bg-1"], owns: async () => true, maxHoldMs: 30 })
  try {
    expect(await settledWithin(hold.idle({ sessionID: "ses_a" }), 300)).toBe(true)
  } finally {
    hold.dispose()
  }
})
