import { expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { createAcpLanguageModel } from "../src/language-model.ts"
import { AcpServerManager } from "../src/server-manager.ts"
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
async function shimWith(
  run: (input: RunInput) => Promise<{ stopReason: string; text: string }>,
  limits: { historyTurns?: number; historyChars?: number; maxBodyBytes?: number } = {},
) {
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
    ...limits,
  })
  const model = createAcpLanguageModel({ server: "fake", model: "model-a", url: shim.url, token: "tok", ...limits })
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

test("sequential plan updates become distinct completed todowrite parts", async () => {
  const { shim, model } = await shimWith(async (input) => {
    input.onUpdate?.({
      sessionUpdate: "plan",
      entries: [
        { content: "Inspect sources", status: "completed", priority: "high" },
        { content: "Write tests", status: "in_progress", priority: "medium" },
      ],
    })
    input.onUpdate?.({
      sessionUpdate: "plan",
      entries: [{ content: "Write tests", status: "completed", priority: "medium" }],
    })
    return { stopReason: "end_turn", text: "" }
  })
  try {
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      headers: { "x-opencode-session-id": "ses_plan" },
    })
    const parts = await readAll(stream)
    const calls = parts.filter((part) => part.type === "tool-call")
    expect(calls.map((part) => part.toolName)).toEqual(["todowrite", "todowrite"])
    expect(new Set(calls.map((part) => part.toolCallId)).size).toBe(2)
    expect(JSON.parse(calls[0].input)).toEqual({
      todos: [
        { content: "Inspect sources", status: "completed" },
        { content: "Write tests", status: "in_progress" },
      ],
    })
    expect(JSON.parse(calls[1].input)).toEqual({ todos: [{ content: "Write tests", status: "completed" }] })
    const results = parts.filter((part) => part.type === "tool-result")
    expect(results.map((part) => part.toolCallId)).toEqual(calls.map((part) => part.toolCallId))
    expect(results.every((part) => part.toolName === "todowrite" && part.isError === false)).toBe(true)
  } finally {
    await shim.close()
  }
})

test("streaming edit, write, and patch defer their card until the input is complete", async () => {
  const { shim, model } = await shimWith(async (input) => {
    // Antigravity appends through `write_file`, so the call is only complete
    // once the diff arrives on a later update.
    input.onUpdate?.({
      sessionUpdate: "tool_call",
      toolCallId: "ag-1",
      name: "write_file",
      kind: "edit",
      title: "write_file",
      status: "pending",
      rawInput: { Path: "notes.md", Append: true },
    })
    input.onUpdate?.({
      sessionUpdate: "tool_call_update",
      toolCallId: "ag-1",
      status: "completed",
      content: [{ type: "diff", path: "notes.md", oldText: "old line", newText: "new line" }],
    })
    // Codex starts an edit with no diffs, then reveals a single added file.
    input.onUpdate?.({
      sessionUpdate: "tool_call",
      toolCallId: "cx-1",
      title: "Editing files",
      kind: "edit",
      status: "in_progress",
      rawInput: {},
      content: [],
    })
    input.onUpdate?.({
      sessionUpdate: "tool_call_update",
      toolCallId: "cx-1",
      status: "completed",
      content: [{ type: "diff", path: "created.md", oldText: null, newText: "hello\n" }],
    })
    // Another edit that turns out to touch several files becomes a patch.
    input.onUpdate?.({
      sessionUpdate: "tool_call",
      toolCallId: "cx-2",
      title: "Editing files",
      kind: "edit",
      status: "in_progress",
      rawInput: {},
      content: [],
    })
    input.onUpdate?.({
      sessionUpdate: "tool_call_update",
      toolCallId: "cx-2",
      status: "completed",
      content: [
        { type: "diff", path: "a.ts", oldText: "one", newText: "two" },
        { type: "diff", path: "b.ts", oldText: "three", newText: "four" },
      ],
    })
    return { stopReason: "end_turn", text: "" }
  })
  try {
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      headers: { "x-opencode-session-id": "ses_partial" },
    })
    const parts = await readAll(stream)
    const starts = parts.filter((part) => part.type === "tool-input-start")
    const calls = parts.filter((part) => part.type === "tool-call")
    const results = parts.filter((part) => part.type === "tool-result")
    expect(starts.map((part) => [part.id, part.toolName])).toEqual([
      ["ag-1", "edit"],
      ["cx-1", "write"],
      ["cx-2", "patch"],
    ])
    expect(calls.map((part) => [part.toolCallId, part.toolName])).toEqual([
      ["ag-1", "edit"],
      ["cx-1", "write"],
      ["cx-2", "patch"],
    ])
    expect(results.map((part) => [part.toolCallId, part.toolName])).toEqual([
      ["ag-1", "edit"],
      ["cx-1", "write"],
      ["cx-2", "patch"],
    ])
    const index = (type: string, id: string) =>
      parts.findIndex((part) => part.type === type && (part.toolCallId ?? part.id) === id)
    expect(index("tool-input-start", "ag-1")).toBeLessThan(index("tool-call", "ag-1"))
    expect(index("tool-call", "ag-1")).toBeLessThan(index("tool-result", "ag-1"))

    const append = JSON.parse(calls[0].input)
    expect(append).toMatchObject({ path: "notes.md", oldString: "old line", newString: "new line" })
    const write = JSON.parse(calls[1].input)
    expect(write).toMatchObject({ path: "created.md", content: "hello\n" })
    const patch = JSON.parse(calls[2].input)
    expect(patch.patchText).toContain("*** Update File: a.ts")
    expect(patch.patchText).toContain("*** Update File: b.ts")
    expect(patch.patchText).toContain("+two")
  } finally {
    await shim.close()
  }
})

