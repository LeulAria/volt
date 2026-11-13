# 24 · Orchestration, round 3: Volt vs Claude Code on the four orchestration tasks

Branch `e3/orch` (worktree `volt-e3-orch`, base `82ae771c1d9`), 2026-11-13. Round 2: [`../round2/10-harness-benchmark.md`](../round2/10-harness-benchmark.md), [`../round2/11-orchestrator.md`](../round2/11-orchestrator.md).

Status: final.

Task names follow round 2 (the brief counts from 1): **t0** "Reply OK", **t1** 3 research subagents + a
synthesis subagent, **t2** 3 parallel bug fixes + `npm test`, **t3** writer + reviewer. Haiku 5.5 for the
parent and every subagent in every arm.

## Summary

Medians of timed runs (load ≤ 14), Claude Code / Volt before / Volt after, n 3 per cell unless noted:

- **t0 "Reply OK"**: 3.2 / 4.3 / 3.0 s. The after build has the lowest median but the widest range
  (2.0-8.1 s); call it even with Claude Code. Volt uses 36-39k tokens for it against Claude Code's 24k
  ($0.0039 / $0.0042 vs $0.0021 at Haiku list price).
- **t1 research (3 subagents + synthesis)**: 30.2 / 44.5 (n 2) / 36.6 s. The fixes took 7.9 s off; Volt
  is still 6.4 s behind. Volt after uses the fewest tokens (177k vs 247k / 244k; $0.0144 vs $0.0184).
- **t2 bug fixes + `npm test`**: 24.5 / 33.8 (n 2) / 27.8 (n 2) s. 6.0 s faster than before, 3.3 s
  behind Claude Code; tokens 317k / 414k / 368k.
- **t3 writer + reviewer**: 40.8 / 73.3 (n 2) / 46.3 s. 27.0 s faster than before, 5.5 s behind Claude
  Code's median (ranges overlap: 40.4-51.8 vs 34.4-49.2 s), with about half its tokens (201k vs 377k;
  $0.0123 vs $0.0174).
- **Correctness**: every graded answer in every arm is right (Claude Code 18/18, Volt before 23/23, Volt
  after 19/19, all runs incl. untimed). Q4 of t1 is not counted (see the grades section).
- **Where the remaining gap is**: Volt's own critical-path overhead is now 0.3-3.5 s median per task; the
  rest of the gap is the lead (Enter → first subagent 8.1 / 10.0 / 7.0 s on t1-t3 vs Claude Code's 4.8 /
  6.4 / 5.7 s: a 39-43k parent prompt vs 29k, and one `delegate_task` call that holds every task until
  it is written) and a 3 s end-of-turn wait on editing subagents whose edits Volt captured
  (root-caused, not fixed).

## Results: medians, timed runs only

Timed = the 1-minute load at the run's start was at most 14 (the brief's gate; 14 cores). Median
[min–max], n per cell. **Claude Code** = Claude Code 2.1.323 CLI (`claude -p`, stream-json, bypass
permissions) in the task folder. **Volt before** = the round-2 tree `82ae771c1d9` (worktree
`volt-e3-orch-base`, arm `volt-r3p-base`). **Volt after** = this branch at `3218fd2568e` (arm `volt-r3q`).
Both Volt builds run side by side in their own dev test instances, the task folder picked as the chat's
project (as Claude Code runs in it), Full access. All three arms interleaved, one rep at a time.
Tokens = input + output + cache read + cache write over the parent and all subagents; cost at Haiku list
price (`analyze.mjs`).

