# 31 · Orchestration, round 4: Volt vs Claude Code on the four orchestration tasks

Branch `e4/orch` (worktree `volt-e4-orch`, base `b2db4e7f605`), 2026-11-14. Round 3: [`../round3/24-orchestration.md`](../round3/24-orchestration.md).

Status: final.

Tasks as in rounds 2-3: **t0** "Reply OK", **t1** 3 research subagents + a synthesis subagent, **t2** 3 parallel
bug fixes + `npm test`, **t3** writer + reviewer. Haiku 5.5 for the parent and every subagent in every arm.

## Summary

Medians of timed runs (1-minute load ≤ 14 at the run's start), Claude Code / Volt before / Volt after:

- **t0 "Reply OK"**: 3.0 / 2.1 / 1.9 s (n 5 / 5 / 4). Volt is ahead of Claude Code on both builds.
  One run of the after build took 32.4 s. That time was spent waiting for the model: the agent was ready in 7 ms and the prompt was sent in 27 ms.
- **t1 research**: 27.0 / 31.3 / 31.5 s (n 10 / 9 / 4); with the last fix (`7aa4e6dc999`) 29.2 s (n 3, range
  28.4-31.5). **Volt is still behind** by about 2 s. The ranges overlap, and the after build's gain over the before build is not shown with this n.
- **t2 bug fixes + `npm test`**: 23.3 / 24.5 / 22.9 s (n 6 / 5 / 6). Volt after has the lowest median; the ranges
  overlap (19.8-29.2 vs 22.2-27.8).
- **t3 writer + reviewer**: 62.4 / 39.5 / 40.4 s (n 7 / 7 / 6). Volt is well ahead. Claude Code's parent re-checks the
  file itself after the reviewer approves (13.5 s tail against 2.7 s). The before and after builds are even.
- **Correct answers**: every graded answer in every arm is right (all runs, timed and untimed; [grades](data/orch/cmp/grades.md)).
- **The fixes this round** are mostly Volt-side waits that ran inside agent turns, so wall time hides some of them:
  - The 3 s new-errors wait after clean edits is gone. Editing subagent runs that ended ≥ 2.9 s late: 6 of 27 on the before build, 0 of 31 on the after builds.
  - CLI-agent edits are now captured: 6 of 27 editing runs before, 31 of 31 after.
  - Enter → first subagent dropped on t2 from 9.7 to 6.7 s, now 0.6 s behind Claude Code (6.1 s).
  - Volt's own overhead on the critical path is 0.2-0.7 s median per task (1-10 % of the wall time).
- **Worktrees again (C1 finding)**: shortening the task-tool schemas had made Opus leads create their own
  `git worktree`s. Typing `isolation` back in the schema (`498b6f7f295`) restores Volt's worktrees:
  - lead probe: 4 of 4 used Volt's worktrees, against 0 of 2 at `00ede1cf0eb`;
  - live C1 run in Volt: 4 of 4 parts used `isolation: "worktree"` on Volt worktrees, and the lead made none of its own.

  The three task tools now cost 740 tokens per request: 2,078 before this round, 685 at the shortest.

## Results: medians, timed runs only

Median [min–max], n per cell. Timed = 1-minute load ≤ 14 at the run's start; runs above that are counted in the
second row and left out of every median. **Claude Code** = Claude Code CLI (`claude -p`, stream-json, bypass
permissions) in the task folder. **Volt before** = `b2db4e7f605` (worktree `volt-e4-base`, arm `volt-r4-base`,
CDP 9945). **Volt after** = this branch at `498b6f7f295` (arm `volt-r4`, CDP 9941). **+ 7aa4e6dc999** = the same
instance after the last fix (arm `volt-r4b`, mainly t1, where the fix applies; 2 t3 runs and 1 t2 run check that the other tasks did not get worse).
Both Volt builds run side by side in dev test instances; the task folder is the chat's project, and access is Full access. Arms ran interleaved,
one rep at a time with rotating order, load checked before each run (`bench.mjs`). Tokens = input + output + cache read +
cache write over the parent and all subagents; cost at Haiku list price.

| Task | Measure | Claude Code | Volt before | Volt after | Volt after + 7aa4e6dc999 |
|---|---|---|---|---|---|
| t0 "Reply OK" | wall s | 3.0 [2.8–4.2] | 2.1 [1.7–3.9] | 1.9 [1.7–32.4] | – |
| | n timed (+ under load, left out) | 5 (+1) | 5 (+1) | 4 (+1) | 0 (+0) |
| | load at start | 12.9 [8.0–13.4] | 12.0 [7.7–12.4] | 10.6 [6.5–13.6] | – |
| | first output s | 2.0 [1.8–3.2] | 1.8 [1.5–3.2] | 1.6 [1.5–32.1] | – |
| | tokens k | 24 [24–24] | 31 [31–31] | 30 [29–30] | – |
| | cost at Haiku list $ | 0.0002 | 0.0037 | 0.0036 | – |
| | correct | 5/5 | 5/5 | 4/4 | – |
| t1 3 research subagents + synthesis | wall s | 27.0 [21.3–32.9] | 31.3 [28.2–45.9] | 31.5 [28.0–42.0] | 29.2 [28.4–31.5] |
| | n timed (+ under load, left out) | 10 (+1) | 9 (+2) | 4 (+2) | 3 (+2) |
| | load at start | 12.4 [5.9–13.0] | 11.9 [7.5–13.6] | 9.3 [6.5–13.5] | 12.9 [11.1–13.4] |
| | first output s | 2.2 [2.1–3.2] | 1.8 [1.6–2.4] | 1.8 [1.5–2.5] | 3.1 [1.8–3.8] |
| | tokens k | 238 [225–348] | 143 [138–197] | 218 [211–243] | 208 [207–212] |
| | cost at Haiku list $ | 0.0192 | 0.0137 | 0.0152 | 0.0142 |
| | correct | 10/10 | 9/9 | 4/4 | 3/3 |
| t2 3 parallel bug fixes + npm test | wall s | 23.3 [22.2–27.8] | 24.5 [22.5–28.8] | 22.9 [19.8–29.2] | 29.0 (n 1) |
| | n timed (+ under load, left out) | 6 (+0) | 5 (+1) | 6 (+0) | 1 (+0) |
| | load at start | 10.8 [5.5–13.3] | 9.6 [4.8–13.9] | 12.1 [5.4–13.0] | 14.0 |
| | first output s | 2.2 [2.0–2.6] | 2.2 [1.6–4.1] | 1.7 [1.7–2.2] | 1.9 |
| | tokens k | 406 [348–438] | 249 [247–259] | 310 [277–328] | 349 |
| | cost at Haiku list $ | 0.0189 | 0.0148 | 0.0154 | 0.0168 |
| | correct | 6/6 | 5/5 | 6/6 | 1/1 |
| t3 writer + reviewer | wall s | 62.4 [35.6–78.9] | 39.5 [28.8–67.5] | 40.4 [31.0–54.9] | 41.0 [27.7–54.4] |
| | n timed (+ under load, left out) | 7 (+0) | 7 (+1) | 6 (+0) | 2 (+0) |
| | load at start | 12.6 [5.3–13.9] | 11.4 [3.6–13.4] | 9.9 [5.9–13.7] | 11.6 [10.5–12.7] |
| | first output s | 2.3 [1.8–8.4] | 1.9 [1.6–2.1] | 1.7 [1.5–2.1] | 2.3 [1.7–2.8] |
| | tokens k | 596 [267–846] | 181 [163–362] | 184 [157–320] | 239 [194–284] |
| | cost at Haiku list $ | 0.0224 | 0.0115 | 0.0124 | 0.0129 |
| | correct | 7/7 | 7/7 | 6/6 | 2/2 |

Notes on the cells:
- Claude Code's t0 cost median is 0.0002 $ because most of its t0 runs read the whole prompt from cache.
- `volt-r4-t0-3` (32.4 s, load 6.5) is kept in the median. The agent came from the pool, was ready in 7 ms and got the prompt at
  27 ms; the first text arrived at 32.0 s. That wait was on the model's side.
- The one t2 run with `7aa4e6dc999` started at load 14.0 (5-minute load 15.0). It is a check, not a timing to compare.
- t3 depends on what the reviewer finds. A second review round (message the writer, review again) adds 15-25 s whenever it
  happens: in 2 of 6 `volt-r4` runs (`t3-2`, `t3-4`), 1 of 8 Volt-before runs (`t3-1`), and in Claude Code's slow runs.
- In t3, Volt's tokens are a third of Claude Code's, mostly because its parent does not re-read the file after the review.

Raw rows: [`data/orch/cmp/runs.jsonl`](data/orch/cmp/runs.jsonl) (rows carry `load` as the three `uptime` averages), per-run
streams and Volt traces in [`data/orch/cmp/raw/`](data/orch/cmp/raw/), the bench log in `~/.volt-r4/orch/bench.log`. Rep 1
(03:2x-03:3x local) ran at load 19-128 and is left out wherever it was above 14. Six earlier smoke runs at load 61-97
are in [`data/orch/smoke/runs.jsonl`](data/orch/smoke/runs.jsonl) and in no table. One run (`volt-r4-t0-1`) failed in the rig
(the project picker showed the previous fixture) and is in `failures.jsonl`. Two optional check runs (cc t3 8, volt-r4b t0 7)
were not taken: the load stayed at 25-28 for 10 minutes and the C1 check needed the instance.

## Where the seconds go

On one clock from Enter (`phases.mjs`, timed runs, medians):

| Arm, task | n | Enter → first subagent, s | Subagents running, s | Last subagent → answer, s | Wall, s |
|---|---|---|---|---|---|
| cc t1 | 10 | 4.7 | 17.5 | 3.0 | 27.0 |
| volt-r4-base t1 | 9 | 6.8 | 15.4 | 7.5 | 31.3 |
| volt-r4 t1 | 4 | 5.5 | 19.4 | 7.3 | 31.5 |
| volt-r4b t1 | 3 | 6.6 | 16.6 | 6.0 | 29.2 |
| cc t2 | 6 | 6.1 | 12.5 | 4.5 | 23.3 |
| volt-r4-base t2 | 5 | 9.7 | 11.0 | 4.1 | 24.5 |
| volt-r4 t2 | 6 | 6.7 | 12.0 | 3.4 | 22.9 |
| cc t3 | 7 | 5.4 | 21.3 | 13.5 | 62.4 |
| volt-r4-base t3 | 7 | 5.0 | 32.1 | 2.7 | 39.5 |
| volt-r4 t3 | 6 | 5.2 | 32.1 | 2.7 | 40.4 |

Volt's own overhead on the critical path (`breakdown.mjs --max-load 14`: Enter → parent run.start, parent agent ready,
child start gaps, child agent ready, report delivery), median [range]:

