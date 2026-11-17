# T3 Code ACP call path and latency

Upstream studied at **pingdotgg/t3code @ `218c18bc028903bf5c6d17be60ede3cbc5fb6305`** (2026-11-17), cloned read-only to `/tmp/opencode/t3code-research`. No dependencies installed, no services started. The repo has no research folder; `notes/` is new.

Our-repo references are working-tree `path:line`: `src/` and `README.md` contain uncommitted user changes, so a commit permalink would point at different code.

Evidence labels:

- **[S]** proven by source: the code does this call or ordering.
- **[M]** measured locally: call sequence supplied from a run against `test/fixtures/fake-agent.mjs`; not re-run by me.
- **[I]** inference about wall-clock latency. **There is no T3 ACP benchmark**, so no latency magnitude below is claimed as measured.

## Bottom line

T3 does not use a different ACP transport that is claimed to be faster. Its latency posture is structural:

1. One ACP process per provider session (one thread), started lazily at the first run and kept for 30 minutes of idleness. **[S]**
2. Model/command discovery is a background probe with caching, not on the turn path or the provider-snapshot creation path. **[S]**
3. A warm turn is exactly one `session/prompt`. **[S]**
4. Control writes happen at session activation or when the model/policy selection changes, not on every turn. **[S]**
5. App-owned text generation (titles, commit messages, branch names, PR descriptions) never uses ACP. **[S]**

Our hot path is also prompt-only, measured locally: after setup discovery, the first pooled turn with `effort=high` sent `session/new`, `session/set_config_option`, `session/prompt`; a second turn with the same key/model/effort sent only `session/prompt`. **[M]** This matches `AcpServerManager.run`: an existing pool entry returns at `src/server-manager.ts:634-639`, before the creation branch that calls `setMode`/`applyEffort` at `:677-687`; only the prompt remains at `:735-760`. Do not describe our reused turns as repeatedly creating sessions or writing model/effort.

The useful differences are therefore **cold paths, discovery, variant switching, auxiliary calls, MCP attachment, and restore**, not the steady-state turn.

## 1. Process and session lifecycle

### T3: one process per thread, lazy start, 30-minute release

