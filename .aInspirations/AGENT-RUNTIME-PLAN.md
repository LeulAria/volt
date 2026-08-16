# Volt Agent Runtime — Implementation Plan

**Goal:** Cursor-speed streaming + every major model/agent from one harness.  
**Constraint:** `voltAgent` is UI-only today (`runMockThinking`). Workbench already has `ILanguageModelsService`, `ILanguageModelToolsService`, `IMcpService`, `IChatProgress`. Reuse those. Do not fork Cline/Roo into the editor.

**Clones:** `.aInspirations/{opencode,cline,Roo-Code,t3code}`

---

## 0. Steal map

| Repo | Steal | Skip |
|------|--------|------|
| **OpenCode** | `LLMEvent` union, route=protocol+endpoint+auth, session coordinator, live-delta vs durable-ended, eager tool fibers, openai-compatible local route | Effect-TS, V1/V2 dual runtime, HTTP-as-default |
| **Cline** | Gateway+lazy factories, stateless `AgentRuntime`, `ToolPolicy`+live approval, `content_start/update/end`, in-process host, MCP `server__tool` | Hub daemon, gRPC/proto, 2.7k-line translator, published npm split |
| **Roo-Code** | Profile registry, per-mode profile map, secret-key routing, `RouterProvider`+model cache, mode→tool-group filter, MCP hub | Giant `switch`, flat `apiKey` collision, webview `postMessage` |
| **T3 Code** | `ModelProvider` ≠ `AgentProvider`, CLI adapter SPI, ACP stdio wrap, probe/detect, HTTP snapshot + WS delta (remote only) | Effect RPC, event-sourcing everything, standalone server for desktop |

**Hard rule:** Claude API ≠ Claude Code. OpenAI API ≠ Codex CLI. Two interfaces.

---

## 1. Target architecture

```
                         VOLT WORKBENCH UI
                    (voltAgent editor — already exists)
                                 │
                    IAgentRuntimeService.subscribe()
                    in-process Event  (NO HTTP / NO gRPC)
                                 │
                    ┌────────────▼────────────┐
                    │     AGENT RUNTIME        │
                    │  session · loop · perms  │
                    └────────────┬────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
       Model Providers     Agent Providers      Local
       (raw LLM APIs)      (CLI harnesses)      (Ollama / LM Studio)
              │                  │                  │
     OpenAI Anthropic      Claude Code         native Ollama
     Gemini OpenRouter     Codex CLI           openai-compat :1234
     Kimi DeepSeek         Gemini CLI          custom baseURL
     Groq Fireworks        OpenCode            llama.cpp
                           Cursor ACP
```

**Speed path (desktop, default):**

```
UI ── Event ── Runtime (same Electron process) ── Provider socket
                  ▲
                  └── first token painted immediately
```

**Remote path (later only):** T3-style HTTP snapshot + WS `afterSequence` deltas. Never put HTTP on the local hot path.

---

## 2. Two provider kinds

```ts
// MODEL = tokens. AGENT = a harness with its own tools/auth/compaction.

interface IModelProvider {
  readonly id: string;
  readonly kind: 'api' | 'local' | 'openai-compat';
  detect(): Promise<IDetectResult>;
  listModels(): Promise<IModelInfo[]>;
  stream(req: IModelRequest, token: CancellationToken): AsyncIterable<IModelEvent>;
}

interface IAgentProvider {
  readonly id: string;
  readonly kind: 'cli';
  detect(): Promise<IDetectResult>;          // which + version + auth
  authenticate(): Promise<IAuthResult>;
  start(req: IAgentStartRequest): Promise<IAgentSession>;
  send(session: IAgentSession, msg: IAgentMessage, token: CancellationToken): AsyncIterable<IAgentEvent>;
  interrupt(session: IAgentSession): Promise<void>;
  dispose(session: IAgentSession): Promise<void>;
}
```

UI never talks to either. UI talks to `IAgentRuntimeService` only.

---

## 3. One event protocol

