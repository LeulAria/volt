# Round 4: Enter to first word (ADEMark A4)

Status: final (2026-11-14). Branch `e4/firstword`, worktree `volt-e4-firstword`. ADEMark method, unofficial.

## Summary

Target: Enter to first word below Diri's 256 ms (ADEMark A4, Haiku 5.5 through Claude Code's ACP adapter against
ADEMark's replay server); round 3 left Volt at 331-360 ms, about 40 ms of it Volt's own and the rest the ACP adapter
and the Claude Code CLI before the model request leaves.

Outcome in one paragraph: three things ran on the prompt's path that the turn does not need; all three are moved off
it (commits below). On the adapter alone, on a quiet machine, the turn's request now leaves with no side request
before it (37 `count_tokens` before, 0 after), with a third less CLI CPU in that window (75 to 50 ms) and 4 ms sooner
(60 to 56 ms median, n 20 each). **In the app, A4 end to end did not measurably change**: 124.5 ms before, 122.5 ms
after (n 24 each, load 5-13). The side work ran beside the request, not in front of it, on a quiet machine. Under
load (1-minute load about 12) the adapter alone was 142 vs 106 ms (n 8 vs 6), but the ranges overlap almost fully, so
that is not counted as a measured gain. The in-app numbers today are far below round 3's 331-360 ms
for both arms alike, so this branch does not explain that. Load explains much of it: round 3's speed-rig A4 ran at load
11-17, and today's second pass at load 12-14 gave 241 and 262 ms. Round 3's 331 ms came from a different driver, the
ADEMark-method runner (real keystrokes, an isolated HOME with an API key), which was not re-run in round 4.

What runs between `session/prompt` and the model request, found with a logging tap in front of the replay server and
a trace preload in the adapter (timestamps on the same wall clock):

