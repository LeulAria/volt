# Round 5: prompt size (tokens)

Status: **final** (2026-11-14). Branch `e5/tokens`, worktree `volt-e5-tokens`, from `9bbb8818c60`. ADEMark Track B
method, unofficial (this Mac, a clean Claude config dir instead of ADEMark's `ademark` macOS user).

## Summary

- "hi" (B1) in a Volt Claude chat on Opus 5.5: **14.1K to 12.2K tokens** (n=3 each, every run identical). The bare
  Claude CLI at the same version Volt runs (Claude Code 2.1.322) sends **18.1K** here. Target was 10.5K: **not reached**.
- The real prompt (B3): **53.1K to 46.4K** (n=3 each). Bare CLI: 61.1K (61.0-105.1K). Target was 35.4K: **not reached**.
- B3 cost: **$0.0614 to $0.0583** (medians, n=3, ranges 0.0592-0.0622 and 0.0545-0.0583), below the $0.069 target on
  every after run. Bare CLI $0.0764.
- On the first after build the real prompt cost **$0.117** in 2 of 3 runs: `<volt_context>` came or went with its
  search deadline and Full access's bypass reminder came or went with timing, so the same prompt rewrote ~8K cached
  tokens. Both are fixed; the final runs read the cache every time.
- Each later code turn of a chat is **about 930 tokens smaller** (turn 2's message 1,005 to 76 tokens, n=1 per build):
  the visuals note, IDE guide and workspace scope now go to an agent session once, not with every turn.
- How: Claude Code 2.1.322's plugin hooks modules can rewrite its per-request reminders (`prompt.attachment`), not
  only defer tools. Volt's main-chat module now says Volt's 135 tool names after one prefix, lists agent types in one
  line each (the Agent tool carries the full text when loaded) and drops bypass mode's "edit through Bash" paragraph.
- No capability lost in the checks run: 11 tool families on Haiku 5.5, before 8 of 11 used, after 10 of 11; Agent (2
  tasks) and ReportFindings on Opus 5.5 used on both builds. The AGENTS.md canary (B4) was obeyed in all 24 Volt runs
  (r5b and r5c).
- Also fixed: the agent server's Tab predictor got `<task>undefined</task>` on every request (the task was dropped on
  the wire).

## Before / after (Opus 5.5, medians, n and range)

Before = `9bbb8818c60` (`volt-e5-base`, run as is). After = `e5/tokens` at `5904b13f4ef`. Bare = Claude Code 2.1.322
(`claude -p`, the binary inside the agent SDK 0.3.322 that Volt's adapter `claude-agent-acp@0.106.0` runs; the CLI on
PATH is 2.1.323) at effort high. Final matrix `r5c` (before and after interleaved) and `r5b` (before, after on an
earlier build, bare, interleaved). Load 35-151 during the runs: token counts do not depend on it, and no timing is
reported here.

| Test | Before | After | Bare CLI 2.1.322, this Mac | Paseo (site) | Bare CLI (site) |
|---|---|---|---|---|---|
| B1 "hi": total | 14.1K (14.1-14.1K, n=3) | **12.2K** (12.2-12.2K, n=3) | 18.1K (18.1-18.1K, n=6) | 22.2K | 38.2K |
| B1: $ (cache read) | 0.0041 (0.0039-0.0041) | **0.0037** (0.0037-0.0391) | 0.0049 (0.0049-0.0050) | 0.0058 | 0.0963 |
| B3 real prompt: total | 53.1K (53.0-53.1K, n=3) | **46.4K** (46.2-46.4K, n=3) | 61.1K (61.0-105.1K, n=3) | 73.2K | 168.3K |
| B3: main thread | 51.7K | 45.1K | 61.1K | | |
| B3: $ | 0.0614 (0.0592-0.0622) | **0.0583** (0.0545-0.0583) | 0.0764 (0.0745-0.1208) | 0.150 | 0.210 |
| B3: main requests | 3 | 3 | 3 (3-5) | | |
| B3: side calls | 1.3K title | 1.3K title | 0 | | |
| B4 AGENTS.md canary obeyed (r5b + r5c; bare r5a + r5b) | 12 of 12 | 12 of 12 | 11 of 12 | yes | yes |

After's B1 maximum ($0.0391) is the first run of the build, which wrote the new prefix to the cache. Bare's 105.1K
B3 run took 5 requests and missed the canary. The baseline matrix `r5a` (before and bare only, taken first) agrees:
before 14.1K / 52.8K, bare 18.1K / 60.9K (60.8-81.9K).

**Against the targets.** ADEMark's rule off its reference Mac is the gap to the bare CLI on the same Mac:

| | Volt after / bare, this Mac | Paseo / bare, ADEMark site | Needed here for Paseo's ratio |
|---|---|---|---|
| B1 | 12.2K / 18.1K = **0.67** (before 0.78) | 22.2K / 38.2K = 0.58 | 10.5K |
| B3 | 46.4K / 61.1K = **0.76** (before 0.87) | 73.2K / 168.3K = 0.43 | 26.3K (35.4K with round 4's bare 81.4K) |

Volt is not ahead of Paseo by that rule. What is left in "hi" is mostly Claude Code's own: tools 3.6K (Bash, Read,
Edit, Write, Skill, ToolSearch), its system prompt ~2.3K, the skills list 1.4K, reminders 0.8K and the environment
0.3K. Volt's share is about 3.0K: the rules 514, the three task tools 702 (orch's), MCP instructions 648, Volt's tool names
~830 and its agent-types rewrite 268. The bare CLI's real prompt here is a different shape from the site's
(2.1.322 has 7K fewer tool tokens than 2.1.303), which is why its B3 is 61K, not 168K.

