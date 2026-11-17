import { expect, test } from "bun:test"
import { createOpenCodeMcpSource } from "../src/mcp-config.ts"

/** An agent whose executable no sign-in hint recognizes. */
const agent = { id: "custom", command: ["custom-acp"] }

function context(configs: Array<[string, any]>) {
  const logs: string[] = []
  const ctx = {
    mcp: {
      transform: async (callback: (editor: any) => void) => {
        callback({ list: () => configs })
        return { dispose: async () => {} }
      },
      list: async () => ({ application: {}, data: [] }),
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
    expect(source.servers(agent)).toEqual([
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
    expect(source.servers(agent).map((server) => server.name)).toEqual(["kept"])
    expect(fake.logs).toEqual(['warn: MCP server "empty" has no command; skipping it for ACP agents'])
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
      'warn: MCP server "remote" signs in through OpenCode, whose login is not shared; Command Code signs in on its own. Run cmd mcp add --transport http "remote" "https://example.test/mcp" then cmd mcp auth "remote" to sign in first.',
    ],
    [
      ["codex-acp"],
      'warn: MCP server "remote" signs in through OpenCode, whose login is not shared; Codex signs in on its own. Run codex mcp add "remote" --url "https://example.test/mcp" then codex mcp login "remote" to sign in first.',
    ],
    [
      ["claude-agent-acp"],
      'warn: MCP server "remote" signs in through OpenCode, whose login is not shared; Claude Code signs in on its own. Run claude mcp add --transport http "remote" "https://example.test/mcp" then claude mcp login "remote" to sign in first.',
    ],
  ]
  for (const [command, message] of expected) {
    const fake = context(config)
    const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
    try {
      source.servers({ id: "agent", command: command as string[] })
      expect(fake.logs).toEqual([message])
    } finally {
      await source.close()
    }
  }
})

test("warns each agent about its own sign-in, once per agent", async () => {
  const fake = context([["remote", { type: "remote", url: "https://example.test/mcp", oauth: {} }]])
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    const codex = { id: "codex", command: ["codex-acp"] }
    const claude = { id: "claude", command: ["claude-agent-acp"] }
    source.servers(codex)
    source.servers(codex)
    source.servers(claude)
    expect(fake.logs).toHaveLength(2)
    expect(fake.logs[0]).toContain("Codex signs in on its own")
    expect(fake.logs[1]).toContain("Claude Code signs in on its own")
  } finally {
    await source.close()
  }
})
