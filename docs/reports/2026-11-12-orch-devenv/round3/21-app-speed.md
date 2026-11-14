# Round 3: app speed (ADEMark Track A targets)

Status: final (2026-11-13). Branch `e3/speed`, worktree `volt-e3-speed`. ADEMark method, unofficial.

## Summary

Eight Volt-side fixes, measured A/B against the round-2 tree on the same rig, both builds running at once and every
test alternating between them:

- **Idle CPU on a new chat's page: 20.9 % of a core before, 3.5 % after** (medians, 7 paired samples each, after
  lower in 7 of 7; 20.2 to 3.4 % keeping only samples at a load of 14 or less). The default chat background (Orbit) redrew its canvas 30 times a second forever; it now holds
  its frame when nobody is touching the window. The same fix frees about 240 MiB of GPU process memory on that page
  (app memory 2,386 to 2,185 MiB). Idle CPU parked on a finished chat: 7.1 % to 3.9 % (7 of 7), mostly the sandbox
  denial log stream (4 % to 0.8 %).
- **Enter to first word: Volt's own part fell from about 130 ms to about 40 ms.** Enter to the prompt leaving the
  window 42.5 to 9 ms; the model's first token to the first word on screen 84 to 30 ms. End to end (Enter to first
  word with Claude Code's ACP adapter and Haiku 5.5 against ADEMark's replay server) the median went 402 to 360 ms
  under a load of 14 or less (456 to 313 ms over all paired runs); most of what is left, 225-285 ms, is the Claude
  Code CLI building its request after Volt has handed it the prompt.
- **New thread to typing: no measurable change** (222 vs 211 ms, after faster in 10 of 18 pairs). ADEMark's leader
  is 183 ms; Volt's dev build is about 30 ms off.
- **Typing lag with 5 streams:** the key-to-frame wall clock on this shared Mac swings from 19 to 667 ms within one
  arm, so it cannot show a fix. The renderer's own main-thread work while typing beside five streams (a trace, the
  number that load moves least) is the A/B for the typing fixes, and it shows no measurable change either: 612 ms
  of busy time per second before and 625 after (medians, 3 interleaved pairs), with the load while typing at 12-50;
  see "A8" below.
- **Memory at rest with 5 idle threads, relaunch, cold start:** no change from these fixes except the GPU memory
  above. Volt is an Electron app with five Claude Code CLIs and five ACP adapters behind it: about 2.2 GiB for the app
  and 0.65 GiB for the agents in a dev build, against 134 MiB for super.engineering (native) and 1.3-2.3 GiB for T3 Code,
  Claude.app and Emdash (Electron) on ADEMark's board. That gap is the platform, not a bug this round could fix.

## Before and after

Paired runs only (07:16Z onward, three paired runs, both builds up at once, every test alternating). Median (n,
range). The left pair of columns keeps every paired row; the right pair keeps only rows whose 1-minute load was 14
or less (for A8, at the start and while typing). The load column is the 1-minute load over all rows (median, max).
Printed by `node scripts/speed/table.mjs since=2026-11-13T07:16:00Z [maxload=14]`.

