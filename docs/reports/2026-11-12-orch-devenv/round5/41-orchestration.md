# 41 · Orchestration, round 5: Volt vs Claude Code on t0-t3, and ADEMark C1

Branch `e5/orch` (worktree `volt-e5-orch`, base `9bbb8818c60`), 2026-11-14. Round 4: [`../round4/31-orchestration.md`](../round4/31-orchestration.md), [`../round4/37-orchestrated-build.md`](../round4/37-orchestrated-build.md).

Status: draft (C1 pending).

## Summary

Haiku 5.5 for the lead and every subagent, same four tasks as rounds 2-4 (**t0** "Reply OK", **t1** 3 research
subagents + a synthesis subagent, **t2** 3 parallel bug fixes + `npm test`, **t3** writer + reviewer). Medians of
timed runs (1-minute load at most 14 at each run's start, taken under the shared timing lock), Claude Code / Volt
before / Volt after:

- **t0**: 2.9 / 1.9 / 1.8 s (n 4 / 4 / 4). Volt ahead, as in round 4.
- **t1**: 25.9 / 30.4 / **21.9 s** (n 4 / 3 / 3). Round 4 left Volt about 2 s behind; the after build is now 4.0 s
  ahead of Claude Code and 8.5 s ahead of the before build, with no overlap of the ranges (after 21.7-25.6, before
  27.1-31.9). Q1-Q3 right in every run.
- **t2**: 21.2 / 21.7 / **20.7 s** (n 3 / 3 / 3). Volt after has the lowest median; the ranges overlap.
- **t3**: 40.5 / 37.0 / **35.3 s** (n 3 / 3 / 3). Volt ahead on both builds. One after run took 70.2 s because its
  reviewer asked for changes and the lead ran a second writer and review round (Claude Code's 56.7 s run did the
  same); the median is not moved by it.
- **Every answer right** in every run (t1 Q1-Q3, t2 7/7 tests, t3 7/7 with the planted bug fixed).
- **Where t1's 8.5 s went** (phases, medians): the time from the last subagent's end to the answer fell from 8.7 to
  3.9 s (the lead's last turn thinks half as much without the pre-read project files), and subagents run 14.6 s
  instead of 18.0 s (the synthesis subagent writes the short answer its brief asks for: 6.1-7.5 s against
  6.4-10.9 s).
- **C1**: see below.

## Results: medians, timed runs only

Median [min-max], n per cell. **Claude Code** = `claude -p` (Haiku 5.5, stream-json, bypass permissions) in the
task folder. **Volt before** = `9bbb8818c60` (worktree `volt-e5-base`, arm `volt-r5-base`, CDP 9978). **Volt
after** = this branch at `616ad44e0aa` (arm `volt-r5`, CDP 9971). Both Volt builds ran side by side as dev test
instances with the task folder as the chat's project and Full access. Arms ran interleaved, one rep at a time with
the arm order rotating per rep (`bench.mjs`), every run under `~/.volt-r5/timing.lock` and only at a 1-minute load
of 14 or less; no run was above 14, so none is left out. Tokens = input + output + cache read + cache write over the
lead and all subagents. Reps 1-3 of every cell ran; rep 4 was stopped by the coordinator after its t0 row of each
arm and Claude Code's t1 row (those rows are kept; that is why some cells have n 4).

| Task | Measure | Claude Code | Volt before | Volt after |
|---|---|---|---|---|
| t0 "Reply OK" | wall s | 2.9 [2.8-3.4] | 1.9 [1.8-2.0] | 1.8 [1.8-1.9] |
| | n timed (+ under load) | 4 (+0) | 4 (+0) | 4 (+0) |
| | load at start | 6.1 [5.6-6.6] | 6.0 [5.3-8.2] | 6.7 [5.7-7.2] |
| | first output s | 2.0 [1.8-2.4] | 1.6 [1.5-1.8] | 1.6 [1.5-1.6] |
| | tokens k | 24 | 21 | 21 |
| | correct | 4/4 | 4/4 | 4/4 |
| t1 research + synthesis | wall s | 25.9 [25.6-28.5] | 30.4 [27.1-31.9] | **21.9 [21.7-25.6]** |
| | n timed (+ under load) | 4 (+0) | 3 (+0) | 3 (+0) |
| | load at start | 5.7 [5.3-7.0] | 6.0 [5.3-8.8] | 6.3 [6.0-9.7] |
| | first output s | 2.4 [1.8-2.7] | 1.6 [1.6-1.7] | 1.6 [1.5-1.8] |
| | tokens k | 296 [226-364] | 173 [148-184] | 169 [147-178] |
| | correct (Q1-Q3) | 4/4 | 3/3 | 3/3 |
| t2 3 bug fixes + `npm test` | wall s | 21.2 [21.0-25.8] | 21.7 [20.9-23.3] | **20.7 [20.1-22.8]** |
| | n timed (+ under load) | 3 (+0) | 3 (+0) | 3 (+0) |
| | load at start | 5.3 [3.8-8.1] | 5.0 [3.7-6.6] | 3.5 [3.2-5.5] |
| | first output s | 2.1 [2.0-2.4] | 1.6 [1.6-1.6] | 1.8 [1.7-2.1] |
| | tokens k | 412 [398-413] | 255 [246-291] | 250 [248-253] |
| | correct | 3/3 | 3/3 | 3/3 |
| t3 writer + reviewer | wall s | 40.5 [32.5-56.7] | 37.0 [36.9-44.4] | **35.3 [31.0-70.2]** |
| | n timed (+ under load) | 3 (+0) | 3 (+0) | 3 (+0) |
| | load at start | 6.2 [5.8-6.3] | 5.3 [4.5-5.6] | 6.3 [3.9-6.9] |
| | first output s | 2.2 [1.9-2.3] | 1.6 [1.6-2.0] | 1.6 [1.6-1.7] |
| | tokens k | 314 [287-530] | 196 [162-211] | 211 [185-422] |
| | correct | 3/3 | 3/3 | 3/3 |

Per run (load, wall, subagents): `node scripts/orch/cmp/grades.mjs data/orch/cmp`; rows in
[`data/orch/cmp/runs.jsonl`](data/orch/cmp/runs.jsonl), raw streams and Volt traces in `data/orch/cmp/raw/`.
t1's Q4 ("checkout's result using only Q1-Q3") is graded apart, as in rounds 2-4: no answer can settle it, and every
arm hedged (0.5-1 in all runs).

Where the seconds go (`phases.mjs`, medians, timed runs; Enter = 0):

| Arm, task | n | Enter to first subagent s | Subagents running s | Last subagent to answer s | Wall s |
|---|---|---|---|---|---|
| Claude Code t1 | 4 | 10.7 | 15.6 | -0.4 | 25.9 |
| Volt before t1 | 3 | 4.3 | 18.0 | 8.7 | 30.4 |
| Volt after t1 | 3 | 4.1 | 14.6 | **3.9** | 21.9 |
| Claude Code t2 | 3 | 6.0 | 2.3 | 10.3 | 21.2 |
| Volt before t2 | 3 | 6.3 | 11.9 | 3.6 | 21.7 |
| Volt after t2 | 3 | 5.1 | 12.1 | 3.3 | 20.7 |
| Claude Code t3 | 3 | 4.8 | 23.2 | 10.7 | 40.5 |
| Volt before t3 | 3 | 4.8 | 30.1 | 2.8 | 37.0 |
| Volt after t3 | 3 | 4.5 | 26.1 | 3.8 | 35.3 |

Claude Code's lead writes the four t1 briefs in one turn after thinking for 10.7 s and works Q4 out itself in the
brief, so its synthesis subagent is short and its answer follows the last tool result at once (its stream marks the
last result a fraction of a second after the answer starts, hence -0.4). Volt's lead starts the first subagent
6.6 s earlier and the after build now also closes the gap at the end.

**How the lead waits** (lead tool calls from the traces, `data/orch/cmp/raw/*.traces.json`). In every Volt t1 run
the lead started Q1-Q3 with three `delegate_task` calls (2.5-5.3 s) and Q4 with `after` (6.6-7.8 s), then waited
with one long-poll: `wait_tasks` (4 of 6 runs; one after run waited on Q1-Q3 and then on Q4, the second call made
while Q4 was still running, so off the critical path) or the waited `delegate_task` itself (2 of 6). No lead
polled, searched for its tools or called anything else. A wait returns the moment its last task settles, and the
lead's final turn starts on that result: from the last wait's return to the answer took 3.9 and 5.5 s on the
after build (the two runs with a `wait_tasks` end mark) against 9.7 and 6.8 s on the before build. What is left
there is the model's last turn, not Volt. t2 and t3 follow the same pattern (one wait per wave; t3's lead starts the
reviewer 2.0-2.6 s after the writer's report).

## Method

- Rig: round 4's `cmp` rig copied to [`scripts/orch/cmp/`](scripts/orch/cmp/) (`bench.mjs` driver, `runcli.mjs`
  for Claude Code, `runvolt.mjs` for Volt over CDP, `score.mjs`, `phases.mjs`, `headline.mjs`, `grades.mjs`),
  fixtures recreated by `mkfixtures.mjs` in `/tmp/v5orch/w`. Round 5 adds the timing lock and load gate to
  `bench.mjs` and fixes `runvolt.mjs stop` matching the base profile by prefix.
- Same prompts as round 4 (family `voltn` for Volt: names `delegate_task` but not the call shape).
- Effort: captured requests (proxy, `~/.volt-r5/orch/capture/diag.jsonl`) show Claude Code and Volt both send
  `output_config.effort = medium` for Haiku 5.5, so effort is not a cause of any gap here and was not changed.
- Lead prompt size: Volt's lead's first request writes 20.9K tokens to the cache against 25.9K for Claude Code, so
  round 4's "Volt's lead prompt is 4-5K larger" no longer holds on the round-4 merge.
- Load 3.2-9.7 at every run's start (this Mac, 14 cores, other agents idle or holding the lock in turn).
- Versions: Claude Code 2.1.322 inside Volt (ACP adapter bundle); `claude` CLI on PATH for the Claude Code arm.

## Fixes

### 1. A subagent reports in the form its brief asks for (`4688f96e870`)

Cause: Volt's subagent prompt asks every report for Outcome / Findings / Verification headings and a list of leads
to check. t1's Q4 brief asks for "at most 3 lines"; Volt's Q4 subagent wrote 0.6-2.1K output tokens in 4.9-11.5 s
(round 4, median 8.4 s) against 3.9 s for Claude Code's, and the lead then read the long reports in its last turn.
Change (`agentTasks.ts`): a brief that sets the answer's form gets exactly that form, without the headings; a task
that waited for others uses their reports as its brief says. Test in `orchestratorDelegation.test.ts`.
Numbers: t1 synthesis subagent 6.5 s [6.1-7.5] after vs 9.5 s [6.4-10.9] before (n 3 / 3); subagents-running phase
18.0 to 14.6 s.

### 2. A top-level chat is told its task tools are loaded (`d00c8e695b1`)

Cause: the volt server's instructions open with "Volt tools (deferred: load with ToolSearch)", and Haiku leads
called ToolSearch for `delegate_task` / `wait_tasks`, which a top-level chat always has, in 4 of 18 round-4 runs
(about 2.5 s each). Change (`voltHostMcp.ts`): the full tool list (top-level chats) adds one line that the three task
tools are loaded; subagents (grouped list) do not get it. +27 tokens (`data/orch/tsprobe/instructions-tokens.json`).
Numbers (lead probe: `claude -p`, Haiku 5.5, t1 prompt as Volt sends it, a stub volt server with the real
instructions, first tool call; `scripts/orch/tsprobe/`): ToolSearch first in 5 of 72 runs with the old text, 0 of 72
with the new ([`data/orch/tsprobe/rows.jsonl`](data/orch/tsprobe/rows.jsonl)). No timed Volt run of either build
called ToolSearch in this bench.

### 3. A chat that delegates gets no pre-read project files (`156015845ba`, `8c01ffbbd11`)

Cause: the turn primer adds the project's files to a chat's first prompt when the request looks like UI work
("checkout", "form" and "page" count, and t1 names `checkout`). A lead that hands the reading to subagents never
uses them, and they ride in every one of its requests. Replaying the lead's last t1 turn (four reports in, the
answer out; `scripts/orch/replay/`, [`data/orch/replay/`](data/orch/replay/README.md)): thinking 936 vs 479 tokens
(median), 7.8 vs 5.4 s (n 16 / 11); Claude Code's own last turn 170 tokens, 4.7 s (n 6). Dropping any other part
of the lead's prompt (each `[Volt]` line, the workspace block, the "Working in Volt" append, the volt server
instructions, task headers in tool results) stayed within the no-files run's noise (n 5 each).
Change (`preflight.ts`, `voltRuntimeService.ts`): a top-level chat whose request delegates skips the primer's
project files; subagents keep them (`8c01ffbbd11`: a subagent's own prompt names `delegate_task`, which the first
version mistook for delegation). The primer's browser part still runs. Tests in `turnPrimer.test.ts`.
Numbers: t1 last-subagent-to-answer 8.7 to 3.9 s (n 3 / 3, timed).

