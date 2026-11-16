import { randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import type { AcpMcpServer } from "./acp-client.ts"
import type { LogFn } from "./server-manager.ts"

type Ctx = Plugin.Context

const MCP_PROTOCOL_VERSION = "2025-06-18"
const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_CONTEXT_CHARS = 60_000
const TOKEN_IDLE_MS = 2 * 60 * 60_000
const TOKEN_EVICT_MIN_IDLE_MS = 60_000
const MAX_TOKENS = 256

const SUBAGENT_DESCRIPTION = [
  "Spawns an agent in a child session to work on the specified task.",
  "Subagents always run in the background: the call returns immediately with a sessionID, and you receive a `<subagent>` message each time the child goes idle, including after later work.",
  "Keep working on non-overlapping tasks, or briefly tell the user what you launched and end your response. Do not sleep, poll, or proactively check on the child's progress.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "Pass the returned sessionID to continue that specific child conversation. A follow-up to a running child joins its current run.",
].join("\n")

const MODELS_DESCRIPTION =
  "Search the models available to use. Use this to turn a model name the user mentions into an exact reference for a tool that takes a model. Check your own provider first."

const TODOWRITE_DESCRIPTION = [
  "Create and update a todo list for the current session. The user sees it as your working plan.",
  "",
  "Use it proactively when a task has 3 or more distinct steps, or when the user gives several tasks or asks for a todo list. Skip it for a single simple task or a purely conversational request. When in doubt, use it.",
  "",
  "- Send the full list on every call; it replaces the previous one.",
  "- Mark items `in_progress` when you start them and `completed` as soon as they're actually done.",
  "- Only call it when the list changes.",
].join("\n")

const QUESTION_DESCRIPTION = [
  "Use this tool when you need to ask the user questions during execution. This allows you to:",
  "1. Gather user preferences or requirements",
  "2. Clarify ambiguous instructions",
  "3. Get decisions on implementation choices as you work",
  "4. Offer choices to the user about what direction to take.",
  "",
  "Usage notes:",
  "- A \"Type your own answer\" option is added automatically; don't include a separate option for free form answers",
  "- Set `multiple: true` to allow selecting more than one option",
  "- If you recommend a specific option, make that the first option in the list and add \"(Recommended)\" at the end of the label",
].join("\n")

/**
 * Order used by the initialize instructions. Clients that defer MCP tools (Codex
 * shows only the server's `instructions` until a namespace is loaded, and appends
 * them to every tool description) never see the per-tool descriptions first, so
 * the namespace text has to name each tool itself.
 */
const TOOL_ORDER = [
  "question",
  "subagent",
  "models",
  "todowrite",
  "session_list",
  "session_get",
  "session_context",
  "session_prompt",
  "session_wait",
  "session_interrupt",
]

export interface McpServerOptions {
  ctx: Ctx
  log?: LogFn
  /** Local OpenCode service that can create forms with a location. Resolved per question. */
  localService?: { url: string; password: string } | (() => Promise<{ url: string; password: string } | undefined>)
  transport?: "stdio" | "http"
  /** Runtime that can execute a JavaScript file, e.g. "node" or "bun". */
  runtime?: string
  version?: string
}

export interface McpLease {
  servers: AcpMcpServer[]
  release: () => void
}

export interface McpServerHandle {
  url: string
  issue: (sessionKey: string) => McpLease
  close: () => Promise<void>
}

interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  call: (args: any, signal: AbortSignal) => Promise<any>
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: any
}

interface TokenEntry {
  sessionKey: string
  lastUsed: number
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
})

const stringSchema = (description?: string) => ({ type: "string", ...(description ? { description } : {}) })

