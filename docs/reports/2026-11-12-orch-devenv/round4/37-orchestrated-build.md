# Round 4, c1: ADEMark C1 (Orchestrated Build) on Volt

Status: final

## Summary

Three Volt runs and one Bare CLI run of ADEMark's C1 task on Opus 5.5 at high effort (ADEMark method, unofficial,
graded with our own tests, n = 1 per row). **No run was taken at load 14 or below**: this Mac sat at load 30 to 124
during every run (a gulp build, a VM and three to five other agents), so every time below is marked "under load"
and none of them is a timing claim. Tokens, handoff and fan-out do not depend on load.

- **Tokens.** Volt after used 1.43M (after-1) and 1.38M (after-2) tokens, against 1.75M on the base build and 1.63M
  for Claude Code alone on the solo task. ADEMark's published leader is Synara with 2.03M (the site's Bare CLI:
  1.65M; ours: 1.63M, so this rig's token count matches the site's within 1.2%).
- **The lead's waits.** Claude Code cut every Volt wait at 60 s, which woke the lead three times for nothing in
  before-1. With `MCP_TOOL_TIMEOUT=300000` (`b5db1b69823`) both after runs waited once (109 s and 156 s) with no
  cut; the lead's requests went from 24 to 14 and 16, its tokens from 1.04M to 0.60M and 0.71M (e4/orch's shorter
  task tools are in that drop too).
- **Shipped.** 5/5 in before-1, cli-solo-1 and after-1. after-2 graded 3/5 at its end: the one failing own test is
  load-sensitive (62 HTTP requests in a row must reach the 60-token limit before 1 token/s refills them; at load
  ~120 they took 7.6 s). The same final checkout graded 5/5 at load 45 (`data/c1/volt-after-2.regrade.json`).
  Handoff 4/4 and codes placed 4/4 in every run.
- **Worker start.** On the base build every worker waited 9 s for its worktree and about 21 s for a cold agent
  (load 76): a warm spare never fits a worktree subagent, because an agent's folder is fixed. Volt now makes
  worktrees ahead with an agent starting in each (`e5cdb97d487`, reworked in `bf2c94426c7`). Both Opus after-runs
  did not exercise it: their leads made their own worktrees with `git worktree add` and ran the four parts in the
  project folder ("shared"), on e4/orch's shorter task schemas. A Haiku smoke shows the adoption (below); the
  Opus effect is not measured.

## Results

| Run | Build | Load (1-min at t0) | Shipped (own tests) | Time (end rule) | Tokens total | USD | Handoff | Codes placed | Fan-out (max at once / workers) |
|---|---|---|---|---|---|---|---|---|---|
| volt-before-1 | base `b2db4e7f605` | 76.4 | 5/5 | 7.46 min, under load | 1,752,902 | 2.23 | 4/4 | 4/4 | 4 / 4 (Volt worktrees) |
| cli-solo-1 | Claude Code 2.1.323, C1-solo prompt | about 42 | 5/5 | 7.79 min, under load | 1,632,752 | 1.99 | 4/4 | n/a | one agent |
| volt-after-1 | e4/c1 `a6d551d20dd` (+ e4/orch `00ede1cf0eb`) | 29.7 (up to 55 during) | 5/5 | 4.45 min, under load | 1,428,464 | 2.30 | 4/4 | 4/4 | 4 / 4 (shared, lead-made worktrees) |
| volt-after-2 | e4/c1 `d7450445792` (since reverted) | 36.1 (100-124 at the end) | 3/5 at the end; 5/5 re-graded at load 45 | 5.85 min, under load | 1,384,101 | 2.39 | 4/4 | 4/4 | 4 / 4 (shared, lead-made worktrees) |

Published (Mac mini M4, ADEMark v1, hidden tests): Synara 5/5 in 5.18 min with 2.03M tokens and 4/4 handoff,
super.engineering 5/5 in 7.08 min with 2.87M, Cloudroom 0/5 with 2.66M; Bare CLI C1-solo 1.65M tokens.

Notes on the rows:
- **volt-before-1** reached the model with six lines of W4 re-indented: the rig typed the prompt and the composer's
  auto-indent nested the last three bullets under the one before (whitespace only; every word arrived, checked
  on the captured request). The rig pastes since `468f3586c6f`; both after runs reached the model byte for byte.
  The row is kept: the deviation does not touch what the run measures, and a re-run costs about 1.7M tokens.
