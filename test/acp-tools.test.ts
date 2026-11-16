import { expect, test } from "bun:test"
import { applyToolUpdate, type AcpToolState } from "../src/acp-tools.ts"

test("maps a shell tool call and preserves its output", () => {
  const states = new Map<string, AcpToolState>()
  const state = applyToolUpdate(
    {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "List files",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: ["bash", "-lc", "ls -la"] },
    },
    states,
  )
  expect(state?.name).toBe("shell")
  expect(state?.input.command).toBe("ls -la")

  const completed = applyToolUpdate(
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      rawOutput: { stdout: "a.txt\nb.txt" },
    },
    states,
  )
  expect(completed?.done).toBe(true)
  expect(completed?.output).toContain("a.txt")

  // A settled call is not reopened by a late update.
  expect(applyToolUpdate({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "pending" }, states)).toBeUndefined()
})

test("falls back to a reported diff for edits", () => {
  const states = new Map<string, AcpToolState>()
  const state = applyToolUpdate(
    {
      sessionUpdate: "tool_call",
      toolCallId: "call-2",
      title: "Edit app.ts",
      kind: "edit",
      status: "in_progress",
      rawInput: { path: "app.ts" },
      content: [{ type: "diff", path: "app.ts", oldText: "a", newText: "b" }],
    },
    states,
  )
  expect(state?.name).toBe("edit")
  expect(state?.input.oldString).toBe("a")
  expect(state?.input.newString).toBe("b")
})

test("names write calls when the title says so", () => {
  const states = new Map<string, AcpToolState>()
  const state = applyToolUpdate(
    {
      sessionUpdate: "tool_call",
      toolCallId: "call-3",
      title: "Create hello.txt",
      kind: "edit",
      status: "in_progress",
      rawInput: { file_path: "hello.txt", content: "hello" },
    },
    states,
  )
  expect(state?.name).toBe("write")
  expect(state?.input.path).toBe("hello.txt")
  expect(state?.input.content).toBe("hello")
})

test("keeps unknown tool kinds generic", () => {
  const states = new Map<string, AcpToolState>()
  const state = applyToolUpdate(
    { sessionUpdate: "tool_call", toolCallId: "call-4", title: "Think", status: "pending" },
    states,
  )
  expect(state?.name).toBe("tool")
  expect(state?.done).toBe(false)
})
