import { expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { createAcpLanguageModel } from "../src/language-model.ts"
import type { AcpServerManager } from "../src/server-manager.ts"
import { createShim } from "../src/shim.ts"

async function startStreamServer(
  handler: (req: { headers: Record<string, unknown>; body: any }, res: any) => void,
): Promise<{ server: Server; url: string; requests: any[] }> {
  const requests: any[] = []
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined
      requests.push({ headers: req.headers, body })
      handler({ headers: req.headers, body }, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return { server, url: `http://127.0.0.1:${port}/v1`, requests }
}

async function readAll(stream: ReadableStream<any>) {
  const reader = stream.getReader()
  const parts: any[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return parts
    parts.push(value)
  }
}

test("translates shim SSE into AI SDK v3 stream parts", async () => {
  const frames = [
    { choices: [{ delta: { reasoning_content: "think " } }] },
    { choices: [{ delta: { content: "hello" } }] },
    {
      choices: [
        {
          delta: {
            _acp_tool: { id: "call-1", name: "shell", title: "ls", input: { command: "ls" }, done: false },
          },
        },
      ],
    },
    {
      choices: [
        { delta: { _acp_tool: { id: "call-1", name: "shell", done: true, isError: false, output: "out" } } },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]

  const { server, url, requests } = await startStreamServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`)
    res.write("data: [DONE]\n\n")
    res.end()
  })

  try {
    const model = createAcpLanguageModel({ server: "fake", model: "model-a", url, token: "tok" }) as any
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      headers: { "x-opencode-session-id": "ses_x" },
      providerOptions: { acp: { reasoningEffort: "high" } },
    })
    const parts = await readAll(stream)

    expect(requests[0].headers.authorization).toBe("Bearer tok")
    expect(requests[0].headers["x-acp-tool-events"]).toBe("1")
    expect(requests[0].headers["x-opencode-session-id"]).toBe("ses_x")
    expect(requests[0].body.model).toBe("fake::model-a")
    expect(requests[0].body.reasoning_effort).toBe("high")
    expect(requests[0].body.messages).toEqual([{ role: "user", content: "hi" }])

    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] })
    expect(parts).toContainEqual({ type: "reasoning-start", id: "reasoning-0" })
    expect(parts).toContainEqual({ type: "reasoning-delta", id: "reasoning-0", delta: "think " })
    expect(parts).toContainEqual({ type: "text-start", id: "text-0" })
    expect(parts).toContainEqual({ type: "text-delta", id: "text-0", delta: "hello" })
    expect(parts).toContainEqual({
      type: "tool-input-start",
      id: "call-1",
      toolName: "shell",
      providerExecuted: true,
    })
    expect(parts).toContainEqual({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "shell",
      input: JSON.stringify({ command: "ls" }),
      providerExecuted: true,
      dynamic: true,
    })
    expect(parts).toContainEqual({
      type: "tool-result",
      toolCallId: "call-1",
      toolName: "shell",
      result: "out",
      isError: false,
      dynamic: true,
    })
    const finish = parts.at(-1)
    expect(finish.type).toBe("finish")
    expect(finish.finishReason.unified).toBe("stop")
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function finishUsage(usage: Record<string, number>) {
  const shim = await createShim({
    manager: {
      list: [{ config: { id: "fake" }, models: [{ id: "model-a", name: "Model A" }] }],
      run: async (input: { onUpdate?: (update: Record<string, unknown>) => void }) => {
        // Codex reports a session-cumulative total here; it is not this turn's input.
        input.onUpdate?.({ sessionUpdate: "usage_update", used: 41_541, size: 475_000 })
        input.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "two" } })
        return { stopReason: "end_turn", text: "two", usage }
      },
    } as unknown as AcpServerManager,
    resolveModel: (modelID) => (modelID === "fake::model-a" ? { server: "fake", model: "model-a" } : undefined),
    token: "tok",
  })
  try {
    const model = createAcpLanguageModel({ server: "fake", model: "model-a", url: shim.url, token: "tok" }) as any
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      headers: { "x-opencode-session-id": "ses_usage" },
    })
    const finish = (await readAll(stream)).at(-1)
    expect(finish.type).toBe("finish")
    return finish.usage
  } finally {
    await shim.close()
  }
}

test("reports the turn's tokens when the agent counts cache reads inside input", async () => {
  // codex-acp's PromptResponse.usage for a second turn.
  const usage = await finishUsage({
    inputTokens: 22_801,
    outputTokens: 5,
    thoughtTokens: 0,
    cachedReadTokens: 18_560,
    totalTokens: 22_806,
  })
  expect(usage).toEqual({
    inputTokens: { total: 22_801, noCache: 4_241, cacheRead: 18_560, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  })
})

test("reports the turn's tokens when the agent counts cache beside input", async () => {
  // claude-agent-acp follows Anthropic: input_tokens excludes cache reads and writes.
  const usage = await finishUsage({
    inputTokens: 12,
    outputTokens: 300,
    cachedReadTokens: 40_000,
    cachedWriteTokens: 2_000,
    totalTokens: 42_312,
  })
  expect(usage).toEqual({
    inputTokens: { total: 42_012, noCache: 12, cacheRead: 40_000, cacheWrite: 2_000 },
    outputTokens: { total: 300, text: 300, reasoning: 0 },
  })
})

test("cancelling the stream does not throw from the controller", async () => {
  const unhandled: unknown[] = []
  const listener = (error: unknown) => unhandled.push(error)
  process.on("unhandledRejection", listener)

  const { server, url } = await startStreamServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n\n`)
    // Leave the response open so the consumer can cancel mid-stream.
  })

  try {
    const model = createAcpLanguageModel({ server: "fake", model: "model-a", url }) as any
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const reader = stream.getReader()
    await reader.read() // stream-start
    await reader.read() // text-start
    await reader.cancel("user stop")
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(unhandled).toEqual([])
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
    process.off("unhandledRejection", listener)
  }
})
