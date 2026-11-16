# Agent companion files

Some ACP agents need a file of their own to change behavior that an ACP client cannot control over
the protocol. A common case is hiding a native orchestration tool that would otherwise compete with
OpenCode's own `subagent` and `question` tools.

One directory per OpenCode `servers[].id`:

```text
agents/
├── cmd/
│   ├── no-native-subagent.ts   # loaded with `cmd acp --mod …`
│   └── opencode-skills.ts      # loaded automatically by the plugin
└── <id>/                       # one directory per server id
    └── <capability>.ts         # name the file after the behavior it changes
```

## Conventions

- The directory name matches the `id` in `opencode.jsonc` (`cmd`, `claude`, `codex`, …).
- The file name describes the behavior, not the agent: `no-native-subagent.ts`.
- Keep each companion file standalone. It must not import from `src/`; the agent loads it with its
  own runtime and API.
- Document how the agent loads the file (CLI flag, env var, config key) in a comment at the top of
  the file and in the README section that references it.
- If an agent needs more than one file, keep them in the same directory and add a short `README.md`
  there listing each file and how it is loaded.

## Command Code (`cmd`)

`no-native-subagent.ts` removes the native `agent` and `agent_output` tools from the main loop.
Command Code's permission rules cannot block the `agent` tool (its docs mark it as always allowed),
so the mod uses `cmd.setActiveTools` to remove it from the model's schema and `beforeToolCall` to
refuse any call that still arrives.

It filters from `cmd.getActiveTools()` rather than `cmd.getAllTools()`, so it only removes those two
tools. Tools another mod disabled stay disabled, and tools another mod added stay active.
`setActiveTools` filters the tool surface only: other mods' commands, hooks, providers, renderers,
and UI are untouched. If some later mod re-enables `agent`, `beforeToolCall` still blocks the call.

Load it from the server entry:

```jsonc
{
  "id": "cmd",
  "name": "Command Code (ACP)",
  "command": [
    "cmd",
    "acp",
    "--mod",
    "/absolute/path/to/opencode-acp/agents/cmd/no-native-subagent.ts"
  ]
}
```

`--mod` is a global `cmd` flag. `cmd acp` accepts it even though `cmd acp --help` does not list it.

Add `"ask_user_question"` to the mod's `DISABLED` set if questions should route through OpenCode
too. Verify with a prompt such as "call the agent tool with subagent_type explore": the agent no
longer sees that tool and should report it as unavailable rather than delegating.

### `opencode-skills.ts`

`cmd acp` accepts the global `--skill` flag but its ACP action never applies it; only the interactive
and print paths call `setSkillLoadOverrides`. Mods are loaded on the ACP path, and
`cmd.addSkillsPath` feeds the same skill discovery plan. This mod reads
`OPENCODE_ACP_SKILL_DIR` and registers it. The plugin sets the env var and appends `--mod` to a
`cmd ... acp` command automatically; `--safe-mode` disables it like any other mod.
