import { expect, test } from "bun:test"
import { createOpenCodeMcpSource } from "../src/mcp-config.ts"

/**
 * Fakes the MCP domain: `transform` captures the callback, and `list()` replays
 * the registered transforms the way the real registry does when it rebuilds.
 */
function context(initial: Array<[string, any]>) {
  let configs = initial
  let replay: ((editor: any) => void) | undefined
  let disposed = 0
  const logs: string[] = []

  const ctx = {
    mcp: {
      transform: async (callback: (editor: any) => void) => {
        replay = callback
        callback({ list: () => configs })
        return {
          dispose: async () => {
            disposed += 1
          },
        }
      },
      list: async () => {
        replay?.({ list: () => configs })
        return { application: {}, data: [] }
      },
    },
  } as any

  return {
    ctx,
    logs,
    disposed: () => disposed,
    log: (level: string, message: string) => logs.push(`${level}: ${message}`),
    setConfigs: (next: Array<[string, any]>) => {
      configs = next
    },
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
    expect(source.servers()).toEqual([
      { name: "github", command: "npx", args: ["-y", "server-github"], env: [{ name: "TOKEN", value: "t" }] },
      { type: "http", name: "linear", url: "https://mcp.linear.app/sse", headers: [{ name: "Authorization", value: "Bearer x" }] },
    ])
    expect(fake.logs).toEqual([])
  } finally {
    await source.close()
  }
})

test("omits empty env and headers instead of sending empty lists", async () => {
  const fake = context([
    ["local", { type: "local", command: ["server"] }],
    ["remote", { type: "remote", url: "https://example.test/mcp" }],
  ])
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    expect(source.servers()).toEqual([
      { name: "local", command: "server", args: [] },
      { type: "http", name: "remote", url: "https://example.test/mcp", headers: [] },
    ])
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
    expect(source.servers().map((server) => server.name)).toEqual(["kept"])
    expect(fake.logs).toEqual(['warn: MCP server "empty" has no command; skipping it for ACP agents'])
  } finally {
    await source.close()
  }
})

test("warns once about settings ACP cannot forward", async () => {
  const config: Array<[string, any]> = [
    ["with-cwd", { type: "local", command: ["server"], cwd: "/srv/repo" }],
    ["with-oauth", { type: "remote", url: "https://example.test/mcp", oauth: {} }],
  ]
  const fake = context(config)
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    source.servers()
    source.servers()
    expect(fake.logs).toEqual([
      'warn: MCP server "with-cwd" sets cwd, which ACP cannot forward; the agent starts it in its own directory',
      'warn: MCP server "with-oauth" signs in through OpenCode, which cannot be shared; the ACP agent needs its own credentials',
    ])
  } finally {
    await source.close()
  }
})

test("does not warn when oauth is explicitly disabled", async () => {
  const fake = context([["remote", { type: "remote", url: "https://example.test/mcp", oauth: false }]])
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    expect(source.servers()).toHaveLength(1)
    expect(fake.logs).toEqual([])
  } finally {
    await source.close()
  }
})

test("picks up configs added after the source was created", async () => {
  const fake = context([])
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    expect(source.servers()).toEqual([])
    fake.setConfigs([["added-later", { type: "local", command: ["server"] }]])
    // A registry rebuild replays the transform, which refreshes the capture.
    await fake.ctx.mcp.list()
    expect(source.servers().map((server) => server.name)).toEqual(["added-later"])
  } finally {
    await source.close()
  }
})

test("disposes the transform registration on close", async () => {
  const fake = context([])
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  await source.close()
  expect(fake.disposed()).toBe(1)
})

test("keeps working when the registry read fails", async () => {
  const fake = context([["github", { type: "local", command: ["npx", "server-github"] }]])
  fake.ctx.mcp.list = async () => {
    throw new Error("registry unavailable")
  }
  const source = await createOpenCodeMcpSource(fake.ctx, fake.log)
  try {
    expect(source.servers().map((server) => server.name)).toEqual(["github"])
    expect(fake.logs).toEqual(["warn: could not read OpenCode's MCP configuration: registry unavailable"])
  } finally {
    await source.close()
  }
})