| Metric | before, all paired | after, all paired | load (median, max) | before, load <= 14 | after, load <= 14 |
|---|---|---|---|---|---|
| A3 new thread to typing, ms | 234 (18, 103-1,474) | 217 (18, 154-488) | 12.9, 21.1 | 222 (16, 103-408) | 211 (16, 154-400) |
| A4 Enter to first word, ms | 456 (21, 270-2,556) | **313** (18, 186-1,442) | 13.1, 21.9 | 402 (14, 295-1,334) | **360** (13, 186-1,442) |
| of which: Enter to prompt leaving the window | 43 (21, 30-1,321) | **10** (18, 8-91) | | 42.5 (14, 30-340) | **9** (13, 8-91) |
| of which: Enter to request at the model API | 348 (21, 197-2,455) | 286 (18, 161-1,383) | | 324 (14, 210-1,129) | 330 (13, 161-1,383) |
| of which: request to first word on screen | 87 (21, 72-257) | **27.5** (18, 24-65) | | 84 (14, 72-205) | **30** (13, 24-65) |
| A8 typing lag p95 with 5 streams, ms (noise, see below) | 190 (6, 19-378) | 159 (7, 23-667) | 21.9, 34.2 | 78 (1) | 394 (1) |
| A8 typing lag p50 with 5 streams, ms | 15.7 (6, 14.1-92.3) | 21.6 (7, 16.2-176) | | 15.3 (1) | 82.6 (1) |
| A7-style app memory p95 while 5 stream (18 s), MiB | 3,080 (6, 2,908-3,192) | 3,022 (7, 2,827-3,246) | | 3,074 (1) | 3,246 (1) |
| A5 app memory at rest, 5 idle threads, on a chat, MiB | 2,274 (7, 2,174-2,296) | 2,266 (7, 2,187-2,323) | 12.8, 24 | 2,279 (4, 2,254-2,296) | 2,270 (4, 2,246-2,304) |
| A5 app + agents at rest, on a chat, MiB | 2,934 (7, 2,839-2,969) | 2,928 (7, 2,863-3,019) | 12.8, 24 | 2,948 (4, 2,928-2,969) | 2,942 (4, 2,903-3,019) |
| A6 idle CPU, app, on a chat, % of a core | 7.1 (7, 6.2-171 \*) | **3.9** (7, 2.4-5.4) | 12.8, 24 | 6.7 (4, 6.2-8.1) | **4.3** (4, 3.8-5.4) |
| A5 app memory at rest, new chat's page, MiB | 2,386 (7, 2,273-2,459) | **2,185** (7, 2,110-2,281) | 12.4, 51.4 | 2,404 (4, 2,364-2,459) | **2,180** (5, 2,110-2,190) |
| A6 idle CPU, app, new chat's page, % of a core | 20.9 (7, 18.0-22.7) | **3.5** (7, 2.3-12.7) | 12.4, 51.4 | 20.2 (4, 18.0-22.7) | **3.4** (5, 2.3-4.3) |
| A6 idle CPU, agents, new chat's page, % of a core | 0.9 (7, 0.7-1.1) | 0.9 (7, 0.6-2.9) | 12.4, 51.4 | 0.8 (4, 0.7-1.1) | 0.9 (5, 0.6-2.9) |
| A2 relaunch to typing (dev build), ms | 10,852 (7, 5,264-26,976) | 8,915 (7, 5,215-16,852) | 14.9, 29 | 5,367 (3, 5,264-26,976) | 6,979 (3, 5,215-16,852) |
| A2 part after the module load, ms | 3,046 (7, 1,826-19,459) | 2,925 (7, 1,954-8,360) | 14.9, 29 | 2,041 (3, 1,826-19,459) | 2,561 (3, 1,954-8,360) |
| A1 cold start | not measured | not measured | | | |

\* One "before" sample on a chat (pair 2) caught another agent's `npm exec` and `cursor-agent` in the instance's
process tree (171 % of a core); the median is unaffected.