| Arm | t0 | t1 | t2 | t3 |
|---|---|---|---|---|
| Volt before | 0.2 [0.2–0.4] (n 5) | 0.6 [0.3–11.4] (n 9) | 1.8 [0.7–5.1] (n 5) | 0.6 [0.4–1.1] (n 7) |
| Volt after | 0.2 [0.1–0.3] (n 4) | 0.4 [0.3–0.8] (n 4) | 0.6 [0.5–1.7] (n 6) | 0.7 [0.4–1.1] (n 6) |
| + 7aa4e6dc999 | – | 0.9 [0.4–1.7] (n 3) | 1.8 (n 1) | 4.3 [0.5–8.1] (n 2) |

The 8.1 s in `volt-r4b-t3-8` was a cold reviewer agent: no warm spare was free, and its first prompt went out at 5.95 s.
Warm subagent starts over all runs were 4 of 5 for that arm, 56 of 58 for `volt-r4`, and 82 of 85 for the before build.

Prompt size per model request (`reqsize.mjs`, median over all requests): Claude Code's parent prompt is 24.4-31.4k
tokens; Volt's is 29.5-35.4k (after) and 30.9-36.6k (before). Subagents are smaller in Volt: 9.5-15.0k against
16.2-20.8k.

What is left on t1 is the model's turn structure, not Volt's waits:
- The parent writes four briefs. Q4 is a synthesis written from the other three reports, so it can start only after them.
- With one call per part, the parent's last turn after the final report takes 6.0-7.5 s against Claude Code's 3.0 s.
- In `volt-r4b-t1-11` (where the fix applied), it took 5.0 s from the tool result to the final text and 6.3 s to the turn's end.
  The first usage event came 1.6 s after the result.
