# 11 · Orchestrator, round 2: subagent size, spin-up, councils, titles

Branch `e2e2/orch` (base `81563ca39e4`), 2026-11-12. Round 1 is in [`../01-orchestrator.md`](../01-orchestrator.md),
[`../06-agent-to-agent.md`](../06-agent-to-agent.md) and [`../parallel/01-orchestrator.md`](../parallel/01-orchestrator.md).

## Summary

- **Subagent first request 28.0k → 9.2k tokens (-67%)** for research and review subagents
  (captured request; live median 28.3k → 9.3k over 9 subagents per arm). Claude Code's own Explore
  subagent on this machine sends 14.8k, mostly the user's skill listing; with the same skill cap it
  would be ~8.4k, so Volt is level with the native harness here, not far ahead. Subagents that
  change files: 15.3-15.5k (were 28k+).
- **B1 (4 subagents, N=3 per arm, interleaved): end to end 46.2 s → 36.5 s (1.26x), critical path
  34.2 → 26.3 s (1.30x), cost $0.650 → $0.460 (-29%), subagent cost -45%**, with the after arm at
  the higher load (50-56 vs 26-47). About 29 of the 36.5 s is model time; Volt's remaining cost is
  the cold agent start (7-12 s for three in parallel vs 2.9-3.6 s bare). Dispatch is 0.13 s
  (was 1.55 s per subagent).
- **Live job, team, council (N=3 each)**: the 6-step job with dependencies and an fx → Claude
  fallback was right in 3 of 3 runs (fix, feature, new module, passing tests, no stray files),
  114 s median; the parent woke 1.4 s after the last report. Team 49 s, 6 of 6 answers right in
  3 of 3. Council 136 s, verdict in 3 of 3.
- **Bugs found live and fixed**: Volt's own code tools (find_symbol, instant_grep, code_nav) were
  refused in every read-only subagent and council seat (24 refusals; every Grok seat, 8 of 8,
  came back cancelled); Claude's start-up denials were rows in every chat under Full access (12 per
  B1 run → 0); the subagent chip and side panel lagged the transcript's counts (now agree at every
  1 s sample).
- **Verified**: titles no longer come from the agent's words (1 of 3 before, 0 of 19 after); the
  empty first `delegate_task` call did not recur (0 of 9). **Not met**: default council seating on
  a fresh session still seats providers that cannot run (1 of 4 seats answered, twice); it only
  learns after a failure.

## Setup

| | |
|---|---|
| Build | this worktree, dev build (`scripts/code.sh`), profile `/tmp/v2-orch-ud`, CDP 9942, `scripts/orch/launch.sh` |
| Claude Code | Volt runs `@agentclientprotocol/claude-agent-acp` 0.81.2, whose SDK (0.3.280) bundles Claude Code **2.1.280**. The user's own CLI (native subagent baseline, title calls) is **2.1.322**. |
| Models | parent and subagents Claude **Haiku 5.5** (`claude-haiku-5-5`) through claude-code; council adds Grok 4.7 and Claude Haiku 4.5; the challenge's failing task starts on fx (`fx:openai/gpt-5.4-nano`) |
| Access / sandbox | Full access (no approvals), sandbox at the user's default (Supervised: workspace-write, network on), as in round 1 |
| Fixture | `/tmp/voltbench/fx` (4-file TypeScript shop with the planted discount bug); challenge copies in `fx/runs/<tag>` |
| A/B | `scripts/orch/arm.sh base|new` swaps the 16 non-test source files this branch changes between `81563ca39e4` and HEAD in the same window (out/ rebuilt, agent server restarts, window reloads). `ab.sh` alternates base, new, base, new… so load drift hits both arms. |
| Load | the machine ran four other agents' suites and instances: 1-minute load **25-249** during these runs (most 25-75); every row carries its load |

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
- **Restart runs**: `scripts/orch/live2.sh 3` (B1 pairs 2-3, three plain-words delegations, two
  default councils, then `after.sh 3`), `verify.sh` (re-runs after the last fixes), `show.py` and
  `summarize.py` print the rows; `countwatch.mjs` samples the three subagent counts once a second.

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
  file tools and 72 of 138 Volt tools. Its first request is measured in the challenge runs (section 6).
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

### 5. Chat titles (item 6)

Round 1: titles sometimes came from the agent's first words ("I couldn't run this. No `council`").
The cause was the title call itself: Claude Code's title request ran Haiku under Claude Code's
full agent prompt, and Haiku answered the message instead of naming it. Commit 023bc9a4f0a gives
the title call its own short system prompt, says the message is data, and drops replies that
answer instead of name (`sanitizeTitle`).

