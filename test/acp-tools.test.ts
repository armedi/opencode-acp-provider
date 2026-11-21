import { describe, expect, test } from "bun:test"
import { applyToolUpdate, planToToolState, type AcpToolState } from "../src/acp-tools.ts"

type ToolUpdate = Parameters<typeof applyToolUpdate>[0]

function toolStates(): Map<string, AcpToolState> {
  return new Map()
}

function mapped(update: ToolUpdate): AcpToolState {
  const state = applyToolUpdate(update, toolStates())
  if (!state) throw new Error("expected a mapped tool state")
  return state
}

function claude(
  toolName: string,
  rawInput: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): ToolUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: `claude-${toolName}`,
    status: "completed",
    rawInput,
    _meta: { claudeCode: { toolName } },
    ...overrides,
  }
}

function antigravity(
  name: string,
  rawInput: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): ToolUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: `antigravity-${name}`,
    name,
    status: "completed",
    rawInput,
    ...overrides,
  }
}

function commandCode(
  title: string,
  rawInput: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): ToolUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: `command-code-${title}`,
    title,
    status: "completed",
    rawInput,
    ...overrides,
  }
}

describe("Claude tool mapping", () => {
  test("maps Bash to shell and drops agent-only fields", () => {
    const state = mapped(
      claude("Bash", {
        command: "npm test -- --watch=false",
        timeout: 120000,
        run_in_background: true,
        description: "Run tests",
        dangerouslyDisableSandbox: true,
      }),
    )
    expect(state.name).toBe("shell")
    expect(state.input).toEqual({ command: "npm test -- --watch=false", timeout: 120000, background: true })
  })

  test("maps PowerShell to shell", () => {
    const state = mapped(
      claude("PowerShell", {
        command: "Get-ChildItem -Recurse",
        timeout: 60000,
        run_in_background: false,
        description: "List files",
        dangerouslyDisableSandbox: false,
      }),
    )
    expect(state.name).toBe("shell")
    expect(state.input).toEqual({ command: "Get-ChildItem -Recurse", timeout: 60000, background: false })
  })

  test("maps Read and drops pages and allow_large", () => {
    const state = mapped(
      claude("Read", {
        file_path: "/repo/src/app.ts",
        offset: 40,
        limit: 80,
        pages: "1-2",
        allow_large: true,
      }),
    )
    expect(state.name).toBe("read")
    expect(state.input).toEqual({ path: "/repo/src/app.ts", offset: 40, limit: 80 })
  })

  test("maps Grep with case-insensitive search and no limit", () => {
    const state = mapped(
      claude("Grep", {
        pattern: "applyToolUpdate",
        path: "src",
        glob: "*.ts",
        "-i": true,
        head_limit: 0,
        type: "ts",
        output_mode: "content",
        "-n": true,
        "-A": 2,
        "-B": 1,
        "-C": 3,
        context: 2,
        offset: 5,
        multiline: true,
      }),
    )
    expect(state.name).toBe("grep")
    expect(state.input).toEqual({
      pattern: "applyToolUpdate",
      path: "src",
      include: "*.ts",
      caseSensitive: false,
    })
  })

  test("maps Grep with case-sensitive search and a positive head_limit", () => {
    const state = mapped(claude("Grep", { pattern: "AcpToolState", "-i": false, head_limit: 25 }))
    expect(state.name).toBe("grep")
    expect(state.input).toEqual({ pattern: "AcpToolState", caseSensitive: true, limit: 25 })
  })

  test("omits caseSensitive when Grep has no -i flag", () => {
    const state = mapped(claude("Grep", { pattern: "TODO", path: "src/acp-tools" }))
    expect(state.name).toBe("grep")
    expect(state.input).toEqual({ pattern: "TODO", path: "src/acp-tools" })
  })

  test("maps Glob and drops extra glob fields", () => {
    const state = mapped(claude("Glob", { pattern: "**/*.test.ts", path: "test", limit: 10, hidden: true }))
    expect(state.name).toBe("glob")
    expect(state.input).toEqual({ pattern: "**/*.test.ts", path: "test" })
  })

  test("maps WebFetch to a markdown webfetch and drops prompt and offset", () => {
    const state = mapped(
      claude("WebFetch", { url: "https://example.com/docs", prompt: "Summarize", offset: 1000 }),
    )
    expect(state.name).toBe("webfetch")
    expect(state.input).toEqual({ url: "https://example.com/docs", format: "markdown" })
  })

  test("keeps an empty streamed WebFetch rawInput empty", () => {
    const state = mapped(claude("WebFetch", {}, { kind: "fetch", status: "pending" }))
    expect(state.name).toBe("webfetch")
    expect(state.input).toEqual({})
  })

  test("maps WebSearch arriving with kind fetch and drops domain filters", () => {
    const state = mapped(
      claude(
        "WebSearch",
        {
          query: "ACP protocol",
          allowed_domains: ["agentclientprotocol.com"],
          blocked_domains: ["spam.example"],
        },
        { kind: "fetch" },
      ),
    )
    expect(state.name).toBe("websearch")
    expect(state.input).toEqual({ query: "ACP protocol" })
  })

  test("maps Write to a write card", () => {
    const state = mapped(
      claude("Write", { file_path: "/repo/notes.md", content: "# Notes\n", mode: "overwrite" }),
    )
    expect(state.name).toBe("write")
    expect(state.input).toEqual({ path: "/repo/notes.md", content: "# Notes\n" })
  })

  test("maps Edit to an edit card", () => {
    const state = mapped(
      claude("Edit", {
        file_path: "/repo/src/app.ts",
        old_string: "const a = 1",
        new_string: "const a = 2",
        replace_all: true,
      }),
    )
    expect(state.name).toBe("edit")
    expect(state.input).toEqual({
      path: "/repo/src/app.ts",
      oldString: "const a = 1",
      newString: "const a = 2",
      replaceAll: true,
    })
  })

  test("maps Skill and drops extra keys", () => {
    const state = mapped(claude("Skill", { skill: "test-audit", args: "focus: flaky tests" }))
    expect(state.name).toBe("skill")
    expect(state.input).toEqual({ id: "test-audit" })
  })

  test("maps the OpenCode question tool and keeps questions unchanged", () => {
    const questions = [{ question: "Proceed?", options: [{ label: "Yes" }] }]
    const state = mapped(
      claude("mcp__opencode__question", { questions, toolSummary: "Ask to proceed" }),
    )
    expect(state.name).toBe("question")
    expect(state.input).toEqual({ questions })
  })

  test("keeps unhidden think tools as exact generic cards", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["Agent", { description: "Explore", prompt: "Find the mapping tests" }],
      ["Task", { description: "Run checks", prompt: "Run bun test" }],
      ["TodoWrite", { todos: [{ content: "Map tools", status: "in_progress" }] }],
      ["TaskCreate", { subject: "Map tools", description: "Write tests" }],
      ["ReportFindings", { findings: [{ title: "Mapped", level: "info" }] }],
    ]
    for (const [toolName, rawInput] of cases) {
      const state = mapped(claude(toolName, rawInput, { kind: "think" }))
      expect(state.name).toBe(toolName)
      expect(state.input).toEqual(rawInput)
      expect(state.hidden).toBeUndefined()
    }
  })

  test("keeps NotebookEdit as a generic card with its raw input", () => {
    const rawInput = { notebook_path: "/repo/analysis.ipynb", cell_number: 2, new_source: "print('hi')" }
    const state = mapped(claude("NotebookEdit", rawInput, { kind: "edit" }))
    expect(state.name).toBe("NotebookEdit")
    expect(state.input).toEqual(rawInput)
  })

  test("keeps other MCP tools as exact generic cards", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["mcp__opencode__subagent", { agent: "explore", prompt: "Inspect the tests" }],
      ["mcp__linear__get_issue", { id: "ENG-42", includeRelations: true }],
    ]
    for (const [toolName, rawInput] of cases) {
      const state = mapped(claude(toolName, rawInput, { kind: "think" }))
      expect(state.name).toBe(toolName)
      expect(state.input).toEqual(rawInput)
      expect(state.hidden).toBeUndefined()
    }
  })
})

