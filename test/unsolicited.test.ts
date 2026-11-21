import { expect, test } from "bun:test"
import { isUnsolicitedActivity, unsolicitedSummary, UnsolicitedTurn } from "../src/unsolicited.ts"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("treats only substantive post-turn activity as unsolicited wake triggers", () => {
  expect(isUnsolicitedActivity({ sessionUpdate: "session_info_update", title: "Background Command" })).toBe(false)
  expect(isUnsolicitedActivity({ sessionUpdate: "available_commands_update", availableCommands: [] })).toBe(false)
  expect(isUnsolicitedActivity({ sessionUpdate: "config_option_update", configOptions: [] })).toBe(false)
  expect(isUnsolicitedActivity({ sessionUpdate: "usage_update", used: 10, size: 100 })).toBe(false)
  expect(isUnsolicitedActivity({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } })).toBe(false)

  expect(isUnsolicitedActivity({ sessionUpdate: "tool_call_update", toolCallId: "bg-1", status: "completed" })).toBe(true)
  expect(isUnsolicitedActivity({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } })).toBe(true)
  expect(isUnsolicitedActivity({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } })).toBe(true)
  expect(isUnsolicitedActivity({ sessionUpdate: "plan", entries: [] })).toBe(true)
})

test("builds readable synthetic wake summaries for command completions and agent messages", () => {
  expect(
    unsolicitedSummary(
      { sessionUpdate: "tool_call_update", toolCallId: "bg-1", status: "completed" },
      { command: "sleep 60 && echo ok", title: "sleep 60" },
      "Antigravity",
    ),
  ).toEqual({
    description: "Background command finished: sleep 60 && echo ok",
    text: "Background command finished: sleep 60 && echo ok",
  })

  expect(
    unsolicitedSummary(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "bg-2",
        status: "failed",
        rawInput: { CommandLine: "exit 1" },
      },
      undefined,
      "Antigravity",
    ),
  ).toEqual({
    description: "Background command failed: exit 1",
    text: "Background command failed: exit 1",
  })

  expect(
    unsolicitedSummary(
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "finished" } },
      undefined,
      "Claude Code",
    ),
  ).toEqual({
    description: "Claude Code background task finished",
    text: "Claude Code background task finished",
  })
})

test("replays buffered updates when attached after an already-settled fast continuation", async () => {
  let settled = 0
  const turn = new UnsolicitedTurn({
    description: "Claude Code background task finished",
    text: "Claude Code background task finished",
    timing: { postUsageMs: 30, messageIdleMs: 120 },
    onSettled: () => {
      settled += 1
    },
  })

  turn.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "part 1 " } })
  turn.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "part 2" } })
  turn.push({
    sessionUpdate: "usage_update",
    used: 200,
    size: 1000,
    cost: { amount: 0.01, currency: "USD" },
    _meta: { "_claude/origin": { kind: "task-notification" } },
  })

  await wait(80)
  expect(settled).toBe(1)

  const seen: string[] = []
  const result = await turn.attach((update) => seen.push(update.sessionUpdate))
  expect(result).toEqual({ stopReason: "end_turn", text: "part 1 part 2" })
  expect(seen).toEqual(["agent_message_chunk", "agent_message_chunk", "usage_update"])
})

test("does not settle prematurely after thought-only usage_update before a follow-up tool call", async () => {
  const turn = new UnsolicitedTurn({
    description: "Background command finished: sleep 10",
    text: "Background command finished: sleep 10",
    timing: {
      awaitingResponseMs: 150,
      thinkingIdleMs: 150,
      thoughtUsageMs: 120,
      messageIdleMs: 150,
      postUsageMs: 30,
    },
  })

  const live: string[] = []
  const attached = turn.attach((update) => {
    live.push(update.sessionUpdate)
  })

  turn.push({ sessionUpdate: "tool_call_update", toolCallId: "bg-1", status: "completed" })
  turn.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "now run followup" } })
  turn.push({ sessionUpdate: "usage_update", used: 100, size: 1000 })

  // Even past `postUsageMs`, a thought-only `usage_update` keeps waiting for the tool call.
  await wait(55)
  turn.push({ sessionUpdate: "tool_call", toolCallId: "followup-1", status: "in_progress" })
  await wait(80)
  turn.push({ sessionUpdate: "tool_call_update", toolCallId: "followup-1", status: "completed" })
  turn.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "all done" } })
  turn.push({ sessionUpdate: "usage_update", used: 120, size: 1000 })

  const result = await attached
  expect(result).toEqual({ stopReason: "end_turn", text: "all done" })
  expect(live).toContain("tool_call")
  expect(live).toContain("agent_message_chunk")
})

test("pauses idle timers while a permission prompt is pending and settles once it completes", async () => {
  const turn = new UnsolicitedTurn({
    description: "Background command finished",
    text: "Background command finished",
    timing: { awaitingResponseMs: 50, postUsageMs: 30 },
  })

  const attached = turn.attach()
  turn.push({ sessionUpdate: "tool_call_update", toolCallId: "bg-1", status: "completed" })
  turn.push({ sessionUpdate: "tool_call", toolCallId: "followup-1", status: "pending" })
  turn.permissionStarted()

  // Held past awaitingResponseMs while permission is pending.
  await wait(80)
  turn.permissionEnded()
  turn.push({ sessionUpdate: "tool_call_update", toolCallId: "followup-1", status: "completed" })
  turn.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } })
  turn.push({ sessionUpdate: "usage_update", used: 10, size: 100 })

  const result = await attached
  expect(result).toEqual({ stopReason: "end_turn", text: "ok" })
})

test("cancels cleanly when the attached AbortSignal fires", async () => {
  const turn = new UnsolicitedTurn({
    description: "Background command finished",
    text: "Background command finished",
    timing: { awaitingResponseMs: 5_000 },
  })
  const controller = new AbortController()
  let aborted = 0
  const pending = turn.attach(undefined, controller.signal, () => {
    aborted += 1
  })
  turn.push({ sessionUpdate: "tool_call_update", toolCallId: "bg-1", status: "completed" })
  controller.abort()
  const result = await pending
  expect(aborted).toBe(1)
  expect(result.stopReason).toBe("cancelled")
})

test("fails without unhandled rejections if the session drops while unattached", async () => {
  const unhandled: unknown[] = []
  const listener = (error: unknown) => unhandled.push(error)
  process.on("unhandledRejection", listener)
  try {
    const turn = new UnsolicitedTurn({
      description: "Background command finished",
      text: "Background command finished",
      timing: { orphanTtlMs: 30 },
    })
    turn.fail(new Error("session closed"))
    await wait(50)
    expect(unhandled).toEqual([])
    await expect(turn.attach()).rejects.toThrow("session closed")
  } finally {
    process.off("unhandledRejection", listener)
  }
})
