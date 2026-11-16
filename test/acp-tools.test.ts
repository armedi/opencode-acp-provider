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

test("renders MCP calls as a console card and reads their result", () => {
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
  expect(state?.name).toBe("shell")
  expect(state?.input.command).toBe('mcp.opencode.models {"query":"gpt-6"}')

  const completed = applyToolUpdate(
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "exec-3",
      status: "completed",
      rawOutput: { result: { content: [{ type: "text", text: '{"total":9}' }] } },
    },
    states,
  )
  expect(completed?.output).toBe('{"total":9}')
})

test("renders mcp__ tool names as console cards", () => {
  const states = new Map<string, AcpToolState>()
  const pending = applyToolUpdate(
    {
      sessionUpdate: "tool_call",
      toolCallId: "call-mcp",
      name: "mcp__opencode__models",
      title: "mcp__opencode__models",
      kind: "other",
      status: "pending",
      rawInput: {},
    },
    states,
  )
  expect(pending?.name).toBe("shell")
  // Codex sends arguments with the first update; Claude sends them later.
  expect(pending?.input.command).toBeUndefined()

  const args = applyToolUpdate(
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-mcp",
      rawInput: { query: "claude", limit: 1 },
    },
    states,
  )
  expect(args?.input.command).toBe('mcp.opencode.models {"query":"claude","limit":1}')

  const completed = applyToolUpdate(
    {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-mcp",
      status: "completed",
      rawOutput: '{"total":30}',
    },
    states,
  )
  expect(completed?.output).toBe('{"total":30}')
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
