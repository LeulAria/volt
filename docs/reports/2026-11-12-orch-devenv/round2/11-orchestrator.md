# 11 · Orchestrator, round 2: subagent size, spin-up, councils, titles

Branch `e2e2/orch` (base `81563ca39e4`), 2026-11-12. Round 1 is in [`../01-orchestrator.md`](../01-orchestrator.md),
[`../06-agent-to-agent.md`](../06-agent-to-agent.md) and [`../parallel/01-orchestrator.md`](../parallel/01-orchestrator.md).

## Summary

<!-- SUMMARY -->

## Setup

| | |
|---|---|
| Build | this worktree, dev build (`scripts/code.sh`), profile `/tmp/v2-orch-ud`, CDP 9942, `scripts/orch/launch.sh` |
| Claude Code | Volt runs `@agentclientprotocol/claude-agent-acp` 0.81.2, whose SDK (0.3.280) bundles Claude Code **2.1.280**. The user's own CLI (native subagent baseline, title calls) is **2.1.322**. |
| Models | parent and subagents Claude **Haiku 5.5** (`claude-haiku-5-5`) through claude-code; council adds Grok 4.7 and Claude Haiku 4.5; the challenge's failing task starts on fx (`fx:openai/gpt-5.4-nano`) |
| Access / sandbox | Full access (no approvals), sandbox at the user's default (Supervised: workspace-write, network on), as in round 1 |
| Fixture | `/tmp/voltbench/fx` (4-file TypeScript shop with the planted discount bug); challenge copies in `fx/runs/<tag>` |
| A/B | `scripts/orch/arm.sh base|new` swaps the 16 non-test source files this branch changes between `81563ca39e4` and HEAD in the same window (out/ rebuilt, agent server restarts, window reloads). `ab.sh` alternates base, new, base, new… so load drift hits both arms. |
| Load | the machine ran four other agents' suites and instances: 1-minute load **28-130** during these runs; every row carries its load |

Measurement sources:

- **Prompt per request, by part**: `scripts/orch/capproxy.mjs` (a logging proxy; Claude Code pointed at it with
  `ANTHROPIC_BASE_URL`) and `breakdown.mjs` (splits a request into system prompt, each tool schema, Claude Code's
  session context: skill listing, deferred tool names, MCP instructions per server, and the messages; part sizes are
  characters scaled to the billed prompt). Behind a proxy Claude Code 2.1.280 turns Tool Search off unless
  `ENABLE_TOOL_SEARCH=true`, and Volt's sandbox passes only listed env keys to the agent, so captures ran with the
  sandbox off (subagent prompts are otherwise the same; the trace numbers below are sandboxed and agree).