- **Fan-out.** The rig counts worker sessions whose folder is a worktree, so it prints 0 for the after runs, whose
  workers ran in the project folder and edited the lead's own worktrees under `.worktrees/`. The captured sessions
  show four workers at once in both (after-1: 52.9-169.5, 65.6-134.5, 71.4-147.8, 83.7-187.3 s; after-2:
  53.2-156.2, 67.5-137.4, 78.9-163.0, 96.6-239.1 s).
- **after-2's grade.** `grade.mjs` ran at the end of the run (load about 120): W1-api's server test failed (no 429
  within 62 requests, because they took 7.6 s and refilled 7 tokens), and with it Integration (`npm test` on main
  with our tests). Re-grading the same checkout at load 45 (`scripts/c1/regrade.mjs`) passed all 5 groups. The
  row in `c1-runs.jsonl` keeps the 3/5 and a null time-to-green, as the rig wrote it.
- **after-2 vs after-1.** after-2 carried `d7450445792` (a longer `isolation:"worktree"` hint); its lead still made
  its own worktrees, so the hint was reverted (`9298102be52`) and the two after runs differ in nothing that ran.

Where the time went (`analyze.mjs`; seconds from Enter; all under load):

| | before-1 | after-1 | after-2 |
|---|---|---|---|
| Lead reads the repo; first delegate call starts | 50.5 | 31.4 | 35.0 |
| Tasks created | 85.8 (all four in one call) | 44.0 / 52.5 / 63.0 / 76.8 | 48.1 / 58.2 / 69.9 / 84.2 |
| Task created to the worker's first request | 32.7-41.2 (worktree 9 s, cold agent ~21 s) | 6.9-13.1 (cold agent) | 5.1-12.4 (cold agent) |
| Lead's waits cut at 60 s ("The operation timed out.") | 3 | 0 (one wait, 109 s) | 0 (one wait, 156 s) |
| Last task settled | 308.9 | 187.4 | 240.5 |
| Lead merges and checks after the last task | 138.7 | 79.6 | 110.5 |
| Lead requests / lead tokens | 24 / 1.04M | 14 / 0.60M | 16 / 0.71M |

The after builds also carry e4/orch's changes (one delegate_task call per part, so the first worker starts while
the lead writes the others; 685-token task tools; the new-errors check and edit-capture fixes). With n = 1 per arm
under load 30 to 124, the time gap cannot be split between those, ours, the model and the load.

## Method (ADEMark method, unofficial)

What is the same as ADEMark (TASKS.md, TESTS.md section 4, bench/tracks/c):

- **Prompt.** `tasks/C1-orchestrated-build/prompt.md` from the ADEMark clone (`~/.volt-r4/ademark`, v1.0.0 task
  folder, arena at commit `270c930`), byte for byte, with the four handoff codes filled in per run by ADEMark's own
  algorithm (`HMAC-SHA256(seed, "W<n>")`, first 6 base32 characters; checked equal to `bench/core/tasks.ts`
  `generateHandoffCodes`). The seed is `ademark-volt-r4-<run id>`, so every run has fresh codes. Volt's one-line
  orchestration trigger goes first, as ADEMark sends every app's (rule 4 of TASKS.md):
  `Use Volt's delegate_task to run the four work items in parallel, one subagent per item.` It is written like the
  Synara and Capy trigger lines (an instruction, not a slash command) and says nothing about worktrees, merging or
  reports: those come from the C1 text itself. C1 has no follow-up messages (those belong to C2).
- **Arena.** A fresh clone of ADEMark's `arena/` per run, on `main` (`scripts/c1/mkarena.sh`).
- **Pins.** Opus 5.5, high effort, full access. In Volt: the model picker's Opus 5.5 row with Effort set to High
  (Volt's shipped default for Opus 5.5 is Medium; ADEMark pins high for every app), Permissions: Full access. The
  Bare CLI runs `claude -p --model claude-opus-5-5 --effort high --dangerously-skip-permissions`.
- **Clean agent config.** Both arms run Claude Code on a throwaway config dir holding only the live login's access
  token (`mkcfg.sh`, `CLEAN=1`: no user settings, MCP servers, skills, plugins or memory), like ADEMark's fresh
  `ademark` macOS user.
- **Capture.** Every model request of every Claude Code process goes through a logging reverse proxy
  (`scripts/c1/proxy.mjs`, `ANTHROPIC_BASE_URL`), which records the usage of each response and reads each request
  body the way ADEMark's `tracks/c/agents.ts` does (client session, coding tools, whether it answers a tool, the
  thread it starts). Runs never overlapped, so each run's window holds only its own requests.
