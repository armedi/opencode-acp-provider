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

test("maps codex read calls from locations and terminal output", () => {
  const states = new Map<string, AcpToolState>()
  const state = applyToolUpdate(
    {
      sessionUpdate: "tool_call",
      toolCallId: "exec-1",
      name: "exec_command",
      title: "Read file '/tmp/sample.txt'",
      kind: "read",
      status: "in_progress",
      locations: [{ path: "/tmp/sample.txt" }],
    },
    states,
  )
  expect(state?.name).toBe("read")
  expect(state?.input.path).toBe("/tmp/sample.txt")

  applyToolUpdate(
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "exec-1",
      _meta: { terminal_output_delta: { data: "alpha\nbeta\n" } },
    },
    states,
  )
  const completed = applyToolUpdate(
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "exec-1",
      status: "completed",
      rawOutput: { exit_code: 0 },
    },
    states,
  )
  expect(completed?.output).toBe("alpha\nbeta\n")
})

test("keeps MCP calls as generic cards with their real names and reads their result", () => {
  const states = new Map<string, AcpToolState>()
  const state = applyToolUpdate(
    {
      sessionUpdate: "tool_call",
      toolCallId: "exec-3",
      kind: "execute",
      title: "mcp.opencode.models",
      status: "in_progress",
      rawInput: { server: "opencode", tool: "models", arguments: { query: "gpt-6" } },
      _meta: { is_mcp_tool_call: true },
    },
    states,
  )
  expect(state?.name).toBe("mcp.opencode.models")
  expect(state?.input).toEqual({ server: "opencode", tool: "models", arguments: { query: "gpt-6" } })

  const completed = applyToolUpdate(
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "exec-3",
      status: "completed",
      rawOutput: { result: { content: [{ type: "text", text: '{"total":9}' }] } },
    },
    states,
  )
  expect(completed?.name).toBe("mcp.opencode.models")
  expect(completed?.output).toBe('{"total":9}')

  // Agents that name the tool `mcp__server__tool` send arguments with a later update.
  const named = applyToolUpdate(
    {
      sessionUpdate: "tool_call",
      toolCallId: "exec-4",
      name: "mcp__opencode__models",
      title: "mcp__opencode__models",
      kind: "other",
      status: "pending",
      rawInput: {},
    },
    states,
  )
  expect(named?.name).toBe("mcp__opencode__models")
  expect(named?.input).toEqual({})

  const args = applyToolUpdate(
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "exec-4",
      rawInput: { query: "claude", limit: 1 },
    },
    states,
  )
  expect(args?.name).toBe("mcp__opencode__models")
  expect(args?.input).toEqual({ query: "claude", limit: 1 })
})

test("does not surface internal think calls as tool cards", () => {
  const states = new Map<string, AcpToolState>()
  const state = applyToolUpdate(
    {
      sessionUpdate: "tool_call",
      toolCallId: "guardian-1",
      kind: "think",
      title: "Guardian Review",
      status: "in_progress",
    },
    states,
  )
  expect(state).toBeUndefined()
  // The completion update carries no kind, so it must not create a late card.
  expect(
    applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "guardian-1",
        status: "completed",
      },
      states,
    ),
  ).toBeUndefined()
})