| Arm | Runs | Titles that answer the request | Examples |
|---|---|---|---|
| Before (B1, interleaved) | 3 | **1** ("I can't run this benchmark. `delegate_task` and…", `img/orch/base-title-from-agent.png`) | "Run Orch bench B1 delegation", "Orch bench B1" |
| After (B1, natural, default councils, challenge, team, councils, re-runs) | 3 + 3 + 2 + 3 + 3 + 3 + 2 = 19 | **0** | "Orch bench B1 delegate and wait run", "Pricing function bug", "Volt council benchmark pricing", "Benchmark spawn_team call for fx-audit" |

The UI agent's own title change was reverted in favour of this one (as the brief says); no
further change here.

### 6. A 6-step job with dependencies and a fallback, a team, a council (item 7)

After arm only (this branch before the two last fixes below), N=3 each, interleaved challenge, team,
council (`after.sh 3`), Haiku 5.5 parent. The machine was busy: load 26-249.

**Challenge** (`chal-prompt.txt`): one `delegate_task` with six parts on a fresh copy of the
fixture: C1 research (callers), C2/C3/C4 implementation in parallel, C4 starting on fx
(`fx:openai/gpt-5.4-nano`) with `fallback_models: [claude-haiku-5-5]`, C5 tests `after` 2-4, C6
review `after` 1 and 5. The parent ends its turn and is woken with the reports.

| Metric | Median (range), N=3 | Notes |
|---|---|---|
| Load (1 min) | 49 (26-74) | |
| End to end | **114.4 s** (83.5-125.6) | |
| Critical path (accepted → last report) | 90.9 s (69.7-109.2) | C2-C4 in parallel → C5 → C6 |
| Outcome checks (`chalcheck.sh`) | **3 of 3 runs: fix, restock, formatCents and the tests all right, 0 stray files** | |
| Fallback: fx fails → Claude prompt sent | fx failed 2.9-5.0 s after dispatch ("Failed to load startup state", fx in a sandbox); the fallback turn was queued at 0 ms and its agent bound 6.1-8.2 s later (cold start) | 3 of 3 |
| Parent woken after the last report | **1.4 s** (0.7-2.9), then its wake turn 4.1 s (3.8-8.6) | 2 parent runs each, no extra wake-ups |
| First request, research / review (read-only) | 9.3k / 10.6-10.9k | |
| First request, implementation (work profile) | 15.3-15.5k (C4 with the fallback note 16.3-16.5k) | before: one profile for all, 28.3k+ |
| First request, test (with 3 upstream reports) | 16.9-21.5k | |
| Cost | $0.955 (0.873-1.096) | |
| Failures, denial rows | 0; 0-2 (two `node` rows in one run: `~/.npmrc`, a tsx pipe) | |

**Team** (`team-prompt.txt`): `spawn_team` with 3 Haiku 5.5 research members and 6 board items.

| Metric | Median (range), N=3 |
|---|---|
| Load | 102 (60-249) |
| End to end | **49.3 s** (43.3-63.8) |
| Critical path | 34.7 s (28.1-48.1) |
| Answers right | 6 of 6 items in 3 of 3 runs |
| Member first request | 10.5k (10.3-10.6k) |
| Parent woken after the team's last member | 1.6 s (1.6-1.9) |
| Cost | $0.688 (0.594-0.688) |

**Council** (`council-prompt.txt`): seats Haiku 5.5, Grok 4.7, Haiku 4.5; moderator Haiku 5.5; one
review round.

| Metric | Median (range), N=3 |
|---|---|
| Load | 88 (64-151) |
| End to end | **135.5 s** (102.7-136.6) |
| Verdict | (A) in 3 of 3, with the reason and the caveat that Grok gave nothing |
| Grok seat | **cancelled in 3 of 3** (answer and review; one review "Rate limited") — bug, fixed below |
| Cost | $0.82 (0.69-0.83) |

**Default seating (item 5)**: the council tool with no participants (`council-default-prompt.txt`),
N=2, load 29 and 38.

