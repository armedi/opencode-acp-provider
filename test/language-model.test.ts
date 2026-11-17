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

type RunInput = {
  key?: string
  model?: string
  effort?: string
  prompt?: unknown
  onUpdate?: (update: Record<string, unknown>) => void
}

/** The real shim in front of a scripted manager, so tests cover the shim's wire format and its parser together. */
async function shimWith(run: (input: RunInput) => Promise<{ stopReason: string; text: string }>) {
  const calls: RunInput[] = []
  const shim = await createShim({
    manager: {
      list: [{ config: { id: "fake" }, models: [{ id: "model-a", name: "Model A" }] }],
      run: (input: RunInput) => {
        calls.push(input)
        return run(input)
      },
    } as unknown as AcpServerManager,
    resolveModel: (modelID) => (modelID === "fake::model-a" ? { server: "fake", model: "model-a" } : undefined),
    token: "tok",
  })
  const model = createAcpLanguageModel({ server: "fake", model: "model-a", url: shim.url, token: "tok" }) as any
  return { shim, model, calls }
}

test("turns an ACP turn into AI SDK v3 stream parts", async () => {
  const { shim, model, calls } = await shimWith(async (input) => {
    input.onUpdate?.({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think " } })
    input.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } })
    input.onUpdate?.({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "ls",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "ls" },
    })
    input.onUpdate?.({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      rawOutput: { stdout: "out" },
    })
    return { stopReason: "end_turn", text: "hello" }
  })
  try {
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      headers: { "x-opencode-session-id": "ses_x" },
      providerOptions: { acp: { reasoningEffort: "high" } },
    })
    const parts = await readAll(stream)

    expect(calls[0]).toMatchObject({ key: "ses_x", model: "model-a", effort: "high" })

    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] })
    expect(parts).toContainEqual({ type: "reasoning-delta", id: "reasoning-0", delta: "think " })
    expect(parts).toContainEqual({ type: "text-delta", id: "text-0", delta: "hello" })
    const call = parts.find((part) => part.type === "tool-call")
    expect(call).toMatchObject({ toolCallId: "call-1", toolName: "shell", providerExecuted: true })
    expect(JSON.parse(call.input).command).toBe("ls")
    const result = parts.find((part) => part.type === "tool-result")
    expect(result).toMatchObject({ toolCallId: "call-1", toolName: "shell", isError: false })
    expect(String(result.result)).toContain("out")
    const finish = parts.at(-1)
    expect(finish.type).toBe("finish")
    expect(finish.finishReason.unified).toBe("stop")
  } finally {
    await shim.close()
  }
})

test("never reports usage, because no ACP number is right for both context and spend", async () => {
  // OpenCode reads a step's tokens as both context size and spend. An ACP turn
  // spans many model calls, so the agent's context reading (here codex-acp's
  // session running total) must not become token counts.
  const { shim, model } = await shimWith(async (input) => {
    input.onUpdate?.({ sessionUpdate: "usage_update", used: 41_541, size: 475_000 })
    input.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "two" } })
    return { stopReason: "end_turn", text: "two" }
  })
  try {
    const raw = await fetch(`${shim.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok" },
      body: JSON.stringify({ model: "fake::model-a", messages: [{ role: "user", content: "hi" }] }),
    })
    expect((await raw.json()).usage).toBeUndefined()

    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      headers: { "x-opencode-session-id": "ses_usage" },
    })
    const finish = (await readAll(stream)).at(-1)
    expect(finish.type).toBe("finish")
    expect(finish.usage).toEqual({
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    })
  } finally {
    await shim.close()
  }
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

test("retries when the shim connection is reset before the response starts", async () => {
  let attempts = 0
  const { server, url } = await startStreamServer((_req, res) => {
    attempts += 1
    if (attempts === 1) {
      // The shim was closing or the socket was reused; nothing was answered.
      res.socket?.destroy()
      return
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "second try" } }] })}\n\n`)
    res.write("data: [DONE]\n\n")
    res.end()
  })

  try {
    const model = createAcpLanguageModel({ server: "fake", model: "model-a", url }) as any
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })
    const parts = await readAll(stream)
    expect(attempts).toBe(2)
    expect(parts).toContainEqual({ type: "text-delta", id: "text-0", delta: "second try" })
    expect(parts.at(-1).type).toBe("finish")
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }
})
