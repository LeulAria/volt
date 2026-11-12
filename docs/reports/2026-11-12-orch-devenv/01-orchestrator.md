# 01 · Orchestrator end to end

## Summary

- **Benchmark B1** is a short orchestration with 4 subagents on Claude Haiku 5.5 (claude-code). Three
  research tasks run in parallel; a fourth uses `after` to wait for them and gets their reports.
  The fixture is `/tmp/voltbench/fx`, a 4-file TypeScript shop (pricing, cart, inventory,
  checkout) with a planted discount bug.
- **Tokens and cost per subagent are down about a third.** The first request of a subagent fell
  from **43.7k to 30.2k prompt tokens (−31%)**. Subagent cost for B1 fell from **$1.38 to $0.92 (−33%)**,
  with the same answers. The change: Volt-delegated subagent sessions start lean (no memory index,
  short skill descriptions, no native Agent tool, a read-only plan-mode workflow, no title request).
- **Orchestrator overhead is small.** `delegate_task` returns as soon as the parent finishes
  writing its arguments. The dependent task started **~0.5 s** after its last upstream finished.
  The 4.9 s between the parent starting the call and Volt receiving it is the parent model
  generating about 2.5 KB of JSON arguments.
- **Wall time: 28.1 s → 20.4 s median (−27%)** on the critical path, after the sandbox launch
  fixes from 03 (three runs at load 20–81; table below). Lean spares are now picked up between
  subagents in 1–159 ms.
- **First after-run (superseded): wall time looked worse, and the orchestrator was not the cause.** A cold agent start
  took **1.1 s on 0.0.6** and **~10 s on this branch** with the new default sandbox (Supervised),
  while the machine ran at a load average of 40–77 (three other agents were running test suites,
  a TypeScript server for the hotel project and two dev instances). With the sandbox off at the
  same load, it took ~6 s. A raw Claude ACP start outside Volt takes 0.9 s (1.6–1.8 s for three at
  once). The sandbox's share (+4–8 s) went to the sandbox work (report 03). Timing gets re-measured
  once the machine is quiet (see "Still open").
- **A 10× wall-time gain is not available from the orchestrator here.** After the fixes, about 90%
  of a short subagent's time is the model (time to first token on a ~30k prompt, then thinking and
  output) and the agent process start. What is left: hide process start behind warm spares, shrink
  the prompt further, and fix the sandbox start cost.

## Setup

| | Before | After |
|---|---|---|
| Build | Installed Volt 0.0.6 (`de2ea41`) | This branch, dev build (`scripts/code.sh`, profile `/tmp/vorch-ud`, CDP 9977) |
| Parent | Opus 5.5 (this chat) | Haiku 5.5, prompted to call `delegate_task` with the identical arguments |
| Subagents | Haiku 5.5 via claude-code, `role: research`, `context: none` | same |
| Sandbox | none (0.0.6) | run A: Supervised default (Seatbelt workspace-write); run B: sandbox Off |

Measurements come from Volt's own traces (`User/voltTraces/<chat>.jsonl`: the `metrics` line per
run, `usage` events) and from the Claude Code transcripts of each subagent session. Scripts:
`/tmp/voltbench/an.js` (per-chat summary), `/tmp/voltbench/cct.js` (what a Claude session loaded),
`/tmp/voltbench/acpstart.mjs` (raw ACP start time), `/tmp/voltbench/cdp.mjs` (drives the test window).

## Results

### Per subagent (B1)

| Task | Before: prompt / request | Before: cost | After (run A): prompt / request | After: cost |
|---|---|---|---|---|
| pricing bug | 44.3k | $0.375 | 30.2k | $0.260 |
| call graph | 44.3k (5 tools) | $0.415 | 30.2k | $0.260 |
| stock check | 44.3k | $0.374 | 30.6k | $0.263 |
| synthesis (`after` 1-3) | 47.7k (pool spare) | $0.212 | 32.0k (pool spare) | $0.134 |
| **Total** | | **$1.376** | | **$0.917 (−33%)** |

Run B (sandbox off) cost $0.489, but it read the cache run A had just written, so it is not
counted as a gain.

### Re-measured after the sandbox launch fixes (03), lower load

Same B1, a fresh chat each run, sandbox on (Supervised default), this branch with the lean
subagent sessions and the sandbox launch fixes committed. Other agents' test instances were still
running, so the load is given for each run.