Paired comparisons (the two arms' runs right after one load gate; all paired runs): A6 on a new chat's page, after
lower in 7 of 7 pairs (median difference -17.5 points); A6 on a chat, 7 of 7 (-3.1); A4 Enter to first word, 12
of 18 (-125 ms); A3, 10 of 18 (-12 ms); A2, 4 of 7. Only A4's window-side parts and A6 are clear gains; A3 and A2
are within the noise.

## A8: the renderer's main-thread work while typing beside five streams

`a8work.mjs` (five `replay:stream-1..5` threads, then a 10 s renderer trace while 40 letters are typed 250 ms apart
into the front composer), alternated by `a8work-ab.mjs`: one arm running at a time, launched fresh, 20 s settle, the
load gate on the 1-minute load at the start (it does not hold the load down while typing). Before = the round-2
tree (`volt-e3-speed-base`, profile `/tmp/v3-speed-ud`, CDP 9952), after = `e3/speed` (`/tmp/v3-speed-b-ud`, 9956).
Rows: [`data/speed/a8work.jsonl`](data/speed/a8work.jsonl).

The paired pass (13:56-14:10Z, 3 runs, order before/after, after/before, before/after), median (n, range):

| Per 10 s trace | before | after |
|---|---|---|
| Renderer main thread busy, ms per s | 612 (3, 588-868) | 625 (3, 362-642) |
| Style passes (`UpdateLayoutTree`), count / ms | 2,482 (3, 1,892-2,665) / 2,106 (1,912-6,936) | 1,842 (3, 1,584-3,093) / 2,276 (1,496-2,721) |
| Layout passes, count / ms | 1,020 (3, 850-1,041) / 518 (390-1,644) | 902 (3, 794-1,053) / 430 (236-534) |
| Paint passes, count / ms | 1,922 (3, 1,847-2,160) / 419 (384-1,679) | 1,499 (3, 1,450-2,789) / 251 (243-337) |
| Tasks over 50 ms | 24 (3, 21-65) | 33 (3, 2-33) |
| Longest task, ms | 214 (3, 208-2,080) | 217 (3, 80-350) |
| 1-minute load at start | 13.4 (3, 12.9-13.9) | 13.2 (3, 13.2-14.0) |
| 1-minute load while typing | 25.9 (3, 16.8-50.1) | 24.5 (3, 11.8-27.1) |

Pair by pair, busy ms per s went 868 to 625, 588 to 642, 612 to 362 (after lower in 2 of 3), and tasks over 50 ms
65 to 33, 24 to 33, 21 to 2. The load fell steadily through the pass (5-minute load 81 to 26), and each pair where
after came out lower had after typing under the lower load (27 vs 50, 11.8 vs 16.8); the one pair typed at the same
load (24.5 vs 25.9) has after 54 ms per s higher. Only one row typed at a load of 14 or less, an after row (362 ms
per s, 2 tasks over 50 ms). One more before row exists from an earlier single-arm attempt (10:56Z, load 13.2 at the
start and 14.6 while typing; its after run failed to find the workbench and the next runs could not reach the
ports, [`raw/a8work-ab.log`](data/speed/raw/a8work-ab.log); the paired pass is
[`raw/a8work-ab2.log`](data/speed/raw/a8work-ab2.log)): 274 ms per s, 0 tasks over 50 ms, lower than every after row. Pass counts follow how
many frames the renderer manages (the two lowest-load rows have the most passes and the least busy time), not the
work per keystroke.

**Result: no measurable change.** On this rig the renderer's busy time tracks the machine's load while typing,
which the start-of-run gate does not control, and 3 pairs cannot separate the fixes from it. Fixes 7 and 8 rest on
their trace numbers (74 style and 74 layout passes, about 740 ms in 5 s, gone from the selection bar; about 19 ms
of each keystroke's composer layout), which are one-build traces, not an A/B. No new A/B was run for this report;
a third pass (`a8work-ab3`, 14:11Z) was stopped before its first row. A clean answer needs the gate held while
typing (or an idle Mac) and more pairs.

## Next to ADEMark's published leaders

ADEMark's published medians (`data/v1/summary.json`, run `control-2026-11-10T08-31-19Z`, Mac mini M4 16 GB,
official method with screen capture) next to Volt's paired "after" medians from this laptop (load <= 14 where that
leaves rows). Different machine, different capture (CDP and the DOM here, OCR of the screen there; a screen capture
adds at least a frame), dev build here: read the Volt column as "same order or not", not as a rank.

| Test | ADEMark leaders (published) | Others on the board (published) | Volt before | Volt after |
|---|---|---|---|---|
| A1 cold start, s | MonoCode 1.8, super.engineering 1.8, Zeron 1.9 | Claude.app 2.4, T3 Code 2.7, Paseo 4.2, Emdash 4.2 | not measured | not measured |
| A2 relaunch, s | Diri 0.7, Zeron 0.8, super.engineering 0.8 | T3 Code 1.5, Claude.app 1.5, Paseo 2.9, Emdash 3.1 | 5.4 (dev build) | 7.0 (dev build; no change, see below) |
| A3 new thread to typing, ms | Emdash 183, MonoCode 191, T3 Code 202 | Paseo 244, bb 244, super.engineering 256 | 222 | 211 |
| A4 Enter to first word, ms | Bare Claude CLI 220, Diri 256, Orca 302 | Zeron 606, Paseo 726, super.engineering 837, T3 Code 1,148 | 402 | 360 |
| A4 request to first word on screen, ms | Synara 70, Paseo 76, Traycer 90 | T3 Code 146, super.engineering 167 | 84 | 30 |
| A5 app memory, 5 idle threads, MiB | Diri 109, super.engineering 134, Zeron 209 | T3 Code 652, Claude.app 865, Emdash 1,494 | 2,279 (dev build) | 2,270 (dev build) |
| A5 app + agents, MiB | super.engineering 134, MonoCode 419, Zeron 951 | T3 Code 1,356, Claude.app 1,696, Emdash 2,334 | 2,948 | 2,942 |
| A6 idle CPU in front, % of a core | super.engineering 0.2, Diri 0.6, Paseo 0.8 | Claude.app 0.7, T3 Code 2.7, MonoCode 9.0 | 6.7 on a chat, 20.2 on a new chat | 4.3 on a chat, 3.4 on a new chat |
| A8 typing lag p95, 5 streams, ms | T3 Code 47.9, Traycer 50.1, Synara 50.9 | super.engineering 72.4, Emdash 83.4 | see A8 | see A8 |