| Task | Measure | Claude Code | Volt before | Volt after |
|---|---|---|---|---|
| t0 "Reply OK" | wall s | 3.2 [3.0–3.4] | 4.3 [2.8–5.0] | 3.0 [2.0–8.1] |
| | n (timed) | 3 | 3 | 3 |
| | first output s | 2.4 [2.1–2.6] | 4.0 [2.3–4.5] | 2.4 [1.5–7.4] |
| | tokens k | 24 [24–24] | 36 [35–37] | 39 [38–40] |
| | cost at Haiku list $ | 0.0021 | 0.0039 | 0.0042 |
| | correct | 3/3 | 3/3 | 3/3 |
| t1 3 research subagents + synthesis | wall s | 30.2 [25.6–35.5] | 44.5 [42.4–46.5] | 36.6 [31.8–48.2] |
| | n (timed) | 3 | 2 | 3 |
| | first output s | 2.7 [1.7–2.8] | 1.9 [1.9–1.9] | 2.0 [1.9–2.4] |
| | tokens k | 247 [207–249] | 244 [215–274] | 177 [176–184] |
| | cost at Haiku list $ | 0.0184 | 0.0173 | 0.0144 |
| | correct | 3/3 | 2/2 | 3/3 |
| t2 3 parallel bug fixes + npm test | wall s | 24.5 [22.3–24.8] | 33.8 [33.0–34.6] | 27.8 [25.0–30.6] |
| | n (timed) | 3 | 2 | 2 |
| | first output s | 2.6 [2.1–2.7] | 2.2 [1.9–2.4] | 2.3 [2.1–2.6] |
| | tokens k | 317 [307–342] | 414 [401–428] | 368 [346–389] |
| | cost at Haiku list $ | 0.0150 | 0.0181 | 0.0163 |
| | correct | 3/3 | 2/2 | 2/2 |
| t3 writer + reviewer | wall s | 40.8 [40.4–51.8] | 73.3 [62.6–84.1] | 46.3 [34.4–49.2] |
| | n (timed) | 3 | 2 | 3 |
| | first output s | 2.3 [2.2–3.3] | 2.8 [2.0–3.6] | 3.7 [3.1–3.7] |
| | tokens k | 377 [369–386] | 452 [393–512] | 201 [197–232] |
| | cost at Haiku list $ | 0.0174 | 0.0197 | 0.0123 |
| | correct | 3/3 | 2/2 | 3/3 |

