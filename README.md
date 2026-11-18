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
- Model list discovered from the ACP session's model config option. An agent without a model
  selector exposes only `acp-<id>/default`, which leaves model selection to the agent.
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
- Title generation and other auxiliary model requests use disposable ACP sessions, so their
  instructions never enter the chat agent's conversation.
- A message you steer into a running turn interrupts it. OpenCode delivers the new message as the
  next turn in the same ACP session (see [Steering](#steering)).
- No custom OpenCode tools and no agent config. Normal models delegate through OpenCode's builtin
  `subagent` tool by passing an ACP model as its `model` override (see
  [Delegating to an ACP agent](#delegating-to-an-acp-agent)).
- An MCP bridge that gives ACP agents the OpenCode-owned tools they need to orchestrate and ask
  questions (see [OpenCode tools inside ACP agents](#opencode-tools-inside-acp-agents)).
- OpenCode's skills mirrored into each agent's own skill discovery, so agents load them with their
  native skill loader instead of a bridge tool (see [Skills](#skills)).
- The agents' own slash commands in OpenCode's palette, namespaced by server (see
  [Commands](#commands)).

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

### Installing agents automatically

A server can install or update its agent with `setup`. It runs once per OpenCode server process, before
that agent is first spawned; every location (including each worktree) reuses the same run, and
`opencode reload` reuses it too. Restarting the server runs it again.

```jsonc
{
  "servers": [
    { "id": "cmd", "setup": "vp add -g command-code@latest", "command": ["cmd", "acp"] },
    {
      "id": "claude",
      "setup": "vp add -g @agentclientprotocol/claude-agent-acp@latest",
      "command": ["claude-agent-acp"]
    },
    {
      "id": "codex",
      "setup": "vp add -g @agentclientprotocol/codex-acp@latest",
      "command": ["codex-acp"]
    },
    {
      "id": "agy",
      "setup": "agy update",
      "command": ["agy", "acp"]
    }
  ]
}
```

- The command runs through `sh -c` in the home directory, with the environment OpenCode inherited.
- Identical commands share one run for the whole server process, even across servers and locations;
  different commands run in parallel.
- A failure (non-zero exit, signal, or a timeout after five minutes) is logged with the end of its
  output, and the agent still starts with whatever is already installed, so an offline start works.
- Setup time is not counted against `initTimeoutMs`.
- Pin a version by naming it instead of `@latest`, e.g. `command-code@0.6.0`.
- The directory the command installs into must be on the `PATH` OpenCode inherits. A desktop app
  launched from the GUI may not see the shell's `PATH` entries; use an absolute path in `command`
  in that case.

### Antigravity (`agy`)

The Antigravity CLI ships its own ACP stdio server, so it needs no adapter package:

```jsonc
{
  "servers": [{ "id": "agy", "setup": "agy update", "command": ["agy", "acp"] }]
}
```

- **Model ids.** Discovery reads the session's `model` select, whose values are the base ids
  (`gemini-3.8-flash`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`).
  `agy models` prints combined ids with the thinking level appended (`gemini-3.8-flash-high`); the
  selector only lists the base ids, so use those.
- **Reasoning effort.** `agy` keeps effort out of the model id. Its `thought_level` select (`low`,
  `medium`, `high`) becomes the model variants, so `acp-agy/gemini-3.8-flash#high` sets it for the
  turn. There is no `off` variant.
- **Mode.** The session's `mode` select (`default`, `accept-edits`, `auto`, `plan`) is not a model
  variant; pin it with the server's `mode` option. Permission requests raised in `default` mode go
  through the normal `autoApprove` path.
- **Auth.** Sign in once with agy itself (`agy acp --login`, or export `GEMINI_API_KEY` and set
  `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json`). The plugin injects no
  credential and never calls the agent's ACP `authenticate` method, so agy's own stored login is what
  authenticates each session.
- **Skills.** `agy` loads `.agents/skills` from its workspace roots and `~/.gemini/config/skills`,
  so the skills mirror works without an agent-specific mod.
- **Native tools.** `agy` keeps its own subagent family (`invoke_subagent`, `define_subagent`,
  `manage_subagents`, `swarm`, `run_workflow`) and `ask_question` alongside the MCP bridge's
  `subagent` and `question`. ACP has no question method, so `ask_question` does not block: it prints
  the question into the turn and ends, which looks like a stalled prompt. The `permissions` block in
  agy's settings cannot gate these tools (it only covers `read_file`, `write_file`, `read_url`,
  `execute_url`, `command`, and `mcp`), so deny them by tool name in agy's hooks
  (`~/.gemini/config/hooks.json` for every workspace, or `<workspace>/.agents/hooks.json`) if you
  want delegation and questions to route through OpenCode:

  ```json
  {
    "opencode-orchestration": {
      "PreToolUse": [
        {
          "matcher": "ask_question|invoke_subagent|define_subagent|manage_subagents|swarm|run_workflow",
          "hooks": [
            {
              "command": "echo '{\"decision\":\"deny\",\"reason\":\"Use the OpenCode question and subagent tools instead.\"}'"
            }
          ]
        }
      ]
    }
  }
  ```

- **Compaction.** `agy` advertises `compact`, so `/compact` on an ACP model reaches its own
  compaction.

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
| `session_create` | `session.create`, then `session.prompt` when `prompt` is set (independent top-level session; requires a `session` permission for `*`) |
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

`session_create` is the counterpart for work the user wants in its own session: it creates a
top-level session (no parent, so no `<subagent>` wake) in the caller's directory unless `directory`
is given, with an optional `title`, `agent`, and `model` (`providerID/modelID#variant`), and sends
`prompt` as its first message.

Calls to these bridge tools appear as console-style cards with a `mcp.<server>.<tool>` command, its
JSON arguments, and the result, because OpenCode's generic tool card has no detail view.

The wrapped builtin tools assert their own permissions (`subagent`, `question`, `todowrite`,
`artifact`). The `session_*` tools are normally client-only, so they assert a `session`
permission with the target session id as the resource. Reads default to the calling session; reading
another session, `session_wait`, `session_prompt`, and `session_interrupt` require permission for that
session id, and `session_list` and `session_create` assert resource `*`:

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
| Command Code (`cmd`) | `agent`, `agent_output`, `ask_user_question` | automatic: the plugin loads a companion mod |
| Antigravity (`agy`) | `ask_question`, plus `invoke_subagent`, `define_subagent`, `manage_subagents`, `swarm`, `run_workflow` | a `PreToolUse` hook that denies those tool names (see [Antigravity](#antigravity-agy)) |

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
`permissions.deny` rule cannot block it. When the MCP bridge is enabled, the plugin appends
`--mod <path>` for the companion mod
[`src/agents/cmd/mods/no-native-orchestration.ts`](src/agents/cmd/mods/no-native-orchestration.ts) to any `cmd ... acp`
command, resolving the path from its own install location. The mod removes the tools from the
model's schema and refuses any call that still arrives. The server entry needs no `--mod`:

```jsonc
{ "id": "cmd", "name": "Command Code (ACP)", "command": ["cmd", "acp"] }
```

`--mod` is a global `cmd` flag, accepted by `cmd acp` even though `cmd acp --help` does not list it.
`--safe-mode` in the server command disables all mods, including this one.
The mod also removes `ask_user_question`, because ACP has no question method: leaving it enabled
makes `cmd acp` relay the question as a permission request instead of using OpenCode's question UI.
With it disabled the agent calls the MCP `question` tool. The mod filters only the active tool list,
so other `cmd` mods keep their tools, commands, and hooks. Verify with a prompt such as "call the
agent tool with subagent_type explore": the agent no
longer sees that tool and should report it as unavailable rather than delegating.

Agent-specific code and companion files live under [`src/agents/`](src/agents/README.md), one
directory per agent. Add a new directory there when another agent needs customization.

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
├── .agents/skills/<id>/SKILL.md   # Codex, Antigravity (and other .agents-compatible agents)
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
global `--skill` flag. The plugin therefore appends a companion mod, the same way it loads
[`no-native-orchestration.ts`](#disabling-native-orchestration-tools)
([`src/agents/cmd/mods/opencode-skills.ts`](src/agents/cmd/mods/opencode-skills.ts)), that registers the directory with
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

## Commands

Each ACP agent advertises its own slash commands through
`session/update → available_commands_update`. The plugin registers them in OpenCode's command
palette, namespaced by server id because commands belong to the agent rather than to one of its
models:

```text
/claude:code-review   Review the current diff, or a PR number/branch/path target…
/cmd:peek             Peek recap diagram: draw one for the last task now, or turn it on or off
/codex:review         Review the current diff
/agy:compact          Compact the conversation now (summarize history to free up the context window)
```

Arguments are passed through verbatim: `/claude:code-review 123 --fix` sends `/code-review 123
--fix` to the agent. ACP has no "run command" method — a slash command is prompt text the agent
intercepts — so the plugin forwards the text as the turn's prompt.

Commands are filtered and kept current:

- **Skills are skipped.** Agents raise their own skills to slash commands, so forwarding them would
  put a second copy of every OpenCode skill in the palette. A command is a skill when the agent marks
  it (`cmd` uses a `skill:` prefix, codex a `$` sigil) or when its description matches a skill in
  OpenCode's registry, ignoring the provenance suffix agents append (`(user)`, `(claude.ai sync)`).
  The registry is read on every rebuild because OpenCode discovers skills in the background.
- **The list is live.** The setup session supplies a first snapshot, and any later
  `available_commands_update` from a pooled session replaces it. A `skill.updated` event rebuilds
  the filter once skill discovery settles.
- **Commands are there from startup.** Agents start in the background, so their commands arrive
  after plugin setup. OpenCode 2.3 publishes a command change made after setup without a location,
  and clients (TUI, desktop, web) only refetch commands for a location-scoped update, so an open
  client would never see them. The plugin therefore stores each agent's last command list and
  registers it during setup, when OpenCode still publishes the change for the location. The agent's
  own list replaces it once the agent reports, at no cost when nothing changed.
- **The first run, and a list that changes, still lag in open clients.** Clients pick up the change
  when they reconnect or open the project again.
- **A command only runs on its own agent.** Command lists are per location, not per model, so all
  agents' commands are visible at once. Running one in a session that is on another provider fails
  with a message naming the agent to switch to, rather than sending text an agent cannot handle.

Set `"commands": false` in the plugin options to turn this off.

## Server options

| Option | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Required. Stable id. Becomes the provider id `acp-<id>`. |
| `name` | `string` | Provider display name. Defaults to `<id> (ACP)`. |
| `command` | `string \| string[]` | Required. Command that starts the ACP agent, e.g. `["cmd", "acp"]`. |
| `setup` | `string` | Shell command that installs or updates the agent before it is first spawned, e.g. `vp add -g command-code@latest`. Runs once per OpenCode server process, shared by every location. See [Installing agents automatically](#installing-agents-automatically). |
| `cwd` | `string` | Agent working directory. Defaults to the OpenCode location. |
| `env` | `object` | Extra environment variables for the agent process. |
| `credential` | `string` | OpenCode integration id whose saved credential is injected into the agent environment. |
| `credentialEnv` | `string` | Env var that receives the credential. Defaults to a known mapping (`commandcode` → `COMMAND_CODE_API_KEY`, `deepseek` → `DEEPSEEK_API_KEY`, …) or `<INTEGRATION>_API_KEY`. |
| `models` | `string[]` | Optional allowlist of model ids to expose. An agent without a model selector only exposes `default`. |
| `model` | `string` | Default ACP model for the server. If the agent has no ACP model selector, omit this or use `default`. |
| `effort` | `string` | Default ACP reasoning effort for sessions without a `#variant`. `cmd` accepts `off`, `low`, `high`, `max`, or `default`. Lower effort usually answers faster; `off` disables thinking entirely. Per-model variants override this. |
| `mode` | `string` | ACP session mode applied to pooled sessions, e.g. `auto-accept` or `plan`. |
| `meta` | `object` | ACP `_meta` passed to `session/new`. Claude Code reads `meta.claudeCode.options`, e.g. `{ "claudeCode": { "options": { "disallowedTools": ["Task"] } } }`. |
| `autoApprove` | `boolean` | Auto-approve real `session/request_permission` requests. Defaults to `true`. When `false`, each request is routed through OpenCode's permission prompt (action `acp_tool`); requests without an OpenCode session are denied. Question prompts that an agent encodes as a permission request are never auto-approved and are declined instead; native ask-user tools should be disabled so agents use the MCP `question` tool. |
| `skills` | `boolean` | Expose OpenCode's skills through this agent's native skill discovery. Defaults to `true`. See [Skills](#skills). |
| `disabled` | `boolean` | Skip the server without deleting its configuration. |

Plugin options:

| Option | Meaning |
| --- | --- |
| `logLevel` | `debug`, `info` (default), `warn`, or `error`. Debug logs also go to `$ACP_PLUGIN_LOG` (default `opencode-acp-<uid>.log` in the OS temp directory; an existing file that is a symlink or belongs to another user is refused), which is truncated at 10 MB. |
| `includeSystem` | Include OpenCode's system message in the ACP prompt. Defaults to `false`; the ACP agent uses its own instructions. |
| `historyTurns` | Turns of history replayed into a brand new ACP session. Defaults to `16`. |
| `historyChars` | Characters of history replayed into a brand new ACP session. Defaults to `8192`. The same cap applies to the recent conversation a `/compact` summary keeps. |
| `maxSessions` | Maximum pooled ACP sessions per location, including sessions still opening. Defaults to `32`. At capacity the least recently used idle session is closed; if none is idle, a new conversation must retry after a turn finishes. Existing conversations can keep using their slots. |
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
| `commands` | Register the agents' own slash commands as namespaced OpenCode commands. Defaults to `true`. See [Commands](#commands). |
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

Remote MCP servers configured in OpenCode are forwarded to every ACP agent. When OpenCode holds an
OAuth sign-in for one, the plugin resolves the active grant and passes it to the agent as an
`Authorization: Bearer` header on `session/new`, so the agent reuses the same login. OpenCode
refreshes an expired grant while resolving it. A header set explicitly in the server's `headers`
wins. A server that is not signed in to OpenCode still starts, but its tools stay unavailable; run
`opencode mcp auth <name>` (or sign in through the agent's own CLI) and the next session picks the
credential up.

ACP cannot update MCP headers on a live session, so a grant that expires during a long-lived pooled
session is not replaced until that session is recycled or a new conversation starts. The token is
also visible to the agent in `session/new`; an agent that persists its session state will store it.

## How it works

1. **Setup** registers each agent's provider from the inventory its last discovery cached in plugin
   storage, then starts discovery in the background. Discovery runs `initialize`, creates a throwaway
   session to read the model inventory, and refreshes the registered models and the cache. A location
   therefore has its models immediately — a fresh worktree included — without waiting for agents whose
   inventory is already known; the first run of a new agent config still registers when it answers.
   If a refreshed agent no longer offers a model, a turn that asks for it fails with the agent's own
   error rather than an unavailable-model error from OpenCode.
2. **Provider models** use the plugin's AI SDK adapter or the OpenAI-compatible fallback, both pointed
   at a loopback HTTP shim. Each model carries a `modelID` of `<server>::<acp-model>` so requests route
   to the right agent even when two agents expose the same model id. The agent's effort levels become
   model variants whose `reasoningEffort` setting reaches the shim as `reasoning_effort`.
3. **Shim** turns an OpenAI chat-completions request into one `session/prompt`. Text deltas come from
   `session/update` → `agent_message_chunk` and reasoning from `agent_thought_chunk`; both are
   re-emitted as SSE chunks (`content` and `reasoning_content`). ACP failures are stream errors, not
   assistant messages. A request whose connection is reset
   before the response starts is retried, and closing the shim lets a turn that is already streaming
   finish first, so a plugin reload does not surface as `ECONNRESET` mid-turn.
4. **Sessions** are keyed by OpenCode's `x-opencode-session-id` header (falling back to
   `x-opencode-session`) and working directory, created once and reused, with prompts serialized per
   session. Model and reasoning effort are settings on that session, not part of its key: a turn that
   asks for a different value changes the existing session before its prompt, so switching variants
   keeps the agent's context. The change and the prompt share the session queue, so concurrent turns
   cannot change each other's model. A turn that asks for the provider default opens a fresh session
   when the previous turn had an explicit value, since many agents cannot reset a live selection. The
   same fallback applies when an agent refuses a live change; history is then replayed into the new
   session. The reuse decision is made inside the pool, so a retry after a failed turn cannot replay
   the wrong prompt. An isolated failure or cancellation normally keeps the ACP session so the
   next prompt continues in the same context. Session ids are also stored in OpenCode's plugin storage, so a new agent
   process reattaches with `session/resume` (or `session/load`) instead of starting over. Reused
   sessions receive only the newest turn; a fresh session also receives bounded replay (last 16
   turns, capped at 8k characters by default). OpenCode's request is trimmed before it crosses the
   shim. Idle sessions are closed after 30 minutes and the session pool is capped at 32 by default.
5. **Titles** use OpenCode's default title behavior rather than a plugin-specific path.
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

The plugin sends `session/cancel` to the running turn and lets OpenCode deliver the queued message
at the next step boundary. OpenCode owns the message throughout, including attachment and skill
resolution. The next prompt uses the same ACP conversation. The plugin does not inject the
message before OpenCode has queued it, which could deliver it twice.

If the ACP session is still being negotiated, the plugin cancels its prompt as soon as it starts.
A brief, bounded lookup through the local OpenCode service can also detect a turn that has not yet
reached the shim. If that lookup fails, OpenCode admits the message normally.

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

A first request can still wait for its own agent to initialize. Later turns reuse its ACP session
and send only the new message, without replaying conversation history. Model generation and tool
work can also take time; use `"effort": "low"` or `"off"`, or a faster model tier, if appropriate.

Control requests taking at least a second and turns taking at least five seconds produce timing
warnings. The turn warning includes time to first text and first thought, without logging prompt
content. Use these to distinguish cold agent startup from a slow model response.

To measure the complete request path, run:

```sh
python3 scripts/latency.py acp-cmd/deepseek/deepseek-v4.1-flash 3
```

This creates diagnostic sessions with and without automatic titles. It reports admission and
end-to-idle times, and excludes empty replies and ACP errors from successful latency statistics.
Model latency varies, so compare successful runs on the same machine and model.

If an agent repeatedly exits with native signals such as `SIGSEGV` or `SIGBUS`, retries can dominate
the wait. Check its runtime outside OpenCode too. For Command Code, a launch such as
`["bun", "/absolute/path/to/node_modules/command-code/dist/index.mjs", "acp"]` is recognized by the
plugin and retains skill injection. `mcpRuntime: "bun"` also avoids starting Node for each stdio
bridge. These are runtime workarounds, not substitutes for fixing the crashing agent/runtime.

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
- A command list is per location, not per selected model, so every configured agent's commands are
  visible at once. There is no hook to scope a command to a model; picking the wrong one fails the
  run with a message naming the right agent. Filtering skills by description only removes commands
  whose text matches a registered skill, so an agent's own bundled skill under a different
  description survives unless the agent marks it (codex's `$`, cmd's `skill:`).
- Plugin setup runs per OpenCode location, so each open location gets its own agent processes and
  shim. Each provider is registered from the cached inventory, so models are selectable immediately;
  agents start in parallel in the background and refresh both the models and the cache.
  `initTimeoutMs` bounds each discovery attempt, not OpenCode startup. The cache is keyed by the
  server's command, environment, credential, and model allowlist, shared across locations, and
  replaced on every successful discovery.
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
- `src/setup.ts` — runs a server's install/update command once before its agent starts.
- `src/server-manager.ts` — agents, credentials, model discovery, session pooling.
- `src/inventory.ts` — caches each agent's last model inventory per server config.
- `src/skills.ts` — mirrors OpenCode's skills into the agents' native skill trees.
- `src/agents/` — per-agent customization; `src/agents/cmd/` adds Command Code mods to `cmd acp`.
- `src/commands.ts` — exposes each agent's slash commands as namespaced OpenCode commands.
- `src/shim.ts` — OpenAI-compatible HTTP shim.
- `src/prompt.ts` — bounds transcript replay before transport and builds the ACP prompt.
- `src/mcp-server.ts` — MCP endpoint, per-session tokens, tool wrappers.
- `src/mcp-bridge.mjs` — stdio-to-HTTP bridge for ACP agents that need stdio MCP.
- `src/debug.ts` — optional file log.

There is no build step: OpenCode loads the TypeScript entrypoint directly. Type-check the plugin
with `bun run typecheck` (or `../../node_modules/.bin/tsc --noEmit`) and run the tests with
`bun test` from this directory.
