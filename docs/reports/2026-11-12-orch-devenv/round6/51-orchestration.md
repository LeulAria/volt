# 51 · Orchestration, round 6: C1 at Opus 5.5 medium, and ADEMark's reliability tests C2-C6

Branch `e6/orch` (worktree `volt-e5-orch`, base `7f07f73d677`), 2026-11-15. Round 5: [`../round5/41-orchestration.md`](../round5/41-orchestration.md).

Status: **final** (2026-11-15). C1 has n 1 per arm: the queue stopped at 97 % of the account's 7-day limit.

## Summary

- **C1 (n 1 per arm, Opus 5.5 medium):** every arm shipped 5/5.

  | Arm | Time | Tokens | Cost |
  |---|---|---|---|
  | Volt after | **2.58 min** | 842K | $1.56 |
  | Volt before | 2.69 min | 1,106K | $1.83 |
  | Claude Code alone | 3.72 min | 695K | $1.11 |

  The fix that gives subagents the user's request whole cut the subagents' tokens by 34 %. Against Claude Code
  alone, Volt is 31 % faster and uses 21 % more tokens. ADEMark's published leader, Synara, took 5.18 min and 2.03M
  tokens (high effort, other machine).
- **Reliability tests C2-C6 (our rigs, pass/fail):**
  - C2 message delivery: 0 of 3 follow-ups dropped, 3 of 3 applied.
  - C3 chat lock: 0 locks over 7 runs.
  - C4 agent killed: pass after fix 1 (resumed alone 11.1 s after the kill).
  - C5 network cut: pass after fix 1b (Claude Code's own retry carried the turn, resumed 7.2 s after the API came
    back).
  - C6 app restart: pass (resumed alone 16 s after the quit).
- **Fixes:**
  - An agent process lost mid-turn now restarts and retries instead of ending the turn as done.
  - Claude Code's own connection retry stays a notice.
  - A subagent gets the user's request whole.

## Method

