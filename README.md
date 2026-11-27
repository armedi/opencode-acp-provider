# opencode-acp-provider

An OpenCode plugin that makes OpenCode an **Agent Client Protocol (ACP) client**. It starts ACP
agents such as Antigravity (`agy acp`) over stdio and registers each as a provider, so selecting one
of its models routes the turn to that agent, which runs with its own harness and tools while
OpenCode provides the session, history, and UI.

```text
OpenCode session ──▶ ACP language model ──▶ chat shim ──▶ ACP client (JSON-RPC/stdio) ──▶ agy acp
```

## Install

```sh
opencode plugin add opencode-acp-provider
```

Or configure it directly:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-acp-provider",
      "options": {
        "logLevel": "info",
        "servers": [
          {
            "id": "agy",
            "name": "Antigravity (ACP)",
            "command": ["agy", "acp", "--process-per-session"]
          }
        ]
      }
    }
  ]
}
```

`opencode reload`, then `opencode models | grep '^acp-'` should list `acp-agy/<model>` entries. Run
a turn with `opencode run -m acp-agy/<model> "..."`; add `#high` to pick a reasoning effort.

## setup

A server runs one shell command before its agent is first spawned. It is not specific to
installation: use it to install or update the agent, log in, prepare a config, or seed files. It runs
once per OpenCode server process; every location (including each worktree) and `opencode reload`
reuses the run, and a server restart runs it again.

```jsonc
{
  "servers": [
    {
      "id": "agy",
      // any command works, e.g. `agy update` or preparing a config file the agent reads at startup
      "setup": "agy update",
      "command": ["agy", "acp", "--process-per-session"]
    }
  ]
}
```

- Runs through `sh -c` in the home directory with OpenCode's environment.
- Identical commands share one run across the whole server process, even across locations; different
  commands run in parallel.
- A failure (non-zero exit, signal, or a timeout after five minutes) is logged with the end of its
  output and the agent still starts, so the command is never a hard dependency and an offline start
  works.
- Not counted against `initTimeoutMs`.
- An installed program must land on the `PATH` OpenCode inherits. A desktop app launched from the GUI
  may not see the shell's `PATH`; use an absolute path in `command` then.

## Agents

Tested with the plugin. Each needs its launch command plus the agent-specific setting below; every
other section applies to all of them. Disabling an agent's own subagent and ask-user tools routes
delegation and questions through the MCP bridge instead of a second hidden agent loop.

| Server | Command | Auth | Native orchestration tools |
| --- | --- | --- | --- |
| Antigravity (`agy`) | `["agy", "acp", "--process-per-session"]` | `agy acp --login` or `GEMINI_API_KEY` | `PreToolUse` hook |
| Claude Code (`claude`) | `["claude-agent-acp"]` | adapter's own login | `meta.claudeCode.options.disallowedTools` |
| Codex (`codex`) | `["codex-acp"]` | adapter's own login | `CODEX_CONFIG` env |
| Command Code (`cmd`) | `["cmd", "acp"]` | sign in with `cmd` itself | companion mod (automatic) |

### Antigravity (`agy`)

Ships its own ACP stdio server, so it needs no adapter package:

```jsonc
{
  "servers": [{ "id": "agy", "setup": "agy update", "command": ["agy", "acp", "--process-per-session"] }]
}
```

- **Session isolation.** `--process-per-session` isolates each session's worker process so the
  `opencode` MCP server keeps its name across sessions (and is required for injected HTTP MCP
  servers).

- **Model ids.** The session's `model` select lists base ids without the thinking level, while
  `agy models` appends it (`<model>-high`). Use the base ids the selector lists.
- **Reasoning effort.** Effort is not part of the model id: its `thought_level` select becomes the
  model variants, so `acp-agy/<base-id>#high` sets it. The levels differ per model (some add
  `xhigh`), and the orchestrator models offer none, so they show no variants and no effort is
  sent. A model's own levels replace the default model's list once it is first selected, and are
  cached. There is no `off` variant.
- **Mode.** Its `mode` select (`default`, `accept-edits`, `auto`, `plan`) is not a variant; pin it
  with the server's `mode` option. Permission requests in `default` mode go through `autoApprove`.