- A cause we have not checked: the adapter's default effort is `high` (`config mode=auto,model=default,effort=high` in the ACP probe
  logs), and the CLI arm runs at its own default. See "Not done".

## Fixes

Every fix is one commit with a unit test where the code is testable. Typecheck (`npm run compile-check-ts-native`)
is clean at the branch head.

| Commit | Change | Measured (same rig, before → after) |
|---|---|---|
| `9f4c286c41d` perf(acp): the new-errors check counts its marker wait from the agent's write | file opened for its language service at the write, the 3 s window counted from the write, unowned files skipped | with `47f6cea41e4`: editing subagent runs ending ≥ 2.9 s late 6/27 → 0/31 (`endgaps.mjs`, all runs) |
| `47f6cea41e4` perf(acp): the new-errors check ends when tsserver says an edited file has no errors | tsserver syntactic/semantic diagnostics answer for clean JS/TS: the wait ends 400 ms after the write | as above; unit tests `codeIntelHost.test.ts`, `codeIntelErrorProbe.test.ts` |
| `8ce2b41c20b` fix(acp): capture CLI-agent edits named by their macOS real path | `/private/tmp/...` paths match the chat's `/tmp/...` folder | editing runs with a `file.change` 6/27 → 31/31 (round 3: 10/51). So the new-errors check, the change list and undo now see these edits |
| `f59e930366d` fix(acp): a Full access Claude chat runs in bypassPermissions | the bridge sends the adapter's `mode` option. Before, nothing was sent and the chat ran in `auto` mode, which holds MCP calls to the end of the message | ACP probe (3 calls in one message, n 3 each): first call ran 3.6-4.2 s after its block began in `auto`, 1.0 s in `bypassPermissions` ([data/orch/probe](data/orch/probe/)) |
| `76d7444ea37` perf(orch): parts started in calls of their own report together, and do not wait on each other | parts of one turn share a batch (one wake-up). A waiting call stops waiting when the next `delegate_task` call starts | unit tests. Makes one-call-per-part safe |
| `e68ee006080`, `fedf3593f58`, `00ede1cf0eb` perf(orch): shorter task tool schemas; one `delegate_task` call per part | `tasks` dropped from the schema (the handler still takes it); options named in the description | three task tools 2,078 → 685 tokens (count_tokens, Haiku 5.5). Enter → first subagent t1 6.8 → 5.5 s, t2 9.7 → 6.7 s (`phases.mjs`, timed). `delegate_task` calls per run 1 → 3-4 |
| `1e6c67da212` fix(acp): no tests-tool hint for requests that run node's own test runner | the hint is skipped for `node --test` / `node:test` requests | tests-tool calls in t2: 0 in 18 runs of both builds this round (round 3: 3 of 6) |
| `498b6f7f295` fix(orch): delegate_task types `isolation` again, so leads use Volt's worktrees | `isolation: {enum: [shared, worktree]}` with one line of description | see the next section. 685 → 740 tokens |
| `7aa4e6dc999` perf(orch): a waited delegate_task returns the reports it held back | a `wait=true` call that ends with its report also returns the finished, undelivered reports of its `after` tasks and batch mates, and marks them acknowledged | t1: in the 2 `volt-r4` runs whose lead started the synthesis with `wait=true` before reading the other reports (`t1-1`, `t1-3`), a `wait_tasks` call followed for those reports, a 3.6 / 3.9 s model round trip. (The commit message says "3 of 3"; the correct count is 2 of 6 runs.) In `volt-r4b-t1-11`, the one `volt-r4b` run with that shape, the waited call returned all four reports (3.3 KB) and the parent answered next. In the other 4 `volt-r4b` runs the lead called `wait_tasks` first or did not wait in the call, and the fix does not apply to them. t1 29.2 s (n 3) vs 31.5 (n 4) is within the spread. Unit test in `agentOrchestratorService.test.ts` |

