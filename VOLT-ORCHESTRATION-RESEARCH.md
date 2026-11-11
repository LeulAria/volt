# Multi-agent orchestration research for Volt (2026-11-09)

**Legend.**
- **[V]** = verified: I read the source or the official docs/changelog (cloned at HEAD today where noted).
- **[C]** = community reverse-engineering.
- **[S]** = secondary source.
- **[I]** = my inference.

**Landscape changes worth knowing first:**
- Conductor is joining Meta. Its cloud product terminates on 2026-11-20 and the app is discontinued in early 2027.
- Vibe Kanban's company (Bloop) shut down on 2026-04-10. The project is now community-maintained.
- coder/agentapi has been deprecated (2026-09-13). coder/mux was renamed **Xum**.
- Crystal has been replaced by Nimbalyst.
- A2A v1.0 renamed every method.
- Claude Code removed `TeamCreate`/`TeamDelete` in v2.1.178.

## 1. herdr (herdr.dev, github.com/ogulcancelik/herdr, mirror herdrdev/herdr)

**Status of evidence:** VERIFIED. Cloned HEAD `ee5bfb5` (2026-10-29), read `skills/herdr/SKILL.md`, `docs/next/website/src/content/docs/{socket-api,agents,agent-automation,integrations,add-herdr-support,persistence-remote,connecting-machines,session-state}.mdx`, `src/detect/manifests/claude.toml`, `src/api/wait.rs`, CHANGELOG (latest 0.9.5, 2026-10-14). Apache-2.0, Rust + Ratatui, vendored ghostty-vt for terminal emulation.

### Architecture
- **It is a terminal multiplexer, not an orchestrator.** A persistent background *server* owns PTYs (workspaces → tabs → panes, BSP layouts); TUI clients attach/detach (`ctrl+b q`). "herdr doesn't wrap or replace [agents]; it owns their terminals." Supports ~25 agent kinds (claude, codex, cursor, opencode, gemini, copilot, pi, droid, amp, kimi, qwen, grok, devin...).
- **Control plane = newline-delimited JSON over a Unix socket** (`~/.config/herdr/herdr.sock`, named sessions get their own socket). Dot-notation methods (`pane.split`, `agent.prompt`, `events.subscribe`...). The CLI (`herdr pane|agent|workspace|worktree ...`) is a thin wrapper returning JSON; `herdr api schema --json` emits a full JSON Schema of requests/responses/events.
- **Agents control other agents by shelling out to the same CLI.** Every pane inherits `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID`. A bundled *skill* (`skills/herdr/SKILL.md`) teaches an agent the CLI. No MCP server, no message bus, no files — **the "message" is a prompt typed into the other agent's TUI** and the "reply" is read back from its screen.
- **State detection (the core IP):** two sources, hook reports win over screen rules.
  1. *Screen manifests*: per-agent TOML rules (`src/detect/manifests/claude.toml`, versioned e.g. `2026.10.11.1`) matching regions such as `osc_title`, `bottom_non_empty_lines(12)`, `last_non_empty_above_prompt_box` with regex/contains/any/not, priorities, and `skip_state_update` (e.g. transcript viewer). Example: Claude working = OSC title starts with braille/half-circle spinner; blocked = approval form. **Manifests hot-update from herdr.dev without a binary release**; local overrides in `~/.config/herdr/agent-detection/<agent>.toml`; `herdr agent explain <target> --json` shows which rule matched and why.
  2. *Integration hooks*: `herdr integration install claude|codex|opencode|...` writes hook scripts (Claude `SessionStart` hook → reports session id; OpenCode/Pi/Kimi/Kilo report full lifecycle state). Note: v0.9.5 *removed* Codex turn hooks and went back to screen detection (timeout warnings).
