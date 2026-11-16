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
  toolCallDisplay?: "off" | "inline"
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
    toolCallDisplay: options.toolCallDisplay,
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

test("answers title requests without spending an ACP turn", async () => {
  const { shim, calls } = await start()
  try {
    const response = await chat(shim.url, {
      model: "fake::model-a",
      messages: [
        { role: "system", content: "You name conversations." },
        { role: "user", content: "<message>Fix the parser bug</message>" },
      ],
    })
    const body = (await response.json()) as any
    expect(body.choices[0].message.content).toBe("Fix the parser bug")
    expect(calls.length).toBe(0)
  } finally {
    await shim.close()
  }
})

test("streams structured tool events when asked", async () => {
  const { shim } = await start({
    run: async (input) => {
      input.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi there" } })
      input.onUpdate?.({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "ls",
        kind: "execute",
        status: "completed",
        rawInput: { command: "ls" },
      })
      return { stopReason: "end_turn", text: "hi there" }
    },
  })
  try {
    const response = await chat(
      shim.url,
      { model: "fake::model-a", stream: true, messages: [{ role: "user", content: "hi" }] },
      { "x-acp-tool-events": "1", "x-opencode-session-id": "ses_stream" },
    )
    const text = await response.text()
    expect(text).toContain("hi there")
    expect(text).toContain("_acp_tool")
    expect(text).toContain("[DONE]")
  } finally {
    await shim.close()
  }
})

test("toolCallDisplay=off hides inline tool lines", async () => {
  const { shim } = await start({
    toolCallDisplay: "off",
    run: async (input) => {
      input.onUpdate?.({
        sessionUpdate: "tool_call",
        toolCallId: "call-2",
        title: "ls",
        kind: "execute",
        status: "completed",
        rawInput: { command: "ls" },
      })
      return { stopReason: "end_turn", text: "done" }
    },
  })
  try {
    const response = await chat(shim.url, {
      model: "fake::model-a",
      messages: [{ role: "user", content: "hi" }],
    })
    const body = (await response.json()) as any
    expect(body.choices[0].message.content).toBe("done")
  } finally {
    await shim.close()
  }
})
