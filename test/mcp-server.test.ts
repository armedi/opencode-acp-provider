import { expect, test } from "bun:test"
import { createMcpServer, bridgeCommand, parseModelRef } from "../src/mcp-server.ts"

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
    location: { directory: "/tmp/project", project: { id: "prj_default" } },
    worktree: {
      create: async () => ({ directory: "/tmp/wt" }),
      remove: async () => {},
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

test("creates an independent session in the caller's directory and sends its first message", async () => {
  const base = context()
  let created: any
  let prompted: any
  const ctx = context({
    session: {
      ...base.session,
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        agent: "build",
        location: { directory: "/tmp/caller" },
      }),
      create: async (input: any) => {
        created = input
        return { id: "ses_new", location: input.location }
      },
      prompt: async (input: any) => {
        prompted = input
        return {}
      },
    },
    permission: {
      assert: async (input: any) => {
        if (input.metadata?.operation === "create" && input.resources?.[0] === "*") return
        throw new Error("denied by test")
      },
    },
  })
  const { server, lease, token } = await start(ctx)
  try {
    const response = await rpc(server.url, token, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "session_create",
        arguments: { title: "Docs pass", model: "openrouter/anthropic/claude#high", prompt: "Update the docs" },
      },
    })
    expect(response.body.result.isError).toBeUndefined()
    expect(response.body.result.structuredContent).toMatchObject({ sessionID: "ses_new", prompted: true })
    expect(created).toEqual({
      title: "Docs pass",
      model: { providerID: "openrouter", id: "anthropic/claude", variant: "high" },
      location: { directory: "/tmp/caller" },
    })
    expect(prompted).toEqual({ sessionID: "ses_new", text: "Update the docs" })
  } finally {
    lease.release()
    await server.close()
  }
})

test("refuses to create a session without the session permission", async () => {
  let created = false
  const base = context()
  const ctx = context({
    session: { ...base.session, create: async () => ((created = true), { id: "ses_new" }) },
  })
  const { server, lease, token } = await start(ctx)
  try {
    const response = await rpc(server.url, token, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "session_create", arguments: { prompt: "hi" } },
    })
    expect(response.body.result.isError).toBe(true)
    expect(JSON.stringify(response.body.result)).toContain("Permission denied: session create")
    expect(created).toBe(false)
  } finally {
    lease.release()
    await server.close()
  }
})

test("creates a worktree for the caller's project and returns its directory", async () => {
  let created: any
  let asserted: any
  const base = context()
  const ctx = context({
    session: {
      ...base.session,
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        projectID: "prj_1",
        location: { directory: "/tmp/caller" },
      }),
    },
    permission: {
      assert: async (input: any) => {
        asserted = input
        if (input.action === "worktree" && input.metadata?.operation === "create" && input.resources?.[0] === "*") return
        throw new Error("denied by test")
      },
    },
    worktree: {
      create: async (input: any) => {
        created = input
        return { directory: "/tmp/wt/task-a" }
      },
      remove: async () => {},
    },
  })
  const { server, lease, token } = await start(ctx)
  try {
    const response = await rpc(server.url, token, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "worktree_create",
        arguments: { from: "abc123", name: "task-a", branch: "" },
      },
    })
    expect(response.body.result.isError).toBeUndefined()
    expect(created).toEqual({ projectID: "prj_1", from: "abc123", name: "task-a" })
    expect(response.body.result.structuredContent).toEqual({ directory: "/tmp/wt/task-a" })
    expect(asserted).toMatchObject({ action: "worktree", resources: ["*"], metadata: { operation: "create" } })
  } finally {
    lease.release()
    await server.close()
  }
})

test("removes a worktree with and without force", async () => {
  const removed: any[] = []
  const asserted: any[] = []
  const base = context()
  const ctx = context({
    session: {
      ...base.session,
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, projectID: "prj_1" }),
    },
    permission: {
      assert: async (input: any) => {
        asserted.push(input)
        if (input.action === "worktree" && input.metadata?.operation === "remove" && input.resources?.[0] === "/tmp/wt") return
        throw new Error("denied by test")
      },
    },
    worktree: {
      create: async () => ({ directory: "/tmp/wt" }),
      remove: async (input: any) => {
        removed.push(input)
      },
    },
  })
  const { server, lease, token } = await start(ctx)
  try {
    const first = await rpc(server.url, token, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "worktree_remove", arguments: { directory: "/tmp/wt" } },
    })
    expect(first.body.result.isError).toBeUndefined()
    expect(first.body.result.structuredContent).toEqual({ directory: "/tmp/wt", removed: true })

    const second = await rpc(server.url, token, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "worktree_remove", arguments: { directory: "/tmp/wt", force: true } },
    })
    expect(second.body.result.isError).toBeUndefined()
    expect(removed).toEqual([
      { projectID: "prj_1", directory: "/tmp/wt", force: false },
      { projectID: "prj_1", directory: "/tmp/wt", force: true },
    ])
    expect(asserted).toHaveLength(2)
    for (const input of asserted) {
      expect(input).toMatchObject({ action: "worktree", resources: ["/tmp/wt"], metadata: { operation: "remove" } })
    }
  } finally {
    lease.release()
    await server.close()
  }
})

test("refuses worktree tools without the worktree permission", async () => {
  let mutated = false
  const ctx = context({
    worktree: {
      create: async () => {
        mutated = true
        return { directory: "/tmp/wt" }
      },
      remove: async () => {
        mutated = true
      },
    },
  })
  const { server, lease, token } = await start(ctx)
  try {
    const create = await rpc(server.url, token, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "worktree_create", arguments: {} },
    })
    expect(create.body.result.isError).toBe(true)
    expect(JSON.stringify(create.body.result)).toContain("Permission denied: worktree create")

    const remove = await rpc(server.url, token, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "worktree_remove", arguments: { directory: "/tmp/wt" } },
    })
    expect(remove.body.result.isError).toBe(true)
    expect(JSON.stringify(remove.body.result)).toContain("Permission denied: worktree remove")
    expect(mutated).toBe(false)
  } finally {
    lease.release()
    await server.close()
  }
})

test("rejects malformed model references", () => {
  expect(parseModelRef("acp-claude/opus")).toEqual({ providerID: "acp-claude", id: "opus" })
  expect(() => parseModelRef("opus")).toThrow("Invalid model")
  expect(() => parseModelRef("acp-claude/opus#")).toThrow("Invalid model")
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

test("launches the stdio bridge without /usr/bin/env on Windows", () => {
  expect(bridgeCommand(undefined, "/b.mjs", "linux")).toEqual({ command: "/usr/bin/env", args: ["node", "/b.mjs"] })
  expect(bridgeCommand("/opt/node", "/b.mjs", "darwin")).toEqual({ command: "/opt/node", args: ["/b.mjs"] })
  expect(bridgeCommand(undefined, "C:\\b.mjs", "win32")).toEqual({ command: "node", args: ["C:\\b.mjs"] })
  expect(bridgeCommand("C:\\node\\node.exe", "C:\\b.mjs", "win32")).toEqual({
    command: "C:\\node\\node.exe",
    args: ["C:\\b.mjs"],
  })
})