- **States:** `idle | working | blocked | done | unknown`. `done` = idle but not yet *seen* by a human (server-side seen flag; focus marks seen, reads don't). `completion_seq` == the `state_change_seq` of the idle transition that represents completed work (startup / session restore do not count). Blocked detection is deliberately strict (only known approval/question UIs); unmatched known-agent screens fall back to idle and are labelled `default_known_agent_idle_fallback`.
- **Persistence:** server ignores SIGHUP; session shape saved atomically (write-then-rename); on restart panes are recreated and agents **natively resumed** using the `resume_argv` the integration reported (`claude --resume <id>`, `copilot --resume=<id>`...). Experimental **live handoff** transfers live PTY fds to a new server binary (batches >64 panes) so agents survive upgrades.
- **Remote:** `herdr --remote host` (remote server owns PTYs, local client renders) and *saved machines* (`herdr machine add`), combined agent list across machines, independent reconnects with exponential backoff to 2 min, app-level health probes, SSH ControlMaster reuse (`ControlPersist 600`), SSH compression, `surface_interest` capability so **only the selected machine streams pane screens; others stream only state/notifications**. Remote API forwarding: `herdr --machine <label> agent prompt reviewer "..." --wait`. "A connection failure does not prove a mutation was not applied: inspect remote state before retrying"; API retries connection setup at most once and never repeats a possibly-mutating request.
- **Concurrency limits / councils / broadcast:** NONE found in source or docs (grep for council/debate/broadcast/concurrency returned only plugin-command and internal hits). Herdr leaves orchestration policy to the calling agent/script. (Third-party blogs claiming "inter-agent scheduling" are describing the prompt/wait primitives.)

### Communication primitives (exact)
| Primitive | Semantics |
|---|---|
| `agent start <name> --kind codex --pane <id> [-- args]` | Launch in an existing shell pane; returns only after detection says *ready* (30 s default, 3–300 s). Startup-blocked → `agent_not_ready`. Names `[a-z][a-z0-9_-]{0,31}`, unique among live agents, follow the occupant. |
| `agent prompt <name> "text" --wait [--until S] --timeout ms` | Bracketed-paste + Enter as **one ordered submission**; **prompt+wait in one request to avoid race**. Refuses with `agent_blocked` (no bytes sent) if target sits on an approval dialog. Must observe `working`/`blocked` within **5 s** or returns `agent_prompt_stalled`. Then waits for first settled `idle/done/blocked`. |
| `agent wait <name> --until blocked|done|...` | Server-owned, event-driven; **pins the resolved pane occupant so a replacement agent can't satisfy the wait**. Returns immediately if already in state. |
| `agent read <name> --source visible|recent|recent-unwrapped|detection --lines N` | Read screen. For alt-screen TUIs (Claude, OpenCode) it *scrolls the app via mouse-wheel events* to collect history, then restores viewport; returns `agent_not_idle` if busy. Fallback recommended in skill: ask agent to write answer to a temp `.md` and reply with the path. |
| `agent send-keys <name> esc|ctrl+c|...` | Validated logical keys for dialogs. |
| `pane run / send-text / send-keys / wait-output --match|--regex` | Raw terminal control for non-agent processes (tests, servers). |
| `events.subscribe` / `events.wait` | Long-lived subscription: `pane.agent_status_changed`, `pane.output_matched`, `pane.exited`, `worktree.created`...; on ring-buffer overrun server sends `events_lost` and closes; client must resubscribe + `session.snapshot` and treat events as *invalidation signals*, not replayable deltas. |
| `pane.report_agent {source, agent, state, message, seq, resume_argv}` | How any agent self-reports. `seq` must be monotonic per source (timestamp OK) — stale/out-of-order reports ignored. `pane.release_agent` on exit; server clears automatically when shell prompt returns. |
| `notification.show {title, body, sound}` | Toast; results `shown|rate_limited|no_foreground_client|busy`. |
| `worktree.create/open/remove` | Git worktree = workspace; never deletes branch. |
| `layout.apply` | Declarative BSP tree of panes with cwd/env/argv (recreates structure, not processes). |
| `agent.view.set` | Declarative filter/sort over agent facts for the sidebar (e.g. attention desc, state_change_seq desc). |

### What's genuinely clever
1. **Data-driven, hot-updatable state-detection manifests + `explain`** — decouples "is the agent busy/blocked" from binary releases; debuggable.
2. **Prompt-and-wait as one atomic server op** with a 5 s "activity observed" gate (`agent_prompt_stalled`) and occupant pinning — kills the classic race (prompt sent, wait starts after agent already finished; or wait satisfied by stale idle).
3. **`blocked` is a first-class state and prompting a blocked agent is refused** (never type into a permission dialog).
4. **`done` vs `idle` via server-side "seen" + `completion_seq`** — distinguishes "finished work you haven't looked at" from "sitting idle".
5. **Monotonic `seq` on self-reports** to drop late hook reports.
6. **`resume_argv` per pane** reported by the agent itself → crash/restart restores the *native* conversation.
7. **Selective streaming across machines** (`surface_interest`): full screen only for the focused machine, state-only for the rest.
8. **Idempotency honesty:** timeouts never imply "not delivered"; skill tells agents to read before re-sending.

### Adopt in Volt
- Volt has ACP so you don't need screen scraping for ACP agents — but **keep a herdr-style manifest detector as a fallback for any agent run as a raw PTY** (Cursor/Gemini without ACP modes, user-launched CLIs in terminals), with `explain` output.
- Make `message_task` / `delegate_task` support **`wait: {until:[idle,blocked,done], timeout_ms}` in the same call**, with an activity-gate (`stalled` error) and target-occupant pinning by `(task_id, turn_seq)`.
- Add `blocked` (needs-human/permission) as a first-class task state, refuse to inject prompts into a blocked task, and surface it to the parent as a distinct wake-up reason.
- Add `seen`/`completion_seq` to turns so the UI and parent distinguish "completed-unreviewed" from "idle".
- Persist `resume_argv`/ACP `sessionId` per task for native resume after agent-server restart.
- For remote devices: stream full transcript only for the focused device; others send state deltas only.

### Pitfalls
- Screen scraping is inherently brittle (new prompt shapes read as `idle` → automation can type into an approval dialog; the docs warn explicitly).
- Waits track lifecycle *state*, not individual turns; agents with background subagents (Antigravity/Grok, Claude background tasks) can look idle while work continues.
- Reading long answers back off a TUI is lossy — even herdr falls back to "write it to a file and give me the path".
- No structured result channel, no task graph, no concurrency control, no councils — orchestration intelligence lives in the prompting agent.

## 2. T3 Code (github.com/pingdotgg/t3code): the closest analogue to Volt [V]
Releases: v0.0.45 (Oct 2) → **v0.1.0 (Oct 15), "Orchestrator V2 stable"** → v0.1.7 (Nov 4). Design notes live in `docs/orchestration-v2/*.md` and `AGENTS.md`.

### Architecture
- A pure `Orchestrator` turns commands into events and does no I/O. `EventSink` commits four things in **one SQLite transaction**: events, projections, a **command receipt**, and **outbox effects**.
- `EffectWorker` claims those effects (start a provider turn, take a checkpoint, …) and feeds the results back as commands.
- Dispatch returns the last committed sequence number, which doubles as the client's reconnect cursor. Replaying a command id returns the same receipt without re-running its side effects.
- Each turn ends in a checkpoint stored as a hidden git ref, `refs/t3/checkpoints/...`. Tests call `EffectWorker.drain` instead of sleeping.

### Data model
- The hierarchy is `AppThread → Run (counted user turn) → ExecutionNode tree (tool / approval / subagent) → ProviderThread`.
- Invariants:
  - App ids are primary; provider ids are only references.
  - **A child completing never closes the parent run.**
  - Rollback is counted in app runs.
  - Switching provider produces an explicit handoff artifact.
  - A fork records lineage first and resolves lazily, either as a native fork or a portable context transfer.

### Capabilities
- Each adapter emits a versioned `ProviderCapabilities` object at session start, for example `canForkThread`, `canRollbackThread`, `supportsModelSwitchInSession`, `pendingRequestsSurviveRestart`.
- Policy falls back for ACP agents that lack features:
  - no steering → cancel-and-restart
  - no fork → portable transfer
  - no native subagents → orchestrator-owned child threads
- It ships a generic **ACP Registry driver** that installs registry agents and verifies their checksums.

### Orchestrator MCP (`t3-code`, HTTP at 127.0.0.1)
- **Credentials:** each provider session gets its own bearer token, scoped to env, parent thread, provider and session. Tokens have a max lifetime and an idle TTL, are revoked on release, and are never persisted.
- **Codex wiring:** registered twice. The `t3-code-direct` entry carries only `t3_thread_wait` with `omit_tools_from=["code_mode","deferred"]`, so the blocking wait is a direct call.
- **`delegate_task`** takes `{task, target{providerInstanceId|driverKind|model}, title, role: implementation|research|review|design|test|general, mode: async|wait, timeoutMs, clientRequestId, runtimeMode, interactionMode}`.
  - The child gets **only the task plus a role instruction**, never the parent's history.
  - It returns `{taskId, childThreadId, status: queued|running|waiting|completed|failed|cancelled|interrupted, workState: working|waiting_for_children|result_available, hasPendingChildRuns, summary, resultContextTransferId, hasPendingQuestion, pendingApproval{requestId,kind,runId}, waitTimedOut}`.
  - **A wait timeout never cancels the child. A pending question or approval ends the wait early.**
- `task_status`. `task_cancel` stops delegates recursively and cancels automatic delivery to the parent.
- Thread tools:
  - `create_threads` (1–20 at once)
  - `t3_thread_launch` (`workspaceStrategy: worktree{baseRef}|existing_worktree|root`)
  - `t3_thread_read` (incremental via `afterPosition`/`nextPosition`)
  - `t3_thread_send` (`auto|queue|steer|restart`)
  - `t3_thread_wait`, `t3_thread_interrupt`
  - `t3_pending_request` (list/read/respond)
  - `schedule_task` (interval, fixed time, or webhook)
- **Policy:**
  - A child's runtime or interaction mode can only stay equal or narrow; any escalation is denied.
  - An agent can't approve its own requests.
  - Errors are typed: `capability_denied`, `parent_not_active`, `runtime_mode_escalation_denied`.
  - `clientRequestId` derives stable command, thread and message ids.
- **Lifecycle:** `delegated_task.request` → child thread with a `subagent` lineage link → `subagent_spawn` context transfer → `subagent_result` transfer.
  - Finalization replays persisted events, so it is **restart-safe and idempotent**.
  - When a child asks a question, the parent is notified: steered into the parent's turn if that provider can steer without interrupting tools, otherwise queued. The queued notice is cancelled if the question gets answered first.
  - Completions wake the parent **in batches**.
  - Thread links look like `<t3-thread://v2/<env>/<thread>>`, so the model never has to format ids or rely on stale titles.

### New since October
- v0.1.0:
  - Durable server queue with steer/queue per message
  - Auto-resume when a usage limit resets, plus a "Limited" state
  - Interrupted threads continue after a restart, and the agent is told which background work died
  - Native subagents from Claude, Codex, OpenCode 2, Cursor and Pi projected as child threads
  - Fork from any run and merge its context back
- v0.1.3: resume Codex parents once their native children finish.
- v0.1.4: Claude MCP timeouts keep the native session.
- v0.1.6: side chats; Stop completes even when the agent is unresponsive.
- v0.1.7: approve a child's requests from the parent conversation; one-time schedules; managed policies.
- Nightly: approval pushes to phones for subagent requests.

### Lessons from probing Codex app-server
- `thread/status/changed` can report idle before the turn completes. **`turn/completed` is the terminal signal.**
- An interrupt completes as a request first; the interrupted state arrives later.
- A child's `turn/completed` can arrive before the parent's.

### Adopt in Volt
Volt already has the event-sourced core. The gaps are:
- the transactional outbox and command receipts
- `clientRequestId` idempotency
- `workState` reported separately from `status`
- pending-question early wake
- the no-escalation rule
- per-session scoped MCP tokens
- a capability-flag fallback policy for each ACP adapter

**Pitfall:** T3's own docs call switching provider mid-thread lossy. Prefer delegate or handoff with an explicit artifact.

## 3. Claude Code agent teams (code.claude.com/docs/en/agent-teams, CHANGELOG to 2.1.319)

### Setup [V]
- Enable with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Interactive only: under `-p` or the SDK, named spawns become plain subagents.
- **v2.1.178 removed `TeamCreate`/`TeamDelete`.** There is now one implicit team per session (`session-<8 chars>`). A teammate is simply the `Agent` tool called with a `name`; `team_name` is ignored.

### Files [V]
- `~/.claude/teams/{team}/config.json` holds `members[]` with name, agentId, agentType, plus pane ids.
- `~/.claude/teams/{team}/inboxes/{agent}.json` is one JSON mailbox per agent. A send counts as successful once the file write succeeds.
- `~/.claude/tasks/{team}/` holds tasks and **survives the session**.
- [C] Older schema, task: `{id, subject, description, status: pending|in_progress|completed, owner, activeForm, blocks[], blockedBy[]}`.
- [C] Inbox entry: `{from, text, timestamp, read}`, with typed variants `idle_notification`, `shutdown_request/approved`, `plan_approval_request`, `permission_request`.
- [C] Locking uses `proper-lockfile` (10 retries, 5–100 ms backoff). Messages are injected as user turns wrapped in `<teammate-message>`.

### Primitives [V]
- **`SendMessage{to, message, summary?, notify_when_idle?}`** sends to one recipient. **The docs now say: "To reach everyone, send one message per recipient."**
  - [C] v2.1.34 had `broadcast`, `shutdown_request/response` and `plan_approval_response` variants. Broadcast was flagged as expensive because it costs N writes.
- **Delivery:**
  - A running agent reads new messages **between tool calls, never in the middle of one**. An idle agent is started with a new turn.
  - The receiver is told the message came from another session, so it can't grant consent or approve permissions.
  - In auto mode a classifier screens each message.
  - Per-sender rate limiting and dedup of identical bursts. Each queue holds at most 50 messages.
- **Idle notification:** when a teammate stops, its final answer is sent to the lead automatically. If the turn died on an API error, the error text is sent instead.
- **Tasks:** `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate` (status, deps, delete).
  - Dependent tasks unblock automatically.
  - Teammates **self-claim the next unassigned, unblocked task under a file lock**. The lead can assign anything.
  - Since v2.1.268 the task tools are on by default only for older models (Opus 4.7, Sonnet 4.6, Haiku 4.5). Newer models need `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.
  - `CLAUDE_CODE_TASK_LIST_ID` shares a list across sessions.
- **Shutdown:** a request/response handshake. The teammate can reject with a reason, and exits only after its current tool call.
- **Plan approval:** a teammate spawned in plan mode sends a plan for approval. If its mode was never changed by hand, the plan is auto-approved.
- **Permissions:** teammates inherit the lead's mode (there is no per-teammate mode), and their prompts bubble up to the lead.

### Hooks (no matchers) [V]
- `TeammateIdle`: exit code 2 sends stderr back and keeps the teammate working; `{"continue":false}` stops it.
- `TaskCreated`: exit code 2 or `decision:block` deletes the task.
- `TaskCompleted`: exit code 2 blocks completion and feeds stderr back. It also fires when a teammate ends its turn with a task still in progress.

### Display [V]
- `teammateMode`: `in-process` (the default), `auto`, `tmux`, or `iterm2`. Split panes don't work in the VS Code terminal or Ghostty.

### Limits [V]
- One team per session, no nested teams, and the lead is fixed.
- `/resume` doesn't restore in-process teammates.
- Task status can lag.
- Cost grows roughly linearly with team size. The docs recommend 3–5 teammates with 5–6 tasks each.

### Known bugs [C, issue titles only]
- #50779: messages to the lead are deferred until `end_turn`.
- #63684: an inbox past ~1 MB / 1000+ messages stalls.
- #57487: a message races an idle notification and is lost.
- #23415: tmux teammates never poll.

### Clever
- Wake-on-message.
- **Hooks as quality gates on task completion.**
- Self-claiming with locks.
- A role is defined once and used either as a subagent or a teammate.

### Adopt in Volt
- A **shared task board with atomic claim** (`claim_task` = a compare-and-swap event on `owner == null && deps done`).
- `TaskCompleted`-style gate hooks that can reject completion with feedback.
- Inject messages only at tool boundaries.
- Per-sender dedup and a capped queue.
- Provenance marking: a peer message can never count as user consent.
- Skip broadcast. Use a topic or board instead, so a send doesn't cost N writes into N contexts.

### UI anatomy [V]
- **Terminal UI:** an agent panel below the prompt with `main` plus one row per agent. **Nested subagents render as a tree; `(+N)` marks rows that have descendants.**
  - Keys: ↑/↓ to select. Enter opens the transcript, and typing there messages that agent. `x` stops it; Esc goes back.
  - More than 3 idle rows collapse into "N idle agents". Successful rows disappear right away; failed ones stay for 30 s.
  - `/tasks` lists them with their models.
  - `claude agents` groups them as Needs input / Working / Completed, with a one-line Haiku summary (refreshed at most every 15 s) and an age.
- **VS Code extension:**
  - Live progress rows appear under the tool-call group that spawned them.
  - An **"N agents" chip in the prompt box** has a dot for working vs. waiting on permission.
  - Clicking the chip opens the **agent map**: a tree under the main agent with status, elapsed time and tokens.
  - Each agent's card shows the prompt, tool calls, a read-only transcript, "Spawned by", and **Stop agent**.

## 4. Codex CLI multi-agent (openai/codex @8703d32, `codex-rs/core/src/tools/handlers/multi_agents_spec.rs`) [V]

### Runtime
- Everything runs as threads in one process, with in-memory `InterAgentCommunication` mailboxes.
- v1 (`multi_agent`) is on by default but deprecated. v2 (`multi_agent_v2`) is stable but off by default.

### v1 tools
- `spawn_agent{message, agent_type?, fork_context?, model?, reasoning_effort?}` → `{agent_id, nickname}`
- `send_input{target, message, interrupt?}`
- `wait_agent{targets[], timeout_ms}`: timeout defaults to 30 s, range 10 s – 1 h
- `resume_agent`
- `close_agent`: closes descendants too. **Completed agents keep counting against the cap until closed.**

### v2 tools
- **Agents are addressed by path** (`/root/task1/task_3`).
- `spawn_agent{task_name, message, agent_type?, fork_turns: all|none}`
- **`send_message`** delivers without starting a turn. **`followup_task`** starts a turn if the target is idle.
- `wait_agent{timeout_ms}` wakes on any mailbox update and returns **only a summary**. The content arrives in history, which keeps the waiter's context small.
- `interrupt_agent`, `list_agents{path_prefix}`
- A child's completion is pushed to its parent as a non-waking `<subagent_notification>{"agent_path","status"}`.

### Limits and config
- Limits: `agents.max_threads` defaults to 6 (v1). v2 has `max_concurrent_threads_per_session` = 4, which leaves 3 spawnable. `max_depth` is 1 in v1 and ignored by v2.
- Roles are TOML files in `.codex/agents/` with `name`, `description`, `developer_instructions`, and optional model and effort.
  - **A role can't override sandbox, approvals or MCP**; those are inherited from the parent.
  - Built-in roles: `default`, `worker`, `explorer`.
- `spawn_agents_on_csv` was removed. `agent_message_board` and `wake_on_agent_messages` are still in development.

### UI
- Transcript cells such as "• Spawned Robie [explorer] (gpt-5 high)", "Waiting for N agents", "Finished waiting └ …".
- `/subagents` opens a picker; ⌥←/→ cycles between agents.
- An "Agent command center" has tabs All / Needs you / Working / Ready / Inactive.

### Adopt in Volt
- Split `message_task` into **`notify` (no wake) vs `followup` (wake if idle)**.
- Have `wait_tasks` return a summary plus a pointer, not the full payload.
- Use path-style task names for readable lineage.
- Release concurrency slots on completion, not on close.

## 5. opencode V2 (anomalyco/opencode @12a661e) [V]

### The `subagent` tool
- The `task` tool is now called **`subagent`**. Input: `{agent, description, prompt, model?, sessionID?, background?}`. Output: `{sessionID, status: completed|running, output}`.
- Each call creates a **child session** with `parentID` set. The prompt is prefixed with "You are a subagent spawned by another session."
- Foreground calls block. `background:true` returns immediately and tells the model not to poll. On completion, `<subagent sessionID state description>…</subagent>` is injected into the parent.
- **Passing an existing `sessionID` continues or steers that child**, and can switch its agent or model.
- Depth comes from `experimental.subagent_depth` (default 1). Interrupting the parent interrupts its children.
- The permission check is `{action:"subagent", resource:<agentId>}`.

### Agent config
- `mode: primary|subagent|all`
- `permissions[{action, resource, effect}]` (last match wins)
- `steps`: tools are removed on the final step, which forces a summary
- `hidden`, `color`
- Nested file paths become ids (`team/reviewer`)

### UI and why it's clever
- **UI:** a composer "Subagents" tab showing up to 5 rows (`agent: title` + Running). Enter jumps to the child session; `ctrl+a` toggles active/inactive.
- **Clever:** a subagent is just a session, so resume, steer and inspect all come for free. One tool covers both foreground and background, and `steps` gives a hard budget with a forced summary.

## 6. Gemini CLI (@62bab5b) [V]
- **Source exposes a single `invoke_agent{agent_name, prompt}` tool.** The docs still describe one tool per agent, so they are stale.
- **A subagent must call `complete_task`.** If it stops without doing so, that's an error. On timeout or max turns it gets one recovery turn with 60 s of grace.
- **Subagents can't call subagents.** Each one has its own tool registry and inline `mcpServers`.
- Defaults: `max_turns` 30, `timeout_mins` 10.
- Built-in agents: `codebase_investigator`, `cli_help`, `generalist`, `browser_agent`.
- **Remote agents over A2A:** `kind: remote` plus `agent_card_url`, with auth via apiKey, http, ADC or OAuth PKCE.
- **Adopt:** an explicit `complete_task{result, artifacts}` terminal tool for Volt-native children. It gives a reliable end-of-task signal and a structured result, instead of scraping the last message.

## 7. Other GUIs and runners

### claude-squad (smtg-ai, v1.0.20) [V]
- tmux sessions plus a Go PTY attach.
- **Status every 500 ms:** a SHA-256 of `tmux capture-pane`. A changed hash means Running, unchanged means Ready.
- Hard-coded prompt strings for Claude, Aider and Gemini; none for Codex.
- AutoYes sends `\r`, and a daemon keeps doing it with the TUI closed.
- Pause auto-commits, removes the worktree and keeps the branch.
- No inter-agent communication.
- **Pitfalls:** it types before Codex is ready (#266), and the tmux `-t` prefix match is a footgun.

### Conductor [V, changelog]
- One worktree per workspace.
- **Checkpoints:** a Claude Code hook commits to a *private git ref* before each response, and revert deletes later messages. Unsafe when several chats share a workspace.
- Conductor MCP (0.82) lets agents create workspaces, read sessions and comment in Changes.
- Stacks (PR stacks), routines, an iOS remote over QR pairing.
- **Discontinuing** (see the landscape note).

### Sculptor (Imbue) [V]
- The default is now **git worktrees**. Containers are reduced to an experimental "custom backend command", and **Pairing Mode appears to have been removed**.
- **It replaces Claude's AskUserQuestion and ExitPlanMode with its own MCP tools**, to get native panels and notifications.
- It asks the model to record task blocking relations, which feed a dependency graph.
- **A bug worth copying the fix for (commit d9d95db):** for *subagent* MCP calls, Claude CLI emits the `tools/call` control_request **before** the sidechain ToolUseBlock. The fix pairs calls by tool name and arguments and queues unmatched ones.

### Vibe Kanban [V]
- **Executors:**
  - Claude: `-p --output-format=stream-json --input-format=stream-json --permission-prompt-tool=stdio --disallowedTools=AskUserQuestion`, with `--resume-session-at <uuid>` to truncate for retries.
  - Codex: the app-server JSON-RPC protocol.
  - Gemini, Qwen and Copilot: ACP.
  - OpenCode: `serve --port 0` with a password, over HTTP and SSE.
- **Cross-provider timeline:** `NormalizedEntry{UserMessage|AssistantMessage|ToolUse{tool_name, action_type, status}|Thinking|ErrorMessage|TokenUsageInfo…}`.
  - `ActionType` values: FileRead, FileEdit, CommandRun, Search, WebFetch, TaskCreate{subagent_type}, PlanPresentation, TodoManagement, …
  - `ToolStatus` values: Created, Success, Failed, Denied, PendingApproval{approval_id}, TimedOut.
  - Entries **stream as RFC 6902 JSON Patches**.
- **MCP tools:**
  - Issues: `create_issue`, `list_issues`, `create_issue_relationship` (blocking/related/duplicate)
  - Workspaces: `start_workspace{executor, repositories[], issue_id}`
  - Sessions: `run_session_prompt` (async), `get_execution`
  - Context: `get_context`
- **Merge:** refuses when the base is ahead of the branch (asks for a rebase first).
- **Remote:** embedded SSH over a WebSocket relay.

### coder/agentapi (deprecated; still the cleanest screen-scrape design) [V]
- vt10x emulation with `TERM=vt100`.
- **Snapshots every 25 ms. "Stable" means the screen is unchanged for 2 s. `Send` is rejected unless the agent is stable.**
- **Two-phase write:** text first, then a wait of up to 2 s for the echo to settle (a timeout here is non-fatal). Then `\r`, then a wait of up to 15 s for any change, resending `\r` at most every 3 s (a timeout here is fatal).
- `screenDiff` extracts new lines, skipping OpenCode's dynamic header.
- **API:** SSE `/events`, `/status`, `/messages`, and an experimental ACP transport behind the same interface.

### Xum (coder/mux) [V]: the most refined delegate/await toolset found
**Spawning**
- `task{agentId, prompt, title (a reusable role), run_in_background, n (best-of-N), kind: subagent|workspace, workspace{mode: new|fork|existing}, isolation}`.
- `isolation` is only offered on runtimes that support it, so the model never sees it otherwise.
- The tool description tells the model that **children see committed state only** and to **never await in the same parallel batch as the spawn**.

**`task_await`**
- `{task_ids? (omit = all descendants), timeout_secs (0 = poll), min_completed (K-of-N), offset_chars (pagination), filter}`.
- Reports are **persisted** so they survive compaction.

**Other tools**
- `task_list` re-discovers tasks after a restart or compaction.
- `task_send_message` reawakens an inactive child.
- **`task_message_parent` / `task_message_sibling`** work only between children of the same parent, with a size cap.
- `agent_report` sends incremental progress that wakes the parent.
- **`task_apply_git_patch`** runs `git am --3way` on a child's format-patch artifact, with `dry_run` in a temp worktree and an `expected_head_sha` guard.

**Bench policy and SSH**
- Keep a capped set of distinct role children, and reuse idle ones whose context still fits.
- The SSH runtime treats the host as hostile: syncs via git bundle and forwards no keys by default.

### ccmanager [V]
- Per-agent `StateDetector`: `waiting_input` when "do you want…" or "esc to cancel" is visible; busy when "esc to interrupt" or a spinner shows above the prompt box. Debounced 1500 ms.
- **Auto-approve:** a regex denylist of dangerous commands first, then a call to **Haiku** to judge whether the action is safe.

### agent-of-empires [V]
- Agents run in tmux.
- **Status comes from agent hooks writing a per-instance file keyed by `$AOE_INSTANCE_ID`:** SessionStart → Idle, PreToolUse → Running, PermissionRequest → Waiting, Stop → Idle.
- ACP client mode, Docker sandbox, and a web/PWA dashboard.

### Superset [V, partial]
- A pty-daemon keeps terminals alive across app restarts.
- Hook shims export `SUPERSET_AGENT_ID`. **Events whose harness and agent id don't match are dropped**, which handles one CLI replaying another's `~/.claude/settings.json`.

### Amp [V, docs]
- The Task subagent returns only a final summary.
- Subagents can't talk to each other and get no live steering.
- Oracle is a review-only model; Librarian handles external repos.

### claude-flow / Ruflo [S]
- Queen/worker hive-mind with a SQLite `.swarm/memory.db`.
- Fixed `maxAgents` of 15, 10 or 5.
- Mostly marketing; low signal.

## 8. Google A2A (v1.0.0, 2026-03-12; v1.0.1, 2026-05-28) [V]

### Methods
- v1 renamed every method:
  - `SendMessage`, `SendStreamingMessage`
  - `GetTask`, `ListTasks` (cursor)
  - `CancelTask`
  - `SubscribeToTask` (multiple subscribers, closes at a terminal state)
  - `Create|Get|List|DeleteTaskPushNotificationConfig`
  - `GetExtendedAgentCard`
- The `kind` discriminators and the `final` flag are gone; end of stream is signalled by the stream closing.

### Agent Card
- `{name, description, supported_interfaces[], capabilities{streaming, push_notifications, extensions[]}, skills[{id, name, description, tags, examples}], security_schemes, signatures (JWS)}`.

### Tasks and messages
- **TaskState:**
  - Normal: SUBMITTED, WORKING
  - Terminal: COMPLETED, FAILED, CANCELED, REJECTED. Sending to a task in a terminal state gives `UnsupportedOperationError`, so start a new task in the same context.
  - Interrupted: **INPUT_REQUIRED, AUTH_REQUIRED**
- **Objects:**
  - Task: `{id, context_id, status{state, message, timestamp}, artifacts[], history[]}`
  - Message: `{message_id, context_id, task_id, role, parts[], reference_task_ids[]}`
  - Part: `text | raw | url | data(JSON)` plus `media_type`
  - **Artifacts are outputs; messages are conversation.** `TaskArtifactUpdateEvent{append, last_chunk}` carries chunked outputs.
- **`contextId` groups tasks.** A follow-up after completion is a new task in the same context, pointing back via `reference_task_ids`.
- `SendMessageConfiguration.return_immediately` replaces `blocking`.

### Adopt in Volt
Use A2A as Volt's **internal task vocabulary** (no need to speak HTTP A2A locally):
- Map `INPUT_REQUIRED` to a child question and `AUTH_REQUIRED` to a provider login.
- Keep artifacts separate from messages, with append/last_chunk streaming.
- Follow-up after a terminal state = a new task in the same context.

Optionally export a Volt Agent Card later, so Gemini CLI's `kind: remote` agents and other A2A clients can call Volt.

## 9. Councils, debate, and best-of-N

### Karpathy llm-council (commit 92e1fcc) [V]
- **Setup:**
  - Council: gpt-5.1, gemini-3-pro, claude-sonnet-4.5, grok-4.
  - Chairman: gemini-3-pro.
  - All calls go through OpenRouter with no temperature set and a 120 s timeout. Failed models are silently dropped.
  - Each stage runs `asyncio.gather` in parallel; the stages run in sequence.
  - Total calls: N + N + 1, plus a title call. **No conversation history** is kept.
- **Stage 1:** independent answers.
- **Stage 2:**
  - Answers are relabelled "Response A/B/C" in **fixed order (no shuffle)**, and every model ranks all of them, **its own included**.
  - Each ranker writes a critique, then a `FINAL RANKING:` line followed by a numbered list.
  - Parsing is a regex for `\d+\.\s*Response [A-Z]`, with fallbacks.
  - The aggregate is the mean position. It is **shown in the UI but not passed to the chairman**.
- **Stage 3:** the chairman gets the Stage 1 answers *with model names* plus the ranking texts, and synthesizes.

### Evidence on debate and judges [V]
- **Du et al. 2023:** debate beat majority vote on arithmetic (81.8 vs 69.0) and GSM8K (85 vs 81), but at 2–3× the compute.
- **Debate doesn't reliably beat cheaper methods:**
  - *Should we be going MAD?*: no reliable win over self-consistency.
  - *Debate or Vote* (NeurIPS 2025): majority voting explains most of the gain, and debate alone forms a martingale.
  - *Stop Overvaluing MAD*: mixing heterogeneous models is the consistent fix.
  - *Can LLM agents really debate?*: majority pressure suppresses correction.
- **MoA and Self-MoA:**
  - MoA scored a 65.1% length-controlled win rate on AlpacaEval 2.0, against 57.5% for GPT-4o.
  - **Self-MoA** (many samples from the best model) beats a mixed MoA by 6.6% / 3.8%. Weak members hurt.
- **Judge biases:**
  - MT-Bench swap consistency is only 65% for GPT-4 and 24% for Claude-v1.
  - Self-preference: +10% (GPT-4), +25% (Claude-v1).
  - Self-recognition correlates with self-preference, so anonymization alone isn't enough.
- **Best-of-N in coding:**
  - Claude 3.7 SWE-bench high-compute: parallel samples, drop patches that fail visible tests, then score the rest: 70.3% vs 63.7%.
  - Augment's ensembler: +3–8%.
  - *Large Language Monkeys*: coverage goes from 15.9% to 56% with 250 samples, but voting and reward models plateau, so **the verifier is the bottleneck**.
  - Cursor `/best-of-n`: one worktree per model, and **the user picks the winner**.

### Recipe for Volt [I, from the evidence]
1. Run N parallel attempts on *heterogeneous strong* models in separate worktrees.
2. Pass them through an **executable verifier** first (tests, typecheck, lint).
3. Have the survivors ranked by judges that **exclude their own answer**, with the order shuffled and **both orders scored**.
4. A chairman synthesizes, or simply picks the best diff.
5. Treat a plain vote as the baseline that debate rounds must beat at equal cost. Add debate only for open-ended design questions.

### DeepSeek
- **[V] DeepSeek Harness (`dsh`)**, github.com/deepseek-ai/deepseek-harness: created 2026-08, TypeScript, plugin-based, "developer preview". The star count reported by the research agent (~277k) is implausible; treat it as unverified.
- **[S]** `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` runs Claude Code on deepseek-v4-pro/flash. That is an easy cheap-teammate option for Volt's Claude adapter.

## 10. Top 15 mechanisms to adopt in Volt (ranked)

1. **Transactional outbox and command receipts** (T3). Write event, projection, receipt and effect rows in one transaction. A worker claims effects and feeds results back as commands. Dispatch returns `seq`, which doubles as the reconnect cursor.
2. **Idempotent `delegate_task` via `clientRequestId`** (T3). Hash `(parentThreadId, clientRequestId)` into stable task, thread and message ids. A retry returns the existing receipt.
3. **`wait_tasks` contract** (T3 + Xum + Codex v2):
   - Parameters: `{ids? (omit = all descendants), timeout_ms (0 = poll), min_completed, offset_chars}`.
   - **A timeout never cancels the task.** The call returns early on `input_required`/`approval`.
   - The result is a summary plus a pointer; reports are persisted so they survive compaction.
4. **First-class `blocked` / `input_required` / `auth_required` states** (A2A, herdr, T3). Refuse to inject prompts into a blocked child. Wake the parent with reason `question`, and let it answer the child's approval (no self-approval).
5. **Batched parent wake-up with steer-or-queue** (T3, Claude teams). Coalesce completions over a window of about 250 ms. Steer into the running turn if the adapter can steer without interrupting tools; otherwise queue a wake turn. Drop the queued notice if the question was answered first. Inject only at tool boundaries.
6. **Split messaging into `notify` (no wake) and `followup` (wake if idle)** (Codex v2). `message_task{mode: notify|followup|steer|restart}`.
7. **Prompt-and-wait as one atomic server op** (herdr):
   - `message_task{..., wait:{until, timeout_ms}}` pins `(taskId, turnSeq)`, so a replacement or stale idle can't satisfy it.
   - If no activity starts within 5 s, return `stalled`.
   - A timeout never implies the message was not delivered.
8. **Shared task board with atomic claim and dependencies** (Claude teams, Vibe Kanban relationships):
   - `board_create`, `board_claim` (a CAS event: `owner==null && blockedBy all done`), `board_update`.
   - Teammates self-claim the next unblocked item.
9. **Completion gates** (Claude `TaskCompleted`/`TeammateIdle` hooks, Gemini `complete_task`):
   - Children finish by calling `complete_task{summary, artifacts}`.
   - Configurable gates (tests, lint, reviewer) can reject completion with feedback, and the child keeps working.
10. **Capability flags and a fallback policy per ACP adapter** (T3):
    - Each adapter emits `{loadSession, fork, steer, modelSwitch, nativeSubagents, mcpHttp}` at session start.
    - Missing steer becomes cancel+restart. Missing fork becomes a portable context artifact. Missing native subagents become Volt child threads.
11. **No privilege escalation; scoped per-session MCP tokens** (T3):
    - A child's permission mode is ≤ the parent's.
    - The bearer token is scoped to env, thread, provider and session, with a max TTL and an idle TTL. It is revoked on release, never persisted, and injected via ACP `session/new.mcpServers`.
12. **Patch-artifact merge-back plus checkpoint refs** (Xum, T3, Conductor, Vibe Kanban):
    - Each child turn ends with `refs/volt/checkpoints/<thread>/<run>`.
    - Results arrive as a format-patch artifact, applied with `git am --3way`, `dry_run` in a temp worktree, and an `expected_head_sha` guard.
    - Refuse when the base has moved ahead of the branch.
    - The tool description says "children see committed state only".
13. **Verified best-of-N / council** (Anthropic high-compute, Debate-or-Vote, llm-council):
    - `council{prompt, models[], verifier?}`: N heterogeneous worktree attempts, then the executable verifier, then anonymized, shuffled, both-order ranking that excludes self, then chairman synthesis or a pick.
    - Use plain voting as the baseline. Don't do multi-round debate by default.
14. **Resource-aware admission control** (gap: no tool does this):
    - `maxParallel = min(cores-2, (freeRAM - 2GB) / Σ(p95RSS[provider] + MCP RSS))`, re-evaluated on every spawn. Queue excess tasks as `queued`.
    - Release slots on completion, not on close (a Codex pitfall).
    - Watchdog: restart an agent above about 2 GB RSS.
    - **Share MCP servers across sessions** where possible (the biggest real-world blowup).
15. **Robust status and identity for non-ACP / PTY agents** (herdr, AoE, Superset, agentapi):
    - Order of preference: hook-reported state with a monotonic `seq` and an instance id (drop mismatched harness events), then data-driven, hot-updatable screen manifests with `explain`, then agentapi-style stability (25 ms snapshots, 2 s stable, send only when stable, two-phase echo+CR).
    - Persist `resume_argv` / sessionId per pane for native resume.

Honourable mentions:
- Normalized cross-provider timeline streamed as JSON patches (Vibe Kanban).
- Subagent MCP `tools/call`-before-ToolUseBlock ordering bug: pair by name+args (Sculptor).
- `turn/completed`, not idle, is terminal (T3).
- Selective streaming for remote devices: full transcript only for the focused device (herdr `surface_interest`).
- Sibling and parent messaging with size caps (Xum).
- A "bench" of reusable role children (Xum).
- `steps` budget with a forced summary (opencode).

## 11. Per-process memory numbers

| Agent | Idle RSS | Typical active | Pathological (reported) | Sources |
|---|---|---|---|---|
| Claude Code CLI (Node/Bun) | 166–192 MB [S] | 279–366 MiB process tree for short headless tasks [V]; about 540–555 MB interactive [V] | 2.5–8 GB per instance (v2.0.8) [V]; 7.5 GB in 20 s, OOM (v2.1.27) [V]; 119–125 GB anon-rss [V]. Note that a VmPeak of 129 GB with 556 MB resident is a red herring [V]. | [claw-bench](https://github.com/devswha/claw-bench), [Qwen mem report](https://github.com/QwenLM/qwen-code/blob/main/docs/e2e-tests/2026-05-18-qwen-memory-benchmark-report.md), [#22042](https://github.com/anthropics/claude-code/issues/22042), [#8968](https://github.com/anthropics/claude-code/issues/8968), [#4953](https://github.com/anthropics/claude-code/issues/4953), [#11315](https://github.com/anthropics/claude-code/issues/11315) |
| Codex CLI (Rust) | 46 MB [S]; ~63 MB [S] | app-server ~1 GB with MCP [V] | 75–85 GB (0.128.0) [V]; app-server ~27 GB from big tool output [V]; images decoded twice (~420 MB each) [V] | [claw-bench](https://github.com/devswha/claw-bench), [#20740](https://github.com/openai/codex/issues/20740), [#24048](https://github.com/openai/codex/issues/24048), [#59695](https://github.com/openai/codex/issues/59695), [#17832](https://github.com/openai/codex/issues/17832) |
| Gemini CLI (Node) | n/a. The fork Qwen Code peaks at 852–1062 MiB tree, about 350 MiB of it MCP [V] | Relaunches with `--max-old-space-size = 50% of total RAM` [V]; warns above 7 GB RSS [V] | 7.3–8.6 GB warnings; ~8.1 GB heap OOM [V] | [gemini.tsx](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/gemini.tsx), [useMemoryMonitor.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/ui/hooks/useMemoryMonitor.ts), [#29591](https://github.com/google-gemini/gemini-cli/issues/29591), [#26588](https://github.com/google-gemini/gemini-cli/issues/26588) |
| OpenCode (Bun) | ~190 MB [V] | Sawtooth to ~383 MB [V]; server ~900 MB with many MCPs [V] | 24–28 GB in under 1 min [V]; 21 GB / 70 GB [V]; auto heap snapshot above 2 GB [V] | [#51761](https://github.com/anomalyco/opencode/issues/51761), [#13230](https://github.com/anomalyco/opencode/issues/13230), [#5363](https://github.com/anomalyco/opencode/issues/5363), [#20695](https://github.com/anomalyco/opencode/issues/20695), [#51003](https://github.com/anomalyco/opencode/issues/51003) |
| Cursor agent CLI | No CLI numbers found | IDE agent grows ~4 GB/h [S] | 98 GB with 6 parallel background agents on a 16 GB Mac [S] | [forum](https://forum.cursor.com/t/title-cursor-reaches-98gb-memory-with-6-parallel-background-agents-macos-memory-pressure-system-freeze-16gb-mac/168061) |
| MCP server (each, per session) | Playwright ~56–65 MB; Python MCP ~135 MB; npm wrapper ~35–90 MB; node_repl ~10 MB [V] | Spawned **per session** in every product | 11 servers became ~300 processes, 24–41 GB swap, kernel panics [V]; 1,319 zombie processes / 37 GB [V]; 133 orphans / 9.3 GB [V] | [claude-code#64366](https://github.com/anthropics/claude-code/issues/64366), [codex#12491](https://github.com/openai/codex/issues/12491), [codex#30408](https://github.com/openai/codex/issues/30408) |

### Concurrency defaults found
- **Claude Code:**
  - Subagents: up to 20 concurrent per session (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, v2.1.217+); spawn depth 3 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`) [V, env-vars docs].
  - Workflows: `min(16, cores-2)` [V issue text / S formula, #63938].
- **Codex:** v1 runs 6 threads at depth 1; v2 runs 4 per session, of which 3 can be spawned [V].
- **Cursor:** 8 parallel agents and 25 worktrees per machine [S/V].
- **Ruflo:** fixed `maxAgents` of 15, 10 or 5 [V].
- **Not RAM/CPU-aware:** herdr, Vibe Kanban, uzi and AoE [V].

**Suggested Volt budget [I]:** for each agent, budget about 0.5 GB for Node/Bun CLIs and about 0.1 GB for Codex. Add the sum of per-session MCP servers on top, typically 0.1–0.4 GB.
## Appendix — Nested subagent tree UI in Volt (requested mid-task)

**Request:** render subagents (and their own sub-subagents, any depth) as a VS Code-style tree in (a) the left chat sidebar, (b) a hover popover on the composer's "N subagents" chip, (c) the top of the side toolbar (lineage dock).

**What's in the code today** (VERIFIED by reading the `VOLT-orchestra` worktree; paths are relative to `src/vs/workbench/contrib/voltAgent/browser`):
- The left sidebar is already a `WorkbenchObjectTree<AgentHomeElement>`: `home/agentHomePane.ts` `createPaneTree()` (~L1380), `AgentHomeRenderer` (~L298). Rows are indented by `1 + 3*sideDepth`. Nesting only happens for **run groups** (`buildAgentHomeTree()` in `home/agentHomeModel.ts` ~L457–486, `renderRunGroup`). **Subagent chats are filtered out** by `isSubagentSession()` (~L3183, applied ~L3048). VOLT-ORCHESTRATOR-PLAN.md §4.8 calls for "subagent chats nested under their parent", but that isn't built.
- Composer chip: `composer/agentComposerChips.ts` `setAgents()` (~L557) plus `onAgentsClick`. In `editor/agentEditor.ts`, `showAgentsMenu()` (~L7697) builds a flat `VoltMenu` from `dockModel()`. Hovers go through Volt's own `chrome/agentTooltip.ts` (`setAgentTooltip`), not `IHoverService`.
- Side toolbar: `chrome/agentLineageDock.ts` `AgentLineageDock` (~L292). Each group (parent / Multitasks / Subagents / Needs attention) is a flat `WorkbenchList<ILineageRow>`.
- Data already supports a tree. `services/voltRuntime/common/orchestration/orchestrator.ts` has `IOrchThread{parentId, rootId, taskId, depth}` and `IOrchTask{parentId, rootId, parentTurnId, toolCallId, childId, source:'volt'|'harness', role}`. `orchestratorViews.ts` has `childTasks()`, `rootTasks()`, `agentRow()`, `lineage()`, `threadStatus()`. Row rendering is shared in `chrome/agentSubagents.ts` (`renderSubagentRow`, `subagentHoverRows`, `renderSubagentAvatar`, `tickSubagentClocks`).

**Design sketch (one model, three views):**
1. **Single tree builder:** add `subagentTree(state, rootThreadId): IObjectTreeElement<IOrchAgentRow>[]` in `orchestratorViews.ts`. It recurses over `childTasks(threadId)` → `task.childId` → that thread's `childTasks`, so it works at any depth. Use `collapsed: status ∉ {working, blocked}`, which auto-expands live branches and collapses finished ones. Harness subagents (`source:'harness'`) that have no Volt thread become leaf rows. Each node carries a rollup computed bottom-up: `{working, blocked, done, failed}` counts plus the worst state. That way a collapsed parent still shows "2 running · 1 needs input" (the same rollup idea herdr uses for workspaces).
2. **Row anatomy** (reuse `renderSubagentRow`): twistie · avatar/provider icon · name or role · model badge · status glyph (spinner / blocked "!" / check / x) · elapsed (`tickSubagentClocks`) · last tool or one-line activity · hover actions (open, message, stop). Use indent guides (`RenderIndentGuides.OnHover`) so deep nesting stays readable.
3. **Left sidebar:** stop filtering subagents in `isSubagentSession()`. In `buildAgentHomeTree()`, attach a session's children as `IAgentHomeNode.children` of the parent session row, mirroring how run groups fold their runs. Add an `AgentHomeElement` kind `'subagent'`, or reuse `session` with `nested:true` and a depth. Set `expandOnlyOnTwistieClick` for these rows so clicking a row opens the chat and doesn't toggle it. Keep `identityProvider` keyed by threadId so `setChildren` preserves expansion state across `onDidChangeTasks`.
4. **Composer chip hover:** replace the flat `VoltMenu` (or the hover card) with a small `WorkbenchObjectTree` inside an `IHoverService.showInstantHover`/`showDelayedHover` with `persistence.sticky` and `trapFocus`, or inside a `ContextView`. Hover shows a read-only tree. Clicking pins it as an interactive popover: arrow keys work, Enter opens the subagent chat, and a Stop action is available. Cap the popover at about 12 visible rows, with "Show all in side toolbar".
5. **Side-toolbar lineage dock:** swap the "Subagents" group's `WorkbenchList` for a `WorkbenchObjectTree` that uses the same renderer and builder. Root it at the current chat's `rootId`, so a child chat shows its siblings and ancestors, with the current node highlighted (`lineage()`). The "Needs attention" group stays flat. It is a filtered projection of blocked nodes at any depth, each with a breadcrumb such as `parent › child`.
6. **Updates:** coalesce `onDidChangeTasks` into a 100–250 ms throttled `tree.setChildren(null, subagentTree(...), {diffIdentityProvider})`. Clock ticks re-render elapsed text in place and don't rebuild the tree.
7. **Prior art to match:**
   - Claude Code's VS Code extension has an "N agents" chip with a working/permission dot. Clicking it opens an **agent map tree** with status, elapsed time and tokens per node. Each node's card shows the prompt, tool calls, a read-only transcript, "Spawned by" and Stop.
   - Claude Code's TUI shows `(+N)` on rows that have hidden descendants. It collapses more than 3 idle rows into "N idle agents" and drops successful rows from the live tree after 30 s (they stay reachable via `/tasks`).
   - Codex's command center filters by All / Needs you / Working / Ready / Inactive.
   - Copy all of these: the `(+N)` descendant badge on collapsed nodes, the idle-collapse row, and filter tabs in the lineage dock.