- **Native tools.** `agy` keeps `ask_question` plus its own subagent family (`invoke_subagent`,
  `define_subagent`, `manage_subagents`, `swarm`, `run_workflow`). ACP has no question method, so
  `ask_question` prints the question into the turn and ends, which looks like a stalled prompt.
  `send_message` only talks to its native subagents, and `schedule` timers die with idle sessions. Its
  `permissions` block cannot gate these (it covers only `read_file`, `write_file`, `read_url`,
  `execute_url`, `command`, and `mcp`), so deny them by tool name in `~/.gemini/config/hooks.json`
  (every workspace) or `<workspace>/.agents/hooks.json`:

  ```json
  {
    "opencode-orchestration": {
      "PreToolUse": [
        {
          "matcher": "ask_question|invoke_subagent|define_subagent|manage_subagents|swarm|run_workflow|send_message|schedule",
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

### Claude Code (`claude`)

```jsonc
{
  "id": "claude",
  "command": ["claude-agent-acp"],
  "meta": {
    "claudeCode": {
      "options": {
        "disallowedTools": [
          "Task", "AskUserQuestion",
          "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
          "ListAgents", "SendMessage",
          "CronCreate", "CronDelete", "CronList", "ScheduleWakeup",
          "PushNotification", "RemoteTrigger", "SendToProject", "SendToProjectContext", "DesignSync"
        ]
      }
    }
  }
}
```

Beyond subagents and questions, this list drops tools that do nothing useful under an ACP host:
plan mode (approval turns into an auto-approved permission request; use OpenCode's plan agent),
native worktrees (edits move out of OpenCode's snapshots; use `worktree_create`), peer-session
messaging, scheduling (idle sessions and processes close, so schedules die silently, and a firing
one starts a turn nobody sent), and Claude app features (push notifications, remote triggers,
projects, design sync). claude.ai connectors stay available.

The adapter accepts injected HTTP MCP servers, so `mcpTransport: "http"` works.

### Codex (`codex`)

```jsonc
{
  "id": "codex",
  "command": ["codex-acp"],
  "env": {
    "CODEX_CONFIG": "{\"agents\":{\"enabled\":false},\"tools\":{\"experimental_request_user_input\":{\"enabled\":false}},\"features\":{\"goals\":false,\"tool_suggest\":false,\"image_generation\":false}}"
  }
}
```

`features` turns off Codex goals (use OpenCode's goal loop), plugin-install suggestions, and image
generation (the plugin forwards text only). To drop individual ChatGPT apps, add
`"apps":{"<connector_id>":{"enabled":false}}`; the ids are in
`~/.codex/cache/codex_apps_tools/*.json` (`connector_id`).

Codex drops injected HTTP MCP servers, so keep the stdio transport. It does not advertise `/compact`,
so a manual `/compact` reports that it cannot compact on request.

### Command Code (`cmd`)

```jsonc
{ "id": "cmd", "name": "Command Code (ACP)", "command": ["cmd", "acp"] }
```

- **Auth.** Sign in with `cmd` itself; the plugin injects no credential. Use `env` to pass a key the
  agent reads, e.g. `{ "COMMAND_CODE_API_KEY": "..." }`.
- **Skills and native tools.** Handled by companion mods, automatically: `cmd` ignores ACP
  `additionalDirectories` and never applies the global `--skill` flag, and its docs mark `agent` as
  always allowed so `permissions.deny` cannot block it. With the MCP bridge on, the plugin appends
  `--mod` for [`no-native-orchestration.ts`](src/agents/cmd/mods/no-native-orchestration.ts) and
  [`opencode-skills.ts`](src/agents/cmd/mods/opencode-skills.ts), resolved from its own install
  location; `--safe-mode` disables all mods. The server entry needs no `--mod` and other `cmd` mods
  keep their tools. Verify by asking the agent to call its `agent` tool: it should report the tool as
  unavailable instead of delegating.
- **Runtime.** A launch such as
  `["bun", "/absolute/path/to/node_modules/command-code/dist/index.mjs", "acp"]` is recognized and
  keeps skill injection; use it if the agent repeatedly exits with native signals such as `SIGSEGV`.

Agent-specific code and companion files live under [`src/agents/`](src/agents/README.md).

## OpenCode tools inside ACP agents

ACP agents keep their own tools; what they lack is OpenCode's orchestration and UI layer. The plugin
serves that layer from a loopback MCP endpoint, passed to the agent in `session/new`, with one bearer
token per ACP session. Every tool is a 1:1 wrapper:

| Tool | Wraps |
| --- | --- |
| `models` | OpenCode's `models` tool (search, variants, pagination) |
| `subagent` | builtin `subagent` (native child session; async with native `<subagent>` wake) |
| `subagent_list` | List available OpenCode subagents with IDs and descriptions on demand |
| `question` | builtin `question` (native session form) |
| `todowrite` | builtin `todowrite` (only with `experimental.todo`) |
| `session_create` | `session.create`, then `session.prompt` when `prompt` is set (independent top-level session) |
| `session_list` | `session.list` |
| `session_get` | `session.get` (defaults to the calling session) |
| `session_prompt` | `session.prompt` (`delivery: "steer"` joins a running turn; `"queue"` follows up) |
| `session_context` | `session.context` (defaults to the calling session; bounded to recent items) |
| `session_wait` | `session.wait` (timeout does not cancel the session) |
| `session_interrupt` | `session.interrupt` |
| `worktree_create` | `worktree.create` for the calling session's project (returns the actual directory) |
| `worktree_remove` | `worktree.remove` |

The wrapped builtins (`subagent`, `question`, `todowrite`) assert their own permissions. The
`session_*` tools are normally client-only, so they assert a `session` permission on the target id:
reads default to the calling session, while reading another session, `session_wait`, `session_prompt`,
and `session_interrupt` need permission for that id, and `session_list` and `session_create` assert
resource `*`:

```jsonc
{ "action": "session", "resource": "*", "effect": "allow" }
```

`worktree_create` asserts a `worktree` permission on resource `*`, and `worktree_remove` on the worktree directory:

```jsonc
{ "action": "worktree", "resource": "*", "effect": "allow" }
```

MCP transport defaults to stdio, which runs `mcp-bridge.mjs` with `node` from `PATH`; set
`mcpRuntime` for another runtime, or `mcpTransport: "http"` for an agent that accepts injected HTTP
servers.

## Skills

OpenCode registers skills in its own registry, out of reach of the ACP agent. Rather than bridging
OpenCode's `skill` tool, the plugin copies the usable skills into a temp directory and passes it to
the agent in `session/new`'s `additionalDirectories`, so the agent reads them with its own loader:

```text
<tmp>/opencode-acp-provider-skills-*/
└── .agents/skills/<id>/SKILL.md   # Antigravity and other .agents-compatible agents
```

Skills already living in `.agents/skills` belong to the agent and stay put.
Skipped: no description, `opencode/autoinvoke: false`, or an ID not portable lowercase kebab-case.
`"skills": false` on a server entry opts that server out; `"skills": ["opencode"]` at the plugin level allowlists specific skill IDs.

Native delivery runs no per-agent `skill` permission check, so a skill OpenCode hides from the current
agent can still reach the ACP agent: use `permissions` on the agent, `"skills": false`, or
`autoinvoke: false` where that matters. The mirror is rebuilt on plugin setup, so skills edited while
OpenCode stays open reach the agent after a reload.

## Commands

Agents advertise slash commands via `session/update → available_commands_update`; the plugin registers
them in OpenCode's palette namespaced by server id, because a command belongs to the agent, not to one
of its models:

```text
/agy:compact          Compact the conversation now (summarize history to free up the context window)
```

Arguments pass through verbatim: `/agy:compact focus on the migration` sends
`/compact focus on the migration` as the turn's prompt. Skills are skipped, since agents raise their
own skills as commands and forwarding them would duplicate every OpenCode skill. A command list is
per location, not per model, so all agents' commands are visible at once; running one on the wrong
provider fails with a message naming the agent to switch to. Set `"commands": false` to turn this
off.

## Agent processes

One process per agent is shared by every OpenCode directory (Antigravity and any agent that takes
the session `cwd`), so opening another directory does not start them again. Shared processes start
in the home directory (or `cwd`), and each session uses its own directory. After the last directory
releases an agent it keeps running for 60 s, so a reload reuses it. During a reload, a conversation
that the old plugin instance is still running is handed to the new one when its turn ends. Set
`"share": false` for an agent that serves one directory per process.

Model discovery runs once per agent configuration per OpenCode service process. Per-model
variants are learned on first selection and shared across locations and plugin reloads.
Restarting the service refreshes discovery. Slash commands are still discovered per location.

## Server options

| Option | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Required. Stable id. Becomes the provider id `acp-<id>`. |
| `name` | `string` | Provider display name. Defaults to `<id> (ACP)`. |
| `command` | `string \| string[]` | Required. Command that starts the ACP agent, e.g. `["agy", "acp", "--process-per-session"]`. |
| `setup` | `string` | Shell command run once before the agent is first spawned. See [setup](#setup). |
| `cwd` | `string` | Working directory for the agent process and its sessions. When unset, sessions use the OpenCode location, and the process starts in the home directory if it is shared across directories (else in the OpenCode location). |
| `env` | `object` | Extra environment variables for the agent process, including any API key the agent reads. |
| `share` | `boolean` | Share one agent process across OpenCode directories. Defaults to `true`. Set `false` for an agent that serves one directory per process. See [Agent processes](#agent-processes). |
| `models` | `string[]` | Optional allowlist of model ids to expose. An agent without a model selector only exposes `default`. |
| `model` | `string` | Default ACP model for the server. If the agent has no ACP model selector, omit this or use `default`. |
| `effort` | `string` | Default ACP reasoning effort for sessions without a `#variant`, e.g. `low`, `medium`, or `high`. Per-model variants override this. |
| `mode` | `string` | ACP session mode applied to pooled sessions, e.g. `accept-edits`, `auto`, or `plan`. |
| `meta` | `object` | ACP `_meta` passed to `session/new`. |
| `autoApprove` | `boolean` | Auto-approve `session/request_permission` requests. Defaults to `true`. When `false`, each request goes through OpenCode's permission prompt (action `acp_tool`) and requests without an OpenCode session are denied. A question encoded as a permission request is never auto-approved and is declined instead. |
| `skills` | `boolean` | Expose OpenCode's skills through this agent's native skill discovery. Defaults to `true`. See [Skills](#skills). |
| `disabled` | `boolean` | Skip the server without deleting its configuration. |

## Plugin options

| Option | Meaning |
| --- | --- |
| `logLevel` | `debug`, `info` (default), `warn`, or `error`. Debug logs also go to `$OPENCODE_ACP_PROVIDER_LOG` (default `opencode-acp-provider-<uid>.log` in the OS temp directory, truncated at 10 MB). |
| `includeSystem` | Include OpenCode's system message in the ACP prompt. Defaults to `false`; the agent uses its own instructions. Either way, the `<system-*>` blocks OpenCode puts in user messages (such as `<system-reminder>` and `<system-update>`) are always removed before the prompt reaches the agent. |
| `historyTurns` | Turns of history replayed into a brand new ACP session. Defaults to `16`. |
| `historyChars` | Characters of history replayed into a brand new ACP session. Defaults to `8192`. Also caps the recent conversation a `/compact` summary keeps. |
| `maxSessions` | Pooled ACP sessions per location, including opening ones. Defaults to `32`. At capacity the least recently used idle session closes; if none is idle, a new conversation retries after a turn finishes. |
| `sessionIdleMs` | Idle time before a reused session closes. Defaults to `1800000` (30 minutes); `0` disables the sweep. |
| `allowPathsOutsideCwd` | Allow the agent's `fs/read_text_file` and `fs/write_text_file` outside the session directory. Defaults to `false`. |
| `maxFileBytes` | Largest file the client reads for the agent. Defaults to `16777216` (16 MB). |
| `maxBodyBytes` | Largest chat-completions body the shim accepts. Defaults to `33554432` (32 MB). |
| `outputLimit` | Output limit advertised for ACP models. Defaults to `32000`. |
| `initTimeoutMs` | How long one agent may take to initialize. Defaults to `20000`; a failed server is retried in the background under the same bound. |
| `requestTimeoutMs` | Timeout for the ACP handshake and control calls such as `session/new`. Defaults to `15000`; raise it for agents that start slowly. |
| `promptTimeoutMs` | How long one ACP turn may run, and how long a session stays busy waiting for a command the agent left running in the background. Defaults to `1800000` (30 minutes); `0` disables the cap. |
| `toolCallDisplay` | `inline` (default) shows finished ACP tool calls as transcript lines on the fallback chat-completions route when OpenCode cannot render native tool cards; `off` hides them. |
| `mcp` | Expose OpenCode tools to ACP agents through the MCP bridge. Defaults to `true`. |
| `commands` | Register the agents' own slash commands as namespaced OpenCode commands. Defaults to `true`. See [Commands](#commands). |
| `skills` | Mirror OpenCode's skills into the agents' native skill discovery. Defaults to `true`; `false` disables it, and an array such as `["opencode"]` is an allowlist. |
| `mcpTransport` | `stdio` (default) or `http`. Use `http` only for an agent that accepts injected HTTP MCP servers. |
| `mcpRuntime` | Runtime that executes the stdio bridge, e.g. `bun`. Defaults to `node` from `PATH`. |

## Sign-ins and external MCP servers

Each agent signs in on its own; the plugin holds no credentials for it. To pass an agent a key, set
it in that server's `env`.

In `session/new`, the plugin only supplies its own `opencode` MCP bridge; it does not forward
OpenCode's external MCP servers. Configure any additional MCP servers directly in the agent's own
MCP configuration (for example, `agy mcp add` / `~/.gemini/config/mcp_config.json`) so the agent
handles its own credentials and tool loading (such as Antigravity's native lazy loading).

## Limits

- Text-only prompt content; images and resource blocks are not forwarded yet.
- ACP's `authenticate` method (OAuth-style sign-in) is unsupported, so an agent must be signed in
  before OpenCode starts it (e.g. its own `--login`, or a key in `env`).
- MCP subagents are bounded by OpenCode's `experimental.subagent_depth` (default `1`); raise it for
  deeper delegation.
- `session_context` returns up to roughly 60k characters; `session_wait` defaults to 45s and caps at
  120s.
- ACP models advertise an unknown context window, so OpenCode never auto-compacts them; each agent
  compacts its own reused session. A manual `/compact` never runs OpenCode's summary turn.
- No token usage is reported and models register with an empty cost list, so OpenCode shows no
  pricing or spend for them.