const antigravityHeader =
  "Created At: 2026-11-21T07:00:00.000Z\r\nCompleted At: 2026-11-21T07:00:01.000Z"

function completeRunCommand(rawOutput: string, options: { omitName?: boolean } = {}): AcpToolState | undefined {
  const states = toolStates()
  const toolCallId = "antigravity-run-command"
  applyToolUpdate(
    {
      sessionUpdate: "tool_call",
      toolCallId,
      name: "run_command",
      kind: "execute",
      status: "in_progress",
      rawInput: { CommandLine: "uptime", Cwd: "/repo" },
    },
    states,
  )
  return applyToolUpdate(
    {
      sessionUpdate: "tool_call_update",
      toolCallId,
      ...(options.omitName ? {} : { name: "run_command" }),
      status: "completed",
      rawOutput,
    },
    states,
  )
}

describe("Antigravity tool mapping", () => {
  test("maps run_command to shell and drops toolSummary", () => {
    const state = mapped(
      antigravity("run_command", {
        CommandLine: "bun test",
        Cwd: "/repo",
        WaitMsBeforeAsync: 5000,
        toolSummary: "Run tests",
      }),
    )
    expect(state.name).toBe("shell")
    expect(state.input).toEqual({ command: "bun test", workdir: "/repo", timeout: 5000 })
  })

  test("strips a zero-exit header and shows only the command output", () => {
    const state = completeRunCommand(
      `${antigravityHeader}\r\nCommand exited with code 0.\r\nCommand output:\r\nalpha\r\nbeta`,
    )
    expect(state?.output).toBe("alpha\nbeta")
  })

  test("keeps the status line for a non-zero exit with stderr", () => {
    const state = completeRunCommand(
      `${antigravityHeader}\r\nCommand exited with code 1.\r\nStderr:\r\npermission denied`,
    )
    expect(state?.output).toBe("Command exited with code 1.\npermission denied")
  })

  test("keeps the status line when the command produced no output", () => {
    const state = completeRunCommand(`${antigravityHeader}\r\nNo output from the command.`)
    expect(state?.output).toBe("No output from the command.")
  })

  test("keeps the background status line and the output body", () => {
    const state = completeRunCommand(
      `${antigravityHeader}\r\nBackground command is still running after 5s: bun run dev\r\nOutput:\r\nListening on http://localhost:3000`,
    )
    expect(state?.output).toBe(
      "Background command is still running after 5s: bun run dev\nListening on http://localhost:3000",
    )
  })

  test("keeps the timeout status line", () => {
    const state = completeRunCommand(`${antigravityHeader}\r\nCommand timed out: 30s`)
    expect(state?.output).toBe("Command timed out: 30s")
  })

  test("keeps the canceled status line", () => {
    const state = completeRunCommand(`${antigravityHeader}\r\nStep was canceled by user.`)
    expect(state?.output).toBe("Step was canceled by user.")
  })

  test("returns an empty output for a zero exit without a body", () => {
    const state = completeRunCommand(
      `${antigravityHeader}\r\nCommand exited with code 0.\r\nCommand output:`,
    )
    expect(state?.output).toBe("")
  })

  test("strips the header when the completion update omits name", () => {
    const state = completeRunCommand(
      `${antigravityHeader}\r\nCommand exited with code 0.\r\nCommand output:\r\nalpha\r\nbeta`,
      { omitName: true },
    )
    expect(state?.output).toBe("alpha\nbeta")
  })

  test("maps read_file to read and drops line-range fields", () => {
    const state = mapped(
      antigravity("read_file", { Path: "/repo/src/app.ts", StartLine: 10, EndLine: 20 }),
    )
    expect(state.name).toBe("read")
    expect(state.input).toEqual({ path: "/repo/src/app.ts" })
  })

  test("maps a normal write_file to write and drops overwrite and append", () => {
    const state = mapped(
      antigravity("write_file", {
        Path: "/repo/notes.md",
        Content: "# Hi\n",
        Overwrite: true,
        Append: false,
      }),
    )
    expect(state.name).toBe("write")
    expect(state.input).toEqual({ path: "/repo/notes.md", content: "# Hi\n" })
  })

  test("builds an edit from a single-update append diff", () => {
    const state = mapped(
      antigravity(
        "write_file",
        { Path: "/repo/log.txt", Content: "line 3\n", Append: true, Overwrite: false },
        {
          kind: "edit",
          content: [
            {
              type: "diff",
              path: "/repo/log.txt",
              oldText: "line 1\n",
              newText: "line 1\nline 3\n",
            },
          ],
        },
      ),
    )
    expect(state.name).toBe("edit")
    expect(state.input).toEqual({
      path: "/repo/log.txt",
      oldString: "line 1\n",
      newString: "line 1\nline 3\n",
    })
  })

  test("builds an edit when the append diff arrives on a later update", () => {
    const states = toolStates()
    const toolCallId = "antigravity-append"
    const first = applyToolUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId,
        name: "write_file",
        kind: "edit",
        status: "in_progress",
        rawInput: { Path: "/repo/log.txt", Content: "line 3\n", Append: true, Overwrite: false },
      },
      states,
    )
    expect(first?.name).toBe("edit")
    expect(first?.input).toEqual({ path: "/repo/log.txt" })

    const second = applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        content: [
          {
            type: "diff",
            path: "/repo/log.txt",
            oldText: "line 1\nline 2\n",
            newText: "line 1\nline 2\nline 3\n",
          },
        ],
      },
      states,
    )
    expect(second?.name).toBe("edit")
    expect(second?.input).toEqual({
      path: "/repo/log.txt",
      oldString: "line 1\nline 2\n",
      newString: "line 1\nline 2\nline 3\n",
    })
  })

  test("maps a single edit_file target to edit", () => {
    const state = mapped(
      antigravity("edit_file", {
        Path: "/repo/app.ts",
        Target: "before",
        Replacement: "after",
        AllowMultiple: true,
      }),
    )
    expect(state.name).toBe("edit")
    expect(state.input).toEqual({
      path: "/repo/app.ts",
      oldString: "before",
      newString: "after",
      replaceAll: true,
    })
  })

  test("maps multiple edit_file edits to an exact patch", () => {
    const state = mapped(
      antigravity("edit_file", {
        Path: "/repo/app.ts",
        Edits: [
          { TargetContent: "a", ReplacementContent: "A" },
          { TargetContent: "b", ReplacementContent: "B" },
        ],
      }),
    )
    expect(state.name).toBe("patch")
    expect(state.input).toEqual({
      patchText:
        "*** Begin Patch\n*** Update File: /repo/app.ts\n@@\n-a\n+A\n@@\n-b\n+B\n*** End Patch",
    })
  })

  test("maps search_web to websearch", () => {
    const state = mapped(antigravity("search_web", { query: "ACP tool mapping" }))
    expect(state.name).toBe("websearch")
    expect(state.input).toEqual({ query: "ACP tool mapping" })
  })

  test("maps mcp_opencode_question and keeps only questions", () => {
    const questions = [{ question: "Pick one", options: [{ label: "A" }] }]
    const state = mapped(
      antigravity("mcp_opencode_question", { questions, toolSummary: "Ask which" }),
    )
    expect(state.name).toBe("question")
    expect(state.input).toEqual({ questions })
  })

  test("keeps other Antigravity tools as exact generic cards", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["mcp_opencode_subagent", { agent: "general", prompt: "Write the tests" }],
      ["mcp_linear_get_issue", { id: "ENG-42" }],
      ["invoke_subagent", { agent: "explore", prompt: "Find mappings" }],
      ["ask_question", { questions: [{ question: "Continue?", options: [] }] }],
    ]
    for (const [name, rawInput] of cases) {
      const state = mapped(antigravity(name, rawInput))
      expect(state.name).toBe(name)
      expect(state.input).toEqual(rawInput)
    }
  })
})

