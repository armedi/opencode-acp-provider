# opencode-acp-client

An OpenCode plugin that makes OpenCode an **Agent Client Protocol (ACP) client**.

It starts ACP agents such as [`cmd acp`](https://commandcode.ai) over stdio, and registers each
agent as a **provider** in OpenCode's model list. Selecting one of those models routes the turn to
the ACP agent, so the agent runs with its own harness and tools while OpenCode provides the session,
history, and UI.

```text
OpenCode session ──▶ ACP language model ──▶ chat shim ──▶ ACP client (JSON-RPC/stdio) ──▶ cmd acp
```

## What you get

For a server named `cmd`:

- Provider id `acp-cmd`, shown as **Command Code (ACP)** in the model picker.
- Model `acp-cmd/deepseek/deepseek-v4.1-flash` (one model per ACP model the agent advertises).
- Model list discovered from the ACP session's `configOptions` (`category: "model"`), with a
  `--list-models` fallback.
- Native tool cards for the agent's own tools. A shell, read, edit, search, or fetch call the agent
  runs appears as the matching OpenCode tool card with the command/path, live status, and output.
  The calls are published as provider-executed parts, so OpenCode shows them but never runs them.
- Reasoning effort levels discovered from the agent's `effort` config option
  (`category: "thought_level"`), exposed as model variants: `#off`, `#low`, `#high`, `#max`.
  Picking a variant sends `reasoning_effort` to the shim, which calls
  `session/set_config_option` on the ACP session before prompting.
- Reused ACP sessions per OpenCode session, so the agent keeps its context between turns, across a
  failed or cancelled turn, and across a plugin reload or agent restart when the agent can restore
  sessions.
- Mid-turn steering: a message you send while the agent is working reaches the running turn through
  `_session/steering` when the agent supports it, and interrupts the turn to land next when it does
  not (see [Steering](#steering)).
- No custom OpenCode tools and no agent config. Normal models delegate through OpenCode's builtin
  `subagent` tool by passing an ACP model as its `model` override (see
  [Delegating to an ACP agent](#delegating-to-an-acp-agent)).
- An MCP bridge that gives ACP agents the OpenCode-owned tools they need to orchestrate and ask
  questions (see [OpenCode tools inside ACP agents](#opencode-tools-inside-acp-agents)).
- OpenCode's skills mirrored into each agent's own skill discovery, so agents load them with their
  native skill loader instead of a bridge tool (see [Skills](#skills)).

## Install

The plugin is a local package. Point OpenCode at the absolute path in your `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-acp",
      "options": {
        "logLevel": "info",
        "servers": [
          {
            "id": "cmd",
            "name": "Command Code (ACP)",
            "command": ["cmd", "acp"],
            "credential": "commandcode",
            "model": "deepseek/deepseek-v4.1-flash",
            "models": ["deepseek/deepseek-v4.1-flash"]
          }
        ]
      }
    }
  ]
}
```

Reload with `opencode reload`, then check the model list:

```sh
opencode models | grep '^acp-'
# acp-cmd/deepseek/deepseek-v4.1-flash
```

Run a turn through the ACP agent:

```sh
opencode run -m acp-cmd/deepseek/deepseek-v4.1-flash "Create hello.txt containing hello"
```

Add a variant to pick a reasoning effort for the turn:

```sh
opencode run -m acp-cmd/deepseek/deepseek-v4.1-flash#max "Prove the claim"
```

## Delegating to an ACP agent

The plugin adds no tools and needs no agent configuration. OpenCode's builtin `subagent` tool
accepts an optional `model` override, so a parent model can dispatch to the ACP model directly:

- `agent`: any available subagent type, e.g. `general` (supplies the child session's agent config).
- `model`: `acp-cmd/deepseek/deepseek-v4.1-flash`, or `acp-cmd/deepseek/deepseek-v4.1-flash#max`
  to pin a reasoning effort. The id is in the normal model list, so the `models` tool can look it up.

Each dispatch runs in its own OpenCode session, so it gets its own ACP session and context.

Optionally, if you want a dedicated subagent name for it, add one to `opencode.jsonc`:

```jsonc
{
  "agents": {
    "cmd": {
      "description": "Delegate a self-contained task to the Command Code ACP agent.",
      "mode": "subagent",
      "model": "acp-cmd/deepseek/deepseek-v4.1-flash"
    }
  }
}
```

Then the parent model can call `subagent` with `agent: "cmd"` and omit `model`. This is optional;
the `model` override works without it.

## OpenCode tools inside ACP agents

ACP agents keep their own tools (shell, edits, search, and so on). What they cannot have is
OpenCode's orchestration and UI layer. The plugin exposes that layer through a loopback MCP server
whose address is passed to the agent in `session/new`:

```text
ACP agent ──MCP (stdio or HTTP)──▶ plugin MCP endpoint ──▶ OpenCode tools/session APIs
```

Each ACP session gets its own bearer token, bound to the OpenCode session id and revoked when the
session closes. `tools/list` is scoped per session and only advertises tools that are actually
registered.

The MCP `initialize` response also carries a short instruction block naming the orchestration
tools by their server-relative names (`subagent`, `question`, and so on), so clients that surface
MCP server instructions know about them before their first tool call without assuming a
client-specific tool prefix.

The tools are 1:1 wrappers over OpenCode's own tools and session APIs:

| Tool | Wraps |
| --- | --- |
| `models` | OpenCode's `models` tool (search, variants, pagination) |
| `subagent` | builtin `subagent` (native child session; async with native `<subagent>` wake) |
| `question` | builtin `question` (native session form) |
| `todowrite` | builtin `todowrite` |
| `artifact_create` / `artifact_read` / `artifact_update` / `artifact_delete` | builtin artifact tools |
| `session_list` | `session.list` (requires a `session` permission for `*`) |
| `session_get` | `session.get` (defaults to the calling session) |
| `session_prompt` | `session.prompt` (`delivery: "steer"` joins a running turn; `"queue"` follows up) |
| `session_context` | `session.context` (defaults to the calling session; bounded to recent items) |
| `session_wait` | `session.wait` (timeout does not cancel the session) |
| `session_interrupt` | `session.interrupt` |

Subagents are real OpenCode child sessions, so they appear in the UI and can be navigated into. The
builtin tool registers the background work itself, so the ACP parent is woken by the normal
`<subagent>` message when the child goes idle. Passing `sessionID` back to `subagent` steers the
running child or starts a new run in it.

Calls to these bridge tools appear as console-style cards with a `mcp.<server>.<tool>` command, its
JSON arguments, and the result, because OpenCode's generic tool card has no detail view.

The wrapped builtin tools assert their own permissions (`subagent`, `question`, `todowrite`,
`artifact`). The `session_*` tools are normally client-only, so they assert a `session`
permission with the target session id as the resource. Reads default to the calling session; reading
another session, `session_wait`, `session_prompt`, and `session_interrupt` require permission for that
session id, and `session_list` asserts resource `*`:

```jsonc
{ "action": "session", "resource": "*", "effect": "allow" }
```

`todowrite` only appears when `experimental.todo` is enabled, and the artifact tools only when
`experimental.artifacts` is enabled; otherwise they are omitted from `tools/list`. ACP agents should
have their own subagent/task and ask-user tools disabled in the agent's configuration so
orchestration and questions route through OpenCode instead. See
[Disabling native orchestration tools](#disabling-native-orchestration-tools).

### Disabling native orchestration tools

ACP agents keep their own tools, including subagents and ask-user prompts. Disable those in the
agent's own configuration so delegation and questions route through the MCP bridge instead of a
second hidden agent loop.

| Server | What to disable | How |
| --- | --- | --- |
| Claude Code | `Task`, `AskUserQuestion` | `meta.claudeCode.options.disallowedTools` |
| Codex | native agents, request-user-input | `CODEX_CONFIG='{"agents":{"enabled":false},"tools":{"experimental_request_user_input":{"enabled":false}}}'` |
| Command Code (`cmd`) | `agent`, `agent_output`, `ask_user_question` | load a mod with `cmd acp --mod …` |

Claude Code:

```jsonc
{
  "id": "claude",
  "command": ["claude-agent-acp"],
  "meta": {
    "claudeCode": {
      "options": { "disallowedTools": ["Task", "AskUserQuestion"] }
    }
  }
}
```

Codex:

```jsonc
{
  "id": "codex",
  "command": ["codex-acp"],
  "env": {
    "CODEX_CONFIG": "{\"agents\":{\"enabled\":false},\"tools\":{\"experimental_request_user_input\":{\"enabled\":false}}}"
  }
}
```

Command Code has no equivalent setting key. Its docs mark the `agent` tool as always allowed, so a
`permissions.deny` rule cannot block it. Use the companion mod at
[`agents/cmd/no-native-orchestration.ts`](agents/cmd/no-native-orchestration.ts), which removes the tools from
the model's schema and refuses any call that still arrives:

```jsonc
{
  "id": "cmd",
  "name": "Command Code (ACP)",
  "command": [
    "cmd",
    "acp",
    "--mod",
    "/absolute/path/to/opencode-acp/agents/cmd/no-native-orchestration.ts"
  ]
}
```

`--mod` is a global `cmd` flag, accepted by `cmd acp` even though `cmd acp --help` does not list it.
The mod also removes `ask_user_question`, because ACP has no question method: leaving it enabled
makes `cmd acp` relay the question as a permission request instead of using OpenCode's question UI.
With it disabled the agent calls the MCP `question` tool. The mod filters only the active tool list,
so other `cmd` mods keep their tools, commands, and hooks. Verify with a prompt such as "call the
agent tool with subagent_type explore": the agent no
longer sees that tool and should report it as unavailable rather than delegating.

Companion files live under [`agents/`](agents/README.md), one directory per server id. Add a new
directory there when another agent needs a file of its own.

Transport defaults to stdio because ACP requires it and some adapters (notably `codex-acp`) drop
injected HTTP servers. The stdio entry runs `mcp-bridge.mjs` with `node` from `PATH`; set
`mcpRuntime` to use another runtime. Set `mcpTransport: "http"` for agents that reliably accept HTTP
MCP servers (`cmd acp` advertises it; Claude's adapter supports it).

## Skills

OpenCode skills are registered in OpenCode, not in the ACP agent. Instead of bridging
OpenCode's `skill` tool, the plugin copies OpenCode's own usable skills into a temporary directory
and gives that directory to the agent through ACP `session/new`'s `additionalDirectories`:

```text
<tmp>/opencode-acp-skills-*/
├── .agents/skills/<id>/SKILL.md   # Codex (and other .agents-compatible agents)
└── .claude/skills/<id>/SKILL.md   # Claude Code
```

Each agent reads the tree with its own skill loader, so skills keep their normal progressive
disclosure and supporting files. Directory-backed skills are copied with their `scripts/`,
`references/`, and `assets/`; built-in OpenCode skills (which have a virtual `skill://` path) are
written from their content. Skills without a description, skills with
`opencode/autoinvoke: false`, and IDs that are not portable lowercase kebab-case are skipped.
Skills already in `.agents/skills` or `.claude/skills` belong to the agents: they stay in place and
each agent keeps loading them natively, so the mirror does not copy them or move them between
conventions.

`cmd` ignores ACP `additionalDirectories`, and its `acp` subcommand accepts but does not apply the
global `--skill` flag. The plugin therefore appends a small mod
([`agents/cmd/opencode-skills.ts`](agents/cmd/opencode-skills.ts)) that registers the directory with
`cmd.addSkillsPath`, and also passes `--skill` for cmd builds that apply it. An explicit `--skill`,
`--no-skills`, or `--safe-mode` in the server command wins. Set `"skills": false` on a server to opt
out entirely.

To copy only specific OpenCode skills, set the plugin option to an allowlist:

```jsonc
{
  "skills": ["opencode"],
}
```

The skill mirror is built during plugin setup and removed on shutdown. Native delivery does not run
OpenCode's per-agent `skill` permission checks: a skill that OpenCode would hide from the current
agent can still be visible to the ACP agent. Use `permissions` on the agent, `"skills": false`, or
`autoinvoke: false` when that matters.

## Server options

| Option | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Required. Stable id. Becomes the provider id `acp-<id>`. |
| `name` | `string` | Provider display name. Defaults to `<id> (ACP)`. |
| `command` | `string \| string[]` | Required. Command that starts the ACP agent, e.g. `["cmd", "acp"]`. |
| `cwd` | `string` | Agent working directory. Defaults to the OpenCode location. |
| `env` | `object` | Extra environment variables for the agent process. |
| `credential` | `string` | OpenCode integration id whose saved credential is injected into the agent environment. |
| `credentialEnv` | `string` | Env var that receives the credential. Defaults to a known mapping (`commandcode` → `COMMAND_CODE_API_KEY`, `deepseek` → `DEEPSEEK_API_KEY`, …) or `<INTEGRATION>_API_KEY`. |
| `models` | `string[]` | Optional allowlist of ACP model ids to expose. Omit to expose every model the agent advertises. |
| `model` | `string` | Default ACP model for the server. |
| `effort` | `string` | Default ACP reasoning effort for sessions without a `#variant`. `cmd` accepts `off`, `low`, `high`, `max`, or `default`. Lower effort usually answers faster; `off` disables thinking entirely. Per-model variants override this. |
| `mode` | `string` | ACP session mode applied to pooled sessions, e.g. `auto-accept` or `plan`. |
| `meta` | `object` | ACP `_meta` passed to `session/new`. Claude Code reads `meta.claudeCode.options`, e.g. `{ "claudeCode": { "options": { "disallowedTools": ["Task"] } } }`. |
| `autoApprove` | `boolean` | Auto-approve real `session/request_permission` requests. Defaults to `true`. When `false`, each request is routed through OpenCode's permission prompt (action `acp_tool`); requests without an OpenCode session are denied. Question prompts that an agent encodes as a permission request are never auto-approved and are declined instead; native ask-user tools should be disabled so agents use the MCP `question` tool. |
| `skills` | `boolean` | Expose OpenCode's skills through this agent's native skill discovery. Defaults to `true`. See [Skills](#skills). |
| `disabled` | `boolean` | Skip the server without deleting its configuration. |

Plugin options:

| Option | Meaning |
| --- | --- |
| `logLevel` | `debug`, `info` (default), `warn`, or `error`. Debug logs also go to `$ACP_PLUGIN_LOG` (default `/tmp/opencode-acp.log`), which is truncated at 10 MB. |
| `includeSystem` | Include OpenCode's system message in the ACP prompt. Defaults to `false`; the ACP agent uses its own instructions. |
| `localTitles` | Answer session-title requests locally instead of spending an ACP turn. Defaults to `true`. |
| `historyTurns` | Turns of history replayed into a brand new ACP session. Defaults to `16`. |
| `historyChars` | Characters of history replayed into a brand new ACP session. Defaults to `8192`. The same cap applies to the recent conversation a `/compact` summary keeps. |
| `maxSessions` | Most reused ACP sessions kept alive per location. Defaults to `32`; the least recently used idle session is closed when the cap is reached. |
| `sessionIdleMs` | Idle time before a reused session is closed. Defaults to `1800000` (30 minutes). Set `0` to disable the sweep. |
| `allowPathsOutsideCwd` | Allow the agent's `fs/read_text_file` and `fs/write_text_file` calls outside the session directory. Defaults to `false`. |
| `maxFileBytes` | Largest file the client reads for the agent. Defaults to `16777216` (16 MB). |
| `maxBodyBytes` | Largest chat-completions body the shim accepts. Defaults to `33554432` (32 MB). |
| `outputLimit` | Output limit advertised for ACP models. Defaults to `32000`. |
| `initTimeoutMs` | How long one agent may take to initialize. Defaults to `20000`; a failed server is retried in the background, with each retry bounded by the same timeout. |
| `requestTimeoutMs` | Timeout for the ACP handshake and control calls such as `session/new`. Defaults to `15000`; raise it for agents that start slowly. |
| `promptTimeoutMs` | How long one ACP turn may run. Defaults to `1800000` (30 minutes); `0` disables the cap. |
| `toolCallDisplay` | `inline` (default) shows finished ACP tool calls as transcript lines; `off` hides them. ACP agents run tools in their own harness, so these are not native OpenCode tool cards. |
| `mcp` | Expose OpenCode tools to ACP agents through the MCP bridge. Defaults to `true`. |
| `skills` | Mirror OpenCode's own skills into the agents' native skill discovery. Defaults to `true`; `false` disables it, and an array such as `["opencode"]` is an allowlist of skill IDs. |
| `mcpTransport` | `stdio` (default) or `http`. Use `http` only for agents that accept injected HTTP MCP servers. |
| `mcpRuntime` | Runtime that executes the stdio bridge, e.g. `bun`. Defaults to `node` resolved through `PATH`. |

## Credentials

The plugin never stores keys. For a server with `credential: "commandcode"`, it resolves the active
`commandcode` account through OpenCode's integration API and passes it to the child as
`COMMAND_CODE_API_KEY`. Connect the account once in OpenCode (`/connect`), and `cmd acp` starts
authenticated.

If no credential is available, the agent still starts, but prompts fail with the agent's own auth
error.

## How it works

1. **Setup** spawns each agent, runs `initialize`, creates a throwaway session to read its model
   inventory, then registers a provider and its models.
2. **Provider models** use `@opencode/ai/providers/openai-compatible` pointed at a loopback HTTP shim
   started by the plugin. Each model carries a `modelID` of `<server>::<acp-model>` so requests route
   to the right agent even when two agents expose the same model id. The agent's effort levels become
   model variants whose `reasoningEffort` setting reaches the shim as `reasoning_effort`.
3. **Shim** turns an OpenAI chat-completions request into one `session/prompt`. Text deltas come from
   `session/update` → `agent_message_chunk` and reasoning from `agent_thought_chunk`; both are
   re-emitted as SSE chunks (`content` and `reasoning_content`). A request whose connection is reset
   before the response starts is retried, and closing the shim lets a turn that is already streaming
   finish first, so a plugin reload does not surface as `ECONNRESET` mid-turn.
4. **Sessions** are keyed by OpenCode's `x-opencode-session-id` header (falling back to
   `x-opencode-session`), model, and reasoning effort, created once and reused, with prompts
   serialized per session. The reuse decision is made inside the pool, so a retry after a failed turn
   cannot replay the wrong prompt. A failed or cancelled turn keeps the ACP session: the agent is
   asked to end the turn, and the next prompt continues the same context. Only a dead process or a
   session the agent no longer knows ends it. Session ids are also stored in OpenCode's plugin
   storage, so a new agent process reattaches with `session/resume` (or `session/load`) instead of
   starting over. Reused sessions receive only the newest user turn; a fresh session receives a short
   transcript (last 16 turns, capped at 8k characters by default) so a restarted agent still sees the
   conversation without replaying an unbounded history. Idle sessions are closed after 30 minutes and
   the pool is capped at 32.
5. **Titles** are answered locally instead of spending an ACP turn on session naming.
6. **Recovery** is automatic: if an agent process exits, the next turn restarts it and resumes the
   stored sessions. Every handshake, control call, and turn has a timeout, retries are bounded by
   `initTimeoutMs`, and a server that fails to start is retried in the background instead of
   disappearing from the model picker.
7. **Cancellation** is wired to the response connection: stopping a turn sends `session/cancel` to
   the agent and gives it a short grace period to finish.

### Steering

A message sent while the agent is working is a *steer*: OpenCode parks it in the session inbox and
delivers it at the next step boundary. An ACP turn is a single step however many tools the agent
runs, so the message would otherwise wait for the whole turn.

The plugin watches the prompt hook for those messages and asks the running ACP turn to take one:

- If the agent advertised `_meta.steering.supported` in `initialize`, the text goes to it through
  `_session/steering` and joins the turn in progress. The queued copy is then removed through the
  local HTTP API, so the message is not delivered a second time at the step boundary. Because the
  message is consumed inside the running turn rather than delivered as its own prompt, it does not
  appear as a separate user message in the transcript; the agent's answer arrives in the step that
  was already streaming.
- Otherwise the turn is interrupted with `session/cancel`. OpenCode then delivers the queued message
  as its own prompt at the step boundary, which resumes the same ACP session with the agent's
  context intact.

A steer only applies to a plain text message: one that carries files, or that names skills whose
content is expanded after the hook runs, keeps the normal delivery so the agent receives the full
prompt. The in-place path needs the local server's HTTP API (`~/.local/state/opencode/service.json`,
written by `serve --service`, which the CLI and desktop app use). If it is unavailable, the plugin
falls back to the interrupt path rather than risk delivering the message twice.

### Thinking blocks

ACP thought chunks are forwarded as `reasoning_content` and the provider sets
`compatibility.reasoningField = "reasoning_content"`, so OpenCode stores them as reasoning parts.
`opencode run --thinking` shows them. The TUI hides thinking blocks by default; bind the toggle:

```json title="~/.config/opencode/cli.json"
{
  "keybinds": {
    "session.toggle.thinking": "<leader>k"
  }
}
```

Press `<leader>k` (Ctrl+X then K by default) to show or hide them.

### Latency

Turn time is dominated by the ACP agent's own model latency and tool loop, not the plugin. The plugin
keeps fixed overhead to a few tens of milliseconds by reusing the ACP session, skipping title model
calls, and not replaying conversation history into a session that already has it. If replies are slow,
try `"effort": "low"` or `"off"` on the server, or a faster model tier exposed by the agent.

ACP models are registered with `capabilities.tools: false`: the ACP agent uses *its own* tools, which
is the point of delegating to it. OpenCode's built-in tools remain available to normal models, and
those models reach an ACP agent through the builtin `subagent` tool (see
[Delegating to an ACP agent](#delegating-to-an-acp-agent)).

## Notes and limits

- Text-only prompt content; images and resource blocks are not forwarded yet.
- Permission requests are auto-approved by default. With `autoApprove: false`, approval goes through
  OpenCode's permission prompt; paths outside the session directory are denied unless
  `allowPathsOutsideCwd` is set, even when the agent asks for permission.
- ACP has no question method. Native ask-user tools must be disabled in the agent's configuration
  so questions go through the MCP `question` tool. If an agent still encodes a question as a
  `session/request_permission` call whose options are the answer choices, it is recognised by its
  `rawInput.question` and declined rather than answered with the first option.
- The MCP `question` tool asks through the OpenCode server's HTTP form API when the plugin runs
  inside a `serve --service` server such as the desktop app. Forms created directly by the builtin
  tool have no location on their event, and the desktop client ignores those events; the HTTP route
  attaches the session location so the question dock appears. Default CLI servers fall back to the
  builtin question tool.
- Steering needs the agent to advertise `_meta.steering.supported` in `initialize` (codex-acp and
  claude-agent-acp do). Everything else is interrupted instead, so the message arrives at the next
  step boundary rather than mid-turn. In-place steering also needs the local server's HTTP API to
  drop the queued copy; without it the plugin interrupts instead of risking a duplicate.
- Plugin setup runs per OpenCode location, so each open location gets its own agent process and
  shim. Startup is bounded by `initTimeoutMs`, and a server that is not ready yet is retried in the
  background.
- The skills mirror is rebuilt when plugin setup runs. Skills installed or edited while OpenCode
  stays open reach the agent after a reload. Built-in skills with a virtual `skill://` path have no
  supporting files to copy; only their `SKILL.md` body is mirrored. Native discovery does not run
  OpenCode's `skill` permission checks.
- Agents that authenticate through ACP's `authenticate` method (OAuth-style) are not supported;
  credentials are injected through the environment instead.
- MCP subagents are bounded by OpenCode's `experimental.subagent_depth` (default `1`). Raise it if
  an ACP child must delegate further.
- `session_context` returns the most recent items up to roughly 60k characters and reports
  `truncated`/`omittedMessages`. `session_wait` accepts a timeout because `session.wait` has none;
  it defaults to 45s and is capped at 120s so a waiting turn cannot hang forever. Reads default to
  the calling session; other sessions need the `session` permission described above.
- The MCP server and the loopback chat shim are bearer-token protected; the shim token is generated
  per plugin instance and never written to the log.
- MCP-originated tool calls are executed through the registered tool's `execute`, so plugin
  `execute.before`/`execute.after` hooks do not observe them. The wrapped builtins assert their own
  permissions.
- Command Code's MCP client ignores `initialize` instructions. It relies on its own "Additional
  tools" list, which names the bridge tools once `tools/list` succeeds.
- The provider does not know per-token pricing, so models are registered with an empty cost list
  (pricing unknown, not free).
- No token usage is reported to OpenCode; unknown beats wrong. OpenCode reads a step's tokens both
  as context size (context ring, context tab, auto-compaction) and as spend (session totals,
  `stats`). Only one model call's usage fits both, and an ACP turn spans many model calls that the
  agents do not report one by one. The turn's sum overstates context; the agent's context reading
  understates spend and has no cache split. Agents also disagree on the numbers: codex-acp's
  `usage_update.used` is a session running total, Command Code's top-level `PromptResponse.usage`
  is session-cumulative (its turn is in `_meta.usage`), and Claude Code's cost on a subscription is
  the API-equivalent price. With `logLevel: "debug"`, each turn's raw usage and every
  `usage_update` (context size, window, cost) go to the debug log.
- ACP models advertise an unknown context window (`0`), so OpenCode never auto-compacts them.
  Each agent keeps the conversation in its reused ACP session and compacts it on its own.
- A manual `/compact` on an ACP model never runs OpenCode's summary turn, which would cost a full
  prompt that the agent never reads. A `compaction` hook sends the agent's own `/compact` to the
  session's open ACP session instead, when the agent advertises that command (Command Code and
  Claude Code do; Codex does not). It never opens a session just to compact it. The stored summary
  says what happened and keeps the recent conversation, capped by `historyTurns` and
  `historyChars`, so a new ACP session can still replay it.

## Develop

Files:

- `src/index.ts` — plugin entry, provider registration.
- `src/acp-client.ts` — ACP JSON-RPC client over stdio.
- `src/agent-command.ts` — reads an agent launch command: which executable it runs.
- `src/server-manager.ts` — agents, credentials, model discovery, session pooling.
- `src/skills.ts` — mirrors OpenCode's skills into the agents' native skill trees.
- `src/shim.ts` — OpenAI-compatible HTTP shim.
- `src/mcp-server.ts` — MCP endpoint, per-session tokens, tool wrappers.
- `src/mcp-bridge.mjs` — stdio-to-HTTP bridge for ACP agents that need stdio MCP.
- `src/debug.ts` — optional file log.

There is no build step: OpenCode loads the TypeScript entrypoint directly. Type-check the plugin
with `bun run typecheck` (or `../../node_modules/.bin/tsc --noEmit`) and run the tests with
`bun test` from this directory.