| Run | Load (1 min) | Critical path (delegate → last report) | Cold agent ready | Spare adopted | Subagent cost |
|---|---|---|---|---|---|
| Before (0.0.6) | low | **28.1 s** | 1.13–1.19 s | synthesis only (6 ms) | $1.376 (cold cache) |
| After, run 1 | 20 | **22.8 s** | 1.92–2.24 s | synthesis (159 ms) | $0.893 (cold cache) |
| After, run 2 | 34 | **18.1 s** | 2.53–2.54 s | 1 research task (6 ms) + synthesis (103 ms) | $0.390 (warm cache) |
| After, run 3 | 81 | **20.4 s** | 3.53–3.59 s | 1 research task (1 ms) + synthesis (40 ms) | $0.427 (warm cache) |

- **Critical path median: 28.1 s → 20.4 s (−27%).** The lean spare a finished subagent leaves
  behind is now picked up by the next one (synthesis 40–159 ms), and the next run's first
  subagent picks it up too (1–6 ms).
- **Cost: −35% on a cold cache ($1.38 → $0.89) and −69 to −72% when runs follow each other within
  the cache lifetime ($0.39–0.43).** Lean subagent prompts are the same across subagents of a
  project, so the cache carries over.
- A cold sandboxed start is 1.9–2.2 s at load 20, against 1.1 s unsandboxed on 0.0.6 at low load.
  Report 03 measured 0.84–1.05 s for a bare start at load 9–16. The remaining gap is load plus
  Volt's MCP server setup in `session/new`.

### Where a subagent's time goes (first after-run, load 40–77, before the sandbox fixes)

| Phase | Before (0.0.6, low load) | After run A (sandbox, load ~40) | After run B (no sandbox, load ~70) |
|---|---|---|---|
| Agent ready (cold) | 1.13–1.19 s | 9.7–10.2 s | 5.7–6.2 s |
| Agent ready (pool spare) | 0.006 s | 3.9 s (spare still starting) | — |
| Prompt → first event | 2.3–2.6 s | ~0.0–0.1 s after ready | ~0.0 s after ready |
| Total, one-file task | 7.6–7.9 s | 16.8–17.5 s | 11.6–12.2 s |
| Critical path (delegate → last report) | 28.1 s | 31.3 s | 32.6 s |

### What a subagent's session loaded (Claude Code transcript attachments)

