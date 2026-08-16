Yes. I read the plan. The foundation is **very strong**, especially the separation of `ModelProvider` vs `AgentProvider`, the in-process hot path, and the unified event protocol.

But if the goal is **“open-source Cursor/Composer, any provider, local models, multiple agents, and Cursor-level responsiveness”**, there are several important pieces missing.

## The biggest architectural change I'd make

Don't think of this as just:

```text
Model Gateway
+
Agent Gateway
+
Tools
```

Make it a **5-layer runtime**:

```text
┌──────────────────────────────────────────────────────────────┐
│                         Volt UI                              │
└──────────────────────────────┬───────────────────────────────┘
                               │
                     IAgentRuntimeService
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                    SESSION ORCHESTRATOR                      │
│                                                              │
│  sessions · runs · cancellation · resume · fork · parallel  │
└───────────────┬───────────────────┬──────────────────────────┘
                │                   │
       ┌────────▼────────┐  ┌───────▼─────────┐
       │  AGENT RUNTIME  │  │  MODEL RUNTIME   │
       │                 │  │                  │
       │ Claude Code     │  │ OpenAI           │
       │ Codex           │  │ Anthropic        │
       │ Gemini CLI      │  │ Gemini           │
       │ OpenCode        │  │ OpenRouter       │
       │ ACP             │  │ Ollama           │
       └────────┬────────┘  └────────┬─────────┘
                │                    │
                └──────────┬─────────┘
                           │
                  ┌────────▼────────┐
                  │  TOOL RUNTIME   │
                  │                 │
                  │ FS · Terminal   │
                  │ LSP · Git · MCP │
                  │ Search · Browser│
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │ SECURITY LAYER  │
                  │                 │
                  │ sandbox         │
                  │ permissions     │
                  │ secrets         │
                  │ resource limits │
                  └─────────────────┘
```

Your current plan has most of this, but some pieces are implicit rather than first-class.

---

# 1. Add a `Run` abstraction

This is probably the biggest missing primitive.

You currently have:

```text
Session
```

but you need:

```text
Session
  └── Run
       ├── Turn
       ├── Tool calls
       ├── Model calls
       ├── approvals
       └── cancellation
```

For example:

```ts
interface IAgentRun {
  runId: string;
  sessionId: string;

  status:
    | 'queued'
    | 'running'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'cancelled';

  startedAt: number;
  endedAt?: number;

  provider: ProviderRef;

  abort(): void;
  pause(): void;
  resume(): void;
}
```

Why?

Because eventually you want:

```text
Chat
 ├── Run #1 → Claude
 ├── Run #2 → Codex
 ├── Run #3 → local Qwen
 └── Run #4 → reviewer
```

without confusing **conversation identity** with **execution identity**.

Your current plan already separates `sessionId` and `conversationId`; extend that idea with a first-class run.

---

# 2. Add a Provider Capability System

Don't hardcode assumptions about providers.

You need:

```ts
interface ProviderCapabilities {
  streaming: boolean;
  reasoning: boolean;
  toolCalling: boolean;
  parallelToolCalls: boolean;

  vision: boolean;
  attachments: boolean;

  promptCaching: boolean;
  structuredOutput: boolean;

  cancellation: boolean;

  contextWindow: number;

  mcp: boolean;

  nativeAgent: boolean;
}
```

Then the runtime knows:

```text
Claude
  ✓ streaming
  ✓ reasoning
  ✓ tools
  ✓ caching

Ollama model X
  ✓ streaming
  ✓ tools
  ✗ reasoning
  ✗ caching
```

This becomes extremely important for **automatic model routing**.

---

# 3. Build a Model Router

This is missing from your current design.

You have:

```text
Provider → Model
```

You eventually need:

```text
Task
 ↓
Router
 ↓
Best model
```

Example:

```ts
route({
  task: 'edit-file',
  complexity: 'medium',
  latency: 'critical',
  budget: 'low'
})
```

could choose:

```text
local Qwen → cheap/simple
Gemini Flash → fast
Claude Sonnet → complex
GPT → difficult reasoning
```

And importantly:

### Don't route every request.

Routing itself costs latency.

Use a **zero-network local classifier** or explicit mode configuration:

```text
Ask       → fast model
Plan      → reasoning model
Agent     → balanced model
Debug     → reasoning model
Autocomplete → local model
```

Your plan already mentions per-mode profiles from Roo.

Take it further into a `ModelRouter`.

---

# 4. Add Model Warm Pools

For your speed requirement, this is huge.

Don't initialize everything on demand.

Maintain:

```text
ProviderPool
 ├── OpenAI connection
 ├── Anthropic connection
 ├── Gemini connection
 ├── Ollama connection
 └── CLI processes
```