All backends normalize to this. UI renders this. Persistence stores this.

```ts
type IVoltEvent =
  | { type: 'run.start'; runId: string; mode: VoltMode }
  | { type: 'text.start' | 'text.delta' | 'text.end'; id: string; delta?: string }
  | { type: 'reasoning.start' | 'reasoning.delta' | 'reasoning.end'; id: string; delta?: string }
  | { type: 'tool.start'; callId: string; name: string }
  | { type: 'tool.input.delta'; callId: string; delta: string }
  | { type: 'tool.end'; callId: string; result?: unknown; error?: string }
  | { type: 'file.change'; uri: URI; kind: 'edit' | 'create' | 'delete' }
  | { type: 'permission.ask'; id: string; tool: string; payload: unknown }
  | { type: 'usage'; input: number; output: number; cache?: number }
  | { type: 'error'; message: string; retryable?: boolean }
  | { type: 'run.end'; runId: string; reason: 'done' | 'abort' | 'fail' };
```

**Live vs durable (OpenCode):** `*.delta` is live-only. Persist `*.end` + tool/file/permission. Replay = durable log + no flicker.

**Map into existing `IChatProgress`** (`markdownContent`, `thinking`, `toolInvocation`, `textEdit`, `elicitation`) so chat/inline chat can consume the same stream later.

---

## 4. Where it lives in Volt

```
src/vs/workbench/services/voltRuntime/
  common/
    events.ts              IVoltEvent
    modelProvider.ts       IModelProvider
    agentProvider.ts       IAgentProvider
    runtime.ts             IAgentRuntimeService
    session.ts             IVoltSession
    permissions.ts         IPermissionPolicy
    profiles.ts            IProviderProfile
  node/                    Electron / shared-process only
    loop/agentLoop.ts
    gateway/modelGateway.ts
    gateway/agentGateway.ts
    providers/api/{openai,anthropic,gemini,openrouter,kimi,compat}.ts
    providers/local/{ollama,lmstudio}.ts
    providers/cli/{claude,codex,gemini,opencode,cursorAcp}.ts
    tools/{fs,terminal,grep,lsp}.ts
    auth/secretStore.ts
  electron-browser/
    voltRuntime.contribution.ts   register services

src/vs/workbench/contrib/voltAgent/browser/
  agentEditor.ts           REPLACE runMockThinking() with runtime.subscribe()
```

**Process rule:** Runtime + CLI spawn + HTTP to providers run in **node/electron**, not the renderer. UI gets `Event<IVoltEvent>` over existing workbench IPC (already zero-copy-ish vs HTTP).

Reuse:

| Existing | Use as |
|----------|--------|
| `ILanguageModelsService` | Optional vendor registration for Copilot/extension models |
| `ILanguageModelToolsService` | Built-in + MCP tool execution |
| `IMcpService` / `McpHub` | Do not rebuild MCP |
| `ISecretStorage` | API keys / refresh tokens |
| Terminal / `runInTerminalTool` | CLI + bash tool |
| `ChatModeKind` | Extend with Plan/Debug/Multitask |

---

## 5. Speed (non-negotiable)

| Rule | Why |
|------|-----|
| In-process Event, no HTTP/gRPC/webview for local | Cline `backendMode: "local"` — this is the Cursor feel |
| Stream first byte, never wait for full response | Paint `text.delta` in the same frame |
| Eager tools: start fiber on `tool.start`, await after stream | OpenCode — hides tool latency under remaining tokens |
| One classifier before retry | Cline stream-part classification — kills empty-UI bugs |
| Coalesce deltas (~16ms / 24k chars) then flush | T3 — fewer layout thrash, still feels instant |
| Prompt-cache key = sessionId | OpenCode — cheaper + faster subsequent turns |
| Lazy-import provider SDKs | Cline `builtins-runtime` — startup stays small |
| Ollama: native API + long first-byte timeout, never cut body | Cline — local models stall on load, not on stream |
| Transfer budget: do not ship raw tool blobs to UI | T3 CI cap — UI gets projected activity, not 5MB JSON |
| Snapshot + delta only if remote | T3 — local needs neither |

