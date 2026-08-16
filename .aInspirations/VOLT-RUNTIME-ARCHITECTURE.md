# Volt Runtime Architecture

**Status:** implementation plan + locked decisions  
**Date:** 2026-08-15  
**Supersedes in practice:** `AGENT-RUNTIME-PLAN.md` (foundation) + the 5-layer refinement  
**Review this file** to suggest changes. Code follows these decisions.

---

## 1. Goal

Ship an open-source Cursor/Composer-class agent runtime inside Volt:

- Connect **models** (OpenAI, Anthropic, Gemini, OpenRouter, Ollama, any OpenAI-compat)
- Connect **agents** over **ACP first** (Cursor ACP, Gemini CLI ACP, any stdio ACP agent)
- Select **modes** (Agent / Plan / Ask / Debug / Multitask)
- Send a message in the existing Volt agent editor and **stream a real response**

ACP is the agent ↔ client layer. MCP stays the agent ↔ tools/context layer. We do not rebuild MCP.

```
             VOLT IDE
                │
              ACP          ← P0 agent transport
                │
             AGENT
                │
              MCP          ← reuse IMcpService
        ┌───────┼────────┐
        ↓       ↓        ↓
      GitHub   DB      Browser
```

---

## 2. Locked decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | **5-layer runtime**, not just gateway+tools | Session/run, agent, model, tools, security must be first-class or we paint into a corner |
| D2 | **ACP is P0** — first agent transport, not a later adapter | One protocol instead of N CLI snowflakes. Cursor ACP (`agent acp`) is the first harness |
| D3 | **`ModelProvider` ≠ `AgentProvider`** | Claude API ≠ Claude Code. OpenAI API ≠ Codex. Hard rule from the original plan |
| D4 | **`Session` + `Run` are separate** | Conversation identity ≠ execution identity. Parallel/fork/resume need `Run` |
| D5 | **UI talks only to `IAgentRuntimeService`** | No provider SDKs, no HTTP, no ACP JSON-RPC in `voltAgent` |
| D6 | **Desktop hot path is in-process `Event`** | No HTTP/gRPC/webview/`postMessage` between Volt UI and Volt runtime |
| D7 | **ACP stdio lives in electron-main** | Renderer cannot `spawn`. Main process owns child processes; renderer gets a proxied `IVoltStdioService` |
| D8 | **HTTP model calls use `IRequestService`** | Existing workbench request stack; renderer-safe; streams via `listenStream` |
| D9 | **Secrets never in `settings.json` or renderer-visible storage** | `ISecretStorageService` only. Profiles store *refs*, not keys |
| D10 | **Normalize the common event, keep provider raw** | `IVoltEventEnvelope.provider.raw` so we do not lose Anthropic/ACP-specific fields |
| D11 | **Do not inject Volt tools into ACP agents** | ACP agents own their loop/tools. Volt only projects `session/update` into `IVoltEvent` |
| D12 | **Do not rebuild MCP** | Wrap `IMcpService`. Names: `mcp__{server}__{tool}` |
| D13 | **Mode is a policy, not a model** | Mode filters tools + prompt. Per-mode *profile* can pick a cheaper model |
| D14 | **Router is local / explicit, never a network hop on the hot path** | Ask→fast, Plan→reasoning, Agent→balanced. No extra classifier RPC |
| D15 | **Large payloads are `ContentRef`, not event strings** | Event bus stays small. UI requests slices |
| D16 | **Thin adapters, no giant `switch (provider)`** | Registry of factories. Adding a provider is `register()` |
| D17 | **Volt Settings is its own editor tab** | Not VS Code Settings. Gear in titlebar opens `Volt Settings` |
| D18 | **Keep the existing voltAgent chrome** | Replace `runMockThinking()` only. Do not rewrite the composer/thread |
| D19 | **VOLT owns execution authority; providers are adapters** | One AccessBroker decides allow/ask/deny. Provider-native permission systems are a translation layer, never a second authority |
| D20 | **Prediction Runtime is a separate subsystem** | Ephemeral, cancellable, no `Session`/`Run`, never `IAgentRuntimeService.send()`. Agent Runtime = durable + permissioned; Tab = speculative + ultra-low-latency. Do not merge them |
| D21 | **Tab follows the composer selection** | The agent/model picked in the composer is what Tab calls. ACP agents (Cursor, Claude, Codex) use a dedicated ask-mode session so they do not pollute the chat thread. Chat models still use `streamModel()`. No selection → first enabled agent, then first usable model |
| D22 | **Models shared via `IVoltModelAccess.streamModel()`** | Narrow escape hatch on the runtime service. Prediction never creates sessions or touches the agent loop |
| D23 | **Reuse VS Code inline-completion/NES machinery** | Register an `InlineCompletionsProvider` on `ILanguageFeaturesService`. Ghost text, NES diff views, Tab accept/jump, cross-file `vscode.open`/`nextEditUri` handoff are upstream. No forked views |
| D24 | **Minimal prediction ContextEngine now** | prefix/suffix excerpt + imports + diagnostics + recent-edit ring buffer + open-tab siblings. Repo ranking/embeddings stay a stub |

