import { expect, test } from "bun:test"
import { createMcpServer } from "../src/mcp-server.ts"

function context(overrides: Record<string, any> = {}) {
  return {
    tool: { list: async () => [] },
    agent: { list: async () => ({ data: [] }) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, agent: "build" }),
      list: async () => ({ data: [] }),
      context: async ({ sessionID }: { sessionID: string }) => [
        { role: "user", content: `context:${sessionID}` },
      ],
      wait: async () => {},
      prompt: async () => ({}),
      interrupt: async () => ({}),
    },
    permission: {
      assert: async (input: any) => {
        if (input.metadata?.operation === "list") return
        if (input.resources?.[0] === input.sessionID) return
        throw new Error("denied by test")
      },
    },
    ...overrides,
  } as any
}

async function start(ctx = context()) {
  const server = await createMcpServer({ ctx, transport: "http", log: () => {} })
  const lease = server.issue("ses_caller")
  const http = lease.servers[0]
  if (http.type !== "http") throw new Error("expected an HTTP MCP server")
  const token = http.headers.find((header) => header.name === "Authorization")?.value ?? ""
  return { server, lease, token }
}

async function rpc(url: string, token: string, payload: unknown, authorized = true) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { authorization: token } : {}),
    },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as any) : undefined }
}

test("requires the per-session bearer token", async () => {
  const { server, lease } = await start()
  try {
    const response = await rpc(server.url, "", { jsonrpc: "2.0", id: 1, method: "ping" }, false)
    expect(response.status).toBe(401)
  } finally {
    lease.release()
    await server.close()
  }
})

test("negotiates the protocol version it implements", async () => {
  const { server, lease, token } = await start()
  try {
    const response = await rpc(server.url, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    })
    expect(response.body.result.protocolVersion).toBe("2025-06-18")
  } finally {
    lease.release()
    await server.close()
  }
})

test("returns explicit tool guidance on initialize", async () => {
  const ctx = context({
    tool: {
      list: async () => [
        { name: "subagent", execute: async () => ({}) },
        { name: "question", execute: async () => ({}) },
        { name: "models", execute: async () => ({}) },
      ],
    },
  })
  const { server, lease, token } = await start(ctx)
  try {
    const response = await rpc(server.url, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    })
    const instructions = response.body.result.instructions
    expect(instructions).toContain("Available tools: `question`, `subagent`, `models`")
    expect(instructions).toContain("`mcp__opencode__question`")
    expect(instructions).toContain("`opencode.question`")
    expect(instructions).toContain("`mcp.opencode.question`")
  } finally {
    lease.release()
    await server.close()
  }
})

test("scopes session reads to the calling session", async () => {
  const { server, lease, token } = await start()
  try {
    const own = await rpc(server.url, token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "session_context", arguments: { sessionID: "ses_caller" } },
    })
    expect(own.body.result.isError).toBeUndefined()
    expect(JSON.stringify(own.body.result)).toContain("context:ses_caller")

    const other = await rpc(server.url, token, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "session_context", arguments: { sessionID: "ses_other" } },
    })
    expect(other.body.result.isError).toBe(true)
    expect(JSON.stringify(other.body.result)).toContain("Permission denied")
  } finally {
    lease.release()
    await server.close()
  }
})

test("cancels an in-flight tool call", async () => {
  const base = context()
  const ctx = context({
    session: {
      ...base.session,
      wait: () => new Promise<void>(() => {}),
    },
  })
  const { server, lease, token } = await start(ctx)
  try {
    const pending = rpc(server.url, token, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "session_wait", arguments: { sessionID: "ses_caller", timeoutMs: 120_000 } },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const cancelled = await rpc(server.url, token, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 10 },
    })
    expect(cancelled.status).toBe(202)
    const result = await pending
    expect(result.body.result.isError).toBe(true)
    expect(JSON.stringify(result.body.result)).toContain("cancelled")
  } finally {
    lease.release()
    await server.close()
  }
})