export async function createMcpServer(options: McpServerOptions): Promise<McpServerHandle> {
  const { ctx, log = () => {} } = options
  const transport = options.transport ?? "stdio"
  const version = options.version ?? "0.5.0"
  const tokens = new Map<string, TokenEntry>()
  /** In-flight tool calls, so `notifications/cancelled` can abort them. */
  const inFlight = new Map<number | string, AbortController>()
  const bridgePath = fileURLToPath(new URL("./mcp-bridge.mjs", import.meta.url))
  let loggedTools = false

  if (transport === "stdio") {
    try {
      statSync(bridgePath)
    } catch {
      throw new Error(`MCP stdio bridge not found at ${bridgePath}`)
    }
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      log("error", `MCP request failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) {
        try {
          res.writeHead(500, { "content-type": "application/json" })
        } catch {
          // connection closed
        }
      }
      if (!res.writableEnded) {
        try {
          res.end()
        } catch {
          // connection closed
        }
      }
    })
  })
  server.requestTimeout = 0
  server.timeout = 0

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  const url = `http://127.0.0.1:${port}/mcp`
  log("info", `OpenCode MCP bridge listening on ${url} (${transport})`)

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - TOKEN_IDLE_MS
    for (const [token, entry] of tokens) {
      if (entry.lastUsed < cutoff) tokens.delete(token)
    }
  }, 10 * 60_000)
  sweeper.unref?.()

  function buildServers(token: string): AcpMcpServer[] {
    if (transport === "http") {
      return [
        {
          type: "http",
          name: "opencode",
          url,
          headers: [{ name: "Authorization", value: `Bearer ${token}` }],
        },
      ]
    }
    const runtime = options.runtime ?? process.env.OPENCODE_MCP_NODE
    const absolute = runtime?.startsWith("/")
    return [
      {
        name: "opencode",
        command: absolute ? runtime! : "/usr/bin/env",
        args: absolute ? [bridgePath] : [runtime ?? "node", bridgePath],
        env: [
          { name: "OPENCODE_MCP_URL", value: url },
          { name: "OPENCODE_MCP_TOKEN", value: token },
        ],
      },
    ]
  }

  function issue(sessionKey: string): McpLease {
    if (tokens.size >= MAX_TOKENS) {
      // Only drop a token that has not been used recently; evicting a live one
      // would break the agent's MCP connection mid-session.
      const cutoff = Date.now() - TOKEN_EVICT_MIN_IDLE_MS
      const oldest = [...tokens.entries()]
        .filter(([, entry]) => entry.lastUsed <= cutoff)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
      if (oldest) tokens.delete(oldest[0])
      else log("warn", `MCP token cap reached (${MAX_TOKENS}); issuing an extra token`)
    }
    const token = randomUUID()
    tokens.set(token, { sessionKey, lastUsed: Date.now() })
    return {
      servers: buildServers(token),
      release: () => {
        tokens.delete(token)
      },
    }
  }

  function resolveToken(req: IncomingMessage) {
    const header = req.headers.authorization
    if (typeof header !== "string" || !header.toLowerCase().startsWith("bearer ")) return undefined
    const token = header.slice(7).trim()
    const entry = tokens.get(token)
    if (!entry) return undefined
    entry.lastUsed = Date.now()
    return { token, sessionKey: entry.sessionKey }
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    res.on("error", () => {})
    const urlPath = (req.url ?? "").split("?")[0]
    if (urlPath !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "Not found" }))
      return
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, { allow: "POST, DELETE, OPTIONS" })
      res.end()
      return
    }
    if (req.method === "GET") {
      res.writeHead(405, { allow: "POST, DELETE, OPTIONS" })
      res.end()
      return
    }

    const auth = resolveToken(req)
    if (req.method === "DELETE") {
      if (auth) tokens.delete(auth.token)
      res.writeHead(204)
      res.end()
      return
    }
    if (!auth) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" })
      res.end(JSON.stringify({ error: "Unauthorized" }))
      return
    }

    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST, DELETE, OPTIONS" })
      res.end()
      return
    }

    const controller = new AbortController()
    res.on("close", () => {
      if (!res.writableEnded) controller.abort()
    })

    let raw: string
    try {
      raw = await readBody(req, MAX_BODY_BYTES)
    } catch {
      res.writeHead(413, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "Request body too large" }))
      return
    }

    let payload: JsonRpcRequest | JsonRpcRequest[]
    try {
      payload = JSON.parse(raw)
    } catch {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }))
      return
    }

    const messages = Array.isArray(payload) ? payload : [payload]
    const responses: unknown[] = []
    const scope = auth.token
    for (const message of messages) {
      if (!message || typeof message !== "object") continue
      if (message.id === undefined || message.id === null) {
        if (message.method === "notifications/cancelled") {
          const requestId = message.params?.requestId
          if (requestId !== undefined && requestId !== null) inFlight.get(`${scope}:${requestId}`)?.abort()
          continue
        }
        await dispatch(message, auth.sessionKey, controller.signal).catch(() => undefined)
        continue
      }
      const requestController = new AbortController()
      const requestKey = `${scope}:${message.id}`
      inFlight.set(requestKey, requestController)
      try {
        responses.push(
          await dispatch(message, auth.sessionKey, combineSignals(controller.signal, requestController.signal)),
        )
      } finally {
        inFlight.delete(requestKey)
      }
    }

    if (!responses.length) {
      res.writeHead(202)
      res.end()
      return
    }
    if (res.headersSent || res.writableEnded) return
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]))
  }

  async function dispatch(message: JsonRpcRequest, sessionKey: string, signal: AbortSignal) {
    const id = message.id ?? null
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result })
    const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } })

    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return undefined

    try {
      switch (message.method) {
        case "initialize": {
          // Only claim the version we actually implement.
          const requested =
            typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : undefined
          const instructions = await buildInstructions(ctx, sessionKey, options.localService, log).catch(() => undefined)
          return reply({
            protocolVersion: requested === MCP_PROTOCOL_VERSION ? requested : MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "opencode", version },
            ...(instructions ? { instructions } : {}),
          })
        }
        case "ping":
          return reply({})
        case "tools/list": {
          const tools = await buildTools(ctx, sessionKey, options.localService, log)
          if (!loggedTools) {
            loggedTools = true
            log("info", `OpenCode MCP tools exposed: ${tools.map((tool) => tool.name).join(", ")}`)
          }
          return reply({
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          })
        }
        case "tools/call": {
          const name = String(message.params?.name ?? "")
          const args = message.params?.arguments ?? {}
          const tools = await buildTools(ctx, sessionKey, options.localService, log)
          const tool = tools.find((candidate) => candidate.name === name)
          if (!tool) return fail(-32602, `Unknown tool: ${name}`)
          const startedAt = Date.now()
          log("debug", `MCP tool ${name} started for ${sessionKey.slice(0, 12)}`)
          try {
            const result = await tool.call(args, signal)
            log("debug", `MCP tool ${name} finished in ${Date.now() - startedAt}ms`)
            return reply(result)
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error)
            log("debug", `MCP tool ${name} failed in ${Date.now() - startedAt}ms: ${text}`)
            return reply({ content: [{ type: "text", text }], isError: true })
          }
        }
        case "resources/list":
          return reply({ resources: [] })
        case "prompts/list":
          return reply({ prompts: [] })
        case "logging/setLevel":
          return reply({})
        default:
          return fail(-32601, `Method not found: ${message.method}`)
      }
    } catch (error) {
      return fail(-32603, error instanceof Error ? error.message : String(error))
    }
  }

  return {
    url,
    issue,
    async close() {
      clearInterval(sweeper)
      tokens.clear()
      for (const controller of inFlight.values()) controller.abort()
      inFlight.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}

class QuestionFormError extends Error {}

function basicAuth(password: string) {
  return `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`
}

function questionFields(questions: any[]) {
  return questions.map((question, index) => ({
    key: `q${index}`,
    title: typeof question?.header === "string" ? question.header : `Question ${index + 1}`,
    description: typeof question?.question === "string" ? question.question : "",
    type: question?.multiple === true ? "multiselect" : "string",
    options: (Array.isArray(question?.options) ? question.options : []).map((option: any) => ({
      value: String(option?.label ?? ""),
      label: String(option?.label ?? ""),
      ...(typeof option?.description === "string" ? { description: option.description } : {}),
    })),
    custom: true,
  }))
}

function answeredQuestions(questions: any[], answer: Record<string, unknown>) {
  const answers = questions.map((_, index) => {
    const value = answer[`q${index}`]
    if (value === undefined || value === null) return []
    if (Array.isArray(value)) return value.map(String)
    return [String(value)]
  })
  const text = `User has answered your questions: ${questions
    .map((question, index) => `"${question?.question ?? ""}"="${answers[index].length ? answers[index].join(", ") : "Unanswered"}"`)
    .join(", ")}. You can now continue with the user's answers in mind.`
  return { output: { answers }, content: [{ type: "text" as const, text }], metadata: { answers } }
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"))
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error("aborted"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Ask through the local server's form API instead of the builtin question tool.
 * A form created outside the HTTP location middleware has no `location` on its
 * event, and the desktop client ignores `form.created` events without one. The
 * HTTP route runs inside that middleware, so the desktop renders the question.
 */
async function askViaForm(
  ctx: Ctx,
  service: { url: string; password: string },
  sessionKey: string,
  args: any,
  signal: AbortSignal,
  log?: LogFn,
): Promise<any> {
  const questions = Array.isArray(args?.questions) ? args.questions : []
  if (!questions.length) throw new QuestionFormError("No questions were provided")

  const session = await ctx.session.get({ sessionID: sessionKey as any }).catch(() => undefined)
  const directory = (session as any)?.location?.directory ?? ctx.location.directory
  const base = service.url.replace(/\/+$/, "")
  const headers = {
    "content-type": "application/json",
    authorization: basicAuth(service.password),
    "x-opencode-directory": encodeURIComponent(directory),
  }
  const endpoint = `${base}/api/session/${encodeURIComponent(sessionKey)}/form`

  const created = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Questions", metadata: { kind: "question" }, fields: questionFields(questions) }),
    signal,
  }).catch((error) => {
    throw new QuestionFormError(error instanceof Error ? error.message : String(error))
  })
  if (!created.ok) {
    const detail = await created.text().catch(() => "")
    throw new QuestionFormError(`form API returned ${created.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`)
  }
  const form = ((await created.json().catch(() => undefined)) as any)?.data
  if (!form?.id) throw new QuestionFormError("form API did not return a form id")

  const formEndpoint = `${endpoint}/${encodeURIComponent(form.id)}`
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error("aborted")
      const response = await fetch(formEndpoint, { headers, signal })
      if (response.ok) {
        const detail = ((await response.json().catch(() => undefined)) as any)?.data
        const state = detail?.state
        if (state?.status === "answered") return answeredQuestions(questions, state.answer ?? {})
        if (state?.status === "cancelled") throw new Error(state.message || "The user dismissed this question")
      } else if (response.status === 404) {
        throw new Error("The question form was closed")
      } else {
        log?.("warn", `question form poll returned ${response.status}`)
      }
      await delay(300, signal)
    }
  } catch (error) {
    await fetch(formEndpoint, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ message: "The question was cancelled because the request was interrupted." }),
      signal: AbortSignal.timeout(2_000),
    }).catch(() => {})
    throw error
  }
}