---

## 2a. Prediction Runtime (Tab / NES / cross-file)

Reference: Zed `crates/edit_prediction` (clone: `.aInspirations/zed/`). LSP completions ≠ edit predictions; predictions are **edits** (local or jump), not tokens; core owns debounce/cache/UI; providers only build prompt → request → parse.

```
keystroke ──► VoltInlineCompletionsProvider (contrib/voltPrediction)
                 │  cancel in-flight · debounce ~40ms · cache
                 ▼
          PredictionRuntime (services/voltRuntime/browser/prediction)
                 │  PredictionContext: excerpt · imports · diagnostics
                 │  recent edits · open siblings
                 ▼
          IVoltModelAccess.streamModel(tabModelRef)
                 ▼
          postProcess / multiEditParser / editGraph
                 ▼
          ghost text · isInlineEdit NES · vscode.open cross-file handoff
```

One-shot **Volt: AI Edit** previews multi-file edits via `IBulkEditService`; low confidence escalates the same intent into the agent thread. That bridge is one-directional and never on the Tab hot path.

---

## 3. Target architecture

```
                         VOLT UI
              voltAgent editor  ·  Volt Settings
                          │
                 IAgentRuntimeService
                          │
                ┌─────────▼──────────┐
                │ SESSION ORCHESTRATOR│
                │ sessions · runs     │
                │ cancel · resume     │
                │ seq · checkpoints   │
                └─────────┬──────────┘
                          │
              ┌───────────┴───────────┐
              │                       │
       ┌──────▼──────┐        ┌───────▼───────┐
       │ AGENT       │        │ MODEL          │
       │ RUNTIME     │        │ RUNTIME        │
       │             │        │                │
       │ ACP (P0)    │        │ OpenAI-compat  │
       │  cursor-acp │        │ OpenAI         │
       │  generic    │        │ Anthropic      │
       │ Claude Code │        │ Gemini         │
       │ Codex       │        │ OpenRouter     │
       │ Gemini CLI  │        │ Ollama         │
       └──────┬──────┘        │ LM Studio      │
              │               └───────┬────────┘
              │                       │
              └───────────┬───────────┘
                          │
                 ┌────────▼────────┐
                 │ CONTEXT ENGINE  │  (stub now, contract locked)
                 │ TOOL RUNTIME    │  (native loop only)
                 │ SECURITY        │  (mode policy + secret store)
                 └─────────────────┘
```

**ACP-first agent path**

```
User prompt
  → IAgentRuntimeService.send()
  → SessionOrchestrator.createRun()
  → AcpAgentProvider.send()
  → IVoltStdioService (electron-main spawn)
  → JSON-RPC: initialize → session/new → session/prompt
  → session/update notifications
  → IVoltEventEnvelope (seq, runId)
  → rAF paint in agent editor
```