### 4. A stray `delegate_task` call starts nothing (`616ad44e0aa`)

Cause (from the tokens agent): Haiku main chats on one-tool requests (open a page, draw a chart) sometimes called
`delegate_task` with no arguments or a placeholder brief (`{"task":"noop"}`) before loading the tool they needed;
the placeholder started a subagent that was then cancelled. Probe (`scripts/orch/tsprobe/dprobe.mjs`, Claude Code
2.1.322 with Volt's rules and plugin, Haiku 5.5, 290 runs): such a stray first call came only with e5/tokens'
compacted deferred-tool names (28 of 208 runs), never with the full names (0 of 68), and no run delegated a real
brief for a one-tool task (0 of 290); Opus 0 of 12. So the lead does not over-delegate trivial tasks; it fires a
stray call. Change (`agentTasks.ts`, `agentOrchestratorService.ts`): a placeholder brief (noop, test, placeholder,
...) is refused without starting anything, and both refusals say first to load the needed tool with ToolSearch and
call it; short real briefs ("Q1", "Fix a.ts") still start. Tests in `agentOrchestratorService.test.ts` and
`orchestratorDelegation.test.ts`. Rows: [`data/orch/tsprobe/drows.jsonl`](data/orch/tsprobe/drows.jsonl).

## C1 (ADEMark method, unofficial)

PENDING

## Not done, and why

- Rep 4 of t1-t3 was not run (the coordinator asked to finish with three valid reps per cell).
- Effort is not a cause here (both send medium for Haiku 5.5), so there is no effort decision for the user.