**Anti-patterns:** UI → HTTP → backend → provider. Hub daemon. Translating events twice. Waiting for tool JSON to finish before starting the tool.

---

## 6. Provider matrix (ship order)

### Model (API / local)

| id | type | P0 | notes |
|----|------|----|-------|
| `openai` | API | 🔥 | Responses API + tools |
| `anthropic` | API | 🔥 | prompt cache + thinking signatures |
| `gemini` | API | 🔥 | |
| `openrouter` | router | 🔥 | 200+ models, Kimi/DeepSeek/etc for free |
| `openai-compat` | API | 🔥 | any `baseURL` (Kimi, Groq, Fireworks, Together, custom) |
| `ollama` | local native | 🔥 | not via `/v1` |
| `lmstudio` | local compat | 🔥 | `http://localhost:1234/v1` |
| `kimi` | API | 🟢 | Moonshot; also via OpenRouter |
| `bedrock` / `vertex` | cloud | 🟢 | after P0 |

### Agent (CLI harness)

| id | wrap | P0 | notes |
|----|------|----|-------|
| `claude-code` | Anthropic agent SDK / `claude` | 🔥 | in-process SDK if possible |
| `codex` | long-lived app-server | 🔥 | own `CODEX_HOME` per instance |
| `gemini-cli` | CLI / ACP | 🔥 | |
| `opencode` | spawn `opencode serve` + SDK | 🔥 | T3 pattern |
| `cursor-acp` | ACP stdio `agent acp` | 🟢 | T3 `AcpSessionRuntime` |
| `cline` / `roo` | CLI | ⚪ later | |

**Adding a model provider:** implement `IModelProvider`, `register()` on the gateway. No central switch.  
**Adding a CLI:** implement `IAgentProvider` (detect/start/send/interrupt/dispose). Map stdout/SDK → `IVoltEvent`.

---

## 7. Agent loop (native path)

Used when the user picks a **model** (API/local). Not used when they pick a **CLI agent** (that harness owns the loop).

```
send(message)
  persist user turn
  while iteration < max:
    stream(model) ──► emit text/reasoning/tool.input deltas
    if no tool calls → end
    for each tool (parallel unless denied):
      permission.ask if policy says so
      execute (eager if already started)
      append tool result
    compact if context pressure
  emit run.end
```

Steal: Cline `AgentRuntime` (stateless) + OpenCode coordinator (one drain per session, wake-coalesce, interrupt). Persistence lives **outside** the loop.

Modes (from current UI: Agent / Plan / Debug / Multitask / Ask):

| Mode | tools | approval |
|------|-------|----------|
| Agent | fs, terminal, grep, lsp, mcp | ask on write/bash |
| Plan | read, grep, lsp | deny writes; ask bash |
| Ask | read, grep | deny writes/bash |
| Debug | + terminal, logs | ask writes |
| Multitask | spawn sub-sessions | ask |

Roo: `mode → tool groups → filter`. Per-mode profile map (`modeApiConfigs`) so Plan can be a cheap model.

---

## 8. CLI adapter (T3 pattern)

```
detect()  → which + version + auth status   (bounded spawn, timeout, max bytes)
start()   → long-lived child OR SDK handle
send()    → prompt / ACP session/prompt
stream    → parse SDK/ACP/JSONL → IVoltEvent
interrupt → SIGINT / session/cancel / SDK abort
dispose   → kill process group, drop handles
```

| CLI | mechanism |
|-----|-----------|
| Cursor / Gemini-ACP | stdio JSON-RPC (`effect-acp` idea, no Effect) |
| Claude Code | `@anthropic-ai/claude-agent-sdk` `query()` if available, else CLI |
| Codex | long-lived app-server process |
| OpenCode | spawn server, wait “listening”, talk SDK on localhost |

Probes are **not** the session process. Never block UI on `--version`.

---

## 9. Auth + profiles