### Where "hi" went (anatomy, `anatomy.mjs`, counted one by one)

| Part | Before | After |
|---|---|---|
| deferred-tools reminder | 1,998 | **1,079** |
| agent-types reminder | 563 (1,163 in sessions where Claude Code turns on its `web-fetch` agent) | **268** |
| Volt MCP instructions | 697 | **612** |
| bypass reminder (when Full access was picked after the session started) | ~130 | **0** |
| skills list, system prompt, tools, user reminders, environment | unchanged | unchanged |

ADEMark's own B2 split (`b2.mjs`) shows no change between before and after (system 2,868, tools 3,633, mcp-tools 702,
injected 808, params 261): B2 counts the first user message's text and does not see the system-role reminders where
all of this round's savings are ([`b2-before-r5c-b1.json`](data/tokens/b2-before-r5c-b1.json),
[`b2-after-r5c-b1.json`](data/tokens/b2-after-r5c-b1.json), [`b2-bare-r5b-b1.json`](data/tokens/b2-bare-r5b-b1.json)).

### Later turns (TOK_FOLLOWUP, n=1 per build, [`analysis-r5f-2turn.md`](data/tokens/analysis-r5f-2turn.md))

B3, then "Now look at src/invoices.ts the same way..." in the same chat. Turn 2's user message: before 1,005 tokens
(the visuals note, IDE guide and workspace scope again), after **76**. That message stays in the chat, so every later
request reads ~930 fewer tokens per code turn; the first request of turn 2 wrote 2,366 tokens to the cache before
and 1,512 after.

## Method