- **End of a run** (TESTS.md 4, since 2026-11-11): after the first end of turn, the run is over when no request has
  answered a tool for 5 minutes; the end time is the last answer to a tool (or the first end of turn when none
  followed). Cap 45 minutes. `time-to-green` = end time minus `t0` (taken just before Enter) when shipped is 5/5.
- **tokens-total** = input + cache write + cache read + output of every completion in the run window, side calls
  included (`runTokens`); USD from ADEMark's `prices/2026-10.json`, per request.
- **handoff** = items whose `W<n> | <branch> | <code>` line in `REPORT.md` has the right code (`handoffCount`);
  **codes placed** = modules whose first line is `// handoff: <code>`.
- **fan-out** = most worker sessions running at once, and how many ran (see the note on shared workers above).

What differs from ADEMark, and why:

- **shipped uses our own tests, not ADEMark's hidden tests.** The hidden tests are published only as SHA-256, so
  `shipped` and `time-to-green` here are graded with tests we wrote from the task text in round 3
  (`scripts/c1/tests/`, the same groups: W1 limiter + API, W2, W3, W4 create + idempotency, Integration with
  `npm test` on main). They are labelled "own tests" everywhere and are not comparable with the site's 5/5. One of
  them (W1-api's server test) is load-sensitive, see after-2.
- **Volt's sandbox is Off** for the lead and every subagent (profile default, set in the runtime's storage before
  launch). Volt's shipped default on macOS is a workspace-write Seatbelt sandbox whose network goes through Volt's
  filtering proxy and refuses loopback ports, so the capture proxy on 127.0.0.1 could not be reached with it on
  (ADEMark's mitmproxy capture would meet the same wall). Both Volt builds run the same way.
- **The Bare CLI runs headless** (`claude -p`, stream-json), not interactively in Ghostty. Its prompt is the
  C1-solo text.
- **Off the reference Mac**: this Mac is shared with three to six other agents. Every run records the load; every
  run of this round was above load 14, so no time here is a timing.
- **Builds and profiles.** Before ran the dev build of `volt-e4-base` with profile `/tmp/v4-c1-ud-base`; the after
  runs ran the dev build of `volt-e4-c1` with `/tmp/v4-c1-ud`, a copy of the before profile (same settings, Opus 5.5
  High kept in the picker, sandbox off, Full access).
- **No C3 probe** (chat lock) runs during C1 here.
- Versions: Volt's agents send as Claude Code 2.1.322 (`agent-sdk/0.3.322`, the ACP adapter's bundle); the Bare CLI
  is Claude Code 2.1.323 (User-Agent of the captured requests).

