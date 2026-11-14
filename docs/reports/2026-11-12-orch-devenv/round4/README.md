# Round 4 (2026-11-14): orchestration, first word, tokens, cold start, memory, smoothness, C1

Round 3 (`../round3/`) left Volt first on ADEMark's A3 and A11, behind Claude Code on three of the four
orchestration tasks, and at 23.2K tokens for "hi". Round 4 took the user's list: beat Claude Code on the
subagent tasks, cut Enter to first word and cold start, shrink the prompt with Claude Code's own tools
lazy-loaded (not cut), cut memory and idle CPU, and run ADEMark's C1 orchestrated build. Seven agents worked in
parallel, each in its own worktree and branch off `b2db4e7f605`; every branch is merged into `volt/8fb8291c`
(this tree), not into `feat/orch-and-devenv-revamp`. Five areas finished with final reports; memory and
smoothness were stopped before their reports and are merged as committed (section "Memory and smoothness").

**ADEMark method, unofficial.** As in round 3: ADEMark's prompts, replay server and procedures, but on a shared
laptop (Apple M4 Max, 14 cores) in a normal account, with DOM timing over CDP. None of it is an ADEMark result.

Timed rows count only at a 1-minute load of 14 or less, with before/after interleaved. The machine sat at load
30-230 for most of the round (seven agents' test windows, two minified builds, a VM and the iOS simulator), so
most timings come from a quiet window on 2026-11-14 after 09:00 once the VM and simulator were closed. Token
counts, grades, handoff and fan-out do not depend on load and are reported from every run.

## Reports

| # | Report | Area | Branch |
|---|---|---|---|
| 31 | [31-orchestration.md](31-orchestration.md) | Volt before/after vs Claude Code on the four orchestration tasks (t0-t3) | `e4/orch` |
| 32 | [32-first-word.md](32-first-word.md) | ADEMark A4 Enter to first word, and the ACP adapter's own cost | `e4/firstword` |
| 33 | [33-tokens.md](33-tokens.md) | Track B prompt size ("hi", a real prompt), lazy-loaded Claude Code tools | `e4/tokens` |
| 34 | [34-cold-start.md](34-cold-start.md) | ADEMark A1 cold start and A2 relaunch on two minified builds | `e4/coldstart` |
| 35 | [35-weight.md](35-weight.md) | ADEMark A5/A9/A10 memory, idle agents stopping and resuming (not finished; numbers below) | `e4/weight` |
| 36 | [36-smoothness.md](36-smoothness.md) | A6 idle CPU, A8 typing lag, chat open and reload (not finished; numbers below) | `e4/smooth` |
| 37 | [37-orchestrated-build.md](37-orchestrated-build.md) | ADEMark C1 orchestrated build on Opus 5.5 | `e4/c1` |

Data is in `data/<area>/`, scripts in `scripts/<area>/`.

## Against Claude Code on the orchestration tasks (report 31)

Haiku 5.5 for the parent and every subagent, medians of runs started at load 14 or less (3.6-14.0), seconds, n in
brackets. Every graded answer in every arm was right.

| Task | Claude Code | Volt before (`b2db4e7f605`) | Volt after |
|---|---|---|---|
| t0 Reply "OK" | 3.0 (5) | 2.1 (5) | **1.9** (4) |
| t1 3 research subagents + synthesis | **27.0** (10) | 31.3 (9) | 31.5 (4); 29.2 (3) with `7aa4e6dc999` |
| t2 3 parallel bug fixes + `npm test` | 23.3 (6) | 24.5 (5) | **22.9** (6) |
| t3 writer + reviewer | 62.4 (7) | 39.5 (7) | **40.4** (6) |

- Volt is level with or ahead of Claude Code on t0, t2 and t3, and about 2 s behind on t1.
- Editing subagents that ended with a 3 s wait for a code-intelligence answer: 6 of 27 before, 0 of 31 after.
  Edits captured from the CLI agent: 6 of 27 before, 31 of 31 after.
- t2 Enter to first subagent: 9.7 s before, 6.7 s after, Claude Code 6.1 s.
- Volt's own time on the critical path: 0.2-0.7 s per task.
- The three task tools went from 2,078 to 740 tokens. The shortest version (685) made Opus leads build their own
  git worktrees instead of Volt's (C1, below); typing `isolation` as an enum again brought Volt's worktrees back
  (4 of 4 lead probes, and a live C1 run with all 4 parts in Volt worktrees) for 55 tokens.

## ADEMark (unofficial, this Mac)

| Test | Before | After | Published leader | After's place |
|---|---|---|---|---|
| A1 cold start to typing (Ready) | 4,185 / 6,057 ms (two attempts) | **1,066 / 1,050 ms** | super.engineering 1.76 s | would be 1st (no `purge`; DOM echo) |
| A2 relaunch to typing (Ready) | 6,258 / 1,599 ms | **876 / 1,031 ms** | Diri 0.67 s | would be 4th |
| Relaunch, restored chat visible | 1,411 ms | **720 ms** | | |
| A4 Enter to first word (in app) | 124.5 ms (n 24) | 122.5 ms (n 24) | Diri 256 ms | not comparable (not ADEMark's runner) |
| B1 "hi" | 23.1K tokens, $0.0059 | **14.1K** merged (15.6K on `e4/tokens`); $0.0041 cached | Paseo 22.2K, $0.0058 | 4.0K below the bare CLI here (18.1K) |
| B3 real prompt | 80.2K tokens | **53.6K** merged (57.3K on `e4/tokens`) | Paseo 73.2K | cost not lower yet (see Merge notes) |
| C1 orchestrated build | 5/5, 1.75M tokens | **5/5, 1.38-1.43M tokens** | Synara 5/5, 2.03M | fewest tokens; times all under load |

- **A1/A2:** the after window paints a stored picture of its last screen in its first frame, with a text box over
  the composer. Typed keys move into the real composer when it takes over (0.5-0.7 s later), and an early Enter
  still sends. The real composer itself is not faster (1,449 vs 1,411 ms at relaunch). First window: no change
  (about 0.53 s).
- **A4:** three fixes moved the adapter's skill-file reads, its sign-in check and Volt's workspace summary off the
  path to the model request. On a quiet machine that work was already running beside the request, so the time did
  not move; under load the adapter alone went from 75 to 50 ms of Claude Code CPU before its request.
- **B1/B3:** the task tools fell from 2,078 to 740 tokens (`e4/orch`) and Claude Code's Agent, Workflow, ScheduleWakeup, ReportFindings and ListAgents (6.5K tokens) are
  lazy-loaded through Claude Code's `tool.describe` hook with a one-line `select:` hint, not cut; each was still
  used when a task asked for it (12 of 12 tasks). The skills list uses 400-character descriptions.
- **C1:** n 1 per row, every run under load 30-124. The lead's 60 s wait cut is gone (`MCP_TOOL_TIMEOUT`), its
  requests fell from 24 to 14-16. Worktree subagents now get worktrees made ahead with a warm agent.

## Memory and smoothness (35, 36: not finished)

The user stopped both agents before their reports were written and chose to merge only their committed fixes,
with no new timings. Reports 35 and 36 are the agents' unfinished drafts. The numbers below are their committed
data run through their own `summarize.mjs` (load gate 14). Each "after" arm was the agent's working tree at the
time, which may have included one uncommitted `agentEditor.ts` edit that is not merged. Dev builds, n small.

### Memory (`e4/weight`, `data/weight/`, `node scripts/weight/summarize.mjs 14`)

| Test | Before | After | Load |
|---|---|---|---|
| A5 five idle threads, total | 1,647 MiB (n 3, 1,498-1,902) | **1,367 MiB** (n 3, 1,141-1,382) | 10.3-13.8 |
| A5 agent processes at rest | 1 Claude CLI (128 MiB) | **0** | 10.3-13.8 |
| A10 20 threads at rest, total | 5,741 MiB (n 1) | **2,730 MiB** (n 2, 2,728-2,731) | 7.6-13.0 |
| A10 ACP adapters alive at rest | 17 (n 1) | 9.5 (n 2, 9-10) | 7.6-13.0 |
| A9 left running after quitting Volt | 394 MiB (n 3, 390-407) | **0** (n 3) | 9.8-13.9 |
| A7 p95 total, working | 3,975 MiB (n 2) | 3,845 MiB (n 2) | 12.4-14.0 |
| First word, reopened thread, 3 s after open | 255 ms (n 5, 220-313) | 237 ms (n 5, 232-5,836) | 10.2-13.9 |
| First word, reopened thread, 1 s after open | 244 ms (n 4, 227-299) | **606 ms** (n 4, 279-803) | 9.6-13.6 |
| First word, first prompt after launch, new thread | 500 ms (n 3, 341-718) | 431 ms (n 3, 399-955) | 5.4-9.8 |
| First word, first prompt after launch, restored chat | 272 ms (n 3, 261-302) | **1,339 ms** (n 3, 1,204-1,412) | 5.7-8.7 |

Fixes merged: the agent server stops 20 s after Volt quits (`fd0762f6078`); idle agents of chats not in use stop
after 30 s and resume through `session/resume` (`72422f9803c`, `5940a69016f`); the chat a window restores starts
no agent until the user acts (`b98ab46593a`), then warms for 30 s after launch and stays on the first keystroke
(`ad7f75e0f14`).

**Memory is down, but the first message to a restored or just-reopened chat is slower.** `ad7f75e0f14` was meant
to fix that. The agent's last run timed it, but that data was never committed (`~/.volt-r4/weight/chain6.log`, n 3
per cell, load 3.7-13.9):
- Restored chat, prompt 15 s after launch: 540-1,834 ms after, against 278-372 ms before.
- Restored chat, prompt 45 s after launch (past the 30 s warm window): 1,635-1,678 ms after, against 343-490 ms before.
- New thread: no regression (374-440 ms after, 410-1,154 ms before).

So the merged tree trades about 1.2-1.3 s on the first message to a chat whose agent was stopped for 0.3-3 GB of
memory. Whether to keep that trade, or warm the agent on composer focus instead, is open.

### Idle CPU, typing lag and chat open (`e4/smooth`, `data/smooth/`, `node scripts/smooth/summarize.mjs`)

| Test | Before | After | Load |
|---|---|---|---|
| A6 idle, window in front: app CPU | 5.07 % of a core (n 4, 3.03-5.47) | **2.86 %** (n 4, 2.39-5.19) | 9.9-13.4 |
| A6 idle, in front: wakeups/s | 167 (n 4, 113-183) | **38** (n 4, 29-46) | 9.9-13.4 |
| A6 idle, in front: GPU process CPU | 1.59 % | **0.06 %** | 9.9-13.4 |
| A6 idle, covered: app CPU | 3.71 % (n 2) | 3.28 % (n 2) | 10.4-13.8 |
| A8 typing with 5 streams, p95 | 162.5 ms (n 3, 111-200) | 133.3 ms (n 3, 74-160) | 12.0-13.8 at start, 16.7-29.1 while typing |
| A8 typing, p50 | 36.2 ms | 25.5 ms | as above |
| Reload, last message on screen (medium chat) | 1,972 ms (n 6, 1,653-2,774) | **1,477 ms** (n 6, 1,263-3,534) | 9.1-13.7 |
| Open a large chat, settled | 820 ms (n 3, 272-865) | **257 ms** (n 3, 197-1,011) | 9.8-11.8 |
| Open a medium / small chat, settled | 75 / 46 ms | 73 / 39 ms | 8.3-13.2 |

Fixes merged: the composer's caret stops blinking after 10 s without input (`b7691223848`) and the hidden native
caret does not blink on macOS (`cb2cb0f0d53`); the sandbox samples idle hosts every 10 s instead of every second
(`64db02de4c8`); worktree sizes are measured in one `du`, only for chats that ran, not at launch (`6c746e73e5c`); the
chat clock ticks every 10 s when nothing changes by the second (`ba0ca189246`); the update button stops polling
(`17aae574cdf`); a chat is read ahead while the pointer rests on its row (`9525f89d390`); a reopened chat draws from
its kept first screen while its transcript is read (`ea48ef5043d`).

Not fixed: the sandbox's `log stream` costs 0.9-2.1 % of a core whenever a sandboxed process is alive (it is now
the largest idle cost in front). A8's loads while typing were above 14, so its rows are not clean timings.