async function buildInstructions(
  ctx: Ctx,
  sessionKey: string,
  service?: { url: string; password: string } | (() => Promise<{ url: string; password: string } | undefined>),
  log?: LogFn,
) {
  const tools = await buildTools(ctx, sessionKey, service, log)
  if (!tools.length) return undefined
  const names = new Set(tools.map((tool) => tool.name))
  // Tools the model is most likely to need come first; some clients append this
  // text to every tool description, so keep it tight.
  const order = new Map(TOOL_ORDER.map((name, index) => [name, index]))
  const listed = [...tools]
    .sort((left, right) => (order.get(left.name) ?? 99) - (order.get(right.name) ?? 99))
    .map((tool) => `\`${tool.name}\``)
    .join(", ")
  const lines = [
    "OpenCode MCP server `opencode`. Tool names are plain (`question`, `subagent`, `session_get`, …) but every client adds its own MCP prefix, for example `mcp__opencode__question`, `opencode.question`, or `mcp.opencode.question`; exec/code-mode scripts call `tools.mcp__opencode__question`. Match the form your own tool list shows.",
    `Available tools: ${listed}.`,
  ]
  if (names.has("question")) {
    lines.push(
      "Use `question` to ask the user for a decision, preference, or clarification instead of asking in plain text.",
      "It exists even when the agent's native ask-user tool is disabled, so never report that there is no question tool.",
    )
  }
  if (names.has("subagent")) {
    lines.push(
      "Use `subagent` for delegation instead of a native subagent or task tool: call it with { agent, description, prompt }.",
      "It returns at once and reports back with a <subagent> message when the child goes idle; do not poll it.",
    )
  }
  lines.push(
    "If a tool above seems missing it may just be deferred: look it up under the `opencode` MCP namespace, using whatever prefix your client lists (for example in ALL_TOOLS or your client's tool search), before concluding it is unavailable.",
  )
  return lines.join("\n")
}

