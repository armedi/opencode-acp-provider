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