Every timed and untimed answer, graded, is in [the per-run table](#every-run-graded) below.

## Where the seconds go now

On one clock from Enter (`phases.mjs`, timed runs, medians): the parent's first request until the first
subagent starts, the subagents (all waves, including the parent's turns between waves), and the last
report until the final answer.

| Arm, task | n | Enter → first subagent, s | Subagents running, s | Last subagent → answer, s | Wall, s |
|---|---|---|---|---|---|
| cc t1 | 3 | 4.8 | 21.3 | 3.5 | 30.2 |
| volt-r3p-base t1 | 2 | 10.3 | 26.4 | 7.8 | 44.5 |
| volt-r3q t1 | 3 | 8.1 | 23.7 | 5.9 | 36.6 |
| cc t2 | 3 | 6.4 | 12.5 | 3.8 | 24.5 |
| volt-r3p-base t2 | 2 | 11.7 | 16.6 | 5.5 | 33.8 |
| volt-r3q t2 | 2 | 10.0 | 12.8 | 5.0 | 27.8 |
| cc t3 | 3 | 5.7 | 21.9 | 16.9 | 40.8 |
| volt-r3p-base t3 | 2 | 20.8 | 49.8 | 2.7 | 73.3 |
| volt-r3q t3 | 3 | 7.0 | 28.6 | 3.5 | 46.3 |

What is still Volt's and what is the model's:

- **Volt's own overhead on the critical path** (`breakdown.mjs`: Enter → parent run.start, parent agent
  ready, child start gaps, child agent ready, report delivery) is now 0.3 / 3.5 / 2.3 / 2.4 s median on
  t0 / t1 / t2 / t3 (13 / 10 / 8 / 5 % of the wall time), against 0.6 / 5.5 / 3.5 / 1.2 s (23 / 12 / 10 /
  2 %) on the before build (timed runs, `breakdown.mjs --max-load 14`, n as in the headline table). The
  after build's t1 range runs to 12.6 s: in `volt-r3q-t1-1` the synthesis subagent's agent took 11.0 s to
  take its prompt; the other two t1 runs were 3.5 and 0.4 s. The t3 cells (0.7-3.8 s over both builds) are
  within run-to-run spread. The 3 s end gap below is not in these numbers: it falls inside the subagent's
  run, so `breakdown.mjs` counts it as model + tools. The rest is model requests and the tools the agents run.
- **The lead (Enter → first subagent) is still 1.3-3.6 s longer than Claude Code's.** In `volt-r3q-t1-3` the
  first token comes at 1.8 s, the parent writes for 5.2 s before the `delegate_task` call starts and
  2.0 s on its arguments (1.4 KB, all four tasks in one call); the subagents start 9.0 s after Enter.
  Claude Code's parent starts each Task as soon as that block is complete (400-byte briefs), the
  first at 4.8 s. Two causes, both on the model's clock but shaped by Volt: the parent prompt is
  larger (Volt 39-43k tokens per parent request vs Claude Code's 28.5-29k, `reqsize.mjs`), and one
  `delegate_task` call holds every task until the whole call is written.
- **The tail (last report → answer) is 1-2.5 s longer on t1/t2**: the parent's final request runs on
  the larger prompt. On t3 Volt is faster at the end (3.5 vs 16.9 s): Claude Code's parent re-checks the
  file itself after the reviewer approves.
- **A 3.0 s gap at the end of some editing subagents is back** (cause in "Not done"): 9 of 24 editing
  subagent runs on the after build in t2/t3 (7/18 in t2, 2/6 in t3) end 3.00-3.33 s after their turn,
  against 1 of 26 on the before build (0/18, 1/8) on the same rig (`endgaps.mjs`, all runs). It is not
  the overlay merge `dd1e73c3ed5` moved (no "sandbox state sync took" line in the agent server log).
  Each of those 10 runs, and none of the other 41 editing runs of both builds, has a `file.change`
  event in its trace: the wait is the new-errors check at the turn's end. The after build records a
  `file.change` in more of its editing runs (9 of 25 vs 1 of 26); why was not pinned.

Prompt size per model request (median over all requests of all runs, `reqsize.mjs`):

| Arm, task | Parent prompt per request (median) | Subagent prompt per request (median) | Requests counted |
|---|---|---|---|
| cc t0 | 24.5k | – | 4 / 0 |
| cc t1 | 29.0k | 18.3k | 12 / 15 |
| cc t2 | 28.5k | 20.5k | 15 / 43 |
| cc t3 | 28.6k | 19.2k | 38 / 41 |
| volt-r3p-base t0 | 35.5k | – | 11 / 0 |
| volt-r3p-base t1 | 40.6k | 11.3k | 34 / 74 |
| volt-r3p-base t2 | 43.4k | 19.7k | 60 / 120 |
| volt-r3p-base t3 | 41.2k | 16.4k | 64 / 118 |
| volt-r3q t0 | 37.6k | – | 8 / 0 |
| volt-r3q t1 | 42.6k | 11.1k | 12 / 46 |
| volt-r3q t2 | 42.1k | 19.5k | 38 / 132 |
| volt-r3q t3 | 39.1k | 16.9k | 36 / 70 |

## Which commits moved what

Per-fix measures from the saved Volt traces (`fixstats.mjs`, medians over every run of the arm,
including untimed runs, since none of these are timings of the machine):

| Arm | Task | n | Tool calls before delegating | delegate_task args, bytes | Enter → first subagent, s | Subagent run.end gap, s (max) | Warm subagent starts | Report chars | `after` refusals | tests-tool calls |
|---|---|---|---|---|---|---|---|---|---|---|
| volt-r3p-base | t1 | 5 | 1 (ToolSearch) | 2276 | 10.4 | – (0.0) | 5/20 | 949 | 0 | 0 |
| volt-r3p-base | t2 | 6 | 1 (ToolSearch) | 3343.5 | 14.1 | 0.1 (0.9) | 18/18 | 754 | 0 | 2 |
| volt-r3p-base | t3 | 6 | 1 (ToolSearch, Read File) | 2200 | 9.1 | 0.0 (3.0) | 10/16 | 1906 | 0 | 0 |
| volt-r3q | t1 | 3 | 0 | 1418 | 7.8 | 0.0 (0.0) | 11/12 | 534 | 0 | 0 |
| volt-r3q | t2 | 6 | 0 | 2424.5 | 10.1 | 0.0 (3.3) | 18/18 | 685.5 | 0 | 3 |
| volt-r3q | t3 | 6 | 0 | 1413 | 7.3 | 0.0 (3.1) | 12/12 | 897.5 | 0 | 0 |

| Commit | Change | Measured effect (before → after build, same rig) |
|---|---|---|
| `36f1ae13231` perf(orch): load delegate_task up front in top-level chats, with a short schema | `delegate_task`/`wait_tasks`/`message_task` always loaded for top-level Claude chats; schema and description cut | ToolSearch before delegating 1 → 0 calls per run; arguments 2.2-3.3 KB → 1.4-2.4 KB; Enter → first subagent t1 10.4 → 7.8 s, t2 14.1 → 10.1 s, t3 9.1 → 7.3 s (with `297eec9d1a3`/`3218fd2568e`) |
| `297eec9d1a3` perf(orch): warm read-only subagent spares when the request needs them | the request decides spare kind (read-only for "do not edit", one read-only next to editing spares for reviewer/researcher parts) | warm subagent starts t1 5/20 → 11/12, t3 10/16 → 12/12 |
| `3218fd2568e` perf(orch): warm subagent agents with the run when the request asks for subagents | warm at the parent's start, not when the call streams (the up-front tool removed the old trigger) | `volt-r3p` → `volt-r3q`: t2 child agent ready on the critical path 14.9 s → 0.1-0.6 s on a loaded run; every r3q subagent wave came from the pool except one t1 synthesis task |
| `f669d0d3b84` perf(orch): ask subagents for short reports | one-sentence outcome, a line per change, a one-line check, open issues only when there are some | report chars t1 949 → 534, t2 754 → 685.5, t3 1906 → 897.5 |
| `e37c9b9111d` fix(orch): a subagent's report is its final message | the parent gets the text after the last tool call, not the notes between calls | part of the report-size drop above; parent requests stay smaller (t3 tokens 452k → 201k) |
| `30b48880c1c` fix(orch): a single delegate_task call may name earlier tasks by position in after | `after: ["1"]` resolves against this chat's tasks | 0 refusals in both arms on this rig (models used one call); unit-tested |
| `4b4d30ad8f7` perf(orch): a Claude parent's wait for its tasks blocks up to 4 minutes | `wait_tasks` cap 45 s → 240 s for Claude parents | no t1-t3 wait here passes 45 s; matters for the C1-size builds; unit-tested |
| `dd1e73c3ed5` perf(acp): end a sandboxed turn before its config overlay merge | merge after run.end; next prompt waits for it | round-2 traces: 3.01 s in 9/9 t2 subagents. On this rig the before build's merge was already fast (no 3 s gap in any of its 25 editing runs without a `file.change`; `endgaps.mjs`), so no end-to-end gain is measurable here |
| `99caa947046` fix(acp): closing a session waits for its last turn's config overlay merge | dispose awaits the merge (≤3 s) | correctness follow-up to `dd1e73c3ed5`; unit-tested |
| `5b89794cc31` fix(ide): the tests tool says which test runs it does not cover | description names `node --test` and custom npm scripts as shell work | tests-tool calls in t2 did not go to zero (before: 2 calls over 6 runs, after: 3 over 6); the parent still tries it first in some runs |

## Every run, graded

Grades (`grades.mjs`): t0 the reply is OK; t1 Q1-Q3 right (the discount bug and its fix, the three import
edges, A1/C3 and true/false); t2 `npm test` 7/7 with only the three source files changed; t3 the
checker's 7/7 with the planted bug fixed and no stray file. **Q4 of t1 is shown apart**: it asks for
`checkout`'s result "using only the answers to Q1-Q3 (no file reads)", which those answers cannot settle.
Almost every answer in every arm says so and hedges; `score.mjs` only checks whether the hedge names
-9720 cents (1), -9000 (0.5) or neither (0). Volt after named -9720 in 3/3 and Claude Code never did, but
that is the synthesis subagent guessing further, not a better answer; two before-build Volt parents
broke the "no file reads" rule ("this comes from the file contents already in my context"). Q4 is
not counted as a win for anyone.

| Run | Load (1 min) | Timed | Wall s | Tokens k | Cost $ | Subagents | Correct | Grade detail |
|---|---|---|---|---|---|---|---|---|
| cc-t0-1 | 38.5 | no | 6.5 | 24 | 0.0027 | 0 | correct | OK |
| cc-t0-2 | 13.8 | yes | 3.2 | 24 | 0.0020 | 0 | correct | OK |
| cc-t0-3 | 11.1 | yes | 3.0 | 24 | 0.0021 | 0 | correct | OK |
| cc-t0-4 | 13.9 | yes | 3.4 | 24 | 0.0027 | 0 | correct | OK |
| volt-r3p-t0-1 | 30.8 | no | 4.4 | 39 | 0.0042 | 0 | correct | OK |
| volt-r3p-base-t0-1 | 28.5 | no | 5.2 | 38 | 0.0074 | 0 | correct | OK |
| volt-r3p-base-t0-2 | 13.0 | yes | 5.0 | 36 | 0.0039 | 0 | correct | OK |
| volt-r3p-base-t0-3 | 10.7 | yes | 4.3 | 37 | 0.0042 | 0 | correct | OK |
| volt-r3p-base-t0-4 | 16.2 | no | 7.5 | 37 | 0.0042 | 0 | correct | OK |
| volt-r3p-base-t0-5 | 18.5 | no | 7.0 | 35 | 0.0037 | 0 | correct | OK |
| volt-r3p-base-t0-6 | 9.1 | yes | 2.8 | 35 | 0.0037 | 0 | correct | OK |
| volt-r3q-t0-1 | 14.8 | no | 3.5 | 40 | 0.0042 | 0 | correct | OK |
| volt-r3q-t0-2 | 12.2 | yes | 8.1 | 39 | 0.0042 | 0 | correct | OK |
| volt-r3q-t0-3 | 11.6 | yes | 2.0 | 38 | 0.0040 | 0 | correct | OK |
| volt-r3q-t0-4 | 12.8 | yes | 3.0 | 40 | 0.0042 | 0 | correct | OK |
| cc-t1-1 | 16.1 | no | 26.3 | 225 | 0.0152 | 4 | correct | q1 1 · q2 1 · q3 1 · (q4 0) |
| cc-t1-2 | 12.8 | yes | 35.5 | 249 | 0.0158 | 4 | correct | q1 1 · q2 1 · q3 1 · (q4 0.5) |
| cc-t1-3 | 12.6 | yes | 25.6 | 247 | 0.0125 | 4 | correct | q1 1 · q2 1 · q3 1 · (q4 0.5) |
| cc-t1-4 | 13.6 | yes | 30.2 | 207 | 0.0140 | 4 | correct | q1 1 · q2 1 · q3 1 · (q4 0) |
| volt-r3p-t1-1 | 13.6 | yes | 38.2 | 184 | 0.0151 | 4 | correct | q1 1 · q2 1 · q3 1 · (q4 1) |
| volt-r3p-base-t1-1 | 15.4 | no | 58.9 | 207 | 0.0177 | 4 | correct | q1 1 · q2 1 · q3 1 · (q4 0.5) |
| volt-r3p-base-t1-2 | 12.9 | yes | 46.5 | 215 | 0.0165 | 4 | correct | q1 1 · q2 1 · q3 1 · (q4 1) |
| volt-r3p-base-t1-3 | 13.3 | yes | 42.4 | 274 | 0.0180 | 4 | correct | q1 1 · q2 1 · q3 1 · (q4 1) |
| volt-r3p-base-t1-4 | 15.4 | no | 38.6 | 202 | 0.0178 | 4 | correct | q1 1 · q2 1 · q3 1 · (q4 0.5) |
| volt-r3p-base-t1-5 | 16.9 | no | 44.2 | 259 | 0.0164 | 4 | correct | q1 1 · q2 1 · q3 1 · (q4 0) |
| volt-r3q-t1-1 | 13.0 | yes | 48.2 | 176 | 0.0135 | 4 | correct | q1 1 · q2 1 · q3 1 · (q4 1) |
| volt-r3q-t1-2 | 12.5 | yes | 36.6 | 177 | 0.0144 | 4 | correct | q1 1 · q2 1 · q3 1 · (q4 1) |
| volt-r3q-t1-3 | 13.7 | yes | 31.8 | 184 | 0.0150 | 4 | correct | q1 1 · q2 1 · q3 1 · (q4 1) |
| cc-t2-1 | 18.5 | no | 24.9 | 320 | 0.0153 | 3 | correct | 7/7 tests |
| cc-t2-2 | 16.3 | no | 23.0 | 343 | 0.0155 | 3 | correct | 7/7 tests |
| cc-t2-3 | 12.3 | yes | 24.8 | 342 | 0.0119 | 3 | correct | 7/7 tests |
| cc-t2-4 | 13.8 | yes | 22.3 | 307 | 0.0152 | 3 | correct | 7/7 tests |
| cc-t2-5 | 12.2 | yes | 24.5 | 317 | 0.0106 | 3 | correct | 7/7 tests |
| volt-r3p-t2-1 | 12.7 | yes | 69.8 | 351 | 0.0227 | 3 | correct | 7/7 tests |
| volt-r3p-base-t2-1 | 21.0 | no | 53.0 | 400 | 0.0205 | 3 | correct | 7/7 tests |
| volt-r3p-base-t2-2 | 12.1 | yes | 33.0 | 401 | 0.0181 | 3 | correct | 7/7 tests |
| volt-r3p-base-t2-3 | 18.7 | no | 28.1 | 513 | 0.0197 | 3 | correct | 7/7 tests |
| volt-r3p-base-t2-4 | 16.8 | no | 32.6 | 412 | 0.0240 | 3 | correct | 7/7 tests |
| volt-r3p-base-t2-5 | 9.0 | yes | 34.6 | 428 | 0.0180 | 3 | correct | 7/7 tests |
| volt-r3p-base-t2-6 | 14.7 | no | 33.6 | 347 | 0.0170 | 3 | correct | 7/7 tests |
| volt-r3q-t2-1 | 15.3 | no | 39.5 | 391 | 0.0172 | 3 | correct | 7/7 tests |
| volt-r3q-t2-2 | 18.1 | no | 22.9 | 347 | 0.0160 | 3 | correct | 7/7 tests |
| volt-r3q-t2-3 | 11.8 | yes | 30.6 | 389 | 0.0162 | 3 | correct | 7/7 tests |
| volt-r3q-t2-4 | 16.8 | no | 30.3 | 323 | 0.0213 | 3 | correct | 7/7 tests |
| volt-r3q-t2-5 | 12.3 | yes | 25.0 | 346 | 0.0164 | 3 | correct | 7/7 tests |
| volt-r3q-t2-6 | 22.4 | no | 34.8 | 328 | 0.0166 | 3 | correct | 7/7 tests |
| cc-t3-1 | 21.1 | no | 55.4 | 459 | 0.0171 | 3 | correct | 7/7, planted bug fixed |
| cc-t3-2 | 13.2 | yes | 51.8 | 386 | 0.0142 | 2 | correct | 7/7, planted bug fixed |
| cc-t3-3 | 16.4 | no | 37.6 | 311 | 0.0133 | 2 | correct | 7/7, planted bug fixed |
| cc-t3-4 | 11.8 | yes | 40.4 | 377 | 0.0159 | 3 | correct | 7/7, planted bug fixed |
| cc-t3-5 | 13.1 | yes | 40.8 | 369 | 0.0127 | 3 | correct | 7/7, planted bug fixed |
| volt-r3p-base-t3-1 | 14.9 | no | 61.9 | 495 | 0.0179 | 2 | correct | 7/7, planted bug fixed |
| volt-r3p-base-t3-2 | 82.3 | no | 92.4 | 493 | 0.0228 | 3 | correct | 7/7, planted bug fixed |
| volt-r3p-base-t3-4 | 14.1 | no | 59.2 | 294 | 0.0150 | 2 | correct | 7/7, planted bug fixed |
| volt-r3p-base-t3-5 | 11.6 | yes | 84.1 | 512 | 0.0229 | 3 | correct | 7/7, planted bug fixed |
| volt-r3p-base-t3-6 | 11.7 | yes | 62.6 | 393 | 0.0165 | 2 | correct | 7/7, planted bug fixed |
| volt-r3p-base-t3-7 | 15.4 | no | 60.7 | 258 | 0.0153 | 2 | correct | 7/7, planted bug fixed |
| volt-r3q-t3-1 | 14.1 | no | 53.5 | 243 | 0.0125 | 2 | correct | 7/7, planted bug fixed |
| volt-r3q-t3-2 | 18.0 | no | 41.1 | 206 | 0.0125 | 2 | correct | 7/7, planted bug fixed |
| volt-r3q-t3-3 | 22.6 | no | 40.2 | 224 | 0.0123 | 2 | correct | 7/7, planted bug fixed |
| volt-r3q-t3-4 | 9.7 | yes | 49.2 | 232 | 0.0130 | 2 | correct | 7/7, planted bug fixed |
| volt-r3q-t3-5 | 13.0 | yes | 46.3 | 201 | 0.0123 | 2 | correct | 7/7, planted bug fixed |
| volt-r3q-t3-6 | 11.3 | yes | 34.4 | 197 | 0.0114 | 2 | correct | 7/7, planted bug fixed |

| Arm, task | Correct / runs |
|---|---|
| cc t0 | 4 / 4 |
| volt-r3p t0 | 1 / 1 |
| volt-r3p-base t0 | 6 / 6 |
| volt-r3q t0 | 4 / 4 |
| cc t1 | 4 / 4 |
| volt-r3p t1 | 1 / 1 |
| volt-r3p-base t1 | 5 / 5 |
| volt-r3q t1 | 3 / 3 |
| cc t2 | 5 / 5 |
| volt-r3p t2 | 1 / 1 |
| volt-r3p-base t2 | 6 / 6 |
| volt-r3q t2 | 6 / 6 |
| cc t3 | 5 / 5 |
| volt-r3p-base t3 | 6 / 6 |
| volt-r3q t3 | 6 / 6 |

## Method

- **Fixtures**: `/tmp/v3orch/w/t0..t3`, made by `scripts/orch/cmp/mkfixtures.mjs` (round 2's generator);
  every run resets its folder with `git` first (`score.mjs resetFixture`).
- **Runners**: `runcli.mjs cc` (Claude Code), `runvolt.mjs run <arm>` (drives a Volt dev test instance
  over CDP: new chat, project chip set to the task folder, model Haiku 5.5, Full access, types the
  prompt; numbers from `<profile>/User/voltTraces` and the saved task tree). Before build: CDP 9981,
  profile `/tmp/v3-orch-base-ud`, checkout `volt-e3-orch-base`; after build: CDP 9955,
  `/tmp/v3-orch-ud`, this worktree.
- **Interleaving**: `bench.mjs` runs every arm once per task and rep, rotating the arm order per rep;
  before each run it waits for the 1-minute load to drop to 14 and records `uptime` in the row.
- **Project mode**: an earlier A/B (`data/orch/cmp/ab/`, arms `volt-r3-base`/`volt-r3`) ran Volt with
  "No Project": each send made a scratch folder, so the agent the composer warmed for the chat never
  matched and every parent started cold, while Claude Code ran in the task folder. Those runs are kept
  but not used for the headline; round 2's profile also had the folder as its project. In that data
  the after build was 35.7 vs 44.2 s (t1), 40.6 vs 50.1 s (t2), 59.7 vs 64.3 s (t3) against Claude Code's
  29.0/33.8/44.4 s (all loads), same direction as the headline.
- **Excluded/failed**: `volt-r3p-base-t3-3` failed in the runner (CDP `fetch failed` while the instance
  restarted, `failures.jsonl`) and has no row. The last fill reps (14:11-14:16 UTC) lost four runs in
  the runner, also without rows: `volt-r3q-t2-7` (runner stopped by SIGTERM after 3 s),
  `volt-r3p-base-t2-7` (runner hung 316 s and exited on an unsettled await), `volt-r3p-base-t1-6` ("no
  New Chat button") and `volt-r3p-base-t3-8` (the project menu listed the folder only as "t3"); they
  were not retried. Runs at load above 14 stay in `runs.jsonl` and in the
  graded table, marked untimed; they are left out of the medians.
- Round 2's medians (Claude Code 7.3/29.6/33.8/48.4 s, Volt 2.4/35.9/31.8/49.0 s) came from another day's
  machine state; this report compares only runs taken side by side today.

## Not done, and why

- **The 3 s end gap on editing subagents (root-caused, not fixed).** In every one of the 10 editing
  subagent runs (both Volt arms) whose trace has a `file.change` event the run ends 3.00-3.33 s after
  the turn, and in none of the 41 without one (`endgaps.mjs`). The chain:
  `file.change` → `noteAgentChange` fills `run.changedFiles` → at the turn's end `agentErrorGate`
  (`voltRuntimeService.ts`) asks code intelligence for new errors → `ServerCodeIntel.newErrors` →
  the window's `CodeIntelHost.freshen` opens the file and waits for a marker change, capped at
  `MARKER_WAIT_MS` = 3 s. No change comes: the test windows' TypeScript extension has no `out/`
  (`exthost.log`: "Skipping activation of 'vscode.typescript-language-features'"), and even with it a
  file that stays clean fires no marker event, so a user's window would wait the same 3 s on every
  clean edit of a diagnosed file. The fix belongs in `freshen` (stop waiting once the language
  service has answered for that version, or skip when no language service owns the file) and needs
  its own A/B; there was no time for it this round. Second finding on the same path: only 10 of 51
  editing runs produced a `file.change` at all (1 of 26 on the before build, 9 of 25 on the after
  build), so the new-errors check silently skips most CLI-agent edits; that is a change-capture bug
  to look at with it.
- **The lead and tail gaps vs Claude Code** (above): a smaller parent prompt (Volt sends 39-43k per
  parent request vs 29k) and starting each task as its part of the `delegate_task` call completes
  would be the next levers. Neither was attempted here; the tokens area (report 23) works on the prompt.
- **The `tests` tool is still tried first on `node --test` projects** in some t2 runs despite
  `5b89794cc31` (3 calls in 6 runs on the after build, 2 in 6 before); the description change was not
  enough.
- **ADEMark C1-style orchestrated build: not run for Volt.** The rig is committed
  (`scripts/orch/c1/`: arena from ADEMark's `arena/`, prompts, our own tests written from the task
  text, `grade.mjs`, runners for the CLI and Volt) with one Claude Code solo baseline
  (`data/orch/c1/c1-runs.jsonl`: Opus 5.5, 10.3 min, all five groups shipped and graded green,
  1.70M tokens, $1.89, taken at load 55, so untimed by the brief's gate). The Volt orchestrated
  run (Opus 5.5, up to 45 min) was not taken: the machine stayed above load 14 for most of the
  afternoon (up to 177 at 17:41), the short-task reps came first, and a single run at that load
  would not be a comparison. No C1 number is claimed.
- **Sample size.** Timed n is 3 per cell where the load allowed it; the n row of the headline table
  shows the cells with n = 2 (Volt before on t1-t3, Volt after on t2). Runs taken above the gate are
  kept, graded and listed, and point the same way.
- **Test windows lack built-in extension builds** (TypeScript, git, etc.: `out/` missing in both
  worktrees). That affects both Volt arms the same way, but it is why the code-intelligence wait above
  always runs to its cap here.

## Data

- Runs: [`data/orch/cmp/ab-project/runs.jsonl`](data/orch/cmp/ab-project/runs.jsonl) (headline),
  raw Claude Code streams and Volt traces in [`data/orch/cmp/ab-project/raw/`](data/orch/cmp/ab-project/raw/);
  the no-project A/B in [`data/orch/cmp/ab/`](data/orch/cmp/ab/); failures in
  [`data/orch/cmp/failures.jsonl`](data/orch/cmp/failures.jsonl).
- Scripts: [`scripts/orch/cmp/`](scripts/orch/cmp/) (`bench.mjs`, `runcli.mjs`, `runvolt.mjs`,
  `headline.mjs`, `analyze.mjs`, `phases.mjs`, `grades.mjs`, `fixstats.mjs`, `breakdown.mjs`,
  `endgaps.mjs`, `reqsize.mjs`, `tables.sh`), [`scripts/orch/tl.mjs`](scripts/orch/tl.mjs) (one run's
  timeline), [`scripts/orch/c1/`](scripts/orch/c1/).
- Tables: `zsh scripts/orch/cmp/tables.sh` prints every table and number in this report from
  `data/orch/cmp/ab-project/` (headline, phases, Volt overhead, end gaps, prompt size, per-fix measures,
  grades). More columns per arm and task:
  `node scripts/orch/cmp/analyze.mjs data/orch/cmp/ab-project/runs.jsonl --arms cc,volt-r3p-base,volt-r3q --max-load 14`.

## Appendix: where the seconds went before (round-2 traces, `scripts/orch/tl.mjs`)

Timelines of the round-2 `volt-final` runs on one clock (parent `P`, subagents `1..n`), read event by event;
this is what the fixes above went after.

| Where | t1 (research) | t2 (bug fixes) | t3 (writer + reviewer) | Whose |
|---|---|---|---|---|
| Parent loads `delegate_task` with ToolSearch first (a whole extra request on a 40k prompt) | 2.5-3.4 s | 2.3 s | 2.5-3.6 s | Volt (tool deferred) |
| Parent writes the `delegate_task` arguments (the schema asks for goal/scope/files/constraints/done_when per task; 2.5 KB of JSON) | 7.0 s (4.5 s thinking + 2.6 s JSON) | 4.8 s | 4.9 s | model, shaped by Volt's schema |
| Every editing (`work`) subagent's run ends 3.01 s after its last model event: `syncSandboxState` waits out its 3 s cap before `run.end` | - | 3.0 s per subagent (all 9 of 9) | 3.0 s per writer round (5 of 5) | Volt |
| Read-only subagents start cold (the warm-up made `work` spares) | 1.2-1.4 s (2 of 3 per wave) | - | 1.1-1.5 s per reviewer | Volt |
| A reviewer started in its own call with `after: ["1"]` was refused ("not a task of this chat"); the parent waited for the writer, then started the reviewer a turn later | - | - | 3.4 s + one parent request | Volt (argument handling) |
| The parent tries Volt's `tests` tool, which does not cover `node --test`, then runs `npm test` in the shell | - | 2.0 s + one request | - | Volt (tool description) |
| Reports: fixed four-heading format incl. "## Open issues: None", interim notes included | 0.5-1.4 KB | 0.6-0.9 KB | 1.3-3.4 KB (2-5 s of output) | model, shaped by Volt's report format |

Claude Code on t1 (`cc-t1-2`, round 2): its first parent request starts subagents 3.5 s after its first
token request, because its Agent tool is always loaded and each Agent call starts as soon as its block
is complete (400-byte briefs). Volt's parent reached the same point after 12.6 s.