async function buildTools(
  ctx: Ctx,
  sessionKey: string,
  localService?: { url: string; password: string } | (() => Promise<{ url: string; password: string } | undefined>),
  log?: LogFn,
): Promise<McpTool[]> {
  const tools: McpTool[] = []
  const available = await ctx.tool.list().catch(() => [])

  const find = (...names: string[]) => {
    for (const name of names) {
      const match =
        available.find((tool) => tool.name === name) ??
        available.find((tool) => tool.name === `opencode.${name}`) ??
        available.find((tool) => tool.id === `opencode.tool.${name}`) ??
        available.find((tool) => tool.id?.endsWith(`.${name}`))
      if (match) return match
    }
    return undefined
  }

  const invoke = async (tool: any, args: any, signal: AbortSignal) => {
    const session = await ctx.session.get({ sessionID: sessionKey }).catch(() => undefined)
    // The public plugin API exposes tool.execute, not the session's tool
    // pipeline, so `execute.before`/`after` hooks do not run for MCP-originated
    // calls. The wrapped builtins assert their own permissions.
    const context = {
      sessionID: sessionKey,
      agent: session?.agent ?? "build",
      messageID: randomUUID(),
      id: randomUUID(),
      signal,
      progress: async () => {},
    }
    return tool.execute(args, context)
  }

  const addBuiltin = (
    name: string,
    aliases: string[],
    description: string,
    inputSchema: Record<string, unknown>,
    mapArgs: (args: any) => any = (args) => args,
  ) => {
    const tool = find(name, ...aliases)
    if (!tool) return
    tools.push({
      name,
      description,
      inputSchema,
      call: async (args, signal) => toMcpResult(await invoke(tool, mapArgs(args ?? {}), signal)),
    })
  }

  addBuiltin("models", ["models"], MODELS_DESCRIPTION, objectSchema({
    query: stringSchema("Text to search for in model names and IDs."),
    provider: stringSchema("Provider ID or name to filter by. Try your own provider first."),
    type: {
      type: "string",
      enum: ["chat", "image"],
      description: [
        "Which kind of model to list. Defaults to \"chat\".",
        "\"chat\": a language model (LLM). Powers sessions, agents and subagents, and can call tools.",
        "\"image\": generates or edits images from a prompt. It can't chat or call tools.",
      ].join("\n"),
    },
    all: { type: "boolean", description: "Include older versions of each model family. By default only the newest version is listed." },
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of models to return. Defaults to 20." },
    offset: { type: "integer", minimum: 0, description: "Number of models to skip, for paging through results." },
  }))

  const subagent = find("subagent")
  if (subagent) {
    tools.push({
      name: "subagent",
      description: await subagentDescription(ctx),
      inputSchema: objectSchema(
        {
          agent: stringSchema(
            "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.",
          ),
          description: stringSchema("A short 3-5 word label for the task, displayed to the user"),
          prompt: stringSchema("The task for the subagent to perform"),
          model: stringSchema(
            "NEVER set this unless the user explicitly asks for a particular model or variant. It must be a chat model; image and decision models can't run subagents. The value is written as \"providerID/modelID\", or \"providerID/modelID#variant\" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.",
          ),
          sessionID: stringSchema("Send a follow-up to an existing subagent, running or finished. Omit to start a new one."),
        },
        ["agent", "description", "prompt"],
      ),
      call: async (args, signal) => {
        const input = { ...(args ?? {}) }
        if (!input.model) delete input.model
        if (!input.sessionID) delete input.sessionID
        return toMcpResult(await invoke(subagent, input, signal))
      },
    })
  }

  const question = find("question")
  if (question) {
    tools.push({
      name: "question",
      description: QUESTION_DESCRIPTION,
      inputSchema: objectSchema({
        questions: {
          type: "array",
          description: "Questions to ask",
          items: objectSchema(
            {
              header: stringSchema("Very short label (max 30 chars)"),
              question: stringSchema("Complete question"),
              options: {
                type: "array",
                description: "Available choices",
                items: objectSchema(
                  { label: stringSchema("Display text (1-5 words, concise)"), description: stringSchema("Explanation of choice") },
                  ["label", "description"],
                ),
              },
              multiple: { type: "boolean", description: "Allow selecting multiple choices" },
            },
            ["header", "question", "options"],
          ),
        },
      }, ["questions"]),
      call: async (args, signal) => {
        const service = typeof localService === "function" ? await localService() : localService
        if (service) {
          try {
            return toMcpResult(await askViaForm(ctx, service, sessionKey, args ?? {}, signal, log))
          } catch (error) {
            if (!(error instanceof QuestionFormError)) throw error
            log?.("warn", `question form API unavailable (${error.message}); using the builtin question tool`)
          }
        }
        return toMcpResult(await invoke(question, args ?? {}, signal))
      },
    })
  }

  addBuiltin("todowrite", ["todowrite", "todo"], TODOWRITE_DESCRIPTION, objectSchema({
    todos: {
      type: "array",
      description: "The updated todo list",
      items: objectSchema(
        {
          content: stringSchema("Brief description of the task"),
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed", "cancelled"],
            description: "Current status of the task: pending, in_progress, completed, cancelled",
          },
        },
        ["content", "status"],
      ),
    },
  }, ["todos"]))

  tools.push(
    {
      name: "session_list",
      description: "List sessions in this location, newest first. Mirrors session.list.",
      inputSchema: objectSchema({
        limit: { type: "integer", minimum: 1 },
        order: { type: "string", enum: ["asc", "desc"] },
        search: stringSchema("Filter by title or content."),
        parentID: { type: ["string", "null"], description: "Only children of this session." },
        archived: { type: "boolean" },
        directory: stringSchema("Filter by directory."),
        project: stringSchema("Filter by project."),
        subpath: stringSchema("Filter by subpath."),
        cursor: stringSchema("Paging cursor."),
      }),
      call: async (args, signal) => {
        await assertList(ctx, sessionKey, signal)
        return toMcpResult(await ctx.session.list(args ?? {}))
      },
    },
    {
      name: "session_get",
      description: "Read one session's status and metadata. Defaults to the calling session.",
      inputSchema: objectSchema({ sessionID: stringSchema("Session ID. Omit for the calling session.") }),
      call: async (args, signal) => {
        const sessionID = await readTarget(ctx, sessionKey, args?.sessionID, "get", signal)
        return toMcpResult(await ctx.session.get({ sessionID }))
      },
    },
    {
      name: "session_prompt",
      description: "Send a message to a session. delivery=steer joins a running turn; delivery=queue starts a follow-up run. Mirrors session.prompt.",
      inputSchema: objectSchema(
        {
          sessionID: stringSchema("Target session ID."),
          text: stringSchema("Message text."),
          id: stringSchema("Stable message id for idempotent retries."),
          files: { type: "array", items: { type: "object", additionalProperties: true } },
          agents: { type: "array", items: { type: "object", additionalProperties: true } },
          skills: { type: "array", items: { type: "object", additionalProperties: true } },
          metadata: { type: "object", additionalProperties: true },
          delivery: { type: "string", enum: ["steer", "queue"], description: "Default follows the session's current state." },
          resume: { type: "boolean" },
        },
        ["sessionID", "text"],
      ),
      call: async (args, signal) => {
        await assertSession(ctx, sessionKey, args.sessionID, "prompt", signal)
        return toMcpResult(await ctx.session.prompt(args))
      },
    },
    {
      name: "session_context",
      description: "Read a session's messages. Defaults to the calling session. Large timelines are truncated to the most recent items.",
      inputSchema: objectSchema({ sessionID: stringSchema("Session ID. Omit for the calling session.") }),
      call: async (args, signal) => {
        const sessionID = await readTarget(ctx, sessionKey, args?.sessionID, "context", signal)
        const messages = await ctx.session.context({ sessionID })
        return toMcpResult(boundContext(messages))
      },
    },
    {
      name: "session_wait",
      description: "Wait for a session to become idle. The timeout does not cancel the session.",
      inputSchema: objectSchema(
        {
          sessionID: stringSchema("Target session ID."),
          timeoutMs: { type: "integer", minimum: 0, description: "Maximum wait in milliseconds. Defaults to 45000 and is capped at 120000." },
        },
        ["sessionID"],
      ),
      call: async (args, signal) => {
        const sessionID = await readTarget(ctx, sessionKey, args.sessionID, "wait", signal)
        const requested = Number(args.timeoutMs ?? 45_000)
        const timeout = requested > 0 ? Math.min(requested, 120_000) : 45_000
        const wait = ctx.session.wait({ sessionID })
        let timer: ReturnType<typeof setTimeout> | undefined
        const outcome = await Promise.race([
          wait.then(() => "done" as const),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), timeout)
            timer.unref?.()
          }),
          waitForAbort(signal),
        ]).finally(() => {
          if (timer) clearTimeout(timer)
        })
        if (outcome === "cancelled") throw new Error("session wait cancelled")
        const timedOut = outcome === "timeout"
        const info = await ctx.session.get({ sessionID }).catch(() => undefined)
        return toMcpResult({ sessionID, session: info, waitTimedOut: timedOut })
      },
    },
    {
      name: "session_interrupt",
      description: "Interrupt a session's active run. Mirrors session.interrupt.",
      inputSchema: objectSchema({ sessionID: stringSchema("Target session ID."), resume: { type: "boolean" } }, ["sessionID"]) as Record<string, unknown>,
      call: async (args, signal) => {
        await assertSession(ctx, sessionKey, args.sessionID, "interrupt", signal)
        return toMcpResult(await ctx.session.interrupt(args))
      },
    },
  )

  return tools
}

