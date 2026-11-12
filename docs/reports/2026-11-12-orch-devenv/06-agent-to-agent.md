# 06 · Agent-to-agent orchestration compared with other harnesses

## Summary

- **Volt's model is chats that talk to chats.** Every subagent is a real Volt chat: visible,
  resumable and on any provider. It has a contract (goal, scope, files, done_when), a budget,
  `after` dependencies, fallbacks, and a report that wakes the parent once. On top of that sit
  teams (a shared board, work stealing, one wake-up per team) and councils (anonymous,
  shuffled, cross-provider review, then a verdict). Messages go between chats with `thread_send`,
  `message_task` and `team_send`.
- **Measured against Claude Code's own subagents** (the closest in-process harness; benchmark B1's
  three research tasks, Haiku 5.5, same prompts):

  | | Claude Code native `Agent` (Explore) | Volt `delegate_task`, before | Volt `delegate_task`, after |
  |---|---|---|---|
  | Prompt per request | 12.3–13.3k | 43.7k | 29.4–30.2k |
  | Time per task | 5.3–8.0 s | 7.6–15.2 s | 5.8–13.8 s (load 20–34, after the sandbox fixes; 01) |
  | Process start | none (in-process) | 1.1 s cold, 0 s from a spare | 0.9–2.5 s cold sandboxed, 1–159 ms from a lean spare |
  | Model / vendor | the parent's vendor only | any of ~200 models, 7 harnesses | same |
  | Visible, resumable, budgeted, contract, dependencies | no | yes | yes |

  Native subagents are cheaper per call because they share the parent's process and get a
  stripped-down prompt. Volt's subagents pay for a full harness session. This pass cut that
  overhead by a third (01). The rest is Claude Code's own system prompt and tool list, plus
  Volt's ~130 MCP tools (see 01, "Still open").
- **Hermes and similar harnesses were not run.** No Hermes agent is installed on this machine,
  and the comparison with herdr, T3 Code, Claude Code agent teams, Codex multi-agent, opencode,
  Gemini CLI, claude-squad, Conductor, Sculptor, Vibe Kanban, Xum, ccmanager, Amp and A2A is the
  design survey in `VOLT-ORCHESTRATION-RESEARCH.md` (2026-11-09). This pass compares live only
  against Claude Code's native subagents.
- **Teams and councils now work end to end. They were broken in four ways, all fixed here (see "Fixes made").**
  A 3-member Haiku team over a 6-item board: every item was claimed exactly once and split 3/2/1,
  all six answers were correct, the lead was woken once, and the run took 29 s in total ($0.79).
  A council (Haiku + Grok 4.7 [+ Gemini 3.8 Flash], one review round, Haiku moderator) gave the
  right verdict, A. It took 123–146 s, almost all of it Grok 4.7 thinking at high effort.

## Setup

- Fixture `/tmp/voltbench/fx` (see 01).
- Native arm: three `Agent` calls (subagent type Explore, model haiku) started in one message
  from this chat. Numbers come from their transcripts under
  `~/.claude/projects/<project>/<session>/subagents/agent-*.jsonl`, with usage counted once per
  request id.
- Volt arm: B1 in report 01.
- Team arm: the `spawn_team` prompt in `/tmp/voltbench/team-prompt.txt`: one member group
  (`claude-haiku-5-5` ×3, research), a board of 6 items, `client_request_id` `team-bench-1`.

## Results

### Native vs Volt, per task (B1)

| Task | Native: time / prompt per request | Volt before: time / prompt | Volt after (sandbox on, load 20–34) |
|---|---|---|---|
| pricing bug | 5.3 s / 12.5k | 7.6 s / 44.3k | 8.0 s / 29.3k |
| call graph | 8.0 s / 13.3k (3 requests) | 15.2 s / 44.3k (5 tools) | 11.8–13.8 s / 29–30k |
| stock check | 5.7 s / 12.5k | 7.9 s / 44.3k | 5.8–8.2 s / 29.3k (5.8 s from a lean spare) |

All three arms answered correctly. The B1 critical path (delegate → dependent synthesis) went from
28.1 s to a median of 20.4 s (01). Claude Code's native subagents remain about 2.3× leaner per
request, because they share the parent's process and get a stripped-down prompt.

### Team: `spawn_team`, 3 × Haiku 5.5 (research), 6-item board, sandbox on (Supervised default)

| Run | What happened | Fixed by |
|---|---|---|
| 1 (load 211) | The agent server restarted mid-turn to load another agent's recompiled code | (test rig) |
| 2 | `spawn_team` waited on an approval card showing `$ mcp__volt__spawn_team` as a shell command | the orchestra tools are now Volt host tools, like `delegate_task` |
| 3 | "spawn_team was blocked: this chat runs in Volt's sandbox"; the lead answered the six items itself | sandbox classes for the orchestra tools (teams inherit the sandbox) |
| 4 | Members ran, but none claimed a board item ("plan mode blocks state-changing tools"), so every member did all six | member brief and plan-mode workflow: the board changes no files |
| **5** | **Each item claimed once (members took 3/2/1), all six answers correct, one wake-up, 29 s total, members 17–20 s, $0.79** | — |

