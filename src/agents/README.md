# Agent-specific customization

Some ACP agents need changes that an ACP client cannot make over the protocol. A common case is
hiding a native orchestration tool that would otherwise compete with OpenCode's own `subagent` and
`question` tools. Everything specific to one agent lives here, one directory per agent:

```text
src/agents/
├── cmd/
│   ├── index.ts                         # plugin side: adds the mods to `cmd acp` launches
│   └── mods/                            # loaded by cmd itself, not by the plugin
│       ├── no-native-orchestration.ts
│       └── opencode-skills.ts
└── <agent>/
    ├── index.ts                # plugin code that customizes how this agent is launched or driven
    └── mods/                   # companion files the agent loads with its own runtime
        └── <capability>.ts     # name the file after the behavior it changes
```

## Conventions

- Name the directory after the agent (`cmd`, `claude`, `codex`, …), matching the usual server `id`.
- `index.ts` is plugin code and may import from the rest of `src/`. The rest of the plugin imports
  the agent's customization from there.
- Files in `mods/` must be standalone: no imports from `src/`, because the agent loads them with its
  own runtime and API. `tsconfig.json` excludes `src/agents/*/mods/**`, since their types come from
  the agent's own packages.
- The file name describes the behavior, not the agent: `no-native-orchestration.ts`.
- Document how the agent loads the file (CLI flag, env var, config key) in a comment at the top of
  the file and in this README.

## Command Code (`cmd`)

### `no-native-orchestration.ts`

Removes the native `agent`, `agent_output`, and `ask_user_question`
tools from the main loop. Command Code's permission rules cannot block the `agent` tool (its docs
mark it as always allowed), so the mod uses `cmd.setActiveTools` to remove it from the model's schema
and `beforeToolCall` to refuse any call that still arrives.

It filters from `cmd.getActiveTools()` rather than `cmd.getAllTools()`, so it only removes the listed
tools. Tools another mod disabled stay disabled, and tools another mod added stay active.
`setActiveTools` filters the tool surface only: other mods' commands, hooks, providers, renderers,
and UI are untouched. If some later mod re-enables `agent`, `beforeToolCall` still blocks the call.

The plugin loads it automatically whenever the MCP bridge is enabled: `cmd/index.ts` appends
`--mod <path>` to any `cmd ... acp` command, with the path resolved from the package's install
location. Do not list it in `opencode.jsonc`. `--mod` is a global `cmd` flag that `cmd acp` accepts
even though `cmd acp --help` does not list it; `--safe-mode` disables all mods.

The mod also removes `ask_user_question`, because ACP has no question method: leaving it enabled
makes `cmd acp` relay the question as a permission request instead of using OpenCode's question UI.
With it disabled the agent calls the MCP `question` tool. Verify with a prompt such as "call the
agent tool with subagent_type explore": the agent no
longer sees that tool and should report it as unavailable rather than delegating.

### `opencode-skills.ts`

`cmd acp` accepts the global `--skill` flag but its ACP action never applies it; only the interactive
and print paths call `setSkillLoadOverrides`. Mods are loaded on the ACP path, and
`cmd.addSkillsPath` feeds the same skill discovery plan. This mod reads
`OPENCODE_ACP_PROVIDER_SKILL_DIR` and registers it. The plugin sets the env var and loads the mod through
`cmd/index.ts`, like `no-native-orchestration.ts`; `--safe-mode` disables it like any other mod.