Per-fix counts from the traces (`fixstats.mjs`, all runs of each arm):

| Arm | Task | n | delegate_task calls | args bytes | Enter → first subagent, s | Editing runs ending ≥ 2.9 s late | Edits captured | Warm starts | tests-tool calls |
|---|---|---|---|---|---|---|---|---|---|
| volt-r4-base | t1 | 11 | 1 | 1578 | 7.0 | – | – | 47/49 | 0 |
| volt-r4-base | t2 | 6 | 1 | 2364.5 | 9.6 | 1/18 | 1/18 | 18/18 | 0 |
| volt-r4-base | t3 | 8 | 2 | 1484 | 5.2 | 5/9 | 5/9 | 17/18 | 0 |
| volt-r4 | t1 | 6 | 4 | 1671 | 5.3 | – | – | 24/24 | 0 |
| volt-r4 | t2 | 6 | 3 | 2732.5 | 6.7 | 0/18 | 18/18 | 18/18 | 0 |
| volt-r4 | t3 | 6 | 2 | 1900 | 4.7 | 0/8 | 8/8 | 14/16 | 0 |
| volt-r4b | t1 | 5 | 4 | 1949 | 4.8 | – | – | 20/20 | 0 |
| volt-r4b | t2 | 1 | 3 | 3679 | 9.6 | 0/3 | 3/3 | 3/3 | 0 |
| volt-r4b | t3 | 2 | 2.5 | 2447.5 | 6.7 | 0/2 | 2/2 | 4/5 | 0 |