**Native model path**

```
User prompt
  → same orchestrator
  → PromptCompiler + mode policy
  → IModelProvider.stream() via IRequestService
  → SSE / event-stream → IVoltEvent
  → same renderer
```

---

## 4. Layer contracts

### 4.1 Session Orchestrator

```
Session                    conversation + mode + selected provider
  └── Run                  one execution (queued|running|waiting|completed|failed|cancelled)
       ├── Turn            one model/agent cycle
       ├── Tool calls
       ├── Approvals
       └── CancellationToken
```

- `sessionId` = host routing (editor tab / side panel)
- `conversationId` = durable transcript
- `runId` = this send
- Events carry `seq` + `runId` + `timestamp`

### 4.2 Provider capabilities

Every catalog item advertises:

```
streaming · reasoning · toolCalling · parallelToolCalls
vision · attachments · promptCaching · structuredOutput
cancellation · contextWindow · mcp · nativeAgent
```

The router and UI use this. They do not hardcode “Claude can think.”

### 4.3 Transports

```
IAgentTransport
  NativeTransport      in-process SDK (later: Claude Agent SDK)
  HttpTransport        OpenAI-compat / vendor HTTP
  StdioTransport       ACP JSON-RPC over IVoltStdioService   ← P0
  WebSocketTransport   reserved, not on desktop hot path
```

### 4.4 Agent manifest

UI is data-driven. A connection is:

```
id, name, kind: model|agent
transport: http|stdio|sdk
command / args / cwd          (ACP)
baseURL / apiStyle            (models)
auth: apikey|oauth|cli|none
capabilities
```

---

## 5. ACP (P0)