- **Rig:** round 5's C1 rig copied to [`scripts/orch/c1/`](scripts/orch/c1/) with round-6 paths (`~/.volt-r6/orch/c1`, the
  timing lock `~/.volt-r6/timing.lock`, seeds `ademark-volt-r6-<id>`), plus a new reliability rig
  [`scripts/orch/crel/crel.mjs`](scripts/orch/crel/crel.mjs) for C2-C6 and the C3 probe, with its own hidden tests
  (`crel/tests/`: round 5's W1 and W3 tests, and new C2-F1/F2/F3 tests written from TASKS.md's "what each group
  asserts"). ADEMark's hidden tests are private, so every grade here is on our own tests.
- **Instance:** a dev build of this branch as a test instance (profile `~/.volt-r6/orch/ud`, CDP 9971), a clean Claude
  config dir (the live login's access token only, no connectors, skills or plugins), every model request through the
  capture proxy on 19972 (`ANTHROPIC_BASE_URL`), sandbox Off and Full access as in round 5. The before build is
  `volt-e5-base` (`7f07f73d677`, profile `~/.volt-r6/orch/ud-base`, CDP 9978).
- **Model:** Opus 5.5 at **medium** effort (the user's choice for this round; ADEMark's published runs use high) for
  the lead and every subagent, picked in the model picker ("Opus 5.5 Medium", the default effort of a new chat).
  Claude Code 2.1.322 inside the global `claude-agent-acp` 0.106.0 on PATH (no preload). The bare CLI arm runs
  `claude -p --effort medium`.
- **Faults (C4-C6), ours, not ADEMark's instruments:** C4 kills (`kill -9`) every process with basename `claude`
  whose cwd is the task clone (ADEMark's default agent executables; in Volt that is the Claude Code binary the
  adapter spawns, the adapter itself is `node`). C5 cuts the model API at the proxy for 30 s (in-flight streams cut,
  new connections reset), not with a `pf` anchor (root). C6 sends Cmd-Q, relaunches 5 s after the processes are gone
  and returns to the thread.
- **End rule (C2-C6):** the chat ran at least once, nothing is running or queued, every follow-up was sent and the
  recovery settled, and no model request for 60 s; cap 10 min (C2) / 15 min (C4-C6). Recovery: 60 s after the fault
  (after the API is back for C5) with no new model request from the chat, `continue` is sent once.
- **C3 probe:** one `z` typed as a key into the composer every 2 s, its echo timed on the DOM (the composer's
  rendered text shows it), deleted at once; paused 3 s around each follow-up and each fault. A lock is a probe with
  no echo within 2 s.
- **Load:** every C2-C6 row below was taken at a 1-minute load of 45-70 (other areas' minified builds); these are
  pass/fail rows, not timings. C1 rows are timings and wait for load 14 or less under the timing lock.

## Results

### C4 Agent Killed

| Run | Fault at | Load | Task first ended | Resumed alone | Survival (own W3 tests) | Note |
|---|---|---|---|---|---|---|
| crel-c4-1 | 90 s (ADEMark) | 51 | 59 s | no (idle agent killed) | partial | the task was done 31 s before the fault; "continue" at 152 s was answered |
| crel-c4-30s-1 | 30 s (ours) | 63 | 32.6 s (cut) | no | partial | before the fix: the turn ended "done" on "The connection to Claude was lost."; row marked invalid for a mis-attributed recovery |
| crel-c4-30s-3 | 30 s (ours) | 66 | 31.8 s (cut) | no | partial | first half of the fix only (session-update path); the adapter puts the failure on the prompt response |
| crel-c4-30s-4 | 30 s (ours) | 47 | 90.8 s (after the restart) | **yes, 11.1 s after the kill** | **pass** | both halves of the fix; "Restarting and retrying." shown |

(c4-30s-2 invalid: the agent server restarted mid-run from a source sync.)

A note on ADEMark's 90 s: Opus 5.5 at medium finishes the W3 task in Volt in 55-60 s (first run end 59-61 s in
the 90 s rows), so a fault at 90 s lands on an idle agent, the task is already done, and the harness's recovery
watch (no new model request within 60 s) sends `continue`, which the rubric counts as `partial`. The 30 s rows
are the real test of recovery; both are reported.

### C6 App Restart

| Run | Fault at | Load | App gone after Cmd-Q | Returned to thread | Resumed alone | Survival (own W3 tests) | Note |
|---|---|---|---|---|---|---|---|
| crel-c6-1 | 30 s | 33 | 10.5 s (the detached agent server was then force-killed by the rig) | yes (restored window) | **yes, 39 s after the quit** | pass by the rubric | the rig waited to its cap for a run.end the cut run never got (fixed; row annotated) |
| crel-c6-2 | 30 s | 26 | 1.3 s | yes (restored window) | **yes, 16 s after the quit** | **pass** (0.95 min) | agent server left alone, as it is designed to outlive the window |

What Volt showed after the relaunch (`data/orch/crel/shots/crel-c6-1-fault+10s.png`): the cut turn marked
"Interrupted" with its file changes kept, then "Continued after Volt restarted" and the agent running again.
No quit-confirmation dialog. The chat was reopened by the restored window itself (no click needed).

### C5 Network Cut

| Run | Cut at | Load | What happened during the cut | Resumed alone | Survival (own W3 tests) | Note |
|---|---|---|---|---|---|---|
| crel-c5-1 | 30 s, 30 s long | 27 | Claude Code's own retry ("Reconnecting to Claude, attempt 1 of 10.") was taken for a lost process by fix 1: the turn failed at 37.8 s, Volt's keep-working rescue restarted the chat at 49 s into the same cut; it resumed 28.7 s after the API came back | yes | pass (2.33 min) | invalid for the method: the regression (fixed, `cfd99bbe1fc`) did the recovering, not the CLI's retry |
| crel-c5-2 | 30 s, 30 s long | 21 | Claude Code retried on its own ("Reconnecting to Claude, attempt 1-6 of 10", shown as notices; the turn stayed open) | **yes, 7.2 s after the API came back** | **pass** (1.8 min) | fix 1b in: no restart, the CLI's own retry carried the turn |

The proxy's cut: 91 requests refused in the 30 s, 88 of them in one burst at +7-9 s (the composer predictor's
Haiku calls and Claude Code's `/api/hello` connectivity checks and retries), one in-flight Opus stream cut.

### C2 Message Delivery

One run (crel-c2-1, load 15, 1.92 min to the end of the last queued turn).

| Follow-up | Sent at | Accepted (on screen within 5 s) | Queued state shown | Delivered (in a later model request) | Applied (own test) |
|---|---|---|---|---|---|
| F1 (RATE_LIMIT_RPS) | 30.2 s (+0.5 s) | yes | yes ("1 Queued Message" card) | yes | yes |
| F2 (x-request-id) | 90.2 s (+1.1 s) | yes | no card: the agent was idle, it was sent at once | yes | yes (after an own-test fix: the 405 check ran on an empty 1-token bucket) |
| F3 (dueOn) | 150.1 s (+0.5 s) | yes | no card (idle) | yes | yes |

**Dropped 0/3, applied 3/3.** The base task ended at 53 s; F1 was queued behind it and started at 53.5 s; F2 and F3
each landed on an idle chat and ran at once (89.6-113.9 s, 149.3-157.7 s). Enter queues behind a running agent in
Volt (Cmd-Enter steers it); ADEMark sends with Enter. The C1 W1 tests also run on this clone: they fail on two
checks the C2 prompt never asks for (`x-ratelimit-remaining`, `RangeError` on a bad cost); W1 is not a C2 value.

### C3 Chat Lock

The probe ran through every C2 and C4-C6 run above (one key every 2 s, 47-398 probes per run, 7 runs): **0 lost
probes, 0 locks**, echo median 0 ms, p95 1-3 ms (DOM echo on a dev build at load 15-66). The composer never
refused a key, not during streaming, the kills, the API cut, nor right after the relaunch.

### C1 Orchestrated Build

Opus 5.5 at medium effort, every request through the capture proxy, graded on our own copies of the hidden tests
(ADEMark's are private). The queue was planned as 3 Volt after runs, 1 before run and 1 Claude Code solo; it got
1 valid run per arm (n 1 each):

| Run | Build | Load | Shipped | Time | Tokens | Cost |
|---|---|---|---|---|---|---|
| volt-r6-4 | after (this branch, dev) | 11.2 | 5/5 | **2.58 min** | **842K** | $1.56 |
| volt-r6-base-2 | before (`7f07f73d677`, dev) | 4.3 | 5/5 | 2.69 min | 1,106K | $1.83 |
| cli-solo-2 | Claude Code 2.1.322 alone (`claude -p --effort medium`) | 6.2 | 5/5 | 3.72 min | 695K | $1.11 |
| ADEMark v1: Synara (leader) | other machine, Opus 5.5 high | | 5/5 | 5.18 min | 2.03M | |
| ADEMark v1: Claude Code solo | other machine, Opus 5.5 high | | | 7.3 min | 1.65M | |

Where the after run saved against the before run (`node scripts/orch/c1/analyze.mjs <id>`):
- **Subagents used 34 % fewer tokens:** 473K for the four together, against 722K. They made fewer requests
  (5, 5, 6 and 8, against 9, 7, 7 and 8), and their prompts were smaller (median 17.8-21.4K, against 22.0-22.8K).
  The lead's own tokens hardly moved (362K, against 378K).
- **Delegation was 6 s shorter:** from the first `delegate_task` to the last brief took 30 s, against 37 s. The
  briefs were 1.9-2.7K characters, against 1.9-3.6K. The last worker started at 39.5 s, against 45.3 s.
- **The tail grew:** after the last worker ended, the lead worked 38.8 s, against 32.2 s. Its `wait_tasks` returned
  when the last worker ended (116 s; 129 s before), so the lead merged nothing while the others ran.

**Against Claude Code alone, Volt was 31 % faster (2.58 against 3.72 min), but used 21 % more tokens and cost 41 %
more.** Four subagents each re-read the code their part needs, and a cached prompt costs every subagent its own
cache write (105K of cache writes in Volt, against 57K solo).

Runs that do not count:
- **Invalid, refused by the API:** volt-r6-1 to -3, volt-r6-base-1 and cli-solo-1. All five ran overnight on an
  expired copy of the access token. They are kept in `data/orch/c1/invalid-401/`.
- **Never started:** volt-r6-5. The after instance's window was gone when the queue reached it after 93 minutes of
  waiting for the timing lock (`ECONNREFUSED` on CDP 9971). It used no tokens.
- **Not run:** volt-r6-6. The queue stopped itself before it because the account reached 97 % of its 7-day limit
  (overage is off).

Raw: `data/orch/c1/c1-runs.jsonl`, `<id>.grade.json`, `<id>.capture.jsonl.gz`, `<id>.traces.json.gz`.

## Fixes

### 1. An agent process lost mid-turn fails the turn and restarts the agent (`8a29df5e081`, `ee30c4ec846`)

Cause: `claude-agent-acp` reports a killed or crashed Claude process as a `transport_lost` session failure
(category `connection`, action `new_session`) in the `_meta` of the prompt response (or of a session update when no
turn is active), and the prompt response otherwise reads as a normal end of turn. Volt showed the notice ("The
connection to Claude was lost.") and ended the run as `done`: the chat sat idle on a half-done task, the keep-working
rescue had nothing to restart, and ADEMark's harness would send `continue` after 60 s (Survival `partial`).
Change: `acpNotices.ts` keeps the failure's class and actions on the notice; `acpProvider.ts` ends the turn as a
dead process does (`ACP session is not running: …`, retryable and restartable) when a connection failure arrives
on the prompt response or a session update mid-turn, so the runtime restarts the agent and sends the prompt again
(the existing "Agent process died. Restarting and retrying." path). Service failures (overloaded, rate limited)
stay notices. Tests: `acpProvider.test.ts` (three cases), `acpNotices.test.ts`.
Numbers: C4 at 30 s, resumed alone 11.1 s after the kill (run 4) against never (runs 1 and 3).

### 1b. A connection retry in progress stays a notice (`cfd99bbe1fc`)

Cause: the adapter reports the CLI's own API retries as `transport_lost` too, at severity `warning`
("Reconnecting to Claude, attempt 1 of 10."); fix 1 took that for a dead process, failed the turn and restarted
the agent into the same outage (C5 run 1: the chat recovered, but by Volt's rescue, with the CLI's retry thrown
away). Change: a lost process is category `connection` at severity `error` (`isLostAgentProcess`); a warning is a
notice only. Test: `acpProvider.test.ts` (api_retry case). Numbers: C5 run 2.

### 2. A subagent gets the user's request whole; the lead names its part (`cc524a5b90b`)

Cause: the brief-level capsule (the default) clipped the user's request at 1,500 characters, so a C1 lead rewrote
every item's spec into its brief: 2.7-4.5K characters per `delegate_task` call, 9-14 s each, one after another, 47 s
from the first call to the last worker's start (round 5's run). Change: the capsule carries the request up to 6,000
characters (9,000 in all), and `delegate_task`'s description says the subagent has it ("for a part the request
spells out, name it and add only what you found"). `wait_tasks`'s description says what `any=true` buys (merge or
check each report while the rest run): round 5's lead waited for all four and merged nothing for the 50-70 s between
the first report and the last. Cost: +42 tokens on every top-level request (the three always-loaded tool texts are
2.1 KB, cap raised from 2.0 to 2.1 KB in the test), and up to +1.1K cached tokens per subagent request when the
user's request is that long. Numbers (C1, n 1 per arm): subagents' tokens 722K -> 473K, first to last brief
37 -> 30 s, run 1,106K -> 842K tokens and 2.69 -> 2.58 min.

## Not done, and why

- **C1 is n 1 per arm, not 3.** The overnight runs were refused (an expired token copy), one run found its test
  window gone, and the queue stopped itself at 97 % of the account's 7-day limit, as designed: at 100 %, every
  Claude client of the account stops until the reset (Wed Nov 18 17:00). The remaining runs wait for the reset.
- **Volt's token cost against Claude Code alone** (+21 %) is not fixed. The levers are: subagents that inherit
  the lead's file reads instead of re-reading them, fewer subagents for a 4-part task of this size, and an earlier
  merge (`any=true`). Each one trades against C1 time, which is where Volt leads.
- **C2-C6 ran at load 21-66.** They are pass/fail rows, not timings. ADEMark has not run them on its own machine
  yet.
- Written by the coordinator from the agent's committed rows after the agent stopped (2026-11-15 11:30). The rig's
  leftovers are gone: the proxy on 19972 is stopped, and the 24 worktrees of the test repos are removed.
