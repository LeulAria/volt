# Orchestrator review: delegate_task, subagents and wake-ups

Branch `e2e/orch` (from `feat/orch-and-devenv-revamp`), 2026-11-12. Everything below was measured
on this branch; numbers come from the files in [`data/orch/`](data/orch/). Nothing here was
estimated unless it says so.

## Summary

- **Volt's own orchestration overhead was already small and is now smaller.** Before the fixes,
  the work Volt does around a subagent took 5 to 11 ms per step (p50, on disk). After them it
  takes 5 to 10 ms. The big gains are in fan-out: a `delegate_task` call with 20 parts now
  saves the tree in **2 writes instead of 20** and **161 KB instead of 2.9 MB**, and all 20
  children start in **17 ms instead of 128 ms (7.4x faster)**.
- **The parts of one `delegate_task` call now wake the parent once, not once per part.** In
  a live run, three parts woke the parent three times. Those wake-ups took 20.7 s of parent turn
  time and cost $0.13. In the bench, the parent now gets 1 wake-up instead of 3, and the wake
  prompts are 38% shorter in total. In one live run after the fix (n=1), the same request took
  2 parent turns instead of 4, 54.1 s instead of 61.1 s, and $0.42 instead of $0.51.
- **Live stalls are fixed.** Before the fix, two of three Haiku subagents under a Full access
  parent waited more than 10 minutes for an approval nobody saw. After the fix, the same request
  finished in 61 s, all tests passed and the review found both planted bugs.