test("reports an ACP failure after partial output without completing the answer", async () => {
  const { shim, model } = await shimWith(async (input) => {
    input.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } })
    throw new Error("agent failed")
  })
  try {
    const call = { prompt: [{ role: "user", content: "hi" }] }
    const { stream } = await model.doStream(call)
    const parts = await readAll(stream)
    expect(parts.filter((part) => part.type === "text-delta").map((part) => part.delta)).toEqual(["partial"])
    expect(parts.at(-1)).toMatchObject({ type: "error", error: new Error("agent failed") })
    expect(parts.some((part) => part.type === "finish")).toBe(false)
    await expect(model.doGenerate(call)).rejects.toThrow("agent failed")

    const response = await fetch(`${shim.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer tok" },
      body: JSON.stringify({ model: "fake::model-a", stream: true, messages: call.prompt }),
    })
    const frames = (await response.text()).split("\n").filter((line) => line.startsWith("data: "))
    expect(JSON.parse(frames.at(-1)!.slice(6))).toEqual({ error: { message: "agent failed", type: "acp_error" } })
  } finally {
    await shim.close()
  }
})

test("a long transcript crosses the shim as the latest turn and bounded replay", async () => {
  const { shim, model, calls } = await shimWith(
    async () => ({ stopReason: "end_turn", text: "ok" }),
    { historyTurns: 2, historyChars: 24, maxBodyBytes: 512 },
  )
  try {
    const large = "unused history ".repeat(1_000)
    const result = await model.doGenerate({
      prompt: [
        { role: "system", content: large },
        { role: "user", content: large },
        { role: "user", content: [{ type: "text", text: `${large}ending` }] },
        { role: "assistant", content: "prior" },
        { role: "user", content: "latest" },
      ],
    })
    expect(result.content).toEqual([{ type: "text", text: "ok" }])
    expect(calls[0]?.prompt).toEqual({
      fresh: "Conversation so far:\n\n[...earlier history omitted...]\n\nending\n\nAssistant: prior\n\n---\n\nlatest",
      reused: "latest",
    })
  } finally {
    await shim.close()
  }
})

test("auxiliary requests keep their instructions and never enter the chat's ACP history", async () => {
  const manager = new AcpServerManager({
    servers: [{
      id: "fake",
      command: [process.execPath, new URL("./fixtures/fake-agent.mjs", import.meta.url).pathname, "--echo-history"],
      autoApprove: true,
    }],
    defaultCwd: process.cwd(),
  })
  const shim = await createShim({
    manager,
    resolveModel: () => ({ server: "fake", model: "fast" }),
  })
  const model = createAcpLanguageModel({ server: "fake", model: "fast", url: shim.url })
  const generate = async (text: string, kind?: string) => {
    const result = await model.doGenerate({
      headers: {
        "x-opencode-session-id": "ses_isolation",
        ...(kind ? { "x-acp-request-kind": kind } : {}),
      },
      prompt: [
        { role: "system", content: "Return only a short title." },
        { role: "user", content: text },
      ],
    })
    return JSON.parse(result.content.filter((part) => part.type === "text").map((part) => part.text).join(""))
  }
  try {
    const first = await generate("Help me debug.", "primary")
    expect(first.prompts).toEqual(["Help me debug."])
    const auxiliarySessions = new Set<string>()
    for (const kind of ["title", "generate", "compaction"]) {
      const result = await generate(`Auxiliary ${kind}.`, kind)
      expect(result.sessionId).not.toBe(first.sessionId)
      expect(result.prompts).toEqual([`System instructions:\nReturn only a short title.\n\n---\n\nAuxiliary ${kind}.`])
      auxiliarySessions.add(result.sessionId)
    }
    expect(auxiliarySessions.size).toBe(3)
    // Missing kind keeps older clients' normal chat-session reuse.
    const next = await generate("Continue debugging.")
    expect(next.sessionId).toBe(first.sessionId)
    expect(next.prompts).toEqual(["Help me debug.", "Continue debugging."])
  } finally {
    await shim.close()
    await manager.stop()
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