Protocol: [Agent Client Protocol](https://agentclientprotocol.com/) JSON-RPC 2.0 over stdio.

**Client (Volt) → Agent**

| Method | When |
|--------|------|
| `initialize` | first connect; protocolVersion + clientCapabilities |
| `authenticate` / `auth/login` | only if agent advertises auth methods |
| `session/new` | new Volt session |
| `session/load` or `session/resume` | if advertised |
| `session/prompt` | user send |
| `session/cancel` | interrupt |
| `session/set_mode` | if agent has modes |

**Agent → Client**

| Message | Maps to |
|---------|---------|
| `session/update` `agent_message_chunk` | `text.delta` |
| `session/update` `agent_thought_chunk` | `reasoning.delta` |
| `session/update` `plan` | plan steps in the thread |
| `session/update` `tool_call` / `tool_call_update` | `tool.*` |
| `session/update` `usage_update` | `usage` |
| `session/request_permission` | `permission.ask` |
| `fs/read_text_file` / `fs/write_text_file` | Volt FS (workspace allowlist) |
| `session/prompt` result `stopReason` | `run.end` |

**First ACP targets**

| id | command | priority |
|----|---------|----------|
| `cursor-acp` | `agent acp` | **P0** |
| `acp-generic` | user command + args | **P0** |
| `gemini-cli` | `gemini --acp` (or documented ACP flag) | P1 |
| `claude-code` | SDK / CLI | P1 |
| `codex` | app-server | P1 |

Detect is a **bounded probe** (`--version` / `which`), never the session process, never blocking the UI.

---

## 6. Model runtime (P0 HTTP)

One workhorse: **OpenAI-compatible** `POST {baseURL}/chat/completions` with `stream: true`.

| id | baseURL default | notes |
|----|-----------------|-------|
| `openai` | `https://api.openai.com/v1` | thin wrapper |
| `openrouter` | `https://openrouter.ai/api/v1` | 200+ models |
| `openai-compat` | user `baseURL` | Groq, Fireworks, Kimi, Together, custom |
| `lmstudio` | `http://127.0.0.1:1234/v1` | local compat |
| `ollama` | `http://127.0.0.1:11434` | native `/api/chat` + tags |
| `anthropic` | `https://api.anthropic.com` | Messages API + thinking |
| `gemini` | `https://generativelanguage.googleapis.com` | generateContent stream |

Native **agent loop** (models only): persist user turn → stream → if no tools, `run.end`. Tool execution lands next; ACP agents already own their loop.

---

## 7. Modes

| Mode | Native tools | Approval overlay | Default routing hint |
|------|--------------|------------------|----------------------|
| Agent | fs, terminal, grep, lsp, mcp | follows the selected access preset | balanced |
| Plan | read, grep, lsp | **deny** writes, mutating shell, and side-effecting MCP — even under Full access | reasoning |
| Ask | read, grep | deny write/bash/MCP | fast |
| Debug | + terminal, logs | follows the selected access preset | reasoning |
| Multitask | spawn child runs | follows the selected access preset | balanced |

Interaction mode (`VoltMode`) and access mode (`VoltAccessMode`) are orthogonal. Plan/Ask are **policy overlays** compiled into the AccessBroker. They are not prompt-only and a provider cannot bypass them.

ACP: if the agent supports `session/set_mode`, we forward. VOLT still evaluates every `session/request_permission` and `fs/write_text_file` against the effective policy.

---

## 7a. Access Control & Provider Authority

VOLT owns execution authority. Providers are execution adapters. The canonical path is:

```
Provider request
  → ProviderAccessBridge.normalize()
  → AccessBroker.evaluate()
  → allow / ask / deny
  → execute, approval card, or reject
```

```
                         VOLT UI
              access picker · approval card
                          │
                   AccessProfile
                   (UX preset only)
                          │
                   EffectivePolicy
                          │
                    ACCESS BROKER     ← authority
                          │
               allow / ask / deny
                          │
                 Provider adapters
          Codex · Claude · Cursor · Grok · OpenCode · ACP
```

**Presets** (Supervised, Auto-accept edits, Auto, Full access) are compiled rule arrays, not an enum the engine branches on. Underneath: `allow | ask | deny` on generic actions (`read`, `edit`, `shell`, `mcp`, …) with resource patterns.

**Precedence:** system hard-deny → preset → project → agent → session saved-approvals. Explicit deny cannot be overridden by an ordinary allow or a saved “always” rule. The interaction-mode overlay applies last and can only tighten.

**Auto** uses a deterministic risk classifier on the hot path (`safe`/`low` allow, `medium+` ask). No LLM is invoked for ordinary permission evaluation. Where a provider already has a native reviewer (Codex `auto_review`), the bridge may delegate the medium band so VOLT does not double-prompt.

**Approvals** are runtime state. `access.ask` is emitted only when the broker returns `ask`. Allowed operations never touch the UI, storage, or the network. Responses are idempotent. MCP, filesystem writes, and shell all go through the same broker.

**Performance:** policies compile once; evaluation is synchronous and memoized per `(mode, action, resource)`. Target: sub-millisecond on the allow/deny path.

**Receipts:** every non-read decision records why it was allowed or denied (`policySource`, risk, action, resource) so “why did this run?” is answerable.

---

## 8. Volt Settings UI

**Entry:** titlebar right (dedicated Volt gear, not the VS Code account gear) → editor tab **Volt Settings**.

Layout (VS Code Settings + Cursor Models):

```
┌ Search settings ──────────────────────────────────┐
│ User | Workspace                                  │
├────────────┬──────────────────────────────────────┤
│ Commonly   │  heading + description + control     │
│ Models     │  task-model row + add/search         │
│ Agents     │  toggle list / connection cards      │
│ ACP        │  command, args, detect, connect      │
│ Modes      │  per-mode profile                    │
│ Security   │  approval defaults                   │
└────────────┴──────────────────────────────────────┘
```

**Models page** matches the Cursor-style list: search/add, refresh, per-model enable toggle, task-model dropdown (Explore / Plan / Agent).

**Agents / ACP page:** add connection (preset Cursor ACP or custom command), detect status (installed / version / auth), enable toggle.

Command: `workbench.action.openVoltSettings`.

---

## 9. Persistence

| What | Where |
|------|-------|
| Profile metadata (id, label, provider, baseURL, model, enabled) | `IStorageService` APPLICATION |
| API keys / tokens | `ISecretStorageService` key `volt.runtime.secret.{profileId}` |
| Live deltas | memory only |
| Durable: user message, assistant end, tool, permission, run state | session log (memory now; disk next) |
| Checkpoints | `checkpoint(runId)` hook reserved |

---

## 10. Performance budget

```
submit → runtime accepted              < 1ms
runtime → provider request             < 5ms
provider first byte → UI paint         < 16ms
interrupt → cancelled                  < 50ms
10k token stream                       0 dropped frames (rAF coalesce)
```

Logged separately: `ttfb_provider`, `ttfb_ui`, `context_build_ms`, `queue_wait_ms`, `tool_wait_ms`, `provider_connect_ms`.

If `ttfb_ui - ttfb_provider > 16ms`, the hop is wrong.

---

## 11. File map

```
src/vs/platform/voltStdio/
  common/voltStdio.ts
  electron-main/voltStdioMainService.ts   spawn + stdio pipes

src/vs/workbench/services/voltRuntime/
  common/          contracts only
  common/access/   AccessBroker, presets, policy compiler, risk classifier, bridges
  browser/         orchestrator, HTTP providers, ACP client, settings-facing API
  browser/agents/bridges/  Codex/Claude/Cursor/OpenCode access translation
  electron-browser/  IVoltStdioService proxy

src/vs/workbench/contrib/voltSettings/browser/
  Volt Settings editor tab

src/vs/workbench/contrib/voltAgent/browser/agentEditor.ts
  send() → runtime; applyEvent(); live catalog
```

---

## 12. Ship order (this implementation)

**Done in this pass (working path)**

1. Contracts: events, run, session, capabilities, profiles, transports
2. Session orchestrator + `IAgentRuntimeService`
3. ACP stdio transport + `cursor-acp` + generic ACP
4. OpenAI-compat + OpenAI + OpenRouter + Ollama + Anthropic + Gemini
5. Auth via secret store
6. Volt Settings tab (Models, Agents/ACP, Modes)
7. Titlebar Volt Settings button
8. Agent editor: drop mock, stream real events, live model/agent picker

**Stubbed with locked interfaces (do not invent a second design later)**

- ContextEngine + ContextBudget (rank/compact later)
- ToolScheduler + result cache (native tools later)
- ContentStore (in-memory map now)
- Model warm pools
- Secret firewall / OS sandbox
- Native HTTP-model tool runtime (AccessBroker is already wired at that seam)
- Speculative execution
- Parallel worktree agents
- Remote HTTP snapshot + WS deltas

---

## 13. What we will not do

- Copy Cline / Roo / OpenCode / T3 into `contrib/`
- One class that is both “call Anthropic” and “run Claude Code”
- Webview + `postMessage` for voltAgent
- Effect-TS or a mandatory local HTTP daemon
- Flat shared `apiKey` field
- Re-implement MCP
- Wait for the full assistant message before paint
- Giant `switch (provider)` factory
- Extra abstraction around every vendor “for purity”

---

## 14. Review checklist

When commenting on this doc, please flag:

1. ACP method names / capability negotiation if the spec moved (v1 vs v2)
2. Whether Cursor’s `agent acp` argv/env needs extra flags
3. Whether Volt Settings should stay a custom editor or eventually fold into VS Code Settings
4. When ContextEngine should become P0 (large-repo quality) vs staying stub
5. Whether native tools should land before more CLI agents

The implementation follows this file. If a decision here is wrong, change the file first.