And:

```text
Claude Code
   └── warm process
Codex
   └── warm process
OpenCode
   └── warm process
```

So the first request doesn't pay:

```text
spawn
→ initialize
→ authenticate
→ load config
→ initialize SDK
→ request
```

Instead:

```text
prompt
 ↓
already-warm session
 ↓
first byte
```

For local models:

```text
Ollama
 └── keep model loaded
```

where practical.

---

# 5. Add Context Engine — this is CRITICAL

Cursor's speed isn't just networking.

A huge part is **how much context it sends**.

You need a dedicated:

```text
ContextEngine
```

with:

```text
workspace indexing
symbol extraction
file ranking
recent files
open editors
selection
diagnostics
git diff
terminal state
semantic search
```

Architecture:

```text
              ContextEngine
                   │
       ┌───────────┼───────────┐
       ↓           ↓           ↓
    Symbol      Lexical     Semantic
    index       search      search
       │           │           │
       └───────────┼───────────┘
                   ↓
             ContextRanker
                   ↓
             Token Budget
                   ↓
               Prompt
```

**Do not let every agent implement its own context gathering.**

Your runtime should own it for native agents.

This is probably the biggest missing subsystem in the current plan.

---

# 6. Add an explicit `ContextBudget`

For example:

```ts
interface ContextBudget {
  maxTokens: number;

  system: number;
  conversation: number;
  workspace: number;
  tools: number;
  retrieved: number;
}
```

Then:

```text
100k context

20k conversation
30k relevant files
10k diagnostics
10k tool output
20k system/tool definitions
10k reserve
```

When context gets tight:

```text
rank
→ drop low-value context
→ summarize
→ compact
→ continue
```

Your current plan mentions compaction, but it should become a first-class **Context Engine**, not just an agent-loop concern.

---

# 7. Tool Runtime needs a proper scheduler

Right now you have tools.

You need:

```text
ToolRegistry
ToolScheduler
ToolExecutor
ToolPermission
ToolResultStore
```

Because:

```text
read A
read B
read C
```

should become:

```text
       ┌─ read A
Agent ─┼─ read B    ← parallel
       └─ read C
```

while:

```text
write A
then
run tests
```

must remain sequential.

So build a dependency-aware scheduler:

```ts
type ToolExecutionPlan = {
  calls: ToolCall[];
  dependencies: Map<ToolCallId, ToolCallId[]>;
};
```

This will make agents noticeably faster.

---

# 8. Add a Tool Result Cache

Massive win.

```text
grep "foo"
```

then immediately:

```text
grep "foo"
```

should not necessarily execute twice.

Cache:

```text
workspace hash
+
tool name
+
normalized arguments
```

→ result.

Especially:

* `grep`
* `glob`
* file reads
* git status
* git diff
* diagnostics
* symbol lookup

Invalidate intelligently when files change.

---

# 9. Don't stream huge tool results

Your plan already mentions transfer budgets.

Go further.

Never do:

```ts
toolResult: string
```

for arbitrary 20 MB output.

Use:

```ts
interface ToolResult {
  id: string;
  summary: string;

  content?: ContentRef;

  stats: {
    bytes: number;
    lines: number;
  };
}
```

Then store large content outside the event bus.

```text
Event
 ↓
"terminal produced 4.2MB"
 ↓
ContentStore
 ↓
UI requests only visible slice
```

This keeps your event bus extremely lightweight.

---

# 10. Add `ContentStore`

This is another missing primitive.

```text
Event Bus
   ≠
Large Content Storage
```

Use:

```ts
interface IContentStore {
  put(content: Uint8Array): ContentRef;
  read(ref: ContentRef, range?: Range): Promise<Uint8Array>;
}
```

Then:

```text
tool output
file diff
terminal output
attachments
screenshots
logs
```

can all use references.

This is particularly important when you eventually support remote execution.

---

# 11. ACP should become a first-class protocol adapter

Your plan mentions ACP. Good.

I'd formalize:

```text
Provider
   │
   ├── Native API
   ├── OpenAI-compatible
   ├── CLI
   └── ACP
```

Then:

```ts
interface IAgentTransport {
  connect(): Promise<void>;
  send(...): AsyncIterable<AgentEvent>;
  cancel(...): Promise<void>;
}
```

Adapters:

```text
NativeTransport
HttpTransport
StdioTransport
ACPTransport
WebSocketTransport
```

This makes adding new agents dramatically easier.

---

# 12. Add an Agent Manifest

Instead of writing provider-specific UI logic:

```ts
{
  id: "claude-code",
  name: "Claude Code",
  type: "agent",

  capabilities: {...},

  auth: {...},

  transport: "sdk",

  executable: "claude"
}
```

Same for:

```text
codex
gemini
opencode
cursor
```

Then your UI becomes completely dynamic.

---

# 13. Authentication needs to be its own subsystem

Your current secret-store approach is correct.

But I'd make:

```text
AuthManager
 ├── APIKey
 ├── OAuth
 ├── CLI credential
 ├── environment
 ├── credential helper
 └── OS keychain
```

Resolution priority:

```text
explicit profile
↓
OS keychain
↓
CLI credential
↓
environment
↓
provider default
```

And **never expose credentials to the renderer or model context**.

---

# 14. Add Environment Isolation

This is extremely important if you're building a Cursor-like open-source product.

An agent can execute:

```bash
rm -rf ...
curl ...
git push
npm install ...
```

So you need:

```text
Tool
 ↓
Policy
 ↓
Sandbox
 ↓
Process
```

At minimum:

```text
workspace allowlist
filesystem restrictions
environment variable filtering
network policy
command approval
process timeout
memory limit
CPU limit
child-process cleanup
```

For macOS specifically, investigate native sandboxing rather than assuming a Node permission check is sufficient.

---

# 15. Add a Secret Firewall

One subtle security problem:

Agent sees:

```text
process.env
.env
AWS credentials
SSH keys
```

You need a rule:

```text
Tool output
 ↓
Secret scanner
 ↓
Redaction
 ↓
Model
```

Never blindly send:

```text
.env
~/.ssh
AWS credentials
GitHub tokens
```

into model context.

---

# 16. Add `PromptCompiler`

Don't build giant prompts in the UI.

Create:

```ts
PromptCompiler.compile({
  mode,
  model,
  workspace,
  context,
  tools,
  rules
})
```

Output:

```text
system
developer
workspace rules
tool definitions
relevant context
conversation
```

Then you can optimize each provider separately.

This also lets you implement:

```text
AGENTS.md
CLAUDE.md
.cursor/rules
.volt/rules
workspace instructions
```

without contaminating your runtime.

---

# 17. Add Rules Engine

I'd support:

```text
.volt/
  config.json
  rules/
  agents/
  modes/
```

And compatibility:

```text
AGENTS.md
CLAUDE.md
.cursor/rules
```

Your goal should be:

> **Any existing AI coding project should work inside Volt without modification.**

That's a killer open-source positioning.

---

# 18. Add Background Indexing

Never index synchronously when the user opens a workspace.

Do:

```text
Open workspace
      ↓
UI instantly usable
      ↓
background indexer
      ↓
files
symbols
AST
embeddings
git
diagnostics
```

Prioritize:

```text
open files
↓
recent files
↓
workspace structure
↓
symbols
↓
semantic embeddings
```

The agent shouldn't have to wait for indexing.

---

# 19. Use incremental indexing, not full re-indexing

Use:

```text
File watcher
 ↓
changed file
 ↓
AST update
 ↓
symbol index update
 ↓
embedding update
```

Not:

```text
file changed
 ↓
index entire repo
```

For a large repository, this difference is enormous.

---

# 20. Add speculative execution

This is where you can start getting **really fast**.

Example:

```text
Agent says:
"I'll inspect package.json and tsconfig.json"
```

You can predict likely reads and start them.

Or when a tool call starts streaming its arguments:

```text
tool.input.delta
```

you can potentially prepare the executor before the final tool call arrives—**but only for safe/read-only operations**.

Your plan already proposes eager tool fibers.

Take this carefully further.

---

# 21. Separate "thinking latency" from "execution latency"

Measure:

```text
T0 user submit

T1 runtime accepted
T2 provider request started
T3 provider first byte
T4 first UI paint
T5 tool requested
T6 tool started
T7 tool completed
T8 next model request
T9 final token
```

Then expose:

```text
TTFB
Tool latency
Model latency
Context-build latency
UI latency
```

Your existing plan already has `ttfb_provider` and `ttfb_ui`.

Add:

```text
context_build_ms
queue_wait_ms
tool_wait_ms
provider_connect_ms
serialization_ms
render_ms
```

You want a **performance flame graph for every agent run**.

---

# 22. Don't over-normalize provider events

This is subtle.

Your:

```ts
IVoltEvent
```

is good for UI.

But don't throw away provider-specific metadata.

Use:

```ts
interface VoltEventEnvelope {
  event: IVoltEvent;

  provider?: {
    rawType: string;
    raw?: unknown;
  };
}
```

Otherwise you'll eventually discover:

> “Anthropic has this useful thing, but our normalized protocol lost it.”

Normalize the **common denominator**, preserve provider extensions.

---

# 23. Add event sequence numbers

Your event needs:

```ts
{
  seq: number;
  runId: string;
  timestamp: number;
  type: ...
}
```