### Volt's worktrees for parallel edits (`498b6f7f295`)

The C1 orchestrated build (report 37, branch `e4/c1`) found that with `00ede1cf0eb` the Opus lead ran `git worktree add`
itself in both after-runs and ran the four parts in shared mode. On the old build the lead used `isolation: "worktree"`.
`00ede1cf0eb` had moved `isolation` from the schema into one clause of the description.

- **Lead probe** ([`scripts/orch/wtprobe/run.mjs`](scripts/orch/wtprobe/run.mjs)): `claude -p`, Opus 5.5 high, the
  C1 prompt, Volt's task tools from a checkout's `out/` over a stub MCP server, stopped at the first worktree decision.
  [rows](data/orch/wtprobe/rows.jsonl):

  | Tools | Volt worktree | `git worktree add` by the lead |
  |---|---|---|
  | `b2db4e7f605` (2,078 tokens) | 1/1 | 0/1 |
  | `00ede1cf0eb` (685 tokens, isolation only in the description) | 0/2 | 2/2 |
  | typed enum, description "shared (default): ... worktree: ..." | 2/2 | 0/2 |
  | typed enum, "worktree: its own branch and checkout, for parallel edits of the same files; merge the branch it names." (committed) | 2/2 | 0/2 |

- **Live run in Volt** (`orch-verify-1`; the C1 rig from `volt-e4-c1` `28df31b9769` run from a private copy with its own
  proxy on 19941 and profile `/tmp/v4-orch-c1-ud`; Opus 5.5 High, Full access, sandbox off, load 14.0 at start):
  - the lead started W1-W4 with `isolation: "worktree"`, each on a Volt branch and checkout (`volt/a3f7a60b` …
    `volt/62073efc`), at 21.8 / 30.0 / 39.9 / 52.4 s;
  - its trace has no `git worktree add`.

  The worktree spares from `e4/c1` are not on this branch, so the worktrees were made one at a time when each task arrived.
  The run itself, graded by the C1 rig: 4.22 min to green, 5/5 shipped, handoff 4/4, fan-out 4 (the rig counts worker
  sessions in worktrees; the two `00ede1cf0eb` after-runs in report 37 show 0), 1.72M tokens, $2.62. This is n 1, at a load of 14.0 at start (5-minute load 17.4).
  It is not a C1 result (see report 37 for those), but the row is kept: [data/orch/c1verify](data/orch/c1verify/c1-runs.jsonl).