1. **A skill-file read that Volt never uses.** Volt declares the JetBrains AIR extension (for session-failure
   notices, native subagent sessions and async tasks). For AIR clients the adapter calls `getContextUsage()` on the
   first `system`/init of a session, to put SKILL.md paths on the slash commands. The CLI answers it with 37
   `count_tokens` requests (one body 210 KB: Volt's MCP tool list); 18-19 of them went out before the turn's own
   request in the first traces, and all 37 in the load-gated adapter-alone runs (after a 5 s warm-up). Volt reads only command names.
2. **A sign-in re-check on every prompt.** The adapter runs `claude auth status --json` (a second Claude Code process,
   a 320 MB binary, 0.2-0.4 s of CPU) at the start of every prompt, while the turn's CLI builds its request. It never
   waits for the answer; the answer only sets a flag that the next prompt reads.
3. **Volt's workspace summary round trip.** The `<volt_workspace>` lead was asked from the window only after the agent
   was ready, so the agent-server-to-window round trip (about 30 ms quiet, up to its 300 ms cap under load) sat between
   agentReady and `session/prompt`. ADEMark's `replay:hi` is small talk, which skips this lead, so A4 does not see this
   one; every real first prompt does.

Neither adapter behaviour has a flag or an environment variable. Volt now starts the adapter as
`node --import <preload> <adapter bin>` (the same `node` its `#!/usr/bin/env node` line finds); the preload is a
`data:` module that registers a module load hook (`module.registerHooks`, or `module.register` on older Node) which
edits the adapter's `dist/v1/acp-agent.js` as it loads: the skill read and the sign-in check are queued and run after
the turn's result (the sign-in check also after 3 s in a turn with no result). Each edit must match its text exactly
once or the file loads untouched, so another adapter version runs as shipped. This is a pinned patch in Volt's
default launch, not a bench switch.

## Before and after

Medians, (n, min-max). Only rows whose 1-minute load at Enter was 14 or less count; the load is per row in the data.
"Before" = `volt-e4-base` (`b2db4e7f605`, round 3 merged), "after" = `e4/firstword`, both dev builds on one profile,
launches interleaved. Times are in-app (CDP/DOM, a frame or more below ADEMark's pixel times), not ranking numbers.

**Pass 1, in-app A4** (2026-11-14 07:27-07:42 +04, 8 rounds x 3 runs per arm, load 5.0-12.8, none left out):

| Enter to ... | before | after |
|---|---|---|
| first word on screen (A4) | 124.5 (24, 110-2,083) | 122.5 (24, 103-203) |
| the turn's model request at the replay server | 100 (24, 86-2,058) | 98 (24, 82-171) |
| model request to first word on screen | 25 (24, 21-30) | 26.5 (24, 21-101) |
| prompt leaving the window | 8 (24, 6-13) | 8 (24, 6-15) |
| first request of any kind before the turn's own, lead | 27 (24, 24-36) | 0 (24, 0-0): the turn's request is the first |
| load at Enter (median, max) | 8.1, 12.8 | 8.0, 11.9 |

**Pass 2, in-app A4 and A3** (09:01-09:28 +04, 6 rounds x 3 runs, arm order alternated per round; the machine got busy
as other areas started: load 10.7-14.0 among the rows kept):

| Test | before | after | left out (load > 14) |
|---|---|---|---|
| A4 Enter to first word | 241 (14, 141-1,146) | 262 (12, 133-1,339) | 4 / 6 |
| A4 Enter to the turn's request | 212.5 (14, 114-847) | 230 (12, 108-1,230) | |
| A4 first request before the turn's own, lead | 44 (14, 18-278) | 0 (12, 0-0) | |
| A3 New Agent to typing (two probe letters painted) | 168 (17, 136-1,046) | 170.5 (10, 150-322) | 1 / 8 |
| load at Enter (median, max) | A4 12.5, 14.0; A3 12.1, 13.6 | A4 12.7, 13.7; A3 12.9, 13.7 | |

Pass 2 shows no difference either way within its spread; A3 did not regress (this branch does not touch the new-thread
path).

**The adapter alone** (`acpbench.mjs`, session/prompt to the turn's request at the tap; 07:45-08:07 +04, 20 rounds,
order rotated, load 3.9-11.4):

| Metric | unpatched | Volt preload |
|---|---|---|
| session/prompt to the model request, ms | 60 (20, 57-68) | 56 (20, 51-114) |
| session/prompt to first text, ms | 64 (20, 62-73) | 63.5 (20, 58-132) |
| `count_tokens` requests before the model request | 37 (20, 37-37) | 0 (20, 0-0) |
| `count_tokens` requests in the whole turn | 37 | 36 (all after the result) |
| CLI CPU from the prompt to the request, ms (`ps`, 10 ms steps) | 75 (20, 60-80) | 50 (20, 30-60) |

**The floor: the CLI with no adapter** (`floor.sh`: Claude Code through the Agent SDK with the adapter's settings
sources and Volt's recorded MCP server, interleaved with both adapter arms; 09:29-09:46 +04, load 9.2-13.6 among the
rows kept):

| User message to ... | CLI via SDK, no adapter | adapter, unpatched | adapter, Volt preload |
|---|---|---|---|
| model request, ms | 57.5 (6, 56-85) | 142 (8, 85-412) | 106 (6, 86-416) |
| first text, ms | 65.5 (6, 62-94) | 182 (8, 102-468) | 129.5 (6, 97-449) |
| rows left out (load > 14) | 2 | 0 | 2 |

At load about 12 the adapter adds about 50 (preload) to 85 ms (unpatched) to the CLI alone. On the quiet adapter-alone
pass (load about 5) the adapter reached the request in 56-60 ms, about what the CLI alone took here at load 12; the
floor itself was not taken on a quiet machine. The preload's median is lower than the unpatched one under load, but
the ranges overlap almost fully at this n, so it is not counted as a measured gain.

Where A4's time goes now (pass 1, after, medians): the window hands the prompt over in 8 ms; the agent server starts
the run and sends `session/prompt` 24 ms after Enter (before: 25.5; a pool spare is adopted in 0-14 ms); the adapter
and the CLI take 69 ms from there to the request (before: 72.5); the first word is on screen 26.5 ms after the request.
Volt's own part is about 50 ms of the 122.5 ms (24 before the hand-off, 26.5 after the request).

## Method

- Rig: `round4/scripts/firstword/` (round 3's speed rig with the round-4 ports: CDP 9942, profile `/tmp/v4-fw-ud`,
  replay server 18942, tap 18944 for diagnosis only, arena `/tmp/v4-fw/arena`).
- In-app A4 (`a4.mjs`, round 3's method): new chat, type `replay:hi`, Enter, first word = second frame after
  `LEDGERMARK` is in the DOM; split with the replay server's request log and the run's server marks. `ab.sh` alternates
  launches of the two checkouts on one profile: "before" = `volt-e4-base` (`b2db4e7f605`, dev build), "after" =
  `e4/firstword` (dev build); 3 runs per launch. Pass 1: `measure.sh 8 20` (arm order before, after every round).
  Pass 2: `measure.sh quiet 6` (A4 then A3 on each launch, arm order alternated per round with `ROTATE=1`).
- In-app A3 (`a3.mjs`, round 3's method): from the finished A4 thread, click New Agent and type probe letters every
  50 ms; Ready = the first painted frame with two probe letters in the new chat's composer.
- Floor (`floor.sh`, `sdkbench.mjs`): the same CLI binary driven through the Agent SDK with no adapter, the adapter's
  settings sources and the recorded MCP server, warmed 5 s, interleaved per round with both adapter arms.
- Adapter alone (`acpbench.mjs` via `acpab.sh`): spawns the adapter the way Volt does (same npx copy, Volt's recorded
  `initialize` and `session/new` params, MCP server answered by a stub serving Volt's recorded tool list), warms the
  session 5 s like a pool spare, sends `replay:hi`, and times the model request at the tap and the first text chunk.
  Variants per repetition, order rotated: unpatched vs `volt` (Volt's preload from this worktree's `out/`). It also
  samples the CLI's CPU time from the prompt to the model request (`ps`, 10 ms resolution).
- Load gate: each repetition starts only when the 1-minute load is at most 14 (`LOAD_MAX=14`); the row records the
  load at Enter, and `summary.mjs` keeps rows at 14 or less (`node summary.mjs until=2026-11-14T05:00:00Z` prints
  pass 1 and the adapter-alone table, `since=2026-11-14T05:00:00Z` pass 2 and the floor). Data:
  [`a4.jsonl`](data/firstword/a4.jsonl), [`a3.jsonl`](data/firstword/a3.jsonl),
  [`acpbench.jsonl`](data/firstword/acpbench.jsonl) (labels `r4-*` adapter alone, `fl-*` floor),
  [`sdkbench.jsonl`](data/firstword/sdkbench.jsonl) (`fl-sdk`).

## Fixes

1. **`2b19e11dece` perf(acp): Claude's adapter reads skill files after the turn, not before its request.**
   Cause: finding 1 above (`refreshSkillFiles` on the first init, for AIR clients only). Change:
   `voltRuntime/common/claudeAcpPatch.ts` builds the preload (patch table, the transform as JavaScript source, both
   hook APIs); `acpLaunchFor` (`cliAgents.ts`) starts Claude's adapter from npx's cache as
   `node --import <data: preload> <bin>`. The read is queued per session and runs after the turn's `result` has been
   handled. Check that nothing is lost: the read still runs (all 36-37 `count_tokens` arrive after the turn,
   `round4/data/firstword/acpbench.jsonl` rows `chk-volt`, `chk-volt2`, `dbg-volt`), and the adapter still resolves
   skill paths from disk when no read has landed. Tests: `claudeAcpPatch.test.ts` (the transform as shipped, run on the
   adapter's own lines: before, after, a version that does not match, other indentation), `cliAgents.test.ts`
   (launch). In-app check: the dev build's agent server log shows the adapter started as `node --import data:...`
   and the A4 turn answered.
2. **`a050b81e89b` perf(acp): Claude's adapter checks the sign-in after the turn's request, not before it.** Cause:
   finding 2. Change: one more edit in the same hook: `void this.authStatus.probe()` in `startTurn` is queued like the
   skill read, with a 3 s fallback timer so a turn that never gets a result (a refused prompt, a CLI that died) still
   checks. The adapter's own contract is unchanged: the answer only sets a flag the next prompt reads; the one case
   that moves is a next prompt sent within about 0.3 s of a turn's end, which now sees an account change one prompt
   later (the original read could also land that late). Trace: `claude auth status` now starts 244 ms after the prompt,
   after the result, instead of before the CLI gets the prompt. Test: `claudeAcpPatch.test.ts`.
3. **`c4c9e09ed0c` perf(runtime): ask the window for the workspace summary when the run starts.** Cause: finding 3.
   Change: `askWorkspaceSnapshot` is called at the top of `executeAgent` (next to the retrieval and the index status
   it already started early); `workspaceLead` then waits at most `WORKSPACE_LEAD_WAIT_MS` (300 ms) for that answer, as
   before, and the dedupe per agent handle is unchanged. Small talk, subagents, `/compact` and Volt notes still skip
   it. Test: `voltRuntimeService.runtime.test.ts` ("the window is asked ... while the agent starts, not after it").
   A4 does not exercise it (`replay:hi` is small talk); the gain is on real first prompts: the window's round trip now
   overlaps the agent's adoption or start instead of following it.
4. **`bcefa70c437` fix(acp): log the adapter's data: preload by its kind.** The agent server's session line printed
   7 KB of base64 per spawn.

Numbers per fix: fixes 1 and 2 ship in one preload and were measured together (the adapter-alone table: 37 to 0
`count_tokens` before the request, CLI CPU 75 to 50 ms, request 60 to 56 ms; in-app no change, 124.5 to 122.5 ms).
Fix 3 is not measured (see below); fix 4 is log hygiene. Checks on the final tree (2026-11-14 09:50): `tsgo` clean;
`claudeAcpPatch.test.ts` 7 passing, `cliAgents.test.ts` 11, `voltRuntimeService.runtime.test.ts` 35.

## Not done, and why

- **The target is not shown met by an ADEMark-comparable number.** A4 was not re-run with the ADEMark-method driver
  (`round3/scripts/ademark/run.ts`: real keystrokes into the frontmost window, isolated HOME); by the time the in-app
  passes were in, the machine was at load 11-16 again. The Bare CLI's A4 (a Ghostty TUI read by OCR) was not measured
  on this Mac either, so Volt's gap to it cannot be put next to the site's. The in-app 122.5 ms (DOM, quiet) is a
  lower bound, not a placement.
- **No end-to-end A4 gain is claimed.** The three fixes move work off the path; on a quiet machine that work ran beside
  the request and the request left at the same time. They pay off when CPU is short (the floor pass hints at it) and on
  real first prompts (fix 3), neither of which is a clean measurement here.
- **Fix 3 is not measured.** `replay:hi` is small talk, which skips the workspace lead, and the replay server has no
  non-small-talk first prompt with a fixed answer. Its cost before the fix was the window's round trip (about 30 ms
  quiet in round 3's trace, up to the 300 ms cap); its test proves the order, not a time.
- **The adapter's remaining cost under load** (50-85 ms over the CLI alone at load about 12) was not traced further.
  The next things to look at are the adapter's own per-prompt work (session state, the `respawnSignedOutSession` check,
  notification fan-out) and the JSON-RPC hop; a warm adapter is already kept (pool spare).
- **Side requests from the CLI itself** (the round-3 "side request" before the main one) are now none in A4: with the
  skill read moved, the turn's request is the first request the replay server sees in every after-arm run (42 of 42,
  both passes, loaded rows included).
- The data files also hold earlier diagnosis rows, mostly taken under load 45-300 (acpbench labels `try`, `v1-*` to
  `v5-*`, `chk-*`, `dbg-volt`, `r4u-*`; sdkbench `sdk-*`); they are structure checks (request order and counts, the
  `noair`/`probe0`/`nomcp`/`nometa` variants that located the causes), not timings, and no table above uses them.