- **The 10x goal was not reached end to end.** A live request takes 40 to 60 s, and almost all
  of that is model time. Volt's overhead is milliseconds. On the same tasks, Volt was about as
  fast as headless Claude Code with its own subagents but cost 2.5x to 4x more. One measured
  cause is context: Volt's first request is 35.3 to 36.8k tokens, Claude Code's is 17.5 to
  18.1k. Hermes was not run (see [Hermes](#hermes)).

## Method

### 1. Model-free bench (`scripts/volt-e2e/orch/bench.mjs`)

The bench loads the real decider and `AgentOrchestratorService` from `out/` in plain Node, the
way the agent server does. It uses a fake runtime and turn host that answer at once, so every
millisecond it measures is Volt's own: durable saves, promise hops and CPU. It runs on a real
disk store (`--store disk`) and on an in-memory store (`--store memory`). Each scenario runs 30
times; fan-out and chains run 10 times. The table shows p50 values. p90 and the means are in
the JSON files.

Scenarios: submit to turn start; `delegate_task` to the child's first turn; child end to parent
wake-up; `wait_tasks` return; fan-out of 5/10/20 parts in one call; a 5-step `after` chain; and
(new in the final run) three parts that finish 25 ms apart, started either with one call or with
three calls. It also measures the size of every tool schema an agent receives, the child brief,
the report and the wake prompt.

The machine was busy during the runs (load average 17 to 23), so timings under 1 ms and
differences of a few ms are noise. Write counts, bytes, wake-up counts and character counts are
deterministic.

| File | Code |
|---|---|
| `bench-0-baseline-{disk,memory}.json` | `feat/orch-and-devenv-revamp` before any fix |
| `bench-1-coalesce-{disk,memory}.json` | after `84e2ed6174c` (coalesced saves) |
| `bench-final-{disk,memory}.json` | after `9dd62762a4f` (all fixes) |

Compare two files with `node scripts/volt-e2e/orch/compare.mjs a.json b.json --md`.

### 2. Live runs in a test instance

The test instance was a visible Volt window (CDP port 9971, fresh profile `/tmp/ve-orch`) with
a throwaway repo, `/tmp/volt-e2e/orch/runs/repo`. The repo has three small modules and their
tests, and `src/c.js` has two planted bugs: `page()` treats a 1-based page number as 0-based,
and `pageCount()` uses `floor` instead of `ceil`. `scripts/volt-e2e/orch/runVolt.mjs` resets the
repo, opens a new chat, switches it to Full access, sends the prompt, waits until the chat tree
is idle, then runs `npm test`. `analyzeVolt.mjs` reads the chat's trace and saved tree. The
prompts are in [`data/orch/live/`](data/orch/live/):

- **a**: three parallel parts (validation in `a.js` with tests, tests for `b.js`, a read-only
  review of `c.js`), then `npm test` and a summary.
- **av**: the same as **a**, but it asks for Volt's `delegate_task` with Haiku 4.5 subagents.
  (Prompt **a** lets Claude Code use its own Task subagents inside Volt.)
- **b**: two subagents in sequence, a spec and then a fix.
- **c**: two independent opinions, from Sonnet and from Haiku.

The parent model was Claude Sonnet 5.5 through Volt's Claude Code (ACP) provider.
`runClaudeCode.mjs` runs the same prompts in headless `claude -p` (Sonnet 5.5) with an empty MCP
config and project settings only, and uses Claude Code's own Task subagents.

Cost is the cost Claude Code reports. Claude's cost is cumulative per session, so
`analyzeVolt.mjs` now adds each run's growth (fixed in this review). The first version summed
each run's last value, which counted a four-turn parent at $1.25 instead of $0.51.

## Before and after: model-free bench (disk store, p50)

| Metric | Baseline | After coalesce `84e2ed6` | Final `9dd6276` | Baseline / final |
|---|---|---|---|---|
| Submit to turn start (ms) | 11.07 | 22.54 | 9.76 | 1.13x |
| `delegate_task` to child's first turn (ms) | 7.14 | 7.04 | 5.07 | 1.41x |
| Bytes written for one `delegate_task` | 15,076 | 9,064 | 9,064 | 1.66x |
| Child end to parent wake-up (ms) | 8.47 | 6.95 | 5.74 | 1.48x |
| Bytes written for one wake-up | 12,513 | 8,135 | 8,135 | 1.54x |
| `wait_tasks` returns after child end (ms) | 5.65 | 7.14 | 5.44 | 1.04x |
| Fan-out 5: all children started (ms) | 32.5 | 13.8 | 11.8 | 2.75x |
| Fan-out 5: writes / KB written | 5 / 201.8 | 2 / 45.6 | 2 / 46.1 | 2.5x / 4.4x |
| Fan-out 10: all children started (ms) | 69.9 | 15.1 | 13.4 | 5.23x |
| Fan-out 10: writes / KB written | 10 / 749.0 | 2 / 82.9 | 2 / 84.0 | 5x / 8.9x |
| Fan-out 20: all children started (ms) | 127.7 | 15.7 | 17.2 | 7.40x |
| Fan-out 20: writes / KB written | 20 / 2,936 | 2 / 158.8 | 2 / 160.8 | 10x / 18.3x |
| Fan-out 20: time spent writing (ms) | 123.8 | 13.8 | 15.9 | 7.78x |
| Fan-out 20: all done to wake-up (ms) | 21.7 | 7.5 | 9.4 | 2.31x |
| `after` chain: one hop, end to next start (ms) | 10.7 | 7.2 | 7.8 | 1.37x |

The 22.5 ms "after coalesce" submit time is noise. The final run on the same code path measured
9.8 ms. On the in-memory store every step takes under 1 ms (p50) before and after. For example,
fan-out 20 starts every child in 7.1 ms before and 2.3 ms after, so on disk the time is almost
all file writes.

**Parts of one call report together** (`staggered3_*` in `bench-final-*.json`, n=10). Before
`9dd6276`, a `tasks` call delivered its reports the way three separate calls still do:

| Three parts, finishing 25 ms apart | Three calls (old behaviour) | One call (now) |
|---|---|---|
| Parent wake-ups | 3 | 1 |
| Wake prompt characters, all wake-ups | 2,114 | 1,316 |
| First wake-up comes after the last part finished | 0 of 10 runs | 10 of 10 runs |

In the fan-out rows, the wake prompt grew from 867 to 2,231 characters (5 parts) and from 1,448
to 7,778 (20 parts). That growth is expected. The fan-out scenario never ends the parent's
wake-up turn, so it only counts the first wake-up. Before the fix, that wake-up carried one
report plus a list of the parts still running. Now it carries every report, shortened. The
baseline's "1 wake-up" therefore hid the later wake-ups.

**Token overhead** (characters / 4, from the same files):

| What an agent reads | Baseline | Final |
|---|---|---|
| `delegate_task` description and schema | ~2,381 tokens | ~2,404 tokens (+23: the sentence that says parts report together) |
| The 7 task tools (`delegate_task` ... `orchestrator_capabilities`) | ~3,125 | ~3,149 |
| All 111 static Volt host tools | ~30,947 | ~30,971 |
| Child brief for a one-line task with a contract | 3,259 chars | 3,259 chars |
| Wake prompt for one 245-char report | 684 chars | 684 chars |

In live runs, Claude Code loads Volt's MCP tools lazily (Tool Search), so the parent does not
pay for all 111 tool schemas up front. Its first request was still 35.3 to 36.8k tokens.

## Live runs

All numbers come from [`data/orch/live/volt-runs.jsonl`](data/orch/live/volt-runs.jsonl) and
[`claude-code-runs.jsonl`](data/orch/live/claude-code-runs.jsonl). Medians are in brackets.
"Last child to end" is the time from the last subagent finishing to the parent's final answer.
For Claude Code it runs to the end of the `claude -p` process.

| Run | n | Wall (s) | First subagent (s) | Last child to end (s) | Parent turns | Cost (USD) | Parent's first context (tokens) | Tests |
|---|---|---|---|---|---|---|---|---|
| **a**, headless Claude Code, Task subagents | 3 | 39.4 / 40.4 / 56.4 [40.4] | 3.8 / 4.9 / 6.2 [4.9] | 32.7 / 33.0 / 47.8 [33.0] | 1 process | 0.164 / 0.170 / 0.199 [0.170] | 17,461 (last run) | 18, 18, 19 pass, 0 fail |
| **a**, Volt, Claude Code's own Task subagents | 5 | 42.6 to 59.5 [46.5] | 5.7 to 13.1 [8.8] | 10.9 to 21.2 [14.4] | 1 | 0.512 to 0.692 [0.564] | 35,488 to 36,059 | not recorded |
| **av**, Volt `delegate_task`, before `1b1d084` | 1 | did not finish; stopped by hand at 680 s | 17.3 | n/a | 2 | 0.397 up to the stop | 36,002 | n/a |
| **av**, Volt `delegate_task`, after `1b1d084` | 1 | 61.1 | 12.0 | 16.0 | 4 | 0.512 (parent 0.334, 3 children 0.178) | 35,975 | 34 pass, 0 fail; both bugs found |
| **av**, Volt `delegate_task`, after `9dd6276` (final) | 1 | 54.1 | 8.2 | 10.1 | 2 | 0.423 (parent 0.237, 3 children 0.186) | 35,656 | 21 pass, 0 fail; both bugs found |
| **b**, headless Claude Code | 1 | 64.6 | 8.6 | 12.4 | 1 process | 0.148 | 18,135 | 10 pass |
| **b**, Volt, Task subagents | 2 | 40.5 / 46.8 | 6.0 / 7.2 | 8.5 / 7.8 | 1 | 0.463 / 0.371 | 36,839 / 36,823 | not recorded |
| **c**, headless Claude Code | 1 | 37.9 | 12.8 | 23.1 | 1 process | 0.067 | 18,058 | no changes (read-only) |
| **c**, Volt, Task subagents | 2 | 20.4 / 31.7 | 9.0 / 11.8 | 0.7 / 6.0 | 1 | 0.290 / 0.256 | 35,752 / 35,731 | 2 pass, no changes |

The **av** runs drive Volt's own orchestrator. The **a/b/c** runs in Volt use Claude Code's
built-in Task tool inside Volt, which Volt tracks as harness subagents.

What the **av** traces show:

- **Before `1b1d084`.** The Haiku subagents ran on the default Supervised mode under a Full
  access parent. Two of the three stopped at their first edit, waiting for an approval in chats
  the user was not looking at ("2 subagents running · 2 needs you", see
  `img/orch-subagents-stuck-on-approval-before.png`). The review part finished in 24 s. The
  other two waited until they were stopped at 680 s. The parent also lost a call: Claude wrote
  "Claude Haiku 4.5", which matched no catalog entry, so it called `delegate_task` again and
  then `list_models`.
- **After `1b1d084`.** All three parts started at 12.0 s and finished in 22.7, 32.1 and 33.0 s.
  The parent's first turn spent 5.9 s on one detour. Claude Code had not loaded the
  `delegate_task` schema yet (Tool Search), so its first call came with no arguments and was
  refused. It then ran `ToolSearch` and made the real call. **This is not fixed** (see
  [Follow-ups](#follow-ups)).
- **Wake-ups, after `1b1d084` and before `9dd6276`.** The parent was woken three times, at
  34.7, 44.2 and 50.6 s. The first two wake-ups each read one report's file and ended with
  "waiting on the other tasks". The three turns took 5.1 + 5.6 + 10.0 s and $0.129 (the
  parent's cumulative cost went from $0.205 to $0.334). `9dd6276` turns this into one wake-up.
- **After `9dd6276`.** All three parts carried one batch id. They finished at 24.3, 29.2 and
  44.0 s, and the parent was woken once, at 44.0 s, with all three reports. That one wake-up
  checked the files, ran `npm test` and answered in 9.8 s. This time the first `delegate_task`
  call succeeded, so there was no Tool Search detour and the first subagent started at 8.2 s.
  Some of the 7 s drop in wall time therefore comes from that, not from batching. With n=1 per
  version, run-to-run variance is not known.

### Approvals in Supervised mode

The first pilot runs used the default Supervised mode, with nobody approving. Prompt **a** took
220.9 s with 5 approval prompts, and prompt **b** took 294.7 s with 2. With Full access, the same
prompts took 42.6 s and 40.5 s. The drivers then switched every chat to Full access, so the runs
measure orchestration and not waiting for a person. While doing that, they found a UI bug: on a
new chat, the access chip kept reading Supervised after you picked Full access
(`img/orch-access-chip-stale-before.png`). `7721a5a` fixes it.

## Fixes (on `e2e/orch`)

| Commit | Problem it solved |
|---|---|
| `3ef590b6` test: deterministic orchestrator micro-bench | There was no repeatable way to measure Volt's orchestration overhead without models. |
| `84e2ed61` perf: coalesce tree saves; keep audit prompts short | Each command rewrote the whole tree file, one write after another. A 20-part `delegate_task` made 20 serial writes of a growing file (2.9 MB, 128 ms before the last child started), and the saved audit trail stored each framed brief twice. Now it makes 2 writes (161 KB) and all children start in 17 ms. |
| `1b1d0840` fix: delegated subagents run without avoidable stalls | Subagents ran on Supervised under a Full access parent and waited 10+ minutes for an unseen approval; they now take the parent's access mode before every turn. Claude Code's Agent-tool argument names (`prompt`, `description`) were refused; they are now accepted. Names like "Claude Haiku 4.5" did not match the catalog label "Haiku 4.5"; matching is now by words, and a refusal lists the models. Task titles no longer start with "In /private/tmp/...". |
| `7f7cc29b` perf: no title generation for subagent chats | Each subagent's first turn also started a title call (a `claude -p` or `codex exec` process), for a chat the orchestrator already names after its task. Not measured separately. |
| `7721a5a3` fix: the access picker shows a chat's new mode at once | On the agent server, a chat's access mode arrives in its session summary, which did not fire `onDidChangeAccess`, so the chip stayed on Supervised. |
| `b44ec787` test: live-run drivers | `runVolt.mjs` (Volt over CDP), `runClaudeCode.mjs` (headless Claude Code), `analyzeVolt.mjs` and `claudeTranscriptTokens.mjs`. |
| `9dd62762` perf: the parts of one `delegate_task` call report together | A `tasks` or `models` call woke the parent once per part (3 wake-ups, 20.7 s and $0.13 in the live run). Each part now carries the call's batch id, saved with the tree. Reports are delivered once no part of the batch is queued or running, and a part waiting for the user does not hold the others back. Tests: `orchestratorDelegation.test.ts` (two cases, including save and load) and `agentOrchestratorService.test.ts` (one wake-up with both reports). Live afterwards: 1 wake-up, 2 parent turns instead of 4. |
| (this commit) | `analyzeVolt.mjs` counted Claude's cumulative session cost once per run and missed later runs' tokens. The bench gained the staggered-parts scenario. Final data and this report. |

Checks on the final code: `tsgo --noEmit` is clean. The orchestration suites
(`test/common/orchestration/*` and `agentOrchestratorService.test.ts`) all pass, 170 tests.
`orchestratorChaos` passes with `VOLT_CHAOS_SCALE=25`.

## Compared with other harnesses

**Claude Code's own subagents (headless `claude -p`, same prompts and repo, Sonnet 5.5).**

- **Speed.** Wall time is about the same. On prompt **a**, the median was 40.4 s for Claude
  Code and 46.5 s for Volt running Claude Code's Task subagents. Volt's own `delegate_task`
  took 61.1 s before the batch fix (5.9 s of it the deferred-schema detour) and 54.1 s after it
  (n=1 each). Claude Code started its first subagent sooner (median 4.9 s, against 8.8 s for
  Volt with Task subagents and 8.2 to 12.0 s with `delegate_task`). Its time from the last
  subagent to the end was longer (median 33.0 s against 14.4 s, and 10.1 s for the final
  `delegate_task` run), so neither harness was clearly faster.
- **Cost.** Volt cost about 2.5x to 4x more for the same work: on **a**, $0.56 median with
  Task subagents and $0.42 with the final `delegate_task`, against $0.17; on **b**, $0.37 to
  $0.46 against $0.15; on **c**, $0.26 to $0.29 against $0.07. The measured
  difference is the parent's first request: 35.3 to 36.8k tokens in Volt against 17.5 to 18.1k
  in headless Claude Code. Subagents differ the same way: a Volt subagent (Haiku through Claude
  Code) starts at 27.8 to 28.4k tokens, and a Claude Code Task subagent at 7.9 to 10.3k.
- **Caveat.** The headless runs used an empty MCP config and project settings only, so they are
  a lean baseline. Some of the gap is Volt's tools, workspace context and sandbox rules. How much
  each one costs was not broken down.
- **Correctness.** Every run that recorded `npm test` passed. The **av** run found both planted
  bugs.

### Hermes

**Hermes Agent (NousResearch) was not run.** Its source was cloned to
`/tmp/volt-e2e/orch/hermes-src`, but it was never installed and no task was run with it, so there
are no Hermes numbers. From its source only (not measured): `tools/async_delegation.py` runs
subagents on a persistent thread pool (3 async children by default), records each dispatch and
completion in SQLite, and replays undelivered completions after a restart. That is the same
durability model as Volt's saved task tree with `delivery: pending`.

## Why there is no 10x

1. **Model time dominates.** In the **av** run, the parent's first turn took 13.7 s, the Haiku
   subagents took 22.7 to 33.0 s, and each wake-up turn took 5 to 10 s. Volt's own work, from
   delegate to child start and from child end to wake-up, takes 5 to 10 ms on disk. Making that
   10x faster again would save less than 0.1 s of a 60 s request.
2. **The large ratios are in the parts that scale.** Fan-out 20 makes 10x fewer writes, writes
   18x fewer bytes and starts all children 7.4x faster. Parts of one call now cost one wake-up
   instead of N. Those gains matter for wide fan-outs and long runs, but they are milliseconds
   per request.
3. **What would move live numbers is turns and tokens, and only part of that is done.** Wake-up
   batching removes N-1 parent turns per call. In the live run it cut the parent from 4 turns to
   2 and its cost from $0.334 to $0.237. The deferred-schema detour (5.9 s when it happens) and
   the doubled first-request context (about 2x tokens, 2.5x to 4x cost compared with headless
   Claude Code) are not fixed.

## Follow-ups

- **Deferred `delegate_task` schema.** Claude Code defers MCP tools behind Tool Search, so
  Claude's first `delegate_task` call has no arguments, is refused, and is followed by
  `ToolSearch` (5.9 s and one extra round trip in the **av** run). Options: have Claude Code load
  the orchestration tools up front for chats that delegate, or return the parameter list in the
  refusal so the next call succeeds without `ToolSearch`.
- **Context size.** Break down Volt's ~36k-token first request (system prompt, workspace block,
  MCP tool stubs, sandbox rules) against headless Claude Code's ~18k, and the subagents' ~28k
  against 7.9 to 10.3k. This is where the 2.5x to 4x cost gap is.
- **Sandbox denials.** Every live Volt run logged 12 to 31 `sandbox.denial` events, even under
  Full access. They did not fail any run, but they were not investigated.
- **Re-measure live at n≥3** for the **av**, **b** and **c** prompts with `delegate_task`. The
  live `delegate_task` rows here are n=1.
- **Hermes.** Install it in a temp venv under `/tmp/volt-e2e/orch/` and run prompts a/b/c with
  `runClaudeCode.mjs`-style timing, so there are measured numbers instead of a design note.