| Attachment | Before | After |
|---|---|---|
| `instructions` (user's auto-memory MEMORY.md) | 15.6 KB | none |
| `agent_listing_delta` (native subagent types) | 7.2 KB | none |
| `skill_listing` | 7.9 KB text | 6.9 KB text (descriptions capped at 160 chars) |
| `plan_mode` (research runs in Claude's plan mode) | full default workflow | Volt's 3-line read-only workflow |
| `ai-title` request | 1 extra model call per subagent | skipped (`title` set) |

CLI A/B of the same one-file task (Claude Code 2.1.280, Haiku 5.5, in the Volt checkout):

| Session | Prompt / request | Cost | Wall |
|---|---|---|---|
| default | 39.4k | $0.331 | 15.5 s |
| lean (memory off, short skills, no Agent) | 22.4k | $0.195 | 8.2 s |
| lean + `--strict-mcp-config` | 22.4k − 2.3k | — | — |
| plan mode default vs Volt plan-mode workflow | 25.4k vs 24.2k | $0.085 vs $0.065 | 7.7 vs 7.1 s |

`strictMcpConfig` would also drop the user's own MCP servers (claude.ai connectors, icon servers).
It saves 2.3k tokens and ~7 s of MCP startup in `claude -p`, but a subagent may need those servers,
so it is **not** applied.

### Quality

The answers were the same before and after. All three research tasks were correct. The synthesis
said −9000 in both runs: it was told not to read files and hedged that `checkout` might add tax
(the true total is −9720, because tax is added to the negative subtotal). That came from the brief,
not the harness.

## Fixes made

| File | Change |
|---|---|
| `services/voltRuntime/common/harness/claudeWorkRules.ts` | `claudeWorkRulesMeta(model, { subagent })`. Lean subagent sessions: `autoMemoryEnabled: false`, `skillListingMaxDescChars: 160`, `disallowedTools: ['Agent']` (nesting goes through Volt's budgeted `delegate_task`), `planModeInstructions` (read-only report workflow, no plan file / ExitPlanMode), `title` (skips Claude's title request). |
| `services/voltRuntime/common/providers.ts` | `IAgentStartRequest.subagent` |
| `services/voltRuntime/common/session.ts` | `IVoltSendRequest.subagent` |
| `services/voltRuntime/common/orchestration/orchestrator.ts` | `IOrchStartTurnRequest.subagent` |
| `services/voltRuntime/browser/orchestration/agentOrchestratorService.ts` | sets `subagent` for delegated tasks (not for Multitask chats, which the user follows up on) |
| `contrib/voltAgent/browser/orchestration/agentTurnHost.ts` | passes it on the send |
| `services/voltRuntime/browser/voltRuntimeService.ts` | the chat remembers it is a subagent. The start request, the pool key and the spare carry it, so subagents adopt only lean spares and a finished subagent leaves a lean spare for the next one. |
| `services/voltRuntime/browser/agents/acpProvider.ts` | lean meta for subagent sessions; `subagent` in the setup key |
| `services/voltRuntime/test/common/harness/claudeWorkRules.test.ts` | lean vs main session meta |

Teams and councils (live, report 06) were broken in four ways, now fixed: an approval card for
`spawn_team`, the sandbox gate refusing it, read-only members not using the board, and a call with
its arguments stuffed into one string that ran with default seats. Grok's SQLite sidecars are now
writable in the sandbox, and Antigravity's `--model` launch flag is gone (06).

Found while driving the test window, fixed:

| File | Change |
|---|---|
| `contrib/voltAgent/browser/ui/menu/voltMenu.ts` | sections can add rows made from the query (`fromQuery`) |
| `contrib/voltAgent/browser/home/agentHomeWorkspaceMenu.ts` | the project picker opens a typed path (`/abs/path`, `~/path`, `C:\path`). Before, it said "No folders match" for any folder not already in recents. |
| `contrib/voltAgent/browser/home/agentHomeWorkspaceActions.ts` | a typed path that is not a folder is reported ("… is not a folder.") instead of opening an empty project; passes the user home |
| `contrib/voltAgent/test/browser/agentHomeWorkspace.test.ts` | `typedFolder` cases |

Tests: Volt Claude work rules 5/5; ACP provider, agent pool, orchestrator and runtime suites
213 passing, 0 failing; menu and workspace suites 14 passing. `tsgo`: 0 errors.

## Bugs found and not fixed here (passed to their owners or still open)

- **Sandbox start cost** (+4–8 s per agent, worse for parallel fan-out). Passed to the sandbox
  work, report 03.
- **Sandbox noise in normal chats**:
  - a "Blocked by the sandbox" card for Claude Code's own skill sync
    (`~/.claude/skills/synced/…/manifest.json`);
  - "Sandbox kept config changes in this chat" for `cachedGrowthBookFeaturesAt`, a cache key that
    changes on every launch.

  Both passed to report 03.
- **New-agent page**: the orbit labels (MERGE, REVIEW, SHIP) animate across the project bar and the
  PROJECT caption and draw on top of their text (`/tmp/voltbench/vorch-3.png`, `vorch-5.png`).
- **Project picker**: the first recent row's path is cut mid-word ("…sktop/Projects/FALCON/gifty"),
  while the others start with `~/`.
- **Chat**: the "Thinking · 5s" row leaves a wide gap between the label and the timer, and a stray
  "–" glyph sits in the left margin next to a finished turn (`vorch-9.png`).

## Still open

- **Re-measure wall time on a quiet machine** (load < 5): B1 before and after, sandbox on and off,
  five repetitions each.
- **Hide the agent start behind the parent's call.** Volt sees the parent start a `delegate_task`
  call 2–5 s before the arguments arrive (B1: 4.9 s). Spares for the subagent model could start
  then, which would hide the ~1 s start on every fan-out.
- **Narrow the Volt MCP surface for subagents.** Every session lists ~130 Volt tools (14.5 KB of
  deferred-tool names) and ~1.2k tokens of server instructions, including devices, desktop,
  pull requests, visuals and thread management. `?groups=` exists, but tools without a group
  disappear under it, so it needs an audit first.
- **Share the prompt cache between parallel siblings.** Siblings started at the same moment each
  write the full cache. Starting siblings 2…N right after the first one's first request would
  turn ~20k cache writes into reads per sibling, at the cost of ~2 s.