The ADEMark area's report ([20-ademark.md](20-ademark.md)) runs the installed app and the other apps on this Mac
through ADEMark's own runner; this report is the dev-build A/B for the fixes.

Where Volt stands: within reach on A3 (211 vs 183 ms) and A4 (360 vs 256 ms, most of it in Claude Code's CLI); its
own first-word path (key to send, token to screen) is now among the fastest on the board. Idle CPU is now in the
range of T3 Code (2.7 %) and Orca (2.6 %) but not the leaders (0.2-0.8 %); what is left on the new-chat page is
spread over the GPU process (1.1 %), the sandbox denial log stream (0.8 %), the renderer (0.6 %) and the agent
server (0.4 %). Memory and launch are far off the
leaders, for the platform reasons under "Not done".

## Method

ADEMark method, unofficial. Official ADEMark runs need a macOS user `ademark` that only the user can create, a Mac
mini M4 and screen capture with OCR. These runs are in-app over CDP on this laptop (Apple M4 Max, 14 cores, shared
with four other agents), so the numbers compare Volt with itself; the leader column is ADEMark's published data for
orientation only.

- **Builds.** "before" is `/Users/leularia/Desktop/VOLT/volt-e3-speed-base`, detached at `19ffd10b7b8` (round 2's
  tree plus the two fixes the replay server needs: the loopback grant `6cc80c0a9bd` and the lead as its own prompt
  block `19ffd10b7b8`; ADEMark's agent carries the same lead fix as `8e69441aa56`). "after" is `e3/speed` at
  `31c47ece702` (the code has not changed since). Both are dev builds (`out/`, unbundled ES modules), launched with
  `scripts/code.sh`; before uses profile `/tmp/v3-speed-ud` and CDP port 9952, after `/tmp/v3-speed-b-ud` and 9956.
  Window restored at 1600 x 1000 and clamped by this screen to 1512 x 896 points.
- **Model API.** ADEMark's own replay server (`bench/replay/server.ts`, its shipped sessions) on 127.0.0.1:18952,
  `ANTHROPIC_BASE_URL` pointed at it, model Haiku 5.5 through Claude Code's ACP adapter 0.106.0. No live model.
- **Seeded state.** The arena (ADEMark's `arena/`, a git checkout at `/tmp/v3-speed/arena`) as the project, and
  5 threads seeded with `replay:seed` (`seed.mjs`). Each round starts with one more seeded thread so A3 opens from a
  finished thread.
- **Pairing.** `pair.mjs` runs both builds at once and alternates every test between them, the order flipping each
  time, so a load burst from the other agents falls on both arms alike. Per round: A2 x1 per arm, A3 x3, A4 x3,
  A5/A6 on a finished chat and on a new chat's page (both arms sampled over the same 60 s after a 60 s settle), and
  A8 x1 per arm with the other arm stopped. Before each pair the rig waits for a 1-minute load of 14 or less
  (`pair.jsonl` records each wait and the load). Three paired runs: 06:30-08:00Z (3 rounds), 08:11-10:54Z
  (3 rounds), 12:27-13:54Z (2 rounds; round 1's A8 was skipped at load 82-145 and the run stopped by hand). Rows before 07:16Z are left out of every table: a sequential suite
  (`suite.mjs`) and the paired rig ran on one profile and port at once until then. A5 rows without `domNodes` (the
  window was gone, 7 processes left) are left out too (`14dd624d1df`).
- **What each test measures here.**
  - A2 Relaunch: `t0` just before the spawn; probe letters every 50 ms (+-20 %) into the restored chat's composer
    (clicked when it has no focus); Ready = second frame after the composer shows two probe letters. No `sudo purge`
    here, so no A1 cold tier. The marks `code/willLoadWorkbenchMain` and `code/didLoadWorkbenchMain` split out the
    dev build's module load (thousands of ES modules; one bundle in a shipped build).
  - A3 Thread Open: click New Agent on a finished thread, probe letters every 50 ms; Ready = the new chat's composer
    shows two probe letters and the old thread's marker is gone (second frame after).
  - A4 First Word: `replay:hi` typed in a new chat, Enter; first word = the second frame after `LEDGERMARK` is in
    the DOM. Split with the replay log (request received) and a hook on the window's agent-server WebSocket (the
    prompt leaving the window, the first frame holding the marker), plus the agent server's own run marks. All
    clocks are wall clocks.
  - A5 Weigh-in / A6 Idle Burn: ADEMark's sampler (`ademark-native sample`, `phys_footprint` at 4 Hz, built from a
    private copy at `~/.volt-r3/speed/native`) over the instance's process tree, 60 s; CPU = delta(user+sys)/wall
    per process, summed for ADEMark's `app` and `agents` groups. Fixed 60 s settle instead of ADEMark's slope rule.
    The window is in front (ADEMark's A6 "front").
  - A8 Typing Lag: 5 new threads with `replay:stream-1..5` 2 s apart, then 60 probe letters 250 ms (+-20 %) apart
    into the front thread's composer (ADEMark types into thread 1; here thread 5, which streams the same way).
    Latency = the key event's timestamp to a task posted from the first frame after the composer's text changed
    (after that frame commits). The sampler runs over the typing window too (A7-style memory, 18 s, not A7's 3 min).
  - A8 work: `a8work.mjs`, the same five streams, then a 10 s renderer trace while a letter is typed every 250 ms:
    busy ms per second of the renderer's main thread (top-level tasks), style/layout/paint passes, tasks over 50 ms.
    `a8work-ab.mjs` alternates the arms run by run, one arm running at a time.
- **Scripts:** [`scripts/speed/`](scripts/speed/) (`setup.sh` recreates the replay server, arena and sampler after a
  reboot; `pair.mjs` runs the paired A/B; `table.mjs since=2026-11-13T07:16:00Z [maxload=14]` prints the table).
  **Data:** [`data/speed/`](data/speed/) (`a1`, `a3`, `a4`, `a5`, `a8`, `a8work`, `pair` `.jsonl`; sampler CSVs in
  `raw/`). The sequential suite's rows are in the same files before 07:16Z and in
  [`data/speed/sequential-r0/`](data/speed/sequential-r0/); the previous agent's first probes are in
  [`data/speed/prev-agent/`](data/speed/prev-agent/).

## Fixes

Each is one commit on `e3/speed` with a unit test where the code is testable. "Rig" numbers are from the paired
table above; "trace" numbers were taken by the previous agents on one build with a CDP trace or a profile and are
not an A/B on the rig.

1. **`f0c958abbef` perf(agent-server): send a quiet chat's first change at once.** Cause: a shown chat's transcript
   patches went out on a 50 ms timer, so a reply's first words waited up to 50 ms on the server. Change: a change
   after a quiet spell goes out on the next task; a stream still sends at most one patch per 50 ms. Test:
   `serverSessionHost.test.ts`. Numbers: with 2 below, A4 "model's first token to first word on screen" 84 to 30 ms
   (rig, load <= 14; 87.5 to 27.5 ms over all paired runs).
2. **`5fd7ead05bc` perf(agent-server): a reply's first words do not wait behind a usage patch.** Cause: Claude's
   adapter reports usage right before the first text; that change went out at once and started the 50 ms interval,
   so the first words then waited out nearly all of it, undoing 1. Change: a change to what is drawn counts the
   interval from the last patch that carried one. Test: `serverSessionHost.test.ts`. Numbers: as 1.
3. **`28357aa6d3d` perf(agent): send the prompt before drawing the pending turn.** Cause: Enter cleared the composer,
   drew the pending turn and laid the window out, and only then sent the prompt (50-80 ms of Enter's task between
   the key and the send). Change: when no earlier send is in flight, the chat needs no bring-back and the prompt has
   no mentions to freeze, the prompt goes out first and the drawing follows; other sends keep the ordered chain.
   Test: `agentThreadLifecycle.test.ts`. Numbers: A4 Enter to the prompt leaving the window 42.5 to 9 ms (rig,
   load <= 14, n 14/13; after's max 91 ms vs before's 340 ms).
4. **`afe6ce6072c` perf(agent): memory notes off a new agent's first-prompt path.** Cause: the sandboxed Memory host
   started on the first send of every new chat after it idled out, and the lead waited for it (480-620 ms in the
   context pack, trace). Change: the last context block is used at once and read again behind the turn; a change to
   the notes drops it; prewarming an agent reads it too. Test: `voltMemoryContext.test.ts` (fixed for the
   interface's third argument in `f207d26c851`). Numbers: trace only. The rig's A4 sends follow each other within
   seconds, so the host rarely idles out between them and the rig does not exercise this path; the A4 split's
   "Enter to request at the model API" is about the same in both arms under load <= 14 (324 vs 330 ms).
5. **`2e69c849c2b` perf(sandbox): narrow the denial log stream by sender before text search.** Cause: the macOS
   denial stream (`log stream` with a text predicate) runs while any sandboxed process lives (spares, idle agents,
   the Memory host) and searched every unified-log line: 3.5-4.5 % of a core at rest. Change: match the kernel's
   Sandbox sender and the logger's flush markers first. Test: `sandboxSecurity.test.ts` (real-OS denial and forge
   tests). Numbers: interleaved 20 s samples, 3 each, 0.61-0.89 s vs 0.08-0.19 s of CPU
   ([`prev-agent/logstream-predicate-cost.txt`](data/speed/prev-agent/logstream-predicate-cost.txt)); on the rig the
   log-stream process's CPU at rest went 3.96 % to 0.76 % on a chat and 4.16 % to 0.80 % on the new-chat page
   (median per process, n 7 each). It is most of A6's 6.7 to 4.3 % on a chat.
6. **`619ed67d339` perf(agent): a drawn chat background holds its frame at rest and while typing.** Cause: the
   default chat background (Orbit, shown on a new chat's page; Volt and Halftone too) redrew its full canvas 30 times
   a second for as long as it was shown. Change: it moves for 15 s after the last pointer or key input, then holds
   its frame, and holds still while keys are typed until they have been quiet for 1.5 s. Test:
   `agentChatBackdropMotion.test.ts`. Numbers (rig, new-chat page, load <= 14): A6 app CPU 20.2 to 3.4 % of a core
   (n 4/5; after lower in all 7 pairs over all paired runs); per process, GPU 8.8 to 1.1 %, renderer 7.8 to 0.6 %;
   GPU process memory 634 to 397 MiB, app memory 2,404 to 2,180 MiB.
7. **`cac290d9054` perf(agent): the selection bar reads the selection only when it can change.** Cause: the Add to
   Chat bar read the window's selection on every `selectionchange`, every scroll in the thread and every resize; each
   read forces style and layout. With five replies streaming (each scrolls its thread every frame) and keys typed,
   that was 74 style and 74 layout passes in 5 s, about 740 ms of the renderer's main thread (trace). Change: a
   change while a text field has focus, or a scroll or resize with no transcript text selected, skips the read.
   Test: `agentThreadSelectionActions.test.ts`. Numbers: see "A8" above.
8. **`31c47ece702` perf(agent): a keystroke that keeps the draft's height lays nothing out.** Cause: every change to
   the composer's draft ran the composer's full layout (style reads, a Monaco layout at height 0 to measure, then a
   second at the measured height), about 19 ms of each keystroke in a dev build (trace). Change: a change runs it
   only when the draft's shape changes (empty or not, one line or several); growing and shrinking already lay out
   from `onDidContentSizeChange`. Test: `agentComposerDraft.test.ts`. Numbers: see "A8" above.

Not Volt-side fixes but on the branch: `6cc80c0a9bd` (a local model endpoint in the CLI's base URL is a loopback
grant, so the sandboxed CLI can reach the replay server) and `19ffd10b7b8` (Volt's lead as its own prompt block,
needed by ADEMark's replay matching; the ADEMark area carries the same change as `8e69441aa56`). Both are in the
"before" build. Rig: `72da01c415d`, `fbd536376ce`, `14dd624d1df`; data: `4fb5241096d`, `5c272bf730b`, `7807584340e`
and the final data commit.

Checks: `npm run compile-check-ts-native` clean; `scripts/test.sh --run` on the seven test files above: 65 passing,
2 pending (the sandbox suite's own skips).

## Not done, and why

- **A1 cold start.** Not measured: ADEMark's cold tier needs `sudo purge` before each launch, which needs the user.
  A dev build's start is dominated by loading thousands of unbundled ES modules (2-19 s of A2 here, depending on
  load), so a dev-build cold number would say little about the shipped app anyway. Next step: A1/A2 on a minified
  release build (`gulp vscode-darwin-arm64-min`) in the ADEMark account.
- **A2 relaunch: no fix and no claimed change.** Paired medians under load <= 14 are 5.4 s before and 7.0 s after
  (n 3 each, ranges 5.3-27.0 and 5.2-16.9 s; after faster in 4 of 7 pairs over all runs): the spread is the load on
  this Mac, not the code. ADEMark's leaders relaunch in 0.7-0.8 s (Diri, Zeron, super.engineering) and the Electron
  apps in 1.5-3.1 s (T3 Code, Claude.app, Paseo, Emdash). Most of Volt's dev-build relaunch is its module load and
  the workbench restore; a shipped bundle removes most of the first.
- **A3 new thread to typing: not faster.** No commit targeted it (the rig has `profile-a3.mjs`/`trace-a3.mjs`, but
  this round's time went to the larger idle-CPU and first-word costs); 211 ms against ADEMark's leader 183 ms (Emdash) and T3 Code's
  202 ms, on a dev build and a loaded laptop.
- **A4 end to end is Claude Code's time.** After Volt hands the prompt to the ACP adapter (the agent server's run start plus its prompt mark: a median 77 ms after Enter
  before, 65 ms after),
  the adapter and the Claude Code CLI take a median 225 ms (before: 285 ms) to send the main request, after a side
  request at about 200 ms. ADEMark's bare Claude Code CLI sends its request 57 ms after Enter on the reference Mac.
  Finding why the CLI under the ACP adapter is that much slower (the side request, the adapter's session setup) is
  the next lever for first word; it is outside Volt's own code and was not attempted.
- **Memory at rest (A5) and while streaming (A7).** No change beyond the GPU memory on the new-chat page. Where the
  2.2 GiB "app" goes (median, on a chat, after): renderer 567 MiB, GPU 488, main 362, five ACP adapters (node)
  294, agent server 194, extension host 106, shared/utility process 105, code index 41, Memory plugin host 25; the
  five Claude Code CLIs ("agents") are another 675 MiB. Native super.engineering is 134 MiB in total and Diri 109 MiB
  for its app. Real levers for Volt, not done this round: one shared ACP adapter process instead of one per thread
  (about 240 MiB), letting idle threads' CLIs and adapters exit and resume on demand (most of 0.9 GiB), and a
  release bundle (smaller renderer and main heaps than a dev build). An Electron window with a GPU process cannot
  reach a native app's 100-200 MiB.
- **A8 wall-clock lag.** The key-to-frame latency with five streams ranged 19-667 ms within each arm on this Mac,
  with the 1-minute load 13-37 while typing (five Claude CLIs streaming add to it). It is reported, but no claim is
  made from it. ADEMark's leader is T3 Code at 47.9 ms p95.
- **A9-A11** (session restore, many threads, long thread) were not in this area's scope; the long-thread work is in
  [22-long-threads.md](22-long-threads.md).
- **Official numbers.** None of these is an ADEMark result; an official run needs the `ademark` account on the
  reference Mac mini, which only the user can set up.