describe("Command Code tool mapping", () => {
  test("maps Shell to shell and drops description", () => {
    const state = mapped(
      commandCode("Shell: npm test", {
        command: "npm test",
        cwd: "/repo",
        timeout: 120000,
        run_in_background: true,
        description: "Run tests",
      }),
    )
    expect(state.name).toBe("shell")
    expect(state.input).toEqual({
      command: "npm test",
      workdir: "/repo",
      timeout: 120000,
      background: true,
    })
  })

  test("maps Monitor to shell", () => {
    const state = mapped(
      commandCode("Monitor: bun run dev", {
        command: "bun run dev",
        cwd: "/repo",
        timeout: 30000,
        run_in_background: true,
        description: "Start the dev server",
      }),
    )
    expect(state.name).toBe("shell")
    expect(state.input).toEqual({
      command: "bun run dev",
      workdir: "/repo",
      timeout: 30000,
      background: true,
    })
  })

  test("maps Command to shell", () => {
    const state = mapped(
      commandCode("Command: bun run build", {
        command: "bun run build",
        workdir: "/repo",
        timeout: 60000,
        description: "Build the package",
      }),
    )
    expect(state.name).toBe("shell")
    expect(state.input).toEqual({ command: "bun run build", workdir: "/repo", timeout: 60000 })
  })

  test("maps powershell to shell", () => {
    const state = mapped(
      commandCode("powershell", {
        command: "Get-Process",
        workdir: "/repo",
        timeout: 15000,
        run_in_background: false,
        description: "List processes",
      }),
    )
    expect(state.name).toBe("shell")
    expect(state.input).toEqual({
      command: "Get-Process",
      workdir: "/repo",
      timeout: 15000,
      background: false,
    })
  })

  test("maps Read to read with offset and limit", () => {
    const state = mapped(
      commandCode("Read: /repo/src/app.ts", {
        file_path: "/repo/src/app.ts",
        offset: 10,
        limit: 30,
      }),
    )
    expect(state.name).toBe("read")
    expect(state.input).toEqual({ path: "/repo/src/app.ts", offset: 10, limit: 30 })
  })

  test("maps a negative read offset to path only", () => {
    const state = mapped(
      commandCode("Read: /repo/var/log/app.log", {
        path: "/repo/var/log/app.log",
        offset: -20,
        limit: 10,
      }),
    )
    expect(state.name).toBe("read")
    expect(state.input).toEqual({ path: "/repo/var/log/app.log" })
  })

  test("maps List to read", () => {
    const state = mapped(commandCode("List: /repo/src", { path: "/repo/src" }))
    expect(state.name).toBe("read")
    expect(state.input).toEqual({ path: "/repo/src" })
  })

  test("keeps a raw read_multiple_files name generic", () => {
    const rawInput = { paths: ["/repo/a.ts", "/repo/b.ts"] }
    const state = mapped(commandCode("read_multiple_files", rawInput, { kind: "read" }))
    expect(state.name).toBe("read_multiple_files")
    expect(state.input).toEqual(rawInput)
  })

  test("keeps Read with paths as a generic read_multiple_files card", () => {
    const rawInput = { paths: ["/repo/a.ts", "/repo/b.ts"] }
    const state = mapped(commandCode("Read: several files", rawInput, { kind: "read" }))
    expect(state.name).toBe("read_multiple_files")
    expect(state.input).toEqual(rawInput)
  })

  test("maps a Search with pattern to grep and drops search-only fields", () => {
    const state = mapped(
      commandCode(
        "Search: applyToolUpdate",
        {
          pattern: "applyToolUpdate",
          path: "src",
          glob: "*.ts",
          "-i": true,
          head_limit: 0,
          type: "ts",
          output_mode: "content",
          "-n": true,
          "-A": 2,
          "-B": 1,
          "-C": 3,
          context: 2,
          offset: 5,
          multiline: true,
        },
        { kind: "search" },
      ),
    )
    expect(state.name).toBe("grep")
    expect(state.input).toEqual({
      pattern: "applyToolUpdate",
      path: "src",
      include: "*.ts",
      caseSensitive: false,
    })
  })

  test("maps a case-sensitive Search with a positive head_limit to grep", () => {
    const state = mapped(
      commandCode(
        "Search: AcpToolState",
        { pattern: "AcpToolState", "-i": false, head_limit: 40 },
        { kind: "search" },
      ),
    )
    expect(state.name).toBe("grep")
    expect(state.input).toEqual({ pattern: "AcpToolState", caseSensitive: true, limit: 40 })
  })

  test("maps a Search with query to websearch", () => {
    const state = mapped(
      commandCode(
        "Search: weather in Tokyo",
        { query: "weather in Tokyo", max_results: 5 },
        { kind: "search" },
      ),
    )
    expect(state.name).toBe("websearch")
    expect(state.input).toEqual({ query: "weather in Tokyo" })
  })

  test("maps Glob and drops offset", () => {
    const state = mapped(
      commandCode(
        "Glob: **/*.ts",
        { pattern: "**/*.ts", path: "src", limit: 25, offset: 10 },
        { kind: "search" },
      ),
    )
    expect(state.name).toBe("glob")
    expect(state.input).toEqual({ pattern: "**/*.ts", path: "src", limit: 25 })
  })

  test("maps Fetch to a markdown webfetch and drops startIndex", () => {
    const state = mapped(
      commandCode(
        "Fetch: https://example.com",
        { url: "https://example.com", timeout: 15000, startIndex: 2000 },
        { kind: "fetch" },
      ),
    )
    expect(state.name).toBe("webfetch")
    expect(state.input).toEqual({ url: "https://example.com", format: "markdown", timeout: 15000 })
  })

  test("maps Edit to an edit card", () => {
    const state = mapped(
      commandCode(
        "Edit: /repo/src/app.ts",
        {
          file_path: "/repo/src/app.ts",
          old_string: "const a = 1",
          new_string: "const a = 2",
          replace_all: true,
        },
        { kind: "edit" },
      ),
    )
    expect(state.name).toBe("edit")
    expect(state.input).toEqual({
      path: "/repo/src/app.ts",
      oldString: "const a = 1",
      newString: "const a = 2",
      replaceAll: true,
    })
  })

  test("maps Write to a write card", () => {
    const state = mapped(
      commandCode(
        "Write: /repo/notes.md",
        { file_path: "/repo/notes.md", content: "# Hi" },
        { kind: "edit" },
      ),
    )
    expect(state.name).toBe("write")
    expect(state.input).toEqual({ path: "/repo/notes.md", content: "# Hi" })
  })

  test("maps activate_skill and drops arguments", () => {
    const state = mapped(
      commandCode("activate_skill", { name: "cleanup", arguments: "focus: diff" }),
    )
    expect(state.name).toBe("skill")
    expect(state.input).toEqual({ id: "cleanup" })
  })

  test("maps codemode to execute and drops timeout_ms", () => {
    const state = mapped(
      commandCode("codemode", { code: "return 42", timeout_ms: 5000 }, { kind: "execute" }),
    )
    expect(state.name).toBe("execute")
    expect(state.input).toEqual({ code: "return 42" })
  })

  test("keeps shell inspection tools as exact generic cards", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["Kill: 7342", { pid: 7342 }, "kill_shell"],
      ["shell_tasks", { includeStopped: true }, "shell_tasks"],
      ["bash_output", { shell_id: "shell-1" }, "bash_output"],
      ["monitor_events", { timeout_ms: 5000 }, "monitor_events"],
      ["Diagnostics", { path: "/repo/src" }, "get_diagnostics"],
    ]
    for (const [title, rawInput, name] of cases) {
      const state = mapped(commandCode(title, rawInput))
      expect(state.name).toBe(name)
      expect(state.input).toEqual(rawInput)
    }
  })

  test("keeps unknown MCP tools generic", () => {
    const rawInput = { description: "Explore", prompt: "Map tools" }
    const state = mapped(commandCode("mcp__opencode__subagent", rawInput))
    expect(state.name).toBe("mcp__opencode__subagent")
    expect(state.input).toEqual(rawInput)
  })

  test("keeps ask_user_question visible despite its think kind", () => {
    const questions = [{ question: "Continue?", options: [{ label: "Yes" }] }]
    const state = mapped(commandCode("ask_user_question", { questions }, { kind: "think" }))
    expect(state.name).toBe("ask_user_question")
    expect(state.input).toEqual({ questions })
    expect(state.hidden).toBeUndefined()
  })

  test("keeps an Agent card generic instead of mapping it to task", () => {
    const rawInput = { prompt: "Find the ACP tool mapping tests" }
    const state = mapped(commandCode("Agent: Explore", rawInput))
    expect(state.name).toBe("Agent: Explore")
    expect(state.name).not.toBe("task")
    expect(state.input).toEqual(rawInput)
  })

  test("hides an Updating todos think call", () => {
    const state = applyToolUpdate(
      commandCode("Updating todos", {}, { kind: "think" }),
      toolStates(),
    )
    expect(state).toBeUndefined()
  })
})