- **Tokens** (count_tokens, Haiku 5.5, as Claude Code lists MCP tools; [`counttools.jsonl`](data/orch/wtprobe/counttools.jsonl)):

  | Build | delegate_task | wait_tasks | message_task | All three |
  |---|---|---|---|---|
  | `b2db4e7f605` | 1,662 | 217 | 199 | 2,078 |
  | `00ede1cf0eb` | 419 | 130 | 136 | 685 |
  | `498b6f7f295` | 474 | 130 | 136 | 740 |

  740 tokens keeps 64 % of the cut. The brief's 0.6K target is not met: the 55 tokens for typing `isolation` are what
  makes leads use Volt's worktrees.

## Method

- Fixtures from `mkfixtures.mjs` under `/tmp/v4orch/w/t0..t3`, reset before each run (`score.mjs resetFixture`).
- Prompts in `scripts/orch/cmp/prompts/` name `delegate_task` but not the call shape, so each build follows its own tool description.
- Claude Code's prompt names its Agent tool.
- `bench.mjs <from> <to>` (or `--jobs`) runs every arm once per task per rep, rotating the order, and waits for load ≤ 14 before each run.
  Rows record the load at the run's own start, so a few rows are above 14 and are left out.
- Grading as in round 3 (`grades.mjs`). As in round 3, Q4 of t1 is not counted: its answer cannot be settled from Q1-Q3.
- Tables: `headline.mjs`, `phases.mjs`, `breakdown.mjs`, `fixstats.mjs`, `endgaps.mjs`, `reqsize.mjs` in `scripts/orch/cmp/`.
- Timings are on a shared 14-core machine, with four to five other agents' builds and test windows running. Medians use only runs that started at load ≤ 14.

## Not done, and open

- **t1 is still about 2 s behind Claude Code.** The gap is in the parent's last turn after the final report (6.0-7.5 s vs
  3.0 s), not in Volt's waits (0.4-0.9 s). Candidates not tested:
  - Volt runs Claude at the ACP adapter's default effort `high`. We did not check what effort the CLI uses for Haiku when none is given.
  - Volt's parent prompt is 4-5k tokens larger.

  The parent-thinking probe ([`data/orch/think`](data/orch/think/rows.jsonl), n 3 per variant, load not recorded,
  not a timing) showed no gap before the first tool call: first tool block 8.1-10.2 s for the CLI with Claude Code's prompt, 8.7-9.7 s for Volt after.
  So the round-3 question "5.6 s of hidden thinking before the first call" did not reproduce.
- **ToolSearch for already-loaded tools.** In 4 of 18 after-build t1/t2 runs (`volt-r4-t1-2`, `-t2-4`, `volt-r4b-t1-11`, `-t2-7`) the parent first called ToolSearch for
  `delegate_task` and `wait_tasks`, although both are always loaded. Each costs about 2.5 s before the first subagent. Not fixed.
- **The fix in `7aa4e6dc999` depends on the lead's shape.** It saves the round trip only when the lead starts the synthesis
  call with `wait=true` before it has read the other reports. That happened in 1 of 5 `volt-r4b` runs and 2 of 6 `volt-r4` runs.
- **Tokens per run grew on t1/t2.** One call per part means more parent requests: t1 143k → 208-218k, t2 249k → 310k,
  against Claude Code's 238k / 406k. Cost at list price is still below Claude Code's on t1-t3.
- **The ADEMark C1 build was not re-timed here.** The c1 area owns it. The one live C1 run above was taken for the
  worktree check, and its row is kept as data, not as a C1 result.
- **Warm reviewer spares** missed once (`volt-r4b-t3-8`, 5.95 s cold start), under load 12.7 with a 5-minute average of 15.4.
