import { expect, test } from "bun:test"
import { createOpenCodeMcpSource } from "../src/mcp-config.ts"

/** An agent whose executable no sign-in hint recognizes. */
const agent = { id: "custom", command: ["custom-acp"] }

interface FakeServer {
  name: string
  status?: "connected" | "needs_auth"
  integrationID?: string
}

function context(
  configs: Array<[string, any]>,
  options: { servers?: FakeServer[]; credentials?: Record<string, any> } = {},
) {
  const logs: string[] = []
  const listing = options.servers ?? []
  const ctx = {
    mcp: {
      transform: async (callback: (editor: any) => void) => {
        callback({ list: () => configs })
        return { dispose: async () => {} }
      },
      list: async () => ({
        location: { directory: "/work" },
        data: listing.map((server) => ({
          name: server.name,
          title: server.name,
          status: { status: server.status ?? "connected" },
          ...(server.integrationID ? { integrationID: server.integrationID } : {}),
        })),
      }),
    },
    integration: {
      connection: {
        active: async (id: string) => (options.credentials?.[id] ? { id } : undefined),
        resolve: async (connection: { id: string }) => options.credentials?.[connection.id],
      },
    },
  } as any
  return {
    ctx,
    logs,
    log: (level: string, message: string) => logs.push(`${level}: ${message}`),
  }
}

test("maps local and remote servers to the ACP shape", async () => {
  const fake = context([
    [
      "github",
      { type: "local", command: ["npx", "-y", "server-github"], environment: { TOKEN: "t" } },
    ],
    ["linear", { type: "remote", url: "https://mcp.linear.app/sse", headers: { Authorization: "Bearer x" } }],
  ])
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    expect(await source.servers(agent)).toEqual([
      { type: "stdio", name: "github", command: "npx", args: ["-y", "server-github"], env: [{ name: "TOKEN", value: "t" }] },
      { type: "http", name: "linear", url: "https://mcp.linear.app/sse", headers: [{ name: "Authorization", value: "Bearer x" }] },
    ])
    expect(fake.logs).toEqual([])
  } finally {
    await source.close()
  }
})

test("skips disabled servers and ones with no command", async () => {
  const fake = context([
    ["off", { type: "local", command: ["server"], disabled: true }],
    ["empty", { type: "local", command: [] }],
    ["kept", { type: "local", command: ["server"] }],
  ])
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    expect((await source.servers(agent)).map((server) => server.name)).toEqual(["kept"])
    expect(fake.logs).toEqual(['warn: MCP server "empty" has no command; skipping it for ACP agents'])
  } finally {
    await source.close()
  }
})

test("forwards OpenCode's OAuth grant to the agent", async () => {
  const fake = context([["linear", { type: "remote", url: "https://mcp.linear.app/mcp" }]], {
    servers: [{ name: "linear", integrationID: "mcp_linear" }],
    credentials: {
      mcp_linear: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 0 },
    },
  })
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    expect(await source.servers(agent)).toEqual([
      {
        type: "http",
        name: "linear",
        url: "https://mcp.linear.app/mcp",
        headers: [{ name: "Authorization", value: "Bearer access-token" }],
      },
    ])
    expect(fake.logs).toEqual([])
  } finally {
    await source.close()
  }
})

test("keeps an Authorization header from the server config", async () => {
  const fake = context(
    [["linear", { type: "remote", url: "https://mcp.linear.app/mcp", headers: { authorization: "Bearer explicit" } }]],
    {
      servers: [{ name: "linear", integrationID: "mcp_linear" }],
      credentials: {
        mcp_linear: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 0 },
      },
    },
  )
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    expect(await source.servers(agent)).toEqual([
      {
        type: "http",
        name: "linear",
        url: "https://mcp.linear.app/mcp",
        headers: [{ name: "authorization", value: "Bearer explicit" }],
      },
    ])
  } finally {
    await source.close()
  }
})

test("leaves a public remote server alone", async () => {
  const fake = context([["public", { type: "remote", url: "https://example.test/mcp" }]], {
    servers: [{ name: "public" }],
  })
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    expect(await source.servers(agent)).toEqual([
      { type: "http", name: "public", url: "https://example.test/mcp", headers: [] },
    ])
    expect(fake.logs).toEqual([])
  } finally {
    await source.close()
  }
})

test("does not forward a non-OAuth credential as a bearer token", async () => {
  const fake = context([["linear", { type: "remote", url: "https://mcp.linear.app/mcp" }]], {
    servers: [{ name: "linear", integrationID: "mcp_linear" }],
    credentials: { mcp_linear: { type: "key", key: "secret" } },
  })
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    expect(await source.servers(agent)).toEqual([
      { type: "http", name: "linear", url: "https://mcp.linear.app/mcp", headers: [] },
    ])
    expect(fake.logs).toHaveLength(1)
    expect(fake.logs[0]).toContain('MCP server "linear" has no OpenCode OAuth sign-in to forward')
  } finally {
    await source.close()
  }
})

test("does not forward a grant when the server disables OAuth", async () => {
  const fake = context([["linear", { type: "remote", url: "https://mcp.linear.app/mcp", oauth: false }]], {
    servers: [{ name: "linear", integrationID: "mcp_linear" }],
    credentials: {
      mcp_linear: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 0 },
    },
  })
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    expect(await source.servers(agent)).toEqual([
      { type: "http", name: "linear", url: "https://mcp.linear.app/mcp", headers: [] },
    ])
    expect(fake.logs).toEqual([])
  } finally {
    await source.close()
  }
})