describe("Codex tool mapping", () => {
  test("maps an array shell command to shell", () => {
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "codex-shell-array",
      name: "exec_command",
      title: "Run git status",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: ["bash", "-lc", "git status --short"], cwd: "/repo" },
    })
    expect(state.name).toBe("shell")
    expect(state.input).toEqual({ command: "git status --short", workdir: "/repo" })
  })

  test("maps a string shell command to shell", () => {
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "codex-shell-string",
      name: "exec_command",
      title: "Run tests",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "bun test", cwd: "/repo" },
    })
    expect(state.name).toBe("shell")
    expect(state.input).toEqual({ command: "bun test", workdir: "/repo" })
  })

  test("maps Read file and preserves streamed output on completion", () => {
    const states = toolStates()
    const toolCallId = "codex-read-file"
    const first = applyToolUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId,
        name: "exec_command",
        title: "Read file '/tmp/sample.txt'",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "/tmp/sample.txt" }],
      },
      states,
    )
    expect(first?.name).toBe("read")
    expect(first?.input).toEqual({ path: "/tmp/sample.txt" })

    applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        _meta: { terminal_output_delta: { data: "alpha\nbeta\n" } },
      },
      states,
    )
    const completed = applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: { exit_code: 0 },
      },
      states,
    )
    expect(completed?.name).toBe("read")
    expect(completed?.input).toEqual({ path: "/tmp/sample.txt" })
    expect(completed?.output).toBe("alpha\nbeta\n")
  })

  test("maps List files in a directory and preserves output for an empty rawOutput", () => {
    const states = toolStates()
    const toolCallId = "codex-list-files"
    const first = applyToolUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId,
        name: "exec_command",
        title: "List files in '/repo/src'",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "/repo/src" }],
      },
      states,
    )
    expect(first?.name).toBe("read")
    expect(first?.input).toEqual({ path: "/repo/src" })

    applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        _meta: { terminal_output_delta: { data: "acp-tools.ts\n" } },
      },
      states,
    )
    const completed = applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: "",
      },
      states,
    )
    expect(completed?.name).toBe("read")
    expect(completed?.input).toEqual({ path: "/repo/src" })
    expect(completed?.output).toBe("acp-tools.ts\n")
  })

  test("maps a bare List files call to read from raw input", () => {
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "codex-list-bare",
      name: "exec_command",
      title: "List files",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "/repo/docs" },
    })
    expect(state.name).toBe("read")
    expect(state.input).toEqual({ path: "/repo/docs" })
  })

  test("maps a Search for query in a path to grep", () => {
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "codex-search-path",
      name: "exec_command",
      title: "Search for 'applyToolUpdate' in src/acp-tools",
      kind: "search",
      status: "in_progress",
    })
    expect(state.name).toBe("grep")
    expect(state.input).toEqual({ pattern: "applyToolUpdate", path: "src/acp-tools" })
  })

  test("maps a bare Search for query to grep without a path", () => {
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "codex-search-query",
      name: "exec_command",
      title: "Search for 'TODO'",
      kind: "search",
      status: "in_progress",
    })
    expect(state.name).toBe("grep")
    expect(state.input).toEqual({ pattern: "TODO" })
  })

  test("maps View Image to read", () => {
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "codex-image",
      name: "view_image",
      title: "View Image /tmp/diagram.png",
      kind: "read",
      status: "in_progress",
    })
    expect(state.name).toBe("read")
    expect(state.input).toEqual({ path: "/tmp/diagram.png" })
  })

  test("maps a live webSearch payload to websearch", () => {
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "codex-websearch-live",
      title: "Web search",
      kind: "search",
      status: "in_progress",
      rawInput: {
        type: "webSearch",
        id: "ws_1",
        query: "ACP protocol",
        action: { type: "search", query: "ACP protocol" },
      },
    })
    expect(state.name).toBe("websearch")
    expect(state.input).toEqual({ query: "ACP protocol" })
  })

  test("maps a replayed webSearch payload without type to websearch", () => {
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "codex-websearch-replay",
      title: "Web search",
      kind: "search",
      status: "in_progress",
      rawInput: { query: "zod v4", action: { type: "search", query: "zod v4" } },
    })
    expect(state.name).toBe("websearch")
    expect(state.input).toEqual({ query: "zod v4" })
  })

  test("maps a single added file to write", () => {
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "codex-file-add",
      title: "Editing files",
      kind: "edit",
      status: "in_progress",
      content: [
        {
          type: "diff",
          path: "/repo/new.ts",
          oldText: null,
          newText: "export const created = true\n",
        },
      ],
    })
    expect(state.name).toBe("write")
    expect(state.input).toEqual({ path: "/repo/new.ts", content: "export const created = true\n" })
  })

  test("maps a single updated file to edit", () => {
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "codex-file-update",
      title: "Editing files",
      kind: "edit",
      status: "in_progress",
      content: [
        {
          type: "diff",
          path: "/repo/app.ts",
          oldText: "const value = 1\n",
          newText: "const value = 2\n",
        },
      ],
    })
    expect(state.name).toBe("edit")
    expect(state.input).toEqual({
      path: "/repo/app.ts",
      oldString: "const value = 1\n",
      newString: "const value = 2\n",
    })
  })

  test("maps a single deleted file to a delete patch", () => {
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "codex-file-delete",
      title: "Editing files",
      kind: "edit",
      status: "in_progress",
      content: [{ type: "diff", path: "/repo/old.ts", oldText: "legacy\n", newText: "" }],
    })
    expect(state.name).toBe("patch")
    expect(state.input).toEqual({
      patchText: "*** Begin Patch\n*** Delete File: /repo/old.ts\n*** End Patch",
    })
  })

  test("maps a multi-file change to an add, update, and delete patch", () => {
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "codex-file-multi",
      title: "Editing files",
      kind: "edit",
      status: "in_progress",
      content: [
        {
          type: "diff",
          path: "/repo/new.ts",
          oldText: null,
          newText: "export const added = true\n",
        },
        {
          type: "diff",
          path: "/repo/app.ts",
          oldText: "const before = 1\n",
          newText: "const after = 1\n",
        },
        { type: "diff", path: "/repo/old.ts", oldText: "legacy\n", newText: "" },
      ],
    })
    expect(state.name).toBe("patch")
    expect(state.input).toEqual({
      patchText:
        "*** Begin Patch\n*** Add File: /repo/new.ts\n+export const added = true\n*** Update File: /repo/app.ts\n@@\n-const before = 1\n+const after = 1\n*** Delete File: /repo/old.ts\n*** End Patch",
    })
  })

  test("maps multiple hunks on one file to a single update chunk set", () => {
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "codex-file-hunks",
      title: "Editing files",
      kind: "edit",
      status: "in_progress",
      content: [
        { type: "diff", path: "/repo/app.ts", oldText: "const a = 1\n", newText: "const a = 2\n" },
        { type: "diff", path: "/repo/app.ts", oldText: "const b = 1\n", newText: "const b = 2\n" },
      ],
    })
    expect(state.name).toBe("patch")
    expect(state.input).toEqual({
      patchText:
        "*** Begin Patch\n*** Update File: /repo/app.ts\n@@\n-const a = 1\n+const a = 2\n@@\n-const b = 1\n+const b = 2\n*** End Patch",
    })
  })

  test("preserves the resolved name and input on a status-only completion", () => {
    const states = toolStates()
    const toolCallId = "codex-file-status"
    applyToolUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Editing files",
        kind: "edit",
        status: "in_progress",
        content: [{ type: "diff", path: "/repo/app.ts", oldText: "a", newText: "b" }],
      },
      states,
    )
    const completed = applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
      },
      states,
    )
    expect(completed?.name).toBe("edit")
    expect(completed?.input).toEqual({ path: "/repo/app.ts", oldString: "a", newString: "b" })
  })

  test("maps an MCP question call and unwraps its questions", () => {
    const questions = [{ question: "Proceed?", options: [{ label: "Yes" }] }]
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "codex-mcp-question",
      title: "mcp.opencode.question",
      kind: "other",
      status: "in_progress",
      rawInput: { server: "opencode", tool: "question", arguments: { questions } },
      _meta: { is_mcp_tool_call: true },
    })
    expect(state.name).toBe("question")
    expect(state.input).toEqual({ questions })
  })

  test("keeps MCP models generic and reads its text result", () => {
    const states = toolStates()
    const toolCallId = "codex-mcp-models"
    const rawInput = { server: "opencode", tool: "models", arguments: { query: "gpt-6" } }
    const started = applyToolUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "mcp.opencode.models",
        kind: "other",
        status: "in_progress",
        rawInput,
        _meta: { is_mcp_tool_call: true },
      },
      states,
    )
    expect(started?.name).toBe("mcp.opencode.models")
    expect(started?.input).toEqual(rawInput)

    const completed = applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: { result: { content: [{ type: "text", text: '{"total":9}' }] } },
      },
      states,
    )
    expect(completed?.name).toBe("mcp.opencode.models")
    expect(completed?.input).toEqual(rawInput)
    expect(completed?.output).toBe('{"total":9}')
  })

  test("keeps MCP subagent generic and reads its text result", () => {
    const states = toolStates()
    const toolCallId = "codex-mcp-subagent"
    const rawInput = {
      server: "opencode",
      tool: "subagent",
      arguments: { agent: "explore", prompt: "Map the tools" },
    }
    const started = applyToolUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "mcp.opencode.subagent",
        kind: "other",
        status: "in_progress",
        rawInput,
        _meta: { is_mcp_tool_call: true },
      },
      states,
    )
    expect(started?.name).toBe("mcp.opencode.subagent")
    expect(started?.input).toEqual(rawInput)

    const completed = applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: { result: { content: [{ type: "text", text: "child finished" }] } },
      },
      states,
    )
    expect(completed?.name).toBe("mcp.opencode.subagent")
    expect(completed?.input).toEqual(rawInput)
    expect(completed?.output).toBe("child finished")
  })

  test("maps a dynamic tool call to its own name with raw input", () => {
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "codex-dynamic",
      name: "custom_tool",
      title: "custom_tool",
      kind: "execute",
      status: "in_progress",
      rawInput: { arguments: { a: 1 } },
    })
    expect(state.name).toBe("custom_tool")
    expect(state.input).toEqual({ arguments: { a: 1 } })
  })

  test("does not surface internal think calls as tool cards", () => {
    const states = toolStates()
    const initial = applyToolUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId: "guardian-1",
        kind: "think",
        title: "Guardian Review",
        status: "in_progress",
      },
      states,
    )
    expect(initial).toBeUndefined()
    const completion = applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "guardian-1",
        status: "completed",
      },
      states,
    )
    expect(completion).toBeUndefined()
  })
})

