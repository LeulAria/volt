# Volt orchestrator: architecture and implementation plan

**Date:** 2026-10-04 · **Status:** in progress (phases below carry their state)
**Research:** `.aInsp/research/t3code-orchestration.md` (T3 Code V2 / PR #2829),
`.aInsp/research/cursor-subagents-protocol.md` (live cursor-agent, claude-agent-acp, codex-acp captures),
`.aInsp/research/reference-orchestration-patterns.md` (opencode, Paseo, Superset, Roo, Zed, synara, zeron, pi, deepseek-harness)

## 1. What we are building

One owner for "what is every agent doing": every chat (thread), every turn, every queued prompt,
every subagent (Volt's own and the harness's), every pending approval, every handoff. It must:

- route work to the right agent or harness, and run many tasks at once across harnesses (Claude, Cursor, Codex, OpenCode, native models);
- track every agent and subagent through an explicit lifecycle, and coordinate parent ↔ child (wake the parent when children finish);
- persist state so runs survive crashes and restarts, and recover them without surprises;
- handle retries, failures, cancellations, timeouts, and manage queues and concurrency safely;
- prevent duplicate and conflicting work;
- keep the UI in sync from one derived status, never from per-view guesses.

It does **not** think, pick tools, or run them: that stays in the harness (the ACP agent or Volt's native loop).

## 2. Where Volt is today (2026-10-04, before this work)

| Area | Today | Consequence |
|---|---|---|
| Queue | `AgentEditor.promptQueue`, a view field; drained only by a *visible* panel (`pendingDrain`) | Queued prompts of a background chat never run; restart auto-sends a restored queue when the chat is shown |
| Sending | `runtime.send` cancels a live ACP run ("one run per chat") | Anything that sends while busy silently interrupts |
| Turn dispatch | `AgentEditor.dispatchPrompt` (view code) builds the transcript messages, then calls the runtime | No turn can start without a view: no headless subagents, no wake-ups |
| Subagents | Harness Task calls render as a tool row; `common/orchestration/agentTasks.ts` (Volt-owned tasks) existed but was not wired | No lifecycle, no parent wake-up, no child transcript, siblings not tracked |
| ACP protocol | `cursor/task` answered with an error; `sessionId` ignored on updates; updates between turns dropped; Claude child steps attributed to the parent | Subagent model, ids and results lost; child steps pollute the parent's work log and watchdog |
| Status | Sidebar status from the last reply's record + `attention`; composer from `isStreaming()` | "Working / waiting / queued / done" disagree between surfaces |
| Recovery | Agent processes die with the window (`voltStdioMainService` kills on reload); nothing reconciles | Stale "running" states, lost queues |

## 3. Lessons from the research

**Cursor (live probes, §1 of the protocol report).** Over ACP a Task is a `tool_call` (`rawInput._toolName:"task"`,
`description`, `prompt`, `subagentType`) and then silence until it ends (`tool_call_update completed` + a `cursor/task`
request carrying `model`, `agentId`, `durationMs`). Failures still say `completed` with `rawOutput.error`. Child
permission requests arrive on the parent session, unattributed. A second `session/prompt` mid-turn **cancels** the
running turn and its subagents. The Cursor app's "Waiting for subagent" is UI-derived. Child transcripts are written
live to `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` (best-effort progress source).

**Claude / Codex.** With AIR capability `nativeSubagentSessions` both send `subagent_spawned`, stream the child's own
`session/update`s under the child `sessionId`, ask permissions on the child session, and end with
`subagent_state_update {completed|failed|cancelled|disconnected}`. Claude queues a second prompt and supports
`_session/steering` (`{outcome:"injected"}`); Codex absorbs a second prompt and never answers the first. Rule:
**never overlap prompts; queue client-side; steer only through `_session/steering` or the native inbox.**

**T3 Code V2.** Commands → (pure-ish) decider → events + outbox effects in one transaction, per-thread serialization,
command receipts for idempotency, CAS-guarded ingestion of provider output, queue held after restart / Stop /
failure, wake deliveries ahead of user-queued prompts, harness subagents never wake the root, budgeted context
handoffs with a visible "Context handoff A → B" divider. Their open gaps we close: a child waiting on approval is
invisible to the parent, no caps on children or depth, children share the parent's checkout.

**References.** opencode's durable inbox (steer vs queue at step boundaries) and child sessions that wake the parent
with an injected notice; deepseek-harness delivers by parent state (idle → new turn, busy → steer) and caps automatic
wake-ups; Paseo drops late events by turn token; Superset "derive, don't reconcile" for UI status.

## 4. Architecture

```text
 ┌─────────────── clients ───────────────┐
 │ chat view (composer, work card, rows) │──┐
 │ MCP task tools (delegate_task, …)     │  │  typed commands (idempotent: command id, client request id)
 │ runtime observer (run/tool/input evts)│  │
 │ recovery (on start)                   │  │
 └───────────────────────────────────────┘  ▼
                         ┌──────────────────────────────────────────────┐
                         │ Orchestrator core (pure, common/orchestration)│
                         │  decide(state, cmd) → events | rejection      │
                         │  apply(state, event) → state  (projector)     │
                         │  schedule(state) → events (fixed point)       │
                         │  effectsFor(events, state) → effects          │
                         └───────────────┬──────────────────────────────┘
                 events (durable first)  │  effects (after persist)
           ┌─────────────────────────────┼──────────────────────────────────────┐
           ▼                             ▼                                      ▼
  OrchestratorStore             Effect worker                              Read models
  per-root atomic snapshot      startTurn → turn host (session            threadStatus · dockModel
  + event tail, live index,     controller; works headless)               lineage · agent rows
  receipts                      steer → runtime.steer / _session/steering        │
                                cancelTurn → runtime.cancel                       ▼
                                prepareWorktree → agentWorktreeService     UI (work card, lineage dock,
                                tasksChanged → wait_tasks long polls        subagent rows, child header/
                                         │                                  footer, handoff divider)
                                         ▼
                              AgentRuntimeService (existing): native loop / ACP provider
                              ACP provider: subagent normalization per harness (subagent.* events),
                              session routing by sessionId, steering capability, cancel cleanup
```

### 4.1 Core model (`services/voltRuntime/common/orchestration/orchestrator.ts`)

- **Thread** = a Volt chat: `active` turn (at most one), `queue`, `pause`, `blocked`, `inputs` (pending approvals and
  questions), `last` outcome, `handoffs`, `pendingHandoff`, `wakeups`, and for subagent chats `parentId`, `rootId`,
  `taskId`, `depth`.
- **Turn** = one prompt and the run answering it. Kinds: `prompt`, `notification` (Volt waking the parent with
  reports), `brief` (a subagent's first turn), `followup` (`message_task`), `resume`, `external` (a run Volt saw but did
  not dispatch, adopted so the queue waits). Phases: `dispatching → running → (cancelling) → settled`.
- **Task** = a subagent, one shape for both sources:
  `source: 'volt'` (child chat started by `delegate_task` or the Multitask composer) and `source: 'harness'`
  (Claude/Codex/Cursor's own Task). Lifecycle `queued → running ⇄ waiting → completed | failed | cancelled | interrupted`,
  `resumed` back to running by a follow-up. Delivery to the parent: `none → pending → delivered | acknowledged`.
- **Effects**: `startTurn`, `steer`, `cancelTurn`, `prepareWorktree`, `tasksChanged`.

Everything is a pure function of `(state, command)`. Commands carry `at`; ids are chosen by callers or derived from the
state's sequence. The same log always replays to the same state (tested).

### 4.2 Policies (decided in the core, never in a view)

| Policy | Rule |
|---|---|
| Submit | `auto`: idle → start, busy → queue. `queue`: always queue. `now`: steerable run → steer; otherwise stop the run and put this prompt at the queue head |
| Steerable | native loop (inbox), or an ACP agent advertising `_meta.steering.supported` (Claude, Codex) via `_session/steering`. Cursor: never (a second prompt cancels the turn and its subagents) |
| Queue drain | after a turn settles: (1) apply a pending handoff, (2) deliver subagent reports, (3) next non-held queue item. Paused queues wait for the user |
| Pause | `failed` (last turn failed; never resend into a failing provider), `interrupted` (restart), `wakeups` (too many automatic turns in a row), `stopped` |
| Wake-up | a finished Volt task with `delivery: pending` reaches its parent as: a steer into a running steerable turn, else a `notification` turn when the parent goes idle. Reports go **before** user-queued prompts. A report the parent read itself (`task_status`, `wait_tasks`) is acknowledged and never re-sent. At most `maxWakeups` (8) automatic turns in a row |
| Harness subagents | tracked by their Task call id, settle with their own end event, and anything still open settles with the parent turn. They never trigger notification turns (their parent already waits for them inside its turn) |
| Concurrency | per parent 4 running Volt subagents, 8 per window; more wait in `queued`. Depth ≤ 2. Harness subagents are the harness's choice (Cursor ran 8) |
| Dedupe / reuse | same `client_request_id` → same task; same brief + same model while live → same task; `message_task` continues an existing child (warm agent, cache hit) |
| Permissions | a child inherits the parent's access mode (global) and the mode its role allows (research/review → Ask); it never gets more than the parent |
| Child waiting on input | `task.waiting` → the parent's card shows "Needs input" with a jump to the child; `wait_tasks` returns early naming it, so the parent never blocks on it |
| Stop | stops the turn and the Volt subagents *that turn* started (`cascade: 'turn'`); "Stop all" on the card stops every live child (`cascade: 'all'`). Cancelled tasks do not wake the parent |
| Ownership | `isolation: 'worktree'` gives a child its own checkout (blocked until it exists). In a shared checkout, two live writers touching one file raise a `conflict` shown on the card until one ends; `scope` claims let the brief name owned paths |
| Handoff | `thread.handoff` (user model switch or the agent's `handoff` tool) applies immediately when idle, else when the turn ends; queued prompts follow the chat to the new model; the transcript shows "Context handoff · A → B" |
| Recovery | after a restart: every active turn → `interrupted`, its queue held (`interrupted`), pending inputs closed, running tasks interrupted (report pending to the parent, which is held too). Nothing starts on its own; the user resumes |

### 4.3 Thread status (one function: `threadStatus`)

Priority: `needsInput` > `stopping` > `starting` > `working` (active turn) > `blocked` > `interrupted` > `paused` >
`queued` > `delegating` (no turn, subagents running) > `failed` > `idle`. `busy` (Stop button) is true only with an
active turn: running subagents alone never keep a chat "working" (T3 pitfall 12, the user's "agent remains working
after final response").

### 4.4 Persistence (`OrchestratorStore`)

Per root chat, one file `voltOrchestrator/roots/<rootId>.json` written atomically after each command batch (small:
threads, queues, task records; transcripts stay in agent history). It carries the newest 200 events as an audit trail.
`voltOrchestrator/index.json` lists live roots (anything active, queued, paused, waiting, or with undelivered reports)
for recovery, plus the global sequence. Effects run only after the batch that caused them is written (outbox rule).
Reading validates every thread and task and drops damaged ones individually.

### 4.5 Turn host (headless sessions)

`AgentSessionController` gains `startTurn(spec)` (the data half of today's `dispatchPrompt`: user message + streaming
reply placeholder, history record, checkpoint, `runtime.send`). A registry keeps one controller per session id, with or
without a view (subagent chats, background queues). Views subscribe for redraws; they no longer own turn state.

### 4.6 Provider adapters: subagents across harnesses

New provider-neutral events on the runtime stream:
`subagent.spawned {childId, parentToolCallId, title, prompt, kind, model, source}`,
`subagent.event {childId, event}` (child tool calls, text, plan, kept out of the parent's step groups and watchdog),
`subagent.update {childId, model?, title?}`, `subagent.completed {childId, status, result?, error?, durationMs?}`.

| Harness | Mapping |
|---|---|
| Cursor | Task `tool_call` (`_toolName:"task"`) → spawned; `tool_call_update completed` (+`rawOutput.error` → failed) → completed; `cursor/task` → answer `{}`, update model/agentId; parent turn ends with open Tasks → cancelled |
| Claude | advertise `nativeSubagentSessions`: `subagent_spawned` → spawned; updates with `sessionId == child` → `subagent.event`; child permission requests → the child's card; `subagent_state_update` → completed. Legacy fallback: `_meta.claudeCode.parentToolUseId` attribution |
| Codex | same native shapes; legacy "Start/Complete subagent" tool calls |
| Volt (`delegate_task`) | real child chats; the orchestrator owns them |

The runtime observer turns these into `harness.*` commands, and child events feed a read-only child transcript that
opens in the right panel like a Volt child chat.

### 4.7 MCP task tools (Volt host MCP, group `tasks`)

`list_models`, `delegate_task`, `task_status`, `wait_tasks` (45 s long poll, under cursor-agent's 60 s MCP timeout;
"the timeout only bounds your wait"), `cancel_task`, `message_task`, `handoff`. Exposed to Agent and Multitask chats.

### 4.8 UI

- **Work card above the composer** (Cursor-style, shared card): "N subagents running" section (collapsible; rows with
  provider icon, status dot, title, model, current step, elapsed, Stop) and "N Queued" section (edit, send now,
  reorder, remove). Order: chips → work card → input box.
- **Transcript**: a T3-style grouped subagent card ("3 subagents · 3 working", avatar stack, elapsed), one row per
  subagent with a hover card (model, status, current step); "Waiting for subagent" tail derived from state.
- **Lineage dock** (beside the chat, rebuilt as one card with dividers): project, git (branch, Commit & push,
  Changes), "Agents · N running" (VS Code list, twistie sections, "Show N more"), "Previous agents (N)" collapsed.
  Rows carry a subagent or multitask icon; clicking opens the agent in the right panel as a tab.
- **Child chat**: "Subagent of · <parent>" header pill; footer instead of a composer while it runs
  ("<model> · Working 5m 31s · Runs on its own · Open parent").
- **Context handoff divider**: "⇄ Context handoff · Claude Opus 5.5 → GPT-6".
- **Sidebar**: per-chat status from `threadStatus`, subagent chats nested under their parent.

## 5. Issue → mechanism → test

| Issue (from the brief) | Mechanism | Test |
|---|---|---|
| Agent stays "working" after its final response because of background tasks | `busy` only with an active turn; `delegating` status for running children | `a parent that went idle wakes up…` (busy false) |
| Parent does not wake when a subagent finishes | `delivery: pending` + scheduler notification turn / steer | `…wakes up with its subagents' reports`, chaos liveness |
| Completion tracking marks siblings done | tasks keyed by id / Task call id; settle by matching id only | `harness subagents are tracked by their own Task call` |
| Permission state not inherited | child inherits access mode, role caps mode | service test (phase 2) |
| Subagent stalls the run waiting for input | `task.waiting`, card surfacing, `wait_tasks` early return | `a subagent waiting for the user is surfaced…` |
| Duplicate subagents / cache misses | client request id, live brief+model dedupe, `message_task` reuse | `a retried or repeated delegation returns the task…` |
| Orchestrator and harness subagents in one UI model | one `IOrchTask` shape, `agentRow` read model | views tests |
| Confusing working / waiting / queued / done | `threadStatus` single derivation | status assertions throughout |
| Queued messages conflicting with active execution | one active turn; Send now = steer or stop-then-head; never overlap prompts | `Send now steers…`, chaos invariant I1 |
| Parent surfaces child failures | failed report in notification text, card error row | `a failed subagent reports its error to the parent` |
| Shared context across collaborating agents | `task_status` lists sibling reports under one root; reports carry files changed | phase 3 |
| Pin work to a machine/runtime | tasks carry their chat; browser tools are per chat; placement field reserved | n/a (local only today) |
| Survive disconnects | durable roots; agents die with the window today → interrupted + Resume; phase 5 detaches agent hosts | recovery tests |
| Persist and recover runs | per-root snapshots, index of live roots, `recover` command | recovery + codec tests |
| Background tasks tracked separately | harness subagents and Volt tasks are rows; dev servers never hold status | views tests |
| Explicit lifecycle spawned → running → waiting → done | `OrchTaskState` + events | all subagent tests |
| Model/harness mixing without corrupting state | handoff deferred until idle; queue follows; one session per thread | `a handoff waits for the turn to end…` |
| Task ownership / conflicting work | worktree isolation, conflict detection, scope claims | `parallel subagents editing the same file…` |
| Resume interrupted agents | `turn.resume`, held queue, interrupted tasks resumable with `message_task` | recovery test |
| Parent/child relationships across many agents | `parentId`/`rootId`/`depth`, unique child ids | chaos invariants I2–I3 |

## 6. Testing

1. **Scenario tests** (`test/common/orchestration/orchestrator.test.ts`): one per behavior above.
2. **Chaos / property tests** (`orchestratorChaos.test.ts`): seeded random interleavings of user commands, runtime
   starts/settles (including stale, duplicated and out-of-order ones), spawns, cancels, follow-ups, inputs, harness
   subagent events, handoffs, crashes (`recover`) and duplicate command ids. After every command: structural
   invariants (one active turn, unique queue ids, caps, delivery rules, harness tasks die with their turn, scheduler
   fixed point). After the run: replay equality, codec round trip, determinism (same seed, same state), and liveness
   (drive to quiescence: no active turns, no undelivered reports, every Volt task terminal).
3. **ACP replay fixtures** for the subagent protocols (Cursor Task + `cursor/task`, Claude native sessions, Codex),
   recorded in `.aInsp/research` captures, run through the provider mapper.
4. **Service tests** with a fake runtime: headless turns, queue drain without a view, wake-ups, persistence
   round trip through the file service, recovery after a simulated reload.
5. **Live chaos runs** in a throwaway repo with real harnesses (Cursor, Claude) via CDP: parallel subagents, queue
   while busy, Stop mid-delegation, reload mid-run, handoff mid-thread.

## 7. Phases

| Phase | Scope | State |
|---|---|---|
| 1 | Core: types, decider, scheduler, projector, views, codec, recovery; scenario + chaos tests (4,000 seeds × 260 steps clean) | done |
| 2 | Service: store, effect worker, runtime observer, turn host + headless sessions, editor queue moved to the orchestrator, MCP task tools | done |
| 3 | ACP: native subagent sessions (Claude/Codex), child-session routing, `cursor/task`, `_session/steering`, late permission rejection, Task failure from `rawOutput.error` | done |
| 4 | UI (Cursor look): transcript subagent rows, work card (subagents + queue), report cards, handoff divider, subagent chat header + status bar, lineage dock (Agents / Previous agents), child chats open in the right panel | done |
| 5 | Survive reloads: agent processes detached from the window with a reconnect grace (main process buffers output, renderer re-attaches by session id) | design only |
| 6 | Follow-ups: Cursor child transcript tailing (live steps for Cursor's own subagents), "Apply branch" action for worktree subagents, sidebar statuses for delegating/paused chats, read-only transcripts of Claude/Codex native children | next |

### Where the code is

- Core (pure): `src/vs/workbench/services/voltRuntime/common/orchestration/` (`orchestrator.ts`, `orchestratorDecider.ts`, `orchestratorProjector.ts`, `orchestratorViews.ts`, `orchestratorCodec.ts`, `agentTasks.ts`, `harnessSubagents.ts`)
- Service and store: `src/vs/workbench/services/voltRuntime/browser/orchestration/`
- Turn host (headless turns): `src/vs/workbench/contrib/voltAgent/browser/orchestration/agentTurnHost.ts`
- UI: `chrome/agentSubagents.ts`, `chrome/agentLineageDock.ts`, `composer/agentComposerQueue.ts`, `editor/agentEditor.ts`, `media/agentSubagents.css`
- Tests: `test/common/orchestration/orchestrator.test.ts` (scenarios), `orchestratorChaos.test.ts` (`VOLT_CHAOS_SCALE=25` for a long hunt), `test/browser/agentOrchestratorService.test.ts`, new cases in `acpProvider.test.ts`, `agentHistoryRestart.test.ts`, `agentSessionController.test.ts`

### Bugs the chaos tests found (all fixed)

1. A follow-up to a finished subagent resumed it past the concurrency limit.
2. A cancelled turn still unwinding could settle the next round of the same task.
3. Follow-ups queued on a subagent that failed or was stopped were stranded.
4. A retried *rejected* command could act (rejections now leave a receipt).
5. Typing into a finished subagent's chat ran it outside the slot limits.
6. A grandchild's report could reach a parent subagent that had already finished and never be delivered.
7. Pruning old tasks orphaned grandchild chats (pruning is now bottom-up).
8. Stopping a subagent from its own chat left its children running with nowhere to report.
9. A subagent whose brief was removed before it started stayed "running" forever.
10. A worktree subagent resumed after a failed checkout never asked for the checkout again.

Live testing found: Claude Task calls classified as exploration (never drawn as subagents), duplicate step rows for subagent calls, the compact side-chat chrome hiding subagent transcripts, and a history index left "running" when a window closed inside its debounce (now reconciled from the log at startup).

## 8. Risks and decisions

- **Renderer-owned orchestrator.** Agents already live and die with the window, so the orchestrator lives beside the
  runtime in the renderer and persists per root. Two windows on the same root would both write it: a root records its
  owner window and a heartbeat; another window only reads a live root it does not own. Moving agent hosts and the
  orchestrator to the main process (T3 pitfall 18) is phase 5.
- **No auto-resume on launch.** A restart never spends tokens on its own (T3 pitfall 5); interrupted chats show Resume.
- **Cursor subagent progress** is invisible over ACP; the card shows start, end, model and duration. Tailing Cursor's
  transcript files is a best-effort later step.
- **Hot reload** in dev swaps modules into running windows; test with a reloaded window, never mid-run.