- Rig: `round5/scripts/tokens/` (round 4's with round-5 ports and profiles). Capture proxy `proxy.mjs` on 19973 in
  `ANTHROPIC_BASE_URL` of both test instances and the bare CLI; `cfg-clean` config dir (the login's access token only,
  no user settings, MCP servers, skills or memory). Arena: ADEMark's `arena/` (Ledger, AGENTS.md canary).
- Instances: after on CDP 9973 (`~/.volt-r5/tokens/ud`), before on CDP 9979 (`~/.volt-r5/tokens/ud-base`, run from
  the read-only `volt-e5-base`; 9979 was free and not in anyone's table). `matrix.sh <tag> claude-opus-5-5 high 3`
  with `B3_N=3`, `TOK_ACCESS=full`, sandbox Off (it blocks the proxy's port); `SKIP_*` switches per arm.
- `runbare.mjs` takes `CLAUDE_BIN`: the bare arm ran the SDK's 2.1.322 binary, the version Volt's adapter runs.
- `modcheck.mjs` (new): writes Volt's hooks module from `out/`, runs it under the real Claude Code binary with a stub
  "volt" MCP server, and prints what the request carried. Claude Code drops a module it does not accept **silently**
  (a handler made by a factory function made it drop the whole module, lazy tools included); this caught it.
- `runtok.mjs` `TOK_FOLLOWUP`: a second prompt in the same chat.
- `analyze.mjs` with ADEMark's `prices/2026-10.json`. Data: [`analysis-r5a.md`](data/tokens/analysis-r5a.md),
  [`analysis-r5b.md`](data/tokens/analysis-r5b.md), [`analysis-r5c.md`](data/tokens/analysis-r5c.md), matrix logs,
  [`windows.jsonl`](data/tokens/windows.jsonl), `capture.jsonl.gz` (metadata and usage of every request; bodies not
  committed, they carry the account's e-mail).

## Fixes

| Commit | What | Tokens |
|---|---|---|
| `815c550f812` | perf(acp): Volt's deferred tools named once after one prefix | -919 per request |
| `89b3535670b` | perf(acp): agent types in one line each; Agent tool carries the full text | -295 (-895 with web-fetch) per request |
| `61705a34752`, `5904b13f4ef` | fix/perf(acp): bypass mode's "edit files through Bash" reminder left out | -130 when present; prompt no longer depends on when Full access was picked |
| `00d21be11ed` | perf(volt-mcp): shorter server instructions | -85 per request |
| `77138cb3ae0` | perf(agent): no `<volt_workspace>` that only repeats Claude Code's git status | -156 on a new session's first code turn |
| `7466fe941e9` | perf(agent): standing notes once per agent session | -930 per later code turn |
| `593f0d15a55` | perf(agent): visuals note in fewer words | -76 per first code turn |
| `3b9d017c463` | perf(agent): no `<volt_context>` that only lists the files the message names | -80, and no cache rewrite (~8K, $0.055) |
| `96a400edc50` | fix(prediction): the agent server's predictor hears its task | (correctness) |

### 1. Volt's tool names said once (`815c550f812`)

Cause: Claude Code lists every deferred tool on its own line; Volt's 135 tools as `mcp__volt__browser_click` etc.
were 1,748 of the reminder's 1,998 tokens. Change: the main chat's hooks module (`claudeLazyToolsPlugin`, Claude Code's
`prompt.attachment` event, matcher `deferred_tools_delta`) turns each run of Volt lines into one line, `Volt tools,
each named mcp__volt__<name> (select:mcp__volt__app_open): app_open, ask_question, ...`. Every tool stays listed by
name. Tests: `claudeWorkRules.test.ts` (the transform, the module run as the worker runs it); `modcheck.mjs` against
the real binary. Capability: capcheck below; the agents loaded `mcp__volt__ask_question`, `code_nav`, `tests`, `ide`,
`render_chart`, `scratch_draw`, `browser_navigate`, `thread_list` by their full names.

### 2. Agent types in one line each (`89b3535670b`)

Cause: the agent-types reminder (563 tokens; 1,163 in sessions where Claude Code turns on its `web-fetch` agent, which
it does for some sessions and not others) went with every request although the main chat loads Agent on demand.
Change: each type keeps its first sentence (cut at 160 characters); the module keeps the reminder's full text and puts
it in the Agent tool's description in place of its pointer to the reminder. Checked live: in both Agent tasks the
loaded Agent schema carried the full list (`Specify search breadth`, web-fetch's handling of fetched files), and the
agent chose `general-purpose` and `Explore` as asked.

### 3. Bypass mode's "edit through Bash" reminder (`61705a34752`, `5904b13f4ef`)

Cause: with Full access, Claude Code may add "you can read, search and edit files with cat, sed and heredocs instead
of Read, Edit or Write", the opposite of Volt's rule (Volt shows only the changes its file tools make). It comes only
when the mode changed after the session started, so it was in 1 of 6 runs and rewrote 3.8K cached tokens there.
First replaced by a one-line note, then left out (an empty text drops the reminder cleanly, checked with a probe
module); auto mode's reminder is untouched.

### 4. MCP instructions (`00d21be11ed`)

The deferred list now names every tool, so the instructions stop listing families (browser_status/mock/emulate/audit,
the stack tools, thread_list/search/read/wait/fork, orchestrator_capabilities); each part keeps what a tool is for and
its rule. 1,950 to 1,731 characters, 693 to 608 tokens. `voltHostMcpMainService.test.ts` limit tightened.

### 5. `<volt_workspace>` with only git (`77138cb3ae0`)

A new Claude session's first code turn carried `<volt_workspace>` with nothing open beside the chat: its preamble and
"Git: on main, clean" (156 tokens), right after Claude Code's own gitStatus. Skipped for `claude-code` sessions when
there are no tabs; tabs, and any later change (branch included), still go out (`workspaceLeadText`, tests in
`workspaceContext.test.ts`).

### 6. Standing notes once per agent session (`7466fe941e9`)

`buildAcpLead` put the visuals note (372 tokens), the IDE guide (426) and the workspace scope (131) on every code turn.
They now go to an agent session once (`ISessionState.leadHeard`, keyed by the agent handle): a new or restarted agent,
a switch to the sandboxed IDE guide and a completed compaction send them again; request-specific notes (tests, UI,
long jobs, git, shape) still go with every request that calls for them. Measured: turn 2's message 1,005 to 76 tokens.

### 7. Visuals note (`593f0d15a55`)

Same tools, cases and rules in fewer words: 372 to 296 tokens. Capability: an asked-for chart was rendered on both
builds; an unasked data question ("How are the lines of code split across the files under src...") got no chart on
either build, on Haiku and on Opus (n=1 each), so this check cannot show a change in unasked charting either way.

### 8. `<volt_context>` that only names the message's files (`3b9d017c463`)

Cause: for B3 the retriever listed `src/paginate.ts` and `src/dates.ts`, which the message names by path; the block
came or went with the search deadline, so the same prompt sent a different first message and rewrote ~8K cached
tokens in 2 of 3 runs on the first after build ($0.117 against $0.062). Change: a CLI agent's block goes out only when
it lists a file the message does not name by its path (`retrievalAddsToMessage`, tests in `contextRetrieval.test.ts`).
Volt's own models still get their snippets.

### 9. Predictor task over the agent server (`96a400edc50`)

Seen in the capture: a composer prediction sent `<task>undefined</task>`. `runtime.streamModel` on the agent server
took ref, messages and options but not the task, so every remote prediction named no task and queued with no
priority (`TASK_PRIORITY[undefined]`). The task now goes over the wire, checked with `isPredictorTask`.

## Capability checks

`capcheck.mjs` (Haiku 5.5, one run per family per build, `capfx` fixture, [`capcheck-cap5.md`](data/tokens/capcheck-cap5.md)):
used by before / after: code yes/yes, tests no/yes, debug yes/yes, db no/yes, chart yes/yes, unasked chart no/no,
scratch yes/yes, browser yes/yes, threads yes/yes, ask yes/yes, ask (multiple choice) yes/yes. The after build used
delegate_task on its own in the chart and browser tasks (n=1; the task tools are orch's).
`lazycheck.mjs` (Opus 5.5, [`lazycheck-lazy5-opus.jsonl`](data/tokens/lazycheck-lazy5-opus.jsonl)): Agent (explicit),
Agent (Explore, natural wording) and ReportFindings used on both builds; ToolSearch to available 1.5-2.8 s (load
46-85, not clean timings).

## Not done, and why

- **10.5K and 35.4K.** The rest of "hi" is Claude Code's own (tools 3.6K, system prompt ~2.3K, skills list 1.4K,
  reminders 0.8K) plus Volt's ~3.0K. Options, each a trade for the user to decide: defer the Skill tool (~560 tokens
  per request; a model-chosen skill then costs one ToolSearch, as Agent does now; slash commands do not use it); cut
  skill descriptions below 400 characters (round 4 lost claude-api at 250).
- **IDE guide** (426 tokens on a session's first code turn): its text belongs to codeintel; it now goes once per
  session, its wording is unchanged.
- **Side calls**: the title call is 1.3K per new chat; the composer's predictor fired on the typed B3 prompt in 1 of 3
  before runs and 1 run during development (2.8-3.2K Haiku tokens). Not changed.
- Effort: Volt's arms ran at Volt's default (medium), the bare CLI at high as ADEMark sets it.
- Not run on ADEMark's Mac or as its `ademark` user; Paseo not run here.

## Commits

| Commit | What |
|---|---|
| `0634ec5ebf8` | docs(reports): round 5 token rig and the before/bare baseline r5a |
| `815c550f812` | perf(acp): Claude main chat names Volt's deferred tools once after one prefix |
| `89b3535670b` | perf(acp): Claude main chat lists agent types in one line each; the Agent tool carries the full text |
| `61705a34752` | fix(acp): Full access no longer tells Claude to edit files through Bash |
| `00d21be11ed` | perf(volt-mcp): shorter server instructions now that the deferred list names every tool |
| `77138cb3ae0` | perf(agent): no <volt_workspace> block that only repeats Claude Code's git status |
| `7466fe941e9` | perf(agent): an agent session hears Volt's standing notes once, not on every turn |
| `96a400edc50` | fix(prediction): the agent server's predictor hears which task a request is |
| `593f0d15a55` | perf(agent): the visuals note in fewer words (372 to 296 tokens) |
| `eb719e93ff6` | docs(reports): round 5 token rig updates and capability data |
| `3b9d017c463` | perf(agent): no <volt_context> that only lists the files the message names by path |
| `5904b13f4ef` | perf(acp): leave bypass mode's Bash-for-files reminder out |

Typecheck (`compile-check-ts-native`) clean. Tests touched, passing: `claudeWorkRules.test.ts` (16),
`contextPack.test.ts` (24), `workspaceContext.test.ts` (15), `contextRetrieval.test.ts` (21), `predictorSkill.test.ts`
(12), `voltHostMcpMainService.test.ts` (10).