test("asks questions through the local form API when a service is available", async () => {
  let posted: any
  let seenAuth = ""
  let seenDirectory = ""
  let polls = 0
  const forms = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      seenAuth = request.headers.get("authorization") ?? ""
      seenDirectory = request.headers.get("x-opencode-directory") ?? ""
      if (request.method === "POST" && url.pathname === "/api/session/ses_caller/form") {
        posted = await request.json()
        return Response.json({ data: { id: "frm_test", sessionID: "ses_caller", fields: posted.fields } })
      }
      if (request.method === "GET" && url.pathname === "/api/session/ses_caller/form/frm_test") {
        polls += 1
        if (polls < 2) return Response.json({ data: { state: { status: "pending" } } })
        return Response.json({ data: { state: { status: "answered", answer: { q0: "Cats" } } } })
      }
      if (request.method === "DELETE") return Response.json({ data: {} })
      return new Response("not found", { status: 404 })
    },
  })

  const base = context()
  const ctx = context({
    session: {
      ...base.session,
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        agent: "build",
        location: { directory: "/tmp/test-project" },
      }),
    },
    tool: {
      list: async () => [
        {
          name: "question",
          execute: async () => {
            throw new Error("builtin question tool should not run")
          },
        },
      ],
    },
  })
  const server = await createMcpServer({
    ctx,
    transport: "http",
    log: () => {},
    localService: { url: `http://127.0.0.1:${forms.port}`, password: "secret" },
  })
  const lease = server.issue("ses_caller")
  const http = lease.servers[0]
  if (http.type !== "http") throw new Error("expected an HTTP MCP server")
  const token = http.headers.find((header) => header.name === "Authorization")?.value ?? ""
  try {
    const response = await rpc(server.url, token, {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "question",
        arguments: {
          questions: [
            {
              header: "Animal",
              question: "Cats or dogs?",
              options: [
                { label: "Cats", description: "indoor" },
                { label: "Dogs", description: "outdoor" },
              ],
            },
          ],
        },
      },
    })

    expect(response.body.result.isError).toBeUndefined()
    expect(JSON.stringify(response.body.result)).toContain("Cats")
    expect(posted.fields[0].key).toBe("q0")
    expect(posted.fields[0].options[0]).toEqual({ value: "Cats", label: "Cats", description: "indoor" })
    expect(seenAuth).toBe(`Basic ${Buffer.from("opencode:secret").toString("base64")}`)
    expect(seenDirectory).toBe(encodeURIComponent("/tmp/test-project"))
  } finally {
    lease.release()
    await server.close()
    forms.stop(true)
  }
})

test("falls back to the builtin question tool when the form API is unavailable", async () => {
  const forms = Bun.serve({
    port: 0,
    fetch: () => new Response("unavailable", { status: 500 }),
  })
  const logs: string[] = []
  const base = context()
  const ctx = context({
    session: {
      ...base.session,
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        agent: "build",
        location: { directory: "/tmp/test-project" },
      }),
    },
    tool: {
      list: async () => [
        {
          name: "question",
          execute: async () => ({
            output: { answers: [["Fallback"]] },
            content: [{ type: "text", text: "builtin question result" }],
          }),
        },
      ],
    },
  })
  const server = await createMcpServer({
    ctx,
    transport: "http",
    log: (level, message) => logs.push(`${level}: ${message}`),
    localService: { url: `http://127.0.0.1:${forms.port}`, password: "secret" },
  })
  const lease = server.issue("ses_caller")
  const http = lease.servers[0]
  if (http.type !== "http") throw new Error("expected an HTTP MCP server")
  const token = http.headers.find((header) => header.name === "Authorization")?.value ?? ""
  try {
    const response = await rpc(server.url, token, {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "question",
        arguments: {
          questions: [
            {
              header: "Animal",
              question: "Cats or dogs?",
              options: [{ label: "Cats", description: "indoor" }],
            },
          ],
        },
      },
    })
    expect(JSON.stringify(response.body.result)).toContain("builtin question result")
    expect(logs.some((line) => line.includes("using the builtin question tool"))).toBe(true)
  } finally {
    lease.release()
    await server.close()
    forms.stop(true)
  }
})