| Run | Seats Volt picked | Answered | Why the others failed |
|---|---|---|---|
| cdef-1 (first council in this window) | Opus 5.5, Codex GPT-6-Luna, fx GPT 5.2, Grok 4.7 | 1 of 4 | Codex out of quota (resets Nov 26); fx cannot start in a sandboxed chat; Grok refused its code tool (bug below) |
| cdef-2 | Grok 4.7, Ollama gemma4:26b, Antigravity Gemini 3.8 Flash, Cursor Auto | 1 of 4 (Cursor answered its review only) | Antigravity cannot bind a loopback port in the sandbox; Cursor did not answer `session/new` within 120 s; Grok as above |

- **Partly verified.** The second council left out the two providers that failed in the first
  (Codex: quota; fx: start in this sandbox), as 3894a2fa65b intends. But Volt learns only from
  failures in the runs it has loaded: the first council of a session seats providers blind, and
  Antigravity and fx are known (round 1) not to start in a sandboxed chat. Both runs ended with one
  real answer and a verdict that says so. Open issue below.
- cdef-2 took 460 s: the local gemma4:26b took 252 s to answer and Cursor's `session/new` waited
  out its 120 s timeout.

### 7. Found live and fixed afterwards, then re-run (N=1 each, functional checks)

**Volt's code tools were refused in every read-only subagent.** Research and review subagents
(and council seats) run in Ask mode. When their agent asked permission for one of Volt's code
tools (`mcp__volt__find_symbol` from Claude, `volt__code_nav` from Grok, `volt-instant_grep:
instant_grep` from Cursor), Volt did not recognise it as its own host tool, judged it a shell
command, and Ask mode refused it. Over this profile: 24 refusals in read-only subagents (Claude,
Grok, Cursor), and Grok answers a refusal by ending its turn, so **every Grok council seat came back
cancelled (8 of 8 Grok seats in 5 councils)**. Volt's own prompts tell these agents to use
exactly these tools. Fix `3a12ad3a2a8`; re-run (`verify.sh`, load 69): 0 refusals, the Claude
seats used `instant_grep` and `code_nav` in Ask mode; the Grok seats could not be checked live
because Grok was rate limited by then (its 24 h cap).

