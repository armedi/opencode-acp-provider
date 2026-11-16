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

test("returns minimal tool guidance on initialize", async () => {
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
    expect(instructions).toContain("the server's `subagent` tool")
    expect(instructions).toContain("the server's `question` tool")
    expect(instructions).toContain("`models`")
    expect(instructions).toContain("do not poll")
    expect(instructions).not.toContain("mcp__opencode__")
  } finally {
    lease.release()
    await server.close()
  }
})

test("lists the session tools", async () => {
  const { server, lease, token } = await start()
  try {
    const response = await rpc(server.url, token, { jsonrpc: "2.0", id: 2, method: "tools/list" })
    const names = response.body.result.tools.map((tool: { name: string }) => tool.name)
    expect(names).toContain("session_context")
    expect(names).toContain("session_prompt")
    expect(names).toContain("session_list")
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