- The ACP adapter declares `supportsMultipleProviderThreadsPerSession: false`, so a provider session normally belongs to one app thread: [adapter.ts L726-L733](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L726-L733).
- A provider session is opened when a run starts, not when the thread is created: `ProviderTurnStartService.ts:845-846` calls `providerSessions.open`; the lifecycle doc says provider state may be created lazily at first run: [feature-lifecycles.md L8-L22](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/docs/orchestration-v2/feature-lifecycles.md#L8-L22).
- `openSession` creates the runtime scope and starts it immediately: spawn child, `initialize`, then `session/new` (or `session/load`/`resume` when the thread has a native id): [adapter.ts L7284-L7321](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L7284-L7321), [adapter.ts L7540-L7561](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L7540-L7561), [AcpSessionRuntime.ts L2196-L2298](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/AcpSessionRuntime.ts#L2196-L2298). The child is spawned when the runtime layer is built: [AcpSessionRuntime.ts L1471-L1494](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/AcpSessionRuntime.ts#L1471-L1494).
- An unstarted thread therefore pays `spawn + initialize + session/new + configure` on its first run. **[S for sequence; I for wall time]**
- Idle sessions are released after 30 minutes (`DEFAULT_IDLE_TIMEOUT_MS`): [ProviderSessionManager.ts L69-L70](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L69-L70), [L527](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L527), [L1589-L1591](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L1589-L1591). Release closes the session scope: [L1390-L1393](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L1390-L1393), which closes the runtime scope and kills the agent: [adapter.ts L2680-L2687](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L2680-L2687). Background work pins release for up to four hours: [ProviderSessionManager.ts L70](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L70).
- The probe uses a throwaway runtime/process, not the chat process: [probe.ts L388-L560](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/probe.ts#L388-L560).
- **T3 does not prewarm a chat ACP process.** The probe process is separate and is deleted/closed; the first real turn still starts its own process. The only prewarm-like pooling I found is in the native OpenCode provider described next, not the ACP path. Our plugin is the opposite: it prewarms one agent process per configured server at setup (`src/server-manager.ts:390-409`), though it does not pre-create a chat session.

A second, architecturally closer pattern exists in T3's native OpenCode provider: one `opencode serve` process is pooled per provider instance with a borrower count and a **30-second** idle TTL: [OpenCodeServerOwner.ts L11-L18](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-opencode/src/server/OpenCodeServerOwner.ts#L11-L18), [L116-L174](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-opencode/src/server/OpenCodeServerOwner.ts#L116-L174). That is a shared server with per-thread OpenCode sessions, not one process per thread.

### Ours: one process per ACP server, sessions pooled per conversation

- `AcpServerManager.initialize()` prepares every enabled server at plugin setup; `doPrepare` starts the child, creates a discovery session, reads models/effort/commands, and closes only the session: `src/server-manager.ts:390-409`, `:446-537`. The process stays alive. `src/acp-client.ts:267-333` owns spawn and `initialize`.
- Chat sessions are pooled per `(server, opencode-session, model, cwd, effort)` (`src/server-manager.ts:311-313`) and share that one process. A first chat turn creates a session; later turns reuse it. Idle sweep closes sessions but **not** the server process (`:965-975`); `stop()` kills the clients (`:990-1006`).
- Compared with T3, our warm thread avoids process spawn and `initialize`; the cost is paid for every configured server at plugin setup, whether or not a thread uses it. That is a real tradeoff, not a strict win.

**Not transferable:** T3's process-per-thread model and idle process kill do not fit this plugin. We deliberately share one agent process across OpenCode conversations and rely on per-conversation sessions. Copying T3 here would add spawn/initialize latency to cold threads and more memory churn.

## 2. Eager vs lazy discovery

### T3: cheap readiness now, full probe in the background

- The provider snapshot is built from a readiness check that does not start an agent; the snapshot says discovery is happening in the background: [driver.ts L580-L598](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/driver.ts#L580-L598).
- Full discovery is `probeAcpRegistryConfiguration`: start a runtime, `initialize`, `session/new`, collect commands and live config, then delete the probe session and let the process scope close: [probe.ts L388-L560](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/probe.ts#L388-L560), [L515-L540](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/probe.ts#L515-L540).
- The probe waits only 500 ms for commands and up to 5 s for a late model catalog, then proceeds: [probe.ts L46-L50](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/probe.ts#L46-L50), [L530-L540](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/probe.ts#L530-L540).
- Results are cached for 15 minutes when a real catalog was found, 30 seconds when only one/default model was seen: [driver.ts L69-L76](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/driver.ts#L69-L76), [L770-L805](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/driver.ts#L770-L805).
- Enrichment is published asynchronously and live configuration updates from a running session override the probe snapshot: [driver.ts L821-L853](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/driver.ts#L821-L853), [L853-L908](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/driver.ts#L853-L908).
- A background probe yields to a foreground agent start so discovery cannot compete with the user's turn: [AcpRegistryRuntimeCoordinator.ts L116-L153](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/AcpRegistryRuntimeCoordinator.ts#L116-L153); the registry adapter wraps runtime startup in that foreground counter: [provider-acp-registry/adapter.ts L339-L347](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/adapter.ts#L339-L347).

### Ours: eager, all-or-nothing at setup

`src/index.ts:447-457` awaits `manager.initialize()` for **all** servers before registering any provider. Inside, each server prepares in parallel, but a provider is registered only after the slowest one returns or times out (`src/server-manager.ts:390-409`). Each discovery also blocks up to 2 s waiting for the command notification before closing the setup session (`src/server-manager.ts:194-196`, `:522-527`). If no models are advertised, `fallbackModels` spawns a separate `--list-models` process with a 15 s timeout (`:540-558`).

**Consequence [I]:** time-to-first-ACP-provider is the slowest server's discovery, not the fastest. The 2 s command wait alone is up to 1.5 s more than T3's 500 ms grace, and it is not needed for correctness here: `onCommands` already refreshes commands from live sessions (`src/acp-client.ts:424-437`, `src/server-manager.ts:343-354`, `src/index.ts:207-214`).

## 3. Session new/load/resume and control calls

### T3

- `initialize` is an idempotent shared effect: concurrent callers await one in-flight result, then reuse it: [AcpSessionRuntime.ts L2137-L2161](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/AcpSessionRuntime.ts#L2137-L2161).
- Session setup chooses `session/load` when `loadSession` is advertised (unless the flavor forces `resume`), otherwise `session/resume`, otherwise `session/new`: [AcpSessionRuntime.ts L2252-L2295](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/AcpSessionRuntime.ts#L2252-L2295). The adapter activates a native session only when the requested id differs from the cached `activeSessionId`, or a runtime restart is required: [adapter.ts L7583-L7607](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L7583-L7607), [L8552-L8563](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L8552-L8563).
- Per turn, `configureSession` runs only if active selection, interaction mode, or runtime mode changed: [adapter.ts L8563-L8585](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L8563-L8585). On activation it writes the requested model (the registry flavor sets `alwaysSetModel: true` because an agent can run a different model than `session/new` reported): [adapter.ts L7665-L7694](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L7665-L7694), [registry adapter L296](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/adapter.ts#L296).
- The runtime itself skips a config write when the cached current value already matches, unless explicitly asked to resend: [AcpSessionRuntime.ts L2058-L2080](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/AcpSessionRuntime.ts#L2058-L2080).
- `session/load` has an optional replay-idle readiness: with a 2 s quiet gap, T3 synthesizes a ready result from `initialize` instead of waiting for a load response that may never arrive. It is opt-in (`sessionLoadReplayIdleReadiness`) and enabled by the Grok flavor: [AcpSessionRuntime.ts L1972-L2045](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/AcpSessionRuntime.ts#L1972-L2045), [L81-L82](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/AcpSessionRuntime.ts#L81-L82), [runtimeModel.ts L1329-L1369](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/runtimeModel.ts#L1329-L1369), [Grok acpSupport.ts L145](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-grok/src/server/acpSupport.ts#L145).
- T3 initializes with `protocolVersion: 2`; our client sends v1 (`src/acp-client.ts:309-320`). This is not a latency mechanism by itself. It changes which optional methods/capabilities can be negotiated, and is a prerequisite for some of the mechanisms above; do not claim v2 generates faster. [AcpSessionRuntime.ts L2120-L2135](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/AcpSessionRuntime.ts#L2120-L2135).

Call sequences, source-derived **[S]**:

| Situation | T3 |
|---|---|
| First turn, new thread | `spawn`, `initialize`, `session/new`, model/options/mode writes, `session/prompt` |
| Later turn, same session/selection | `session/prompt` only |
| Thread returns after idle release | `spawn`, `initialize`, `session/load` or `session/resume`, model writes, `session/prompt` |
| Model/effort changes while session is live | config write(s) on the same session, then `session/prompt` |

### Ours

- Discovery already created and closed a session; the first chat turn creates a second session for the conversation and then optionally sets mode/effort: `src/server-manager.ts:677-687`, `src/acp-client.ts:605-666`. Reused turns skip that branch entirely.
- On a missing pooled session, a stored id is restored with `session/resume` when advertised, else `session/load`: `src/acp-client.ts:675-703`; then manager sets mode, effort, and (only for a restored session) the requested model: `src/server-manager.ts:686-698`.
- The pool key includes `model` and `effort` (`:311-313`). **[S]** Switching to a variant with no live or stored session is a cache miss: the next turn does `session/new`, writes mode/effort, and sends the **fresh** prompt with replayed history (`src/shim.ts:84-107`, `:320`, `src/server-manager.ts:735-736`). Switching back to a still-pooled variant reuses it directly. A previously persisted variant can instead restore with `session/resume|load`; a successful restore sets `reused=true` and sends only the newest prompt, not fresh history. T3 changes config on the existing session when the agent supports it.
- Restoring writes effort unconditionally and model when restored (`:686-698`), even if the resume/load response already reports those values. `restoreSession` discards the response (`src/acp-client.ts:689-702`), so the manager cannot compare.

## 4. Prompt transport and streaming

- T3 sends one `session/prompt` over newline-delimited JSON-RPC. The runtime serializes prompt fibers, tracks when the prompt is queued, and exposes a `released` signal for agents that hold the RPC response past foreground work: [AcpSessionRuntime.ts L1168-L1203](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/AcpSessionRuntime.ts#L1168-L1203), [L2660-L2689](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/AcpSessionRuntime.ts#L2660-L2689).
- A "busy" prompt from an agent that is still processing is retried after 1 s rather than failing the turn: [adapter.ts L146-L175](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L146-L175).
- Only changed runtime instructions are appended to later prompts, or they are resent after compaction: [adapter.ts L8471-L8510](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L8471-L8510). They are extra text in the same prompt, not a control call.
- Streaming text is emitted immediately for the first chunk, then coalesced into full-text snapshots every 50 ms because T3's UI projection persists snapshots and would otherwise do quadratic work: [adapter.ts L177-L184](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L177-L184), [L3043-L3062](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L3043-L3062). This is a persistence optimization, not a transport optimization.

Our path is ACP -> shim SSE -> OpenCode AI SDK. `src/shim.ts:377-423` forwards each ACP text/thought chunk as an SSE delta; `src/language-model.ts:35-61` makes one loopback HTTP request per model call and `:159-171` retries only a connection that died before headers. This adds one local HTTP request and SSE re-encoding per turn versus T3's in-process adapter, but it does not add ACP round trips: the shim calls `manager.run` once (`src/shim.ts:369-423`). The turn-level timing logs (first text/thought, total, chunk count) are in `src/shim.ts:360-435`, with per-request timing in `src/acp-client.ts:529-547` (uncommitted). No isolated benchmark of the HTTP hop exists in the repo.

## 5. MCP attachment startup

- T3 picks the MCP transport per agent capability at `session/new`: ACP-native MCP if `mcpCapabilities.acp`, else HTTP if `mcpCapabilities.http`, else the configured stdio server: [AcpSessionRuntime.ts L2170-L2184](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/AcpSessionRuntime.ts#L2170-L2184).
- The stdio default is a child process (`t3-code acp-mcp-bridge`) that the agent launches; the HTTP variant reuses the already-running endpoint, and is opt-in because some agents drop injected HTTP servers (the code names codex-acp 1.2.0 and pi-acp): [adapter.ts L902-L965](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L902-L965). The HTTP variant can ask the server to expose deferred tools: [L944-L946](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L944-L946).
- MCP credentials are prepared once per thread/provider instance and reused across session opens/workspace handoffs: [ProviderSessionManager.ts L554-L632](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/apps/server/src/orchestration-v2/ProviderSessionManager.ts#L554-L632).

Ours defaults to a **stdio** bridge per new ACP session: `src/mcp-server.ts:175-201` builds `node mcp-bridge.mjs` with a token; `:202-230` issues one lease/token per session creation. A global `mcpTransport: "http"` option exists (`src/index.ts:70-71`, `src/mcp-server.ts:120-164`), but the client never reads the agent's MCP capabilities (`src/acp-client.ts:98-110`, `:323-331` are the whole handshake shape). The README already notes `mcpRuntime: "bun"` to avoid Node startup per stdio bridge. T3's capability negotiation is the stronger version: no per-session child when the agent supports HTTP or ACP-native MCP.

## 6. Auxiliary/title calls

T3 explicitly refuses to route app-owned text generation through ACP: the registry driver implements every text-generation operation as unsupported and reports `supportsTextGeneration: false`: [driver.ts L136-L153](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/driver.ts#L136-L153), [L304](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/driver.ts#L304), [L1008](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp-registry/src/server/driver.ts#L1008). The user docs say the same: [providers-acp.md L134-L136](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/docs/user/providers-acp.md#L134-L136).

Ours does the opposite by necessity: when the ACP model is the one OpenCode chooses for titles, OpenCode sends `title`/`generate` model requests through the same provider. The shim detects the `x-acp-request-kind` header, marks them auxiliary, drops the reusable session key, and uses the full-history prompt: `src/shim.ts:302-320`. With no key, `AcpServerManager.run` creates a disposable session, optionally writes mode/model/effort, prompts, and closes it: `src/server-manager.ts:611-628`. So every title is `session/new`, optional mode/model/effort writes, prompt with up to 16 turns/8k chars, close. **[S for sequence; I for time]**

This is the main place our provider spends an agent turn the user did not ask for. The repo already has `scripts/latency.py:30-43`, which deliberately measures sessions with automatic titles off and on; that is the right experiment. T3's design cannot be copied literally without either losing titles in OpenCode or routing titles to a separate non-ACP model. Options and tradeoffs are in section 9.

## 7. Cancellation and steering

- T3's generic ACP capability block says no active steering and interrupt/restart steering support: [adapter.ts L743-L752](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L743-L752). A flavor can opt into native steering through `steering.send` and `injectedSteerId`: [adapter.ts L498-L518](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L498-L518). The registry flavor does not set it, so registry agents take the interrupt path.
- Runtime cancel first waits until the prompt has actually been queued for writing, bounded by a timeout; otherwise an agent can drop a cancel that arrives before its prompt: [AcpSessionRuntime.ts L2412-L2436](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/AcpSessionRuntime.ts#L2412-L2436).
- Separately, a flavor can hold `session/cancel` until an update after `session/prompt` matches an `isStart` predicate, or a bound expires: [adapter.ts L585-L595](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L585-L595), [L8007-L8020](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L8007-L8020). Its comment names Kiro, which can drop an early cancel and run the turn to completion.
- A flavor can also interrupt the local prompt fiber before sending cancel for agents that wedge their prompt: [adapter.ts L585-L586](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L585-L586), [L2591](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L2591), [AcpSessionRuntime.ts L2426-L2435](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/AcpSessionRuntime.ts#L2426-L2435).
- Steers are only deliverable where a flavor implements `steering.send`; otherwise the orchestrator interrupts and restarts: [adapter.ts L9323-L9375](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/packages/provider-acp/src/server/adapter.ts#L9323-L9375).

Ours is **ahead here for agents that support the extension**: `_session/steering` is used when advertised, with `idleBehavior: "promptRequired"` so an idle agent hands the message back instead of starting an unobserved turn: `src/acp-client.ts:810-831`, `src/server-manager.ts:851-903`, `src/steering.ts:166-211`. The fallback interrupts. The uncommitted steering change also keeps the inbox cleanup out of the admission decision (`src/steering.ts:203-207`).

Our early-steer cancel is sent immediately after `client.prompt` has written `session/prompt` (`src/server-manager.ts:753-758`), and our client write is synchronous (`src/acp-client.ts:523-527`), so prompt-before-cancel ordering is guaranteed on our side. T3's runtime additionally waits for its writer queue ack, and its optional start gate exists for agents that drop a cancel even after that. This is an agent-specific robustness measure, not a general latency win; do not add a first-update gate globally.

## 8. Latency measurement

I found **no ACP benchmark, TTFT counter, or per-phase latency metric** in `packages/effect-acp`, `packages/provider-acp`, or `packages/provider-acp-registry`. The only `TTFT` occurrence is a literal string in a UI test fixture, not ACP-generated data: [MessagesTimeline.logic.test.ts L524](https://github.com/pingdotgg/t3code/blob/218c18bc028903bf5c6d17be60ede3cbc5fb6305/apps/web/src/components/chat/MessagesTimeline.logic.test.ts#L524). T3 has general turn timestamps and session-open metrics, but nothing that separates process start, initialize, session setup, prompt dispatch, and first token for ACP.

So no claim that T3 produces faster generation or lower wall-clock latency is supported. The source only supports claims about **which calls happen on which path**.

## 9. Transferable changes, ranked

Ranking is by likely effect on this plugin, not by certainty of magnitude. Every performance claim is **[I]**.

### 1. Re-key the pool so model/effort changes reuse the ACP session (highest impact on variant switches)

**Status:** implemented in the working tree. The pool is keyed by server/session/cwd, live selection changes run inside the session queue, and a refused change replays history into a fresh session.

- Evidence: our key at `src/server-manager.ts:311-313`; cold creation + fresh history prompt at `:640-698`, `:735-736`, `src/shim.ts:84-107`. T3 compares selection/policy and configures the live session (`adapter.ts:8563-8585`) with a runtime that skips matching writes (`AcpSessionRuntime.ts:2058-2080`).
- Change: key by `(server, opencode-session, cwd)` only. Store `model`/`effort` as applied values on `PooledSession`. On a turn whose requested values differ, call `setEffort`/`setModel` on the existing session if the agent advertises it, update the cached values, then prompt. Fall back to a new session only when the control call is refused (`-32602`) or the agent exposes no model/config option. `AcpClient.newSession` already returns `configOptions` (`src/acp-client.ts:657-665`) but `AcpServerManager` keeps only models/efforts, not the model option id (`src/server-manager.ts:497-519`); retain that id so `setModel` uses the advertised id, not a hard-coded `"model"`.
- Tradeoff: serialize selection changes and the prompt together inside the existing per-session queue; otherwise concurrent turns can switch a running turn's model. Agents that do not support in-session switching need a clean fallback; a model change can reset effort, so reapply effort after the model. Test against real agents, not only the fixture. This preserves tool context and removes one `session/new` plus a history prefill when switching to a previously unused variant. **[S for call sequence; I for time]**
- Acceptance test with the fake agent: same key, effort high -> `session/new, set_config_option, prompt`; same key, effort low -> `set_config_option, prompt` (no `session/new`); same key/effort again -> `prompt`.

### 2. Do not block all provider registration on full discovery; shorten the command wait (best startup win, low risk)

- Evidence: `src/index.ts:447-457` awaits every `prepare`; `src/server-manager.ts:390-409` only resolves after the slowest; `:522-527` waits up to 2 s for commands; T3 publishes readiness immediately and enriches in the background with a 500 ms command grace (`driver.ts:596`, `probe.ts:46-50`).
- Change: add an `onReady(state)` callback to the manager (or expose per-server ready promises) and register/reload each provider as it finishes. Coalesce `ctx.provider.reload()` calls. Drop the command snapshot timeout to 500 ms; commands already update live through `onCommands` and `commandBridge.sync` (`src/acp-client.ts:424-437`, `src/index.ts:207-214`).
- Tradeoff: the model picker appears incrementally; a provider whose agent is slow shows up later rather than all at once. That is exactly T3's behavior and is better than no provider while one agent times out. The existing retry path already proves late registration + reload works (`src/index.ts:344-369`). **[S for waits; I for perceived startup]**

### 3. Stop paying a fresh ACP session for titles (when automatic titles are enabled; product tradeoff)

- Evidence: auxiliary detection at `src/shim.ts:302-320`; disposable session + config writes + close at `src/server-manager.ts:611-628`; T3 refuses ACP text generation entirely (`driver.ts:136-153`, `docs/user/providers-acp.md:134-136`); the local `scripts/latency.py:30-43` already isolates titles on/off.
- Change options, best to worst:
   1. Route titles to a non-ACP model through a supported V2 integration. The V2 plugin API provides a `title` hook with a `result` override and `ctx.experimental.generate.text`; verify the chosen model and prompt handling before implementing. Do not assume the legacy `small_model` configuration field applies: it is not documented in the current [V2 configuration guide](https://opencode.ai/docs/config).
  2. Add an opt-in `auxiliaryTitles: "local"` mode that answers `title` requests from the first user line (truncated) in the shim, without an ACP prompt. Do not fake `generate`/summary responses this way.
  3. Add a separate cheap `auxiliary` server config. More moving parts; not justified without measurements.
- Tradeoff: a local title is lower quality than the agent's title. Reusing the **main** session is not an option: it would inject title instructions into the user's conversation and pollute its context. **[S for call sequence; I for time]**

### 4. Negotiate MCP transport from `initialize` (cold-session win, medium complexity)

- Evidence: our handshake ignores MCP capabilities (`src/acp-client.ts:98-110`, `:323-331`); stdio bridge per session (`src/mcp-server.ts:175-201`, `:202-230`); global HTTP option only (`src/index.ts:70-71`). T3 chooses ACP-native > HTTP > stdio at `session/new` (`AcpSessionRuntime.ts:2170-2184`) and only falls back to a child process when needed (`adapter.ts:902-965`).
- Change: extend the handshake with `agentCapabilities.mcpCapabilities`; add per-server `mcpTransport: "auto" | "stdio" | "http" | "acp"`; in `auto`, use HTTP when advertised and configured, else stdio. Keep a force-stdio override because some agents advertise HTTP and drop it (T3's own comment). If ACP-native MCP is in scope, add the `type: "acp"` server shape; otherwise HTTP is the cheaper win.
- Tradeoff: capability claims are not always honored; wrong negotiation costs a retry. Per-agent override contains that risk. **[S for config difference; I for startup time]** The README's `mcpRuntime: "bun"` note is evidence that bridge startup is already noticeable enough to document.

### 5. Remove the restore tail: optional replay-idle and config-value dedupe (agent-specific, low-medium impact)

- Evidence: our restore waits for `session/load` or `session/resume` (`src/acp-client.ts:689-702`) and then writes effort/model unconditionally (`src/server-manager.ts:687-698`). T3 can treat `session/load` replay as ready after a 2 s quiet gap (`AcpSessionRuntime.ts:1972-L2045`, `runtimeModel.ts:1329-1369`) and skips matching config writes (`AcpSessionRuntime.ts:2058-2080`).
- Change: capture `configOptions` from the resume/load response and store the applied model/effort on the pool; skip writes that already match. For load-only agents whose load never resolves, add a per-server `loadReplayIdle` option using T3's 2 s gap + a minimum replay-activity guard. Keep it off by default; T3 enables it only for Grok.
- Tradeoff: declaring load complete early can drop late replay updates; dedupe depends on the agent reporting truthful config values. This only affects cold restore, not normal turns. **[S for mechanism; I for tail latency]**

### 6. Optional cancel start gate (robustness, not a latency change)

- Evidence: T3 holds cancel until an update after prompt start for agents such as Kiro (`adapter.ts:585-595`, `:8007-L8020`); our early cancel is sent after our synchronous prompt write (`src/server-manager.ts:753-758`, `src/acp-client.ts:523-527`).
- Change: only if a real agent drops our early cancel, add a per-server `cancelAfterPromptStarts` predicate/bound. Do not make it global: it delays cancellation by at least one update and cannot fix an agent that never emits a start update.
- Tradeoff: slower Stop/steer on healthy agents for a problem not yet observed in this repo. **[S for T3 behavior; I for benefit]**

### Considered and rejected

- **Process per thread / kill process after idle.** T3 does it for isolation and memory. Our shared warm process and 30-minute session pool are a latency advantage on warm threads; copying T3 would regress it. Our plugin cannot cheaply isolate per thread without changing the provider architecture.
- **Adopt T3's 50 ms text coalescing.** T3 coalesces because it persists full-text snapshots. Our shim streams deltas, so there is no quadratic snapshot cost; adding coalescing would only add time-to-first-token.
- **In-process shim instead of loopback HTTP.** It would remove one local request and SSE re-encode per turn, but `src/language-model.ts:35-61` already delivers tokens as they arrive and the shim is the shared path for the AI SDK and OpenAI-compatible routes. The refactor is large for a small, unmeasured reduction; not worth it without a trace showing the hop is material.
- **No active steering.** T3's generic ACP path interrupts. Our `_session/steering` support is better for agents that implement it; keep it.
- **T3's per-thread MCP credentials and retired-session quarantine.** Those are isolation/correctness features, not latency features; out of scope here.

## 10. Proof of work and limitations

- Upstream pinned and cloned: `/tmp/opencode/t3code-research`, `git rev-parse HEAD` = `218c18bc028903bf5c6d17be60ede3cbc5fb6305`; no install and no service was run.
- ACP implementation located: `packages/effect-acp` (transport/schema), `packages/provider-acp` (runtime/adapter), `packages/provider-acp-registry` (driver/probe/flavors); the native OpenCode provider was read only for its shared-server pool contrast.
- All requested areas are covered above: process scope and startup, eager/lazy discovery, reuse/pooling/prewarming, new/load/resume, prompt transport/streaming, model/effort control calls, auxiliary/title calls, MCP attachment, cancellation/steering, and latency measurement.
- Our side was read in full for `src/acp-client.ts`, `src/server-manager.ts`, `src/index.ts`, `src/shim.ts`, `src/language-model.ts`, `src/steering.ts`; no production file, test, config, or existing doc was modified. The only added file is this note.
- The local sequence measurement was supplied by the parent session from a run against `test/fixtures/fake-agent.mjs` with request timing logs. I verified the sequence against the source paths cited above but did not re-run it. It is a call-sequence measurement, not a wall-clock benchmark.
- No wall-clock benchmark of T3 or of this plugin was run, so the report does not claim T3 generates faster or that any proposed change is faster by a specific amount. The ranked changes are mechanisms to remove known round trips/process starts; they need local measurement with `scripts/latency.py` and the first-chunk logs before/after.
- The T3 approach does **not** fully fit this plugin: per-thread processes, idle process teardown, and excluding ACP from application text generation conflict with OpenCode's provider model. I stopped at the compatible mechanisms above rather than recommending a port of T3's lifecycle.