Scripts: `scripts/c1/` (`runvolt.mjs`, `runcli.mjs`, `proxy.mjs`, `grade.mjs`, `regrade.mjs`, `analyze.mjs`,
`common.mjs`, `mcp-timeout/`). Data: `data/c1/` (`c1-runs.jsonl` rows; per run the prompt sent, grade, capture
rows without bodies, Volt traces or the CLI's stream; `volt-after-2.regrade.json`).

## Fixes

### 1. Claude waits for Volt's MCP tools past 60 s (`b5db1b69823`, test log `cf337cdb69b`)

Cause: Claude Code gives up on an MCP tool call after 60 s and returns "The operation timed out." Volt's long-poll
for a lead (`delegate_task` with `wait=true`, `wait_tasks`) runs up to 240 s. In volt-before-1 all three of the
lead's waits ended in that error after about 61 s; each woke the lead for one more request on its whole context,
a status check and a new wait.
Change: Claude sessions start with `MCP_TOOL_TIMEOUT=300000` (the Claude provider's `acpEnv`). A user's own value in
Claude's `settings.json` `env` still wins (`data/c1/mcp-timeout-sdk-2.1.322.log`: a 90 s tool is cut at 60.7 s
without it and answered at 90.0 s with it; a settings value of 20 s cut a 30 s tool at 20 s). Unit test in
`cliAgents.test.ts`.
Numbers: waits cut 3 (before-1) to 0 and 0 (after-1, after-2: one wait each, 109 s and 156 s). Lead requests 24 to
14 and 16; lead tokens 1.04M to 0.60M and 0.71M (that drop also has e4/orch's shorter task tools in it).

### 2. Worktree subagents take worktrees made ahead, with their agent warm (`e5cdb97d487`, `bf2c94426c7`)

Cause: a warm spare agent is bound to its folder, and the spares Volt warms when a chat is about to delegate start
in the project folder. A subagent with `isolation: "worktree"` works in a new worktree, so it never matched a
spare: in volt-before-1 the three project-folder spares (started at 6 s, ready at about 32 s) went unused, the four
worktrees were made one after another when the tasks arrived (85.8 to 94.9 s), and then each worker started its
agent cold: `initialize` 9.4-11.2 s, `session/new` 8.7-10.5 s, about 21 s in all (load 76).
Change (`WorktreeSpares`, `common/orchestration/worktreeSpares.ts`): a worktree spare is a fresh `volt/<id>`
checkout at HEAD with a spare agent starting in it. The orchestrator's `prepareWorktree` takes one
(`IAgentRuntimeService.takeWorktreeSpare`) before making its own, and the subagent's agent adopts the spare in that
folder. If HEAD moved before it is taken, its branch moves along (`git reset --hard`) and its agent, whose session
saw the old commit, is stopped. Spares nobody takes are removed with their branch after 90 s.
`e5cdb97d487` made worktree spares when the request contained the word "worktree". Both Opus after-runs showed that
guess is wrong: the leads made their own worktrees and ran their parts shared, so four worktree spares went unused
(removed after 90 s, nothing left behind) and the shared workers found no folder spare and started cold (5.1-13.1 s
at load 30-120). `bf2c94426c7` warms folder spares at the start again, as the base did, and starts worktree spares
from the chat's first worktree task: each part the request names (two to six, at most four) that has not started
yet gets a worktree made ahead, and the folder's work spares stop. A request that names no count warms no worktree.
Unit tests: `worktreeSpares.test.ts` (5), `agentPool.test.ts` (`discard`), `orchestratorDelegation.test.ts`.
Checks (Haiku smokes on the after build, two worktree parts each, not result rows):
- smoke-wt-1 (`e5cdb97d487`, load about 31): both workers took a spare, showed no "Starting" phase, and went from
  task created to running in 2.8 s; only the two worktrees used remained.
- smoke-wt-2 (`bf2c94426c7`, load 60-100): the first worktree task started cold (`agentSource: cold`, "Starting"
  21.2 s), the second took the spare made for it 0.8 s earlier (`agentSource: pool`, "Starting" 14.8 s while the
  spare finished); two worktrees remained, the two used.
Not measured on Opus: neither after run used Volt's worktrees, and a third Opus run was out of this round's budget.

### 3. As many spares as the request names, up to four (`a6d551d20dd`)

Cause: three spares were warmed whatever the request said, so the fourth worker of a four-part request started its
agent cold, on the critical path. Change: `subagentSpareCount` reads the parts or agents a request names ("the four
work items", "up to 4 agents", "three subagents"; two to six, capped at four), else three as before; the pool's
burst room grew from 3 to 4. Unit test in `orchestratorDelegation.test.ts`. Not measured on Opus (in both after
runs the work spares were the unused worktree spares of fix 2's first version).

### Tried and reverted: a longer `isolation:"worktree"` hint (`d7450445792`, reverted in `9298102be52`)

e4/orch's short schemas name `isolation:"worktree"` in delegate_task's description only. The hint
`(Volt makes its own git worktree and branch)` did not change after-2's lead, which again made its own worktrees,
so it was reverted (orch owns that text).

## Not done, and why

- **No timing.** Load never came near 14 during this agent's window (30 to about 230). Time-to-green needs interleaved
  before/after runs at load 14 or below, each about 1.4-1.8M tokens.
- **n = 1 per arm.** The brief allowed one before, one Claude Code alone and one or two after.
- **Fixes 2 (as reworked) and 3 are not measured on Opus.** The next C1 run on `e4/c1` should show four warm folder
  spares adopted by shared parts, or worktree spares adopted from the second worktree part on.
- **The lead runs its parts shared on e4/orch's short schemas** (2 of 2 runs; the base build's lead used Volt's
  worktrees, 1 of 1). That is orch's call; the C1 result did not suffer (5/5 and 4/4 handoff in after-1).
- **Volt's per-task `verify` re-runs `npm test` after each worker** (before-1: 8-10 s per task, under load) even
  when the worker ran it just before; it is the lead's option and a correctness check, so it stays.
- **Own test W1-api server check is load-sensitive** (62 sequential requests against a 1 token/s refill); left as
  is so all rows are graded by the same tests, with `regrade.mjs` for a second grade.
- **Not graded with ADEMark's hidden tests** (published as hashes only).
