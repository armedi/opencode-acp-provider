# Agent companion files

Some ACP agents need a file of their own to change behavior that an ACP client cannot control over
the protocol. A common case is hiding a native orchestration tool that would otherwise compete with
OpenCode's own `subagent` and `question` tools.

One directory per OpenCode `servers[].id`:

```text
agents/
├── cmd/
│   ├── no-native-orchestration.ts   # loaded by the plugin (src/cmd-mods.ts)
│   └── opencode-skills.ts           # loaded by the plugin (src/cmd-mods.ts)
└── <id>/                       # one directory per server id
    └── <capability>.ts         # name the file after the behavior it changes
```

## Conventions

- The directory name matches the `id` in `opencode.jsonc` (`cmd`, `claude`, `codex`, …).
- The file name describes the behavior, not the agent: `no-native-orchestration.ts`.
- Keep each companion file standalone. It must not import from `src/`; the agent loads it with its
  own runtime and API.
- Document how the agent loads the file (CLI flag, env var, config key) in a comment at the top of
  the file and in the README section that references it.
- If an agent needs more than one file, keep them in the same directory and add a short `README.md`
  there listing each file and how it is loaded.

## Command Code (`cmd`)

`no-native-orchestration.ts` removes the native `agent`, `agent_output`, and `ask_user_question`
tools from the main loop. Command Code's permission rules cannot block the `agent` tool (its docs
mark it as always allowed), so the mod uses `cmd.setActiveTools` to remove it from the model's schema
and `beforeToolCall` to refuse any call that still arrives.

It filters from `cmd.getActiveTools()` rather than `cmd.getAllTools()`, so it only removes the listed
tools. Tools another mod disabled stay disabled, and tools another mod added stay active.
`setActiveTools` filters the tool surface only: other mods' commands, hooks, providers, renderers,
and UI are untouched. If some later mod re-enables `agent`, `beforeToolCall` still blocks the call.

The plugin loads it automatically whenever the MCP bridge is enabled: `src/cmd-mods.ts` appends
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
`OPENCODE_ACP_SKILL_DIR` and registers it. The plugin sets the env var and loads the mod through
`src/cmd-mods.ts`, like `no-native-orchestration.ts`; `--safe-mode` disables it like any other mod.