## Merge notes

Merged in this order onto `b2db4e7f605`: `e4/tokens`, `e4/orch`, `e4/c1`, `e4/firstword`, `e4/coldstart`,
`e4/weight`, `e4/smooth`.

- `e4/weight` and `e4/smooth` are merged as committed when their agents stopped (the user's choice); their
  uncommitted work stays in their worktrees, unmerged.
- `agentEditor.ts` (coldstart + smooth): each added a method at the same place (`takeOverWindowSnapshot` /
  `windowSnapshotComposer`, and `drawOverFirstScreen`); kept all three.
- `e4/weight` brings 46 MB of raw memory samples (`data/weight/raw/*.csv`, about 22k lines each).
- `cliAgents.test.ts` (orch + firstword): both added an import; kept both.
- `agentTasks.ts` (orch + c1): `e4/c1` carries an older `e4/orch` and a reverted description change; the merged
  file keeps `e4/orch`'s typed `isolation` enum and adds `e4/c1`'s worktree-spares hook.
- `extensions/volt-provider-claude/package.json` (c1): `MCP_TOOL_TIMEOUT=300000` for Claude, and
  `~/.volt/claude-plugins` readable in its sandbox.
- Tokens on the merged tree (report 33's rig, Opus 5.5, n 3, [`data/tokens/merged/`](data/tokens/merged/analysis-merged.md)):
  "hi" **14.1K** (14.1-14.3K), real prompt **53.6K** (52.9-55.6K). The three task tools are 702 tokens (1,945 on
  `e4/tokens`), and Full access now runs Claude Code in bypass-permissions mode, so the classifier context
  (`safeguards`, about 800 tokens) is gone. B4's AGENTS.md canary was in 12 of 12 requests and obeyed 6 of 6.
- Found by that run and fixed on this tree (`620eb885f7a`): `<volt_context>` listed each file's reasons in the
  order the parallel searches finished, so the same prompt sent a different first message every run and wrote
  9.8-10.1K to the cache each time ($0.13 per B3 run against $0.07 on `e4/tokens`, which sent no
  `<volt_context>`). Evidence is now sorted before scoring and before the headline; cost not re-measured.

## Verification (merged tree)

- Type check (`tsgo --project src/tsconfig.json --noEmit`): 0 errors, after five branches and again after all seven.
- Full unit suite (`scripts/test.sh --run`): **16,091 passing, 0 failing**, 213 pending, after five branches.
  After all seven: **16,124 passing, 0 failing**, 213 pending, after fixing one flaky test the first run hit
  (`serverCompression.test.ts` asserted which of two concurrent copies reached the compressor first; failed 2 of
  3 runs alone, 6 of 6 pass after `0ccdc992716`; round 4 did not touch that code).
- Live: "hi" and the real prompt on the merged tree (five branches), 3 runs each on Opus 5.5 (Merge notes). The
  timing numbers above come from each branch's own build, not the merged tree.

## Still open

- **First message to a stopped agent** (35): the memory savings make the first word on a restored or just-reopened
  chat about 1.2-1.3 s slower (1.34-1.68 s against 0.27-0.49 s). Keep the trade, or warm the agent on composer
  focus or pointer movement over the composer.
- **t1 vs Claude Code** (31): about 2 s behind. The lead's last turn after the final report takes 6.0-7.5 s against
  3.0 s; untested causes are Volt running Claude at `high` effort and a lead prompt 4-5k tokens larger. In 4 of 18
  runs the lead also searched for task tools it already had (about 2.5 s each).
- **B3 cost** (33, Merge notes): not lower than base yet; the `<volt_context>` ordering fix (`620eb885f7a`) should
  let identical prompts hit the cache, not re-measured.
- **Cold start** (34): the real composer is not faster (1,449 vs 1,411 ms at relaunch; 1,694 vs 1,489 ms on the
  long chat); the first window still opens at about 0.53 s against ADEMark leaders' 0.27-0.29 s. The before build's
  4-5 s composer stall (19 of 40 reps) is gone after, cause not isolated.
- **A4** (32): not run with ADEMark's own runner; the bare CLI's A4 on this Mac is not measured, so 122.5 ms cannot
  be placed against the site's board. The adapter adds 50-85 ms over Claude Code alone under load.
- **Idle CPU** (36): the sandbox's `log stream` (0.9-2.1 % of a core while any sandboxed process lives).
- **C1** (37): no run at load 14 or less; Volt's ready worktrees not yet timed on Opus with the typed `isolation`.
- **Token rig**: `runtok.mjs` must set `VOLT_AGENT_SERVER_LAUNCHD=0` for trees outside the Desktop folder.
- **Official ADEMark numbers** still need the `ademark` macOS account on the reference hardware.