async function subagentDescription(ctx: Ctx) {
  const parts = [SUBAGENT_DESCRIPTION]
  try {
    const agents = (await ctx.agent.list()).data
    const available = agents
      .filter((agent) => agent.mode !== "primary" && !agent.hidden)
      .sort((left, right) => left.id.localeCompare(right.id))
    if (available.length) {
      parts.push("", "Available subagents:", ...available.map((agent) => `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`))
    }
  } catch {
    // agent discovery is best effort
  }
  return parts.join("\n")
}

async function assertSession(ctx: Ctx, caller: string, target: any, operation: string, signal: AbortSignal) {
  if (!target) throw new Error(`session ${operation} requires a sessionID`)
  try {
    await ctx.permission.assert({
      sessionID: caller as any,
      action: "session",
      resources: [String(target)],
      metadata: { operation },
    } as any)
  } catch (error) {
    if (signal.aborted) throw error
    const message = error instanceof Error && error.message ? `: ${error.message}` : ""
    throw new Error(`Permission denied: session ${operation} on ${target}${message}`)
  }
}

/** Listing spans sessions, so it needs an explicit permission of its own. */
async function assertList(ctx: Ctx, caller: string, signal: AbortSignal) {
  try {
    await ctx.permission.assert({
      sessionID: caller as any,
      action: "session",
      resources: ["*"],
      metadata: { operation: "list" },
    } as any)
  } catch (error) {
    if (signal.aborted) throw error
    const message = error instanceof Error && error.message ? `: ${error.message}` : ""
    throw new Error(`Permission denied: session list${message}`)
  }
}