```
IProviderProfile {
  id, label
  kind: 'model' | 'agent'
  providerId
  modelId?
  endpoint?: { baseURL }
  credentials: ApiKey | OAuth | Aws | Vertex | None
}
```

- Secrets → `ISecretStorage` via a **key registry** (Roo `SECRET_STATE_KEYS`). Never `settings.json`.
- Named profiles, not one global key. Multiple OpenRouter accounts / two Claudes.
- OAuth: `volt://` URI handler (OpenRouter) or localhost callback (Codex/Gemini CLI).
- Detect CLI auth; do not reimplement `claude auth login` — surface status + “open provider login”.
- Enterprise allowlist later (Roo `ProfileValidator`).

---

## 10. Permissions

```
effect: allow | deny | ask
scope:  once | session | workspace | always
```

Layers (fail closed):

1. Mode tool-group filter  
2. `ToolPolicy.autoApprove`  
3. Live `requestApproval()` (re-read settings mid-run — Cline)  
4. MCP `alwaysAllow` / `disabledTools`  
5. File-regex (Roo edit group)

UI: `permission.ask` → existing elicitation/confirm widgets. Core never opens a modal.

---

## 11. Tools + MCP

**Native tools (runtime-owned, Volt implementations):** read, write/apply_patch, grep/glob, terminal (reuse `runInTerminalTool`), lsp/diagnostics, git.

**MCP:** wrap `IMcpService`. Names: `mcp__{server}__{tool}` (Cline) with Roo-style hyphen/underscore normalize. Do not start a second MCP client.

**CLI agents:** do **not** inject Volt tools into Claude Code/Codex. They have their own. Only project their tool events into `IVoltEvent` for the UI.

---

## 12. Session

```
IVoltSession {
  sessionId          // host routing
  conversationId     // transcript identity (Cline split — keep it)
  mode, profileId
  provider: { type: 'model' | 'agent', id, modelId? }
  messages[]         // durable
  live?: IVoltEvent  // current stream overlay
}
```

- Allocate id on start; persist after first user turn.  
- Interrupt = cancel token + provider `interrupt()`.  
- Resume CLI via provider `resumeCursor` (T3) stored on session.  
- Compaction = `prepareTurn` projection; canonical log stays append-only (Cline).

---

## 13. UI wiring (replace the mock)

Today: `agentEditor.send()` → `runMockThinking()`.

Replace with:

```
send()
  session = runtime.getOrCreate(this.sessionKey)
  runtime.send(session.id, { text, mentions, mode, profileId })
  this._store.add(runtime.onEvent(session.id, e => this.applyEvent(e)))
```

`applyEvent`:

| event | UI |
|-------|-----|
| `reasoning.*` | existing thinking block |
| `text.delta` | append to agent message (rAF coalesce) |
| `tool.*` | activity row (Read / Grep / Terminal) |
| `file.change` | changes chip + diff |
| `permission.ask` | inline approve/deny |
| `run.end` | duration, stop spinner |

Model picker: live list from `modelGateway.list() + agentGateway.detect()`. Kill hardcoded `MODEL_OPTIONS`.

---

## 14. Implementation steps

### Step 1 — Contracts (1–2 days)

Add `voltRuntime/common/` types: `IVoltEvent`, `IModelProvider`, `IAgentProvider`, `IAgentRuntimeService`, `IProviderProfile`, `IPermissionPolicy`.  
No IO. Unit-test event guards + reducers (session state from event list).

### Step 2 — Runtime skeleton + UI swap (2–3 days)

`AgentLoop` with a **fake** model that streams tokens.  
`IAgentRuntimeService` in-process.  
Delete `runMockThinking`. Wire `send()` → subscribe.  
**Exit:** typing in voltAgent shows real streamed text. Proves the speed path before any vendor SDK.

### Step 3 — Model gateway P0 (3–5 days)