- **Timing, cost, wake-ups, failures, denials**: `scripts/orch/b1run.mjs` drives one run over CDP and
  `orchmetrics.mjs` reads Volt's own traces (`User/voltTraces`) and the saved tree (`User/voltOrchestrator/roots`).
  Prompt per subagent = the `used` of its first `usage` event (its first request's context).
- **CLI probes**: `scripts/orch/cliprobe.sh` runs the bundled CLI headless through the proxy, one setting at a time.

The round-2 agent's session ended part way ("Sign in to continue"). Its last four B1 rows were
Claude refusing every turn ("Your organization has disabled Claude subscription access for Claude
Code", no turn ran); they are kept apart in `data/orch/b1ab-aborted.jsonl` with two earlier rows
cut short by a window reload. The restart re-ran the missing pairs; Claude worked again by then.

## Results

### 1. A subagent's first request (item 1)

The first request a Volt research subagent sends, by part (B1 "pricing bug", Haiku 5.5, captured
through `capproxy.mjs`; tokens are characters scaled to the billed prompt):

| Part | Before (`81563ca39e4`) | After (this branch, `readonly` profile) | Claude Code's own Explore subagent (CLI 2.1.322) |
|---|---|---|---|
| System prompt | 5,512 | 704 (Volt's own read-only prompt) | 1,362 |
| Built-in tool schemas | 13,481 (11 tools: Bash 4.2k, Workflow 1.9k, ScheduleWakeup 1.7k, AskUserQuestion 1.4k, Read, ReportFindings, Skill, Edit, ToolSearch, ListAgents, Write) | 4,095 (Bash, Read, Skill, ToolSearch) | 3,187 (Bash, Read, Skill, ToolSearch) |
| Deferred stubs / loaded MCP tools | 792 | 74 | 736 (claude.ai Docs connectors) |
| Session context: skill listing | 2,848 | 2,335 | **8,664** |
| Session context: deferred tool names | 1,486 (138 Volt tools + claude.ai) | 348 (26 Volt tools) | 180 |
| Session context: MCP instructions | 1,419 (volt 741, claude.ai Docs 678) | 346 (volt, tasks/core groups only) | 0 |
| Session context: other | 290 | 96 | 373 |
| First user message (Volt framing + brief) | 2,105 | 1,221 | 259 |
| **Billed prompt** | **27,990** | **9,218 (-67%)** | **14,762** |

- **Item 1 target met for read-only subagents**: 28.0k to 9.2k tokens, below Claude Code's own
  Explore subagent on this machine (14.8k). The comparison is honest only with a caveat: most of
  Explore's size is the user's skill listing (8.7k; CLI 2.1.322 lists every skill in full). With
  Volt's 160-character cap on skill descriptions Explore would be about 8.4k, so Volt is level with
  it, not far ahead. What Volt still carries that Explore does not: a longer Bash description
  (sandbox notes, +0.6k) and the brief's framing (+0.8k).
- Live, over every research subagent of the B1 runs (Volt's own `usage` events, sandbox on), the
  first request is in the table below (B1, section 2).
- A subagent that changes files (`work` profile: implementation, test) keeps Claude Code's prompt,
  file tools and 72 of 138 Volt tools. Its first request is measured in the challenge runs (section 5).
- CLI probes (`data/orch/cliprobes.jsonl`, Claude Code 2.1.280 headless, one-file read) show what
  each setting is worth: round-1 lean session 21.7k; no claude.ai connectors or skill/plugin sync
  19.4k; without the never-used tools 14.4k; no git instructions 11.8k; a short custom system
  prompt with no file-editing tools 6.5k.

### 2. B1 delegation, before and after (items 1, 3, 4)

B1 = one `delegate_task` call with 4 research subagents on Haiku 5.5 (three in parallel, a fourth
`after` them with their reports), parent Haiku 5.5 waiting in `wait_tasks`. Same window, arms
interleaved base, new, base, new... (`arm.sh`), N=3 each, sandbox on (Supervised), Full access.
Rows: `data/orch/b1ab.jsonl`; `summarize.py` gives the medians.

| Metric (median, range) | Before (`81563ca39e4`), N=3 | After (this branch), N=3 | Change |
|---|---|---|---|
| Load (1 min) | 47, 26, 26 | 56, 50, 55 | after ran at **higher** load |
| **End to end** (send → parent's last turn ends) | **46.2 s** (41.9-48.5) | **36.5 s** (34.7-44.2) | **-21%** (1.26x) |
| Critical path (`delegate_task` accepted → last report) | 34.2 s (29.5-36.7) | 26.3 s (23.9-32.5) | -23% (1.30x) |
| Subagent first-request prompt (research) | 28.3k (28.3-28.3k) | 9.3k (9.3-9.3k) | **-67%** (3.0x smaller) |
| Synthesis subagent first-request prompt (with 3 reports) | 29.1k (29.1-29.6k) | 10.8k (10.7-10.8k) | -63% |
| Dispatch → prompt sent, per subagent | 1.55 s (0.61-2.32) | 0.13 s (0.02-0.70) | -1.4 s per subagent |
| Cold agent ready (3 in parallel) | 9.9 s (5.8-12.6) | 7.5 s (7.1-11.6) | load-bound, see below |
| Pool spare adopted (synthesis) | 76 ms (13-140; one run had none: 2.3 s cold) | 13 ms (5-523) | |
| **Cost per run** (parent + subagents) | **$0.650** (0.636-0.674) | **$0.460** (0.426-0.501) | **-29%** |
| Subagent cost per run | $0.405 (0.394-0.434) | $0.221 (0.220-0.261) | -45% |
| Sandbox denial rows per run | 12 (9-24) | 0 (0-12; the 12 is the run before the housekeeping fix) | see 4 |
| Failures, refused calls | 0, 0 | 0, 0 | |

Where the after-run's 36.5 s goes (median run `b1ab-new-2`, load 50):

| Phase | Time | Whose |
|---|---|---|
| Parent: send → `delegate_task` accepted (time to first token on a 37k prompt, then 2.5 KB of JSON arguments) | 7.8 s | model |
| Dispatch → prompt sent | 0.03-0.06 s | Volt |
| Cold agent start (3 at once: sandbox launch, ACP `initialize` + `session/new` with Volt's MCP server) | 7.1-7.3 s | Volt + Claude Code start |
| Research subagents' model work (TTFT, one Read, answer) | 5.6-10.0 s | model |
| Synthesis: dispatch 17 ms, pool spare 5 ms, then model | 9.0 s | model |
| Parent wakes in `wait_tasks`, replies "done" | 2.4 s | model |

- **End to end the gain is 1.26x, not more.** About 29 s of the 36.5 s is model time (Haiku's
  first token on each request and its output); Volt's own share is the cold agent start (~7 s, of
  which a bare `claude-agent-acp` start outside Volt is 2.9-3.6 s for three at once at the same load,
  `data/orch/acpstart-raw.jsonl`) and well under 0.2 s of dispatch.
- The cheaper prompt is the main win: 3x smaller first request, 45% cheaper subagents, and Haiku's
  time to first token falls with it.
- **Cold start (item 4)**: the dispatch wait for the git checkpoint is gone for read-only subagents
  (1.55 s to 0.13 s per subagent, commit 3894a2fa65b). The agent start itself (7-12 s at load 50,
  ~4 s more than a bare start) is the sandboxed launch plus Volt's MCP server setup in
  `session/new`; it was not shortened here. Starting spares while the parent is still writing the
  `delegate_task` arguments (Volt sees the call start 1.5-2.7 s before the arguments) would hide
  part of it; it needs spares keyed before the subagent chat exists (open issue).

### 3. Claude's first `delegate_task` call (item 2)

Round 1 saw Claude's first `delegate_task` arrive with no arguments (the schema was deferred behind
Tool Search; 5.9 s and a ToolSearch round trip lost). Commit 023bc9a4f0a answers such a call with
the arguments to use, so the next call is right without loading the schema.

Live, a request in plain words (`natural-delegate-prompt.txt`: "Ask a subagent (delegate_task, …)
to read pricing.ts…"), after arm, N=3, load 31-40 (`data/orch/natural.jsonl`):

| Run | Parent's calls | Empty calls | End to end | Subagent agent |
|---|---|---|---|---|
| natural-1 | ToolSearch, then `delegate_task` with full arguments | 0 | 13.0 s | pool spare, 65 ms |
| natural-2 | same | 0 | 12.6 s | pool spare, 2 ms |
| natural-3 | same | 0 | 14.9 s | pool spare, 22 ms |

- **The empty call did not happen in 3 of 3 runs** (nor in any B1 run, 6 of 6, before or after),
  so the guidance could not be seen working live; it is covered by the unit test
  (`agentOrchestratorService.test.ts`, "a delegate_task call without arguments (schema not loaded yet) is told the arguments, so the next call is right"). Claude Code
  2.1.280 loads the schema with ToolSearch first (about 2 s).
- In the B1 after-runs Claude called `delegate_task` directly with no ToolSearch at all, because the
  prompt names the tool's exact arguments.

### 4. Sandbox denials under Full access (item 3)

**Cause.** "Full access" is the approval mode (no prompts); it does not turn the sandbox off. The
chats run in the user's default sandbox (Supervised: workspace writes, network on), so the kernel
still refuses what lies outside it, and every refusal was a transcript row. What was refused, in
every run, was each agent's start-up and nothing the task did:

| Denied | By | Per | Why it happens |
|---|---|---|---|
| read `~/.config`, `~/.claude/state`, `/private/var` (as folders) | claude | each new subagent | Claude Code's start-up looks (XDG lookup, its state folder, the walk to the temp root) |
| read `~/.zshenv`, `~/.zprofile`, `~/.zshrc` | zsh | each agent's first Bash call | the Bash tool's shell reads the user's startup files, which the sandbox keeps out (they may export tokens) |
| write `~/.claude/plugins/synced/…`, `known_marketplaces_claudeai.json.lock` | claude | the parent (not lean) | claude.ai plugin sync; the config overlay links `plugins` read-only |

**Fix** (`921ce414445`, `sandboxPolicy.ts`): these are housekeeping, like the CLI's other
background state: still denied, logged in the agent server log, never a row or an "Allow" button.
A write to an rc file still shows. After the fix: **0 rows per run** in B1 (2 of 2 runs), the
challenge, the team and the councils; before: 12 (9-24) per B1 run. The agent server log shows the
same denials as "housekeeping denial, not shown".

<!-- RESULTS -->