Board after run 5 (`voltOrchestrator/orchestra/teams/team-*.json`): `subtotal` → 600, `tax` → 80,
`inStock B2` → false, `reserve C3` → true and stock 0, `cart imports` → LineItem, subtotal,
applyDiscount and tax from ./pricing, `checkout throws` → `Error('out of stock ' + sku)`. Every
item has `claims: 1`.

### Council: `council`, Haiku 5.5 + Grok 4.7 (+ Gemini 3.8 Flash), 1 review round, Haiku moderator

| Run | Participants that ran | Total | Notes |
|---|---|---|---|
| 1 | Haiku 21 s, Grok **401 s** (review 130 s) | 456 s | Grok's turns ended minutes after its answer; Grok's `~/.grok/worktrees.db-wal`, `bundled/.lock` and `registry.lock` writes were denied |
| 2 | Haiku 22 s, Grok 51 s (review 62 s) | **123 s** | verdict A, correct. With 2 seats each reviewer sees only one other answer, so the ranking says little (the moderator said so) |
| 3 | the requested seats were **ignored**; Opus 5.5, GPT-6-Luna, GPT 5.2 and Gemini were seated instead | 81 s | Haiku had put all the arguments into `question` as a JSON string. Codex was out of quota, fx failed ("Failed to load startup state", see Still open), Antigravity exited ("flags provided but not defined: -model") |
| 4 | Haiku 15 s, Grok 98 s (review 96 s); Gemini failed to start | 146 s | verdict A. Antigravity now starts, but its language server can't listen on `127.0.0.1:0` inside the sandbox (see Still open). Grok's sidecar denials are gone; its time is thinking at high effort (first text at 45 s) |

Run 1's 401 s did not repeat in runs 2 and 4 (51–98 s), so I don't claim the sidecar fix explains
it. The fix removes the denials in any case.

## Fixes made in this area

| File | Change |
|---|---|
| `services/voltRuntime/common/hostTools.ts` | the orchestra tools (`spawn_team`, `council`, `team_send`, `team_board`, `orchestra_status`, `machine_run`) are Volt host tools: auto-approved like `delegate_task`, and shown as Volt rows, not `$` commands |
| `services/voltRuntime/common/hostToolSandbox.ts` (+ test) | sandbox classes: `spawn_team`/`council` like `delegate_task` (a worktree team escapes), `team_send` like `message_task`, `team_board`/`orchestra_status` safe, `machine_run` escapes. The completeness test now includes the orchestra tools; that gap hid the bug |
| `services/voltRuntime/common/orchestration/orchestra.ts` | member brief: team_board and team_send change no files, so they are used in Ask/Plan chats too |
| `services/voltRuntime/common/harness/claudeWorkRules.ts` | the subagent plan-mode workflow names Volt's coordination tools as allowed |
| `services/voltRuntime/common/hostTools.ts` `unwrapStuffedArgs` + `browser/host/hostToolService.ts` (+ test) | a call whose only argument is the whole call as JSON runs with the arguments inside |
| `platform/voltSandbox/node/sandboxResolver.ts` (+ test), `common/sandboxPolicy.ts`, `extensions/volt-provider-grok/package.json`, generated tables | SQLite `-wal`/`-shm`/`-journal` files that don't exist yet are kept as writable single files (they were dropped, for Grok and OpenCode); Grok's two lock files added |
| `services/voltRuntime/browser/agents/acpProvider.ts` | Antigravity starts without `--model`, which `agy acp` 1.5 rejects; the model is set through its ACP config option |
| `services/voltRuntime/common/harness/claudeWorkRules.ts` | lean subagent sessions (01) also apply to team members and council seats |

Tests: host tools 39, sandbox classes 9, orchestra + work rules 191, providers-as-data + sandbox
283, sandbox attestation 17, adversarial + Seatbelt equivalence 43, ACP 110. All passing; `tsgo`
0 errors.

## Still open

- **Antigravity can't run in a sandboxed chat.** Its language server listens on a random loopback
  port. The sandbox allows only ports the user grants, and on macOS a granted port is reachable on
  every interface (report 03). Allowing it would open a random port to the network. Options: run
  Antigravity only with the sandbox off (say so in the picker), or have Volt grant it one fixed
  port. Your call.
- **fx can't start in a sandboxed chat** ("Failed to load startup state"). It starts fine outside
  the sandbox, and no file denial was logged. Its login is probably in the keychain, which the
  agent profile denies, and fx has no secure-storage bridge like Claude's.
- **Default council seating ignores availability.** It seated Codex while the account was out of
  quota, plus fx and Antigravity, which can't start sandboxed. It should prefer providers that ran
  successfully recently.
- **Two-seat councils:** a reviewer never sees its own answer, so with 2 seats each review sees
  one answer. Council could require 3 seats, or warn.
- **Chat titles from the agent's first words:** e.g. "I couldn't run this. No `council`" and
  "I don't have a `spawn_team`…", instead of the user's request.
- **Claude.ai connector instructions reach every subagent.** A team member saw Claude Docs'
  "create a doc first" instruction and ignored it. Read-only subagents could run with
  `strictMcpConfig` (01).
- Hermes (Nous Research) is not installed here, so it was not compared.