/** Reads default to the calling session; another session needs a permission check. */
async function readTarget(
  ctx: Ctx,
  caller: string,
  requested: unknown,
  operation: string,
  signal: AbortSignal,
) {
  const target = typeof requested === "string" && requested ? requested : caller
  if (target !== caller) await assertSession(ctx, caller, target, operation, signal)
  return target
}

function waitForAbort(signal: AbortSignal): Promise<"cancelled"> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve("cancelled")
      return
    }
    signal.addEventListener("abort", () => resolve("cancelled"), { once: true })
  })
}

function combineSignals(...signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0]!
  const anyOf = (AbortSignal as unknown as { any?: (list: AbortSignal[]) => AbortSignal }).any
  if (typeof anyOf === "function") return anyOf(signals)
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

function toMcpResult(value: any) {
  const output = value && typeof value === "object" && "output" in value ? value.output : value
  let content = value && typeof value === "object" && Array.isArray(value.content) ? value.content : undefined
  if (!content) {
    const text =
      value && typeof value === "object" && typeof value.content === "string"
        ? value.content
        : typeof output === "string"
          ? output
          : JSON.stringify(output ?? null)
    content = [{ type: "text", text }]
  }
  return {
    content,
    ...(output === undefined ? {} : { structuredContent: output }),
  }
}

function boundContext(messages: any[]) {
  const serialized = JSON.stringify(messages)
  if (serialized.length <= MAX_CONTEXT_CHARS) return { messages, truncated: false, omittedMessages: 0 }
  let size = 0
  let start = messages.length
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const length = JSON.stringify(messages[index]).length
    if (size + length > MAX_CONTEXT_CHARS) break
    size += length
    start = index
  }
  return { messages: messages.slice(start), truncated: true, omittedMessages: start }
}

function readBody(req: IncomingMessage, maxBytes: number) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    req.on("data", (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        settled = true
        reject(new Error("Request body too large"))
        req.destroy()
        return
      }
      chunks.push(Buffer.from(chunk))
    })
    req.on("end", () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString("utf8"))
    })
    req.on("error", (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}