Then:

```text
seq 100
seq 101
seq 102
```

The UI can detect:

```text
101 missing
```

and recover.

This becomes essential for remote mode and crash recovery.

---

# 24. Add checkpoints

Don't persist every token.

Persist:

```text
user message
assistant completed block
tool call
tool result
file change
permission
run state
checkpoint
```

And:

```text
live deltas → memory only
```

Your plan already has the right live-vs-durable idea.

I'd add explicit checkpoints:

```ts
checkpoint(runId)
```

so a crashed runtime can recover.

---

# 25. Make parallel agents a first-class feature

Because you're specifically inspired by ADEs:

```text
Multitask
```

shouldn't just mean "another chat."

Build:

```ts
runtime.spawn({
  parentRunId,
  workspace,
  provider,
  task
})
```

Then:

```text
                    Parent
                      │
          ┌───────────┼───────────┐
          ↓           ↓           ↓
       Agent A     Agent B      Agent C
       Claude       Codex       Local
          │           │           │
       worktree    worktree    worktree
          └───────────┼───────────┘
                      ↓
                    Review
```

This is where Emdash/Superset/Conductor concepts become relevant.

---

# The final architecture I'd use

```text
                         VOLT
                          │
                   ┌──────▼──────┐
                   │   VS CODE   │
                   │     UI      │
                   └──────┬──────┘
                          │
                   Event subscription
                          │
                ┌─────────▼──────────┐
                │ SESSION ORCHESTRATOR│
                │                     │
                │ sessions            │
                │ runs                │
                │ forks               │
                │ cancellation        │
                │ checkpoints         │
                └─────────┬───────────┘
                          │
              ┌───────────┴───────────┐
              │                       │
       ┌──────▼──────┐        ┌───────▼───────┐
       │ AGENT       │        │ MODEL          │
       │ RUNTIME     │        │ RUNTIME        │
       │             │        │                │
       │ Claude Code │        │ OpenAI         │
       │ Codex       │        │ Anthropic      │
       │ Gemini CLI  │        │ Gemini         │
       │ OpenCode    │        │ OpenRouter     │
       │ ACP         │        │ Ollama         │
       └──────┬──────┘        │ LM Studio      │
              │               │ Any compatible │
              │               └───────┬────────┘
              │                       │
              └───────────┬───────────┘
                          │
                 ┌────────▼────────┐
                 │ CONTEXT ENGINE  │
                 │                 │
                 │ AST             │
                 │ symbols         │
                 │ lexical search  │
                 │ semantic search │
                 │ ranking         │
                 │ token budget    │
                 └────────┬────────┘
                          │
                 ┌────────▼────────┐
                 │ TOOL RUNTIME    │
                 │                 │
                 │ FS              │
                 │ terminal        │
                 │ grep            │
                 │ LSP             │
                 │ git             │
                 │ MCP             │
                 └────────┬────────┘
                          │
                 ┌────────▼────────┐
                 │ SECURITY        │
                 │                 │
                 │ permissions     │
                 │ sandbox         │
                 │ secret firewall │
                 │ network policy  │
                 │ resource limits │
                 └─────────────────┘
```

## And the most important performance rule

Your hot path should be:

```text
User
 ↓
VS Code event
 ↓
Runtime
 ↓
already-warm provider
 ↓
stream
 ↓
event
 ↓
rAF paint
```

**No HTTP. No WebSocket. No JSON serialization between your own local components. No daemon. No renderer `postMessage`.**

Your existing plan already correctly establishes this as the desktop default.

### Target

I'd set aggressive internal targets:

```text
submit → runtime accepted       < 1ms
runtime → provider request      < 5ms
provider first byte → UI paint < 16ms
interrupt → cancelled          < 50ms
tool dispatch                  < 5ms
local provider overhead        < 5ms
10k token stream               0 dropped frames
```

And track:

```text
TTFB_provider
TTFB_runtime
TTFB_UI
context_build
tool_dispatch
tool_execution
model_latency
serialization
render
```

### The 5 things I would add **before writing more provider adapters**

**1. `Run` + `Session` orchestration**
**2. `ContextEngine` + token budgeting**
**3. `ToolScheduler` + result cache**
**4. `ProviderCapabilities` + `ModelRouter`**
**5. `ContentStore` + event sequence/checkpoint system**

Those five will make the architecture much harder to paint yourself into a corner with.

And I would **not** add another abstraction layer around every provider just for architectural purity. Your plan's strongest idea is already there: **native model providers + external agent harnesses + one event protocol**. Keep that extremely thin.

If you nail **runtime + context + tools + provider adapters + security** while keeping everything in-process, you can make the open-source project feel substantially closer to **Cursor Composer than a typical VS Code AI extension**.
