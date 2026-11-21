import { expect, test } from "bun:test"
import { createShim } from "../src/shim.ts"
import type { AcpServerManager } from "../src/server-manager.ts"

const TOKEN = "shim-test-token"

type RunInput = {
  key?: string
  sessionKey?: string
  onUpdate?: (update: Record<string, unknown>) => void
}

function fakeManager(run: (input: RunInput) => Promise<{ stopReason: string; text: string }>) {
  return {
    list: [{ config: { id: "fake" }, models: [{ id: "model-a", name: "Model A" }] }],
    run,
  } as unknown as AcpServerManager
}

async function start(options: {
  run?: (input: RunInput) => Promise<{ stopReason: string; text: string }>
  drainTimeoutMs?: number
} = {}) {
  const calls: RunInput[] = []
  const shim = await createShim({
    manager: fakeManager(async (input) => {
      calls.push(input)
      return options.run ? options.run(input) : { stopReason: "end_turn", text: "ok" }
    }),
    resolveModel: (modelID) =>
      modelID === "fake::model-a" ? { server: "fake", model: "model-a" } : undefined,
    token: TOKEN,
    drainTimeoutMs: options.drainTimeoutMs,
  })
  return { shim, calls }
}

function chat(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  authorized = true,
) {
  return fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

test("rejects requests without the bearer token", async () => {
  const { shim } = await start()
  try {
    const response = await chat(`${shim.url}`, { model: "fake::model-a", messages: [] }, {}, false)
    expect(response.status).toBe(401)
    const models = await fetch(`${shim.url}/models`)
    expect(models.status).toBe(401)
  } finally {
    await shim.close()
  }
})

test("keys the session by x-opencode-session-id, not the affinity header", async () => {
  const { shim, calls } = await start()
  try {
    const response = await chat(
      shim.url,
      { model: "fake::model-a", messages: [{ role: "user", content: "hi" }] },
      { "x-opencode-session": "parent-session", "x-opencode-session-id": "child-session" },
    )
    expect(response.status).toBe(200)
    await response.text()
    expect(calls[0]?.key).toBe("child-session")
    expect(calls[0]?.sessionKey).toBe("child-session")
  } finally {
    await shim.close()
  }
})

test("labels finished tool calls with their resolved OpenCode names in the text transcript", async () => {
  const { shim } = await start({
    run: async (input) => {
      input.onUpdate?.({
        sessionUpdate: "tool_call",
        toolCallId: "claude-1",
        title: "WebSearch",
        kind: "search",
        status: "pending",
        _meta: { claudeCode: { toolName: "WebSearch" } },
        rawInput: { query: "opencode acp" },
      })
      input.onUpdate?.({
        sessionUpdate: "tool_call_update",
        toolCallId: "claude-1",
        status: "completed",
        rawOutput: { output: "results" },
      })
      input.onUpdate?.({
        sessionUpdate: "tool_call",
        toolCallId: "antigravity-1",
        name: "run_command",
        title: "run_command",
        kind: "execute",
        status: "in_progress",
        rawInput: { CommandLine: "git status", Cwd: "/tmp" },
      })
      input.onUpdate?.({
        sessionUpdate: "tool_call_update",
        toolCallId: "antigravity-1",
        status: "completed",
        rawOutput: { output: "clean" },
      })
      input.onUpdate?.({
        sessionUpdate: "tool_call",
        toolCallId: "codex-1",
        title: "mcp.opencode.models",
        kind: "other",
        status: "in_progress",
        _meta: { is_mcp_tool_call: true },
        rawInput: { server: "opencode", tool: "models", arguments: { query: "gpt" } },
      })
      input.onUpdate?.({
        sessionUpdate: "tool_call_update",
        toolCallId: "codex-1",
        status: "completed",
        rawOutput: { result: { content: [{ type: "text", text: "[]" }] } },
      })
      input.onUpdate?.({
        sessionUpdate: "tool_call",
        toolCallId: "think-1",
        title: "Guardian Review",
        kind: "think",
        status: "completed",
      })
      return { stopReason: "end_turn", text: "" }
    },
  })
  try {
    const response = await chat(shim.url, {
      model: "fake::model-a",
      messages: [{ role: "user", content: "hi" }],
    })
    const body = await response.json()
    const content: string = body.choices[0].message.content
    expect(content).toContain("\n\n> ✓ websearch: opencode acp\n\n")
    expect(content).toContain("\n\n> ✓ shell: git status\n\n")
    expect(content).toContain("\n\n> ✓ mcp.opencode.models\n\n")
    expect(content).not.toContain("Guardian Review")
    expect(content).not.toContain("WebSearch")
    expect(content).not.toContain("run_command")
  } finally {
    await shim.close()
  }
})

test("close lets an in-flight turn finish instead of resetting it", async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const { shim } = await start({
    run: async (input) => {
      await gate
      input.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } })
      return { stopReason: "end_turn", text: "done" }
    },
  })
  const response = await chat(shim.url, {
    model: "fake::model-a",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  })
  expect(response.status).toBe(200)
  // The turn is streaming now; disposing the plugin must not cut it off.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const closed = shim.close()
  release()
  const body = await response.text()
  await closed
  expect(body).toContain('"content":"done"')
  expect(body).toContain("[DONE]")
})

test("close stops waiting after its drain timeout", async () => {
  const { shim } = await start({ run: () => new Promise(() => {}), drainTimeoutMs: 50 })
  const response = await chat(shim.url, {
    model: "fake::model-a",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  await reader.read()
  await shim.close()
  await reader.cancel().catch(() => {})
})