test("warns when resolving the sign-in fails", async () => {
  const fake = context([["linear", { type: "remote", url: "https://mcp.linear.app/mcp" }]], {
    servers: [{ name: "linear", integrationID: "mcp_linear" }],
  })
  fake.ctx.integration.connection.active = async () => ({ id: "mcp_linear" })
  fake.ctx.integration.connection.resolve = async () => {
    throw new Error("credential store unavailable")
  }
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    expect(await source.servers(agent)).toEqual([
      { type: "http", name: "linear", url: "https://mcp.linear.app/mcp", headers: [] },
    ])
    expect(fake.logs).toContain(
      'warn: could not read the OpenCode sign-in for MCP server "linear": credential store unavailable',
    )
  } finally {
    await source.close()
  }
})

test("skips a disabled remote server with a sign-in", async () => {
  const fake = context([["linear", { type: "remote", url: "https://mcp.linear.app/mcp", disabled: true }]], {
    servers: [{ name: "linear", integrationID: "mcp_linear" }],
    credentials: {
      mcp_linear: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 0 },
    },
  })
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    expect(await source.servers(agent)).toEqual([])
    expect(fake.logs).toEqual([])
  } finally {
    await source.close()
  }
})

test("picks up a sign-in that arrived after setup", async () => {
  const fake = context([["linear", { type: "remote", url: "https://mcp.linear.app/mcp" }]], {
    servers: [{ name: "linear", status: "needs_auth" }],
    credentials: {
      mcp_linear: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 0 },
    },
  })
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    expect(await source.servers(agent)).toEqual([
      { type: "http", name: "linear", url: "https://mcp.linear.app/mcp", headers: [] },
    ])
    expect(fake.logs).toHaveLength(1)
    fake.ctx.mcp.list = async () => ({
      location: { directory: "/work" },
      data: [{ name: "linear", title: "linear", status: { status: "connected" }, integrationID: "mcp_linear" }],
    })
    expect(await source.servers(agent)).toEqual([
      {
        type: "http",
        name: "linear",
        url: "https://mcp.linear.app/mcp",
        headers: [{ name: "Authorization", value: "Bearer access-token" }],
      },
    ])
  } finally {
    await source.close()
  }
})

test("warns once when the MCP listing cannot be read", async () => {
  const fake = context([["linear", { type: "remote", url: "https://mcp.linear.app/mcp" }]])
  fake.ctx.mcp.list = async () => {
    throw new Error("registry unavailable")
  }
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    await source.servers(agent)
    await source.servers(agent)
    expect(fake.logs.filter((line) => line.includes("could not read OpenCode's MCP authentication"))).toHaveLength(1)
  } finally {
    await source.close()
  }
})

test("names the agent's own sign-in commands in the oauth warning", async () => {
  const config: Array<[string, any]> = [
    ["remote", { type: "remote", url: "https://example.test/mcp", oauth: {} }],
  ]
  const expected = [
    [
      ["cmd", "acp"],
      'warn: MCP server "remote" has no OpenCode OAuth sign-in to forward; Command Code cannot use it until it is authenticated. Run opencode mcp auth "remote" to sign in through OpenCode. Or run cmd mcp add --transport http "remote" "https://example.test/mcp" then cmd mcp auth "remote" to sign in Command Code separately.',
    ],
    [
      ["codex-acp"],
      'warn: MCP server "remote" has no OpenCode OAuth sign-in to forward; Codex cannot use it until it is authenticated. Run opencode mcp auth "remote" to sign in through OpenCode. Or run codex mcp add "remote" --url "https://example.test/mcp" then codex mcp login "remote" to sign in Codex separately.',
    ],
    [
      ["claude-agent-acp"],
      'warn: MCP server "remote" has no OpenCode OAuth sign-in to forward; Claude Code cannot use it until it is authenticated. Run opencode mcp auth "remote" to sign in through OpenCode. Or run claude mcp add --transport http "remote" "https://example.test/mcp" then claude mcp login "remote" to sign in Claude Code separately.',
    ],
  ]
  for (const [command, message] of expected) {
    const fake = context(config)
    const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
    try {
      await source.servers({ id: "agent", command: command as string[] })
      expect(fake.logs).toEqual([message])
    } finally {
      await source.close()
    }
  }
})

test("warns when OpenCode reports an unsigned server that needs auth", async () => {
  const fake = context([["linear", { type: "remote", url: "https://mcp.linear.app/mcp" }]], {
    servers: [{ name: "linear", status: "needs_auth" }],
  })
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    await source.servers(agent)
    expect(fake.logs).toHaveLength(1)
    expect(fake.logs[0]).toContain('MCP server "linear" has no OpenCode OAuth sign-in to forward')
  } finally {
    await source.close()
  }
})

test("warns each agent about its own sign-in, once per agent", async () => {
  const fake = context([["remote", { type: "remote", url: "https://example.test/mcp", oauth: {} }]])
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    const codex = { id: "codex", command: ["codex-acp"] }
    const claude = { id: "claude", command: ["claude-agent-acp"] }
    await source.servers(codex)
    await source.servers(codex)
    await source.servers(claude)
    expect(fake.logs).toHaveLength(2)
    expect(fake.logs[0]).toContain("Codex cannot use it until it is authenticated")
    expect(fake.logs[1]).toContain("Claude Code cannot use it until it is authenticated")
  } finally {
    await source.close()
  }
})