Registry `Map<id, factory>` (not a switch).  
Implement: `openai`, `anthropic`, `gemini`, `openrouter`, `openai-compat`.  
Normalize each SDK stream → `IModelEvent` → loop → `IVoltEvent`.  
Secret store + one “Add provider” profile UI.  
**Exit:** BYOK OpenAI/Anthropic/Gemini/OpenRouter/Kimi-via-router all stream in the pane.

### Step 4 — Local models (1–2 days)

`ollama` native (list tags, `num_ctx`, long TTFB).  
`lmstudio` + generic compat (`baseURL`).  
Detect `127.0.0.1:11434` / `:1234` on startup, show in picker if up.

### Step 5 — Tools + permissions (3–4 days)

Register read/write/grep/terminal against `ILanguageModelToolsService`.  
Loop executes tools; emit `tool.*` + `file.change`.  
Permission ask/allow/deny with session memory.  
Plan mode = read-only filter.  
**Exit:** Agent mode can edit a file with a confirm.

### Step 6 — CLI agent gateway (4–6 days)

`IAgentProvider` + process supervisor (spawn, pgid kill, timeouts).  
Order: Claude Code → Codex → Gemini CLI → OpenCode.  
ACP helper shared by Cursor/Gemini-ACP.  
Detect panel: installed / version / auth.  
**Exit:** picking “Claude Code” streams that CLI’s events in the same UI.

### Step 7 — MCP + modes + profiles (2–3 days)

Attach `IMcpService` tools into the native loop.  
`.voltmodes` (Roo `.roomodes` shape) + per-mode profile.  
Model picker grouped: **Models** vs **Agents**.

### Step 8 — Fast path hardening (2–3 days)

rAF coalesce, first-token metric, prompt-cache keys, stream classifier + retry, transfer budget (project tool results), interrupt <50ms, session replay without re-streaming deltas.

### Step 9 — Optional remote gateway

Only if mobile/web needs the same runtime. T3: HTTP snapshot + WS deltas + scoped subscribe. Desktop stays in-process.

---

## 15. File-level first PR

```
voltRuntime/common/events.ts
voltRuntime/common/runtime.ts
voltRuntime/node/loop/agentLoop.ts
voltRuntime/node/gateway/modelGateway.ts
voltRuntime/node/providers/api/openai.ts          # first real provider
voltRuntime/electron-browser/voltRuntime.contribution.ts
voltAgent/browser/agentEditor.ts                  # drop mock
```

After that, one provider or one CLI per PR. Do not land a mega-port.

---

## 16. Test the speed

| probe | target |
|-------|--------|
| keystroke → first `text.delta` painted | < 200ms after provider first byte |
| local IPC hop | 0 HTTP; Event only |
| interrupt | < 50ms to `run.end` abort |
| 10k-token stream | no dropped frames (coalesce) |
| Ollama cold start | first-byte timeout ≥ 60s; body uncapped |

Log `ttfb_provider` and `ttfb_ui` separately. If `ttfb_ui - ttfb_provider` > 16ms, the hop is wrong.

---

## 17. Do not do

- Copy Cline/Roo/OpenCode into `contrib/`.  
- One class that is both “call Anthropic” and “run Claude Code”.  
- Webview + `postMessage` for voltAgent (you already own the workbench).  
- Effect-TS or a mandatory Node WebSocket server on desktop.  
- Flat `apiKey` field shared across providers.  
- Re-implement MCP.  
- Wait for full assistant message before render.  
- Giant `switch (provider)` factory.

---

## 18. Decision recap

```
voltAgent UI
    │  IAgentRuntimeService  (in-process, events)
    ▼
Native loop ──────────── OR ──────────── CLI adapter
    │                                      │
IModelProvider.stream()              IAgentProvider.send()
    │                                      │
OpenAI Anthropic Gemini              claude  codex  gemini
OpenRouter Kimi-compat               opencode cursor-acp
Ollama LM Studio
    │                                      │
    └──────────── IVoltEvent ──────────────┘
                      │
                 one renderer
```

Ship Step 2 first. If that path is not instant, nothing later will feel like Cursor.