describe("Shared tool state behavior", () => {
  test("maps plan entries to a todowrite card", () => {
    const state = planToToolState({
      sessionUpdate: "plan",
      entries: [
        { content: "Map Claude tools", status: "completed", priority: "high" },
        { content: "Map Antigravity tools", status: "in_progress", priority: "medium" },
        { content: "Map Codex tools", status: "canceled", priority: "low" },
      ],
    })
    expect(state).toEqual({
      id: expect.any(String),
      name: "todowrite",
      kind: "think",
      title: "Update todos",
      input: {
        todos: [
          { content: "Map Claude tools", status: "completed" },
          { content: "Map Antigravity tools", status: "in_progress" },
          { content: "Map Codex tools", status: "cancelled" },
        ],
      },
      status: "completed",
      isError: false,
      done: true,
    })
  })

  test("generates unique plan ids across calls", () => {
    const update = {
      sessionUpdate: "plan",
      entries: [{ content: "One", status: "pending" }],
    }
    const first = planToToolState(update)
    const second = planToToolState(update)
    expect(first?.id).toMatch(/^plan-/)
    expect(second?.id).toMatch(/^plan-/)
    expect(first?.id).not.toBe(second?.id)
  })

  test("ignores non-plan updates", () => {
    expect(planToToolState({ sessionUpdate: "tool_call" })).toBeUndefined()
  })

  test("fills edit fields from a fallback diff", () => {
    const state = mapped({
      sessionUpdate: "tool_call",
      toolCallId: "fallback-edit",
      title: "Edit src/app.ts",
      kind: "edit",
      status: "completed",
      rawInput: { path: "src/app.ts" },
      content: [{ type: "diff", path: "src/app.ts", oldText: "before", newText: "after" }],
    })
    expect(state.name).toBe("edit")
    expect(state.input).toEqual({ path: "src/app.ts", oldString: "before", newString: "after" })
  })

  test("pretty-prints structured output without text fields", () => {
    const states = toolStates()
    const toolCallId = "claude-Bash"
    applyToolUpdate(
      claude("Bash", { command: "cat data.json" }, { toolCallId, status: "in_progress" }),
      states,
    )
    const completed = applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: { total: 9, items: ["a"] },
      },
      states,
    )
    expect(completed?.output).toBe(JSON.stringify({ total: 9, items: ["a"] }, null, 2))
  })

  test("pretty-prints a structured MCP result when no error is present", () => {
    const states = toolStates()
    const toolCallId = "codex-mcp-json"
    applyToolUpdate(
      {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "mcp.opencode.models",
        kind: "other",
        status: "in_progress",
        rawInput: { server: "opencode", tool: "models", arguments: {} },
        _meta: { is_mcp_tool_call: true },
      },
      states,
    )
    const completed = applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: { result: { total: 9, items: ["a"] }, error: null },
      },
      states,
    )
    expect(completed?.output).toBe(JSON.stringify({ total: 9, items: ["a"] }, null, 2))
  })

  test("clips output at 32000 characters", () => {
    const states = toolStates()
    const toolCallId = "claude-Bash"
    applyToolUpdate(
      claude("Bash", { command: "yes" }, { toolCallId, status: "in_progress" }),
      states,
    )
    const completed = applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: "x".repeat(32_005),
      },
      states,
    )
    expect(completed?.output?.length).toBe(32_000)
    expect(completed?.output?.endsWith("…")).toBe(true)
  })

  test("combines stdout and stderr when output is absent", () => {
    const states = toolStates()
    const toolCallId = "claude-Bash"
    applyToolUpdate(
      claude("Bash", { command: "run" }, { toolCallId, status: "in_progress" }),
      states,
    )
    const completed = applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: { stdout: "alpha", stderr: "beta" },
      },
      states,
    )
    expect(completed?.output).toBe("alpha\nbeta")
  })

  test("keeps output on shell cards when present", () => {
    const states = toolStates()
    const toolCallId = "claude-Bash"
    applyToolUpdate(
      claude("Bash", { command: "echo ok" }, { toolCallId, status: "in_progress" }),
      states,
    )
    const completed = applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: { output: "shell ok\n" },
      },
      states,
    )
    expect(completed?.output).toBe("shell ok")
  })

  test("keeps output on generic cards when present", () => {
    const states = toolStates()
    const toolCallId = "claude-mcp__opencode__subagent"
    applyToolUpdate(
      claude(
        "mcp__opencode__subagent",
        { prompt: "Find the tests" },
        { toolCallId, status: "in_progress" },
      ),
      states,
    )
    const completed = applyToolUpdate(
      {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: { text: "subagent finished" },
      },
      states,
    )
    expect(completed?.name).toBe("mcp__opencode__subagent")
    expect(completed?.output).toBe("subagent finished")
  })
})