**Subagent counts disagreed** (`img/orch/subagent-counts-disagree.png`: card "3 working · 1
queued", chip "2 subagents running", side panel "1 RUNNING" at the same moment). e5a733cb888 fixed
the card. Sampled once a second during a B1 run after it (`countwatch.mjs`,
`data/orch/counts-new2.jsonl`), the composer chip still ran one step behind (4 running with 3 live;
1 running with all 4 done) and the side panel kept a finished subagent "running" for about 2 s.
Fix `06dbd0a6135`; re-run (`data/orch/verify-counts.jsonl`): at every sample the card's live
count, the chip and the side panel agree (3/3/3, 2/2/2, 1/1/1, then all cleared together).

## Fixes made

| Commit | Files | What | Why | Test |
|---|---|---|---|---|
| 023bc9a4f0a | `claudeWorkRules.ts`, `providers.ts`, `acpProvider.ts`, `voltRuntimeService.ts`, `agentOrchestratorService.ts`, `agentTasks.ts`, `hostTools.ts`, `voltHostMcp.ts`, `voltHostMcpService.ts`, `session.ts`, `orchestrator.ts`, `agentTurnHost.ts` | Delegated subagents start as `readonly` (research, review, Ask/Plan) or `work`: no claude.ai connectors or skill/plugin sync, no git workflow, no Workflow/ScheduleWakeup/AskUserQuestion/ReportFindings/ListAgents…; read-only ones on Volt's short system prompt with `strictMcpConfig` and no file-editing tools. Host tools by group (`?groups=`: 26 of 138 read-only, 72 work), server instructions follow the groups; the brief drops notes for groups it lacks | 28k-token first request (item 1) | `claudeWorkRules.test.ts`, `acpProvider.test.ts`, `agentOrchestratorService.test.ts`, `voltHostMcpMainService.test.ts`; live: section 1, 2 |
| 023bc9a4f0a | `agentTasks.ts`, `agentOrchestratorService.ts` | An argument-less `delegate_task` is answered with the arguments to use | round 1's empty first call (item 2) | `agentOrchestratorService.test.ts`; live: did not occur (section 3) |
| 023bc9a4f0a | `titleGeneration.ts` | Title call on its own system prompt; the message is data; answers dropped | titles from the agent's words (item 6) | `titleGeneration.test.ts`; live: section 5 |
| 3894a2fa65b | `agentTurnHost.ts` | Read-only subagents do not wait for the git checkpoint before their prompt | 1.0-2.3 s per subagent, siblings queued on one index (item 4) | `agentTurnHost.test.ts`; live: 1.55 → 0.13 s |
| 3894a2fa65b, e5a733cb888 | `orchestra.ts`, `agentOrchestraService.ts` | Default council seats leave out providers out of quota or unable to start in this sandbox, put working and signed-in ones first, fill a third seat with a second model; 2-seat councils review without a ranking | round 1: seating ignored whether providers can run (item 5) | `orchestra.test.ts`; live: partly (section 6) |
| e5a733cb888 | `agentEditor.ts` | The parent's subagent card re-renders on its tasks' changes while it waits | card stuck at "3 working · 1 queued" | live: section 7 |
| 921ce414445 | `sandboxPolicy.ts` | Claude's start-up looks (plugin sync, `~/.claude/state`, `~/.config`, `/private/var`) and shell rc reads are housekeeping: logged, not rows | 12 (9-24) denial rows per B1 run under Full access (item 3) | `sandboxPolicy.test.ts` HOUSEKEEPING-1; live: 0 rows |
| 3a12ad3a2a8 | `acpProvider.ts` | Volt's code tools count as its own host tools in any agent's permission prompt | refused in every Ask-mode subagent; Grok seats cancelled | `acpProvider.test.ts` (new case); live: 0 refusals |
| 06dbd0a6135 | `agentEditor.ts`, `agentLineageDock.ts` | The composer chip and the side panel follow task changes too | counts one step behind / 2 s late | live: `verify-counts.jsonl` |

Tests on the final tree (after `transpile-client-oxc`): `claudeWorkRules` 7, `acpProvider` 33,
`agentOrchestratorService` 19, `titleGeneration` 12, `agentTurnHost` 3, `orchestra` 31,
`sandboxPolicy` 25, `voltHostMcpMainService` 10, all passing. `tsgo` 0 errors. CI lints pass
(listener, spawn, manifest ceiling, feature imports, git spawn, command visibility, layers);
`authorityGate` fails only on the known `extensionCodeScan.ts:361` line owned by the sandbox agent.

## Bugs found and not fixed

- **Review subagents cannot run tests.** Research and review run in Ask mode, which refuses
  shell commands that Claude Code asks about (`node --test …` in challenge C6, 1 of 3 runs; `git
  diff` passes because Claude Code does not ask for it). Volt's own read-only system prompt tells
  them to run "a test or a type check when the brief asks". Either the prompt or the mode is wrong;
  the recommended fix is a read-only mode that allows non-mutating commands under the sandbox's
  read-only level, which needs the sandbox owner. Not changed here.
- **Other agents' start-up denials are still rows**: Grok (reads of `~/.claude.json`,
  `~/.claude/settings.json`, `~/.cursor/mcp.json`, skills folders; writes of
  `~/.grok/experiments_remote_opt_out.*.tmp`, `~/.grok/bundled/.tmp*`), Cursor (skills folders,
  `~/.cursor/agent-cli-state.json`) and Codex (plugin cache temp files): 22 rows per council with a
  Grok seat. `AGENT_HOUSEKEEPING` has entries for Claude Code only and matches folders, not temp-file
  name patterns. Passed to the sandbox area.
- **A council review whose own seat already failed for quota or start-up runs anyway** and fails
  again (Codex: quota; fx, Antigravity: sandbox), costing up to 29 s; a transient failure (Cursor's
  `session/new` timeout) did recover in its review, so a blanket skip would be wrong. Not changed.

## Open issues

- **Default council seating on a fresh session** (item 5): Volt has no memory of provider health
  across sessions and no static knowledge that fx and Antigravity cannot start in a sandboxed chat,
  so the first council seats them (1 of 4 seats answered, twice). Recommended: persist seat health
  (with quota reset times) in the orchestrator store, and seat a replacement when a seat fails to
  start.
- **Cold agent start is the largest Volt cost left** (item 4): 7-12 s for three parallel Claude
  starts at load 50-55 against 2.9-3.6 s for a bare `claude-agent-acp` start at load 40. Hiding it
  behind the parent's `delegate_task` call (1.5-2.7 s visible before the arguments arrive) needs
  spares keyed before the subagent chat exists; the rest is the sandbox launch and `session/new`
  with Volt's MCP server (sandbox area).
- **Grok seat with the code-tool fix**: not seen live (Grok rate limited); unit-tested.
- The read-only subagent still carries the full skill listing (2.3k of 9.2k tokens); dropping the
  Skill tool for research would save ~2.9k but loses project skills a reviewer may need (for
  example UI rules), so it was left on.

