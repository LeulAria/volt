Status: final

# Round 5, area "idle": idle CPU and typing lag

Branch `e5/idle` (worktree `volt-e5-idle`), from `9bbb8818c60`. Before = `volt-e5-base` (same commit, read-only),
after = this branch. Both are dev builds (transpiled `out/`, not minified), run one at a time on CDP 9977 with their
own profiles (`~/.volt-r5/idle/ud/<arm>`). ADEMark method, unofficial.

## Summary

- **A6 idle, window in front: app CPU 1.70 % -> 0.69 % of a core** (n 2 per arm, load 5.5-8.3), wakeups 28.4/s -> 19.1/s.
  The target (under 0.18 %) is not met: main (0.31 %), the two node utility processes (0.22 %) and the agent server
  (0.09 %) remain.
- The largest cut is the sandbox's resident `log stream` (0.66 % before, gone after): refusals are now read on demand
  with `log show`, and the "blocked by the sandbox" card still shows in the same turn (live check, both arms).
- The sandbox helper went from 0.26 % to 0.03 %, main's wakeups from 14.4/s to 8.0/s, the agent server from 0.23 % to
  0.09 % (8.2 -> 4.5 wakeups/s).
- **A8 typing lag was not measured at quiet load.** The only A8 rows (key to pixels) were taken at load 15-46 and are
  invalid. The user asked to finish before the quiet A8 session could run. So the keystroke-first frame gate
  (`ccbbbbc3749`), which had no proof, is reverted (`ce91ce68668`). The two other typing-path fixes (`f4307569e85`,
  `604496a7ce2`) stay on profile evidence only, with no A8 number.

## Before / after

All rows: dev builds, 2026-11-14 18:19-18:36 UTC, run order before, after, after, before, timing lock held, load
recorded at each sample's start. Data: [data/idle/a6.jsonl](data/idle/a6.jsonl), raw 4 Hz samples in
[data/idle/raw/](data/idle/raw/).

| Test | Before | After | Load at start |
|---|---|---|---|
| A6 idle, in front: app CPU | 1.70 % (n 2, 1.66-1.74) | **0.69 %** (n 2, 0.62-0.77) | 5.5-8.3 |
| A6 idle, in front: app wakeups/s | 28.4 (n 2, 28.1-28.6) | **19.1** (n 2, 17.6-20.6) | 5.5-8.3 |
| `log stream` (sandbox refusal monitor) CPU | 0.66 % (0.64-0.68) | **0** (no process) | 5.5-8.3 |
| sandbox helper CPU | 0.26 % (0.26-0.26) | **0.03 %** (0.03-0.04) | 5.5-8.3 |
| main CPU / wakeups | 0.36 % / 14.4 per s | 0.31 % / **8.0 per s** | 5.5-8.3 |
| agent server CPU / wakeups | 0.23 % / 8.2 per s | **0.09 %** / **4.5 per s** | 5.5-8.3 |
| node utility (2 processes) CPU | 0.15 % (0.14-0.16) | 0.22 % (0.21-0.24) | 5.5-8.3 |
| renderer / GPU CPU | 0.02 % / 0.02 % | 0.03 % / 0.01 % | 5.5-8.3 |
| A6 idle, covered: app CPU | invalid (cover failed both reps) | 0.62 % (n 1; the other rep invalid) | 4.9 |
| A8 key to pixels, 5 streams | not measured at load <= 14 | not measured at load <= 14 | - |
| "Blocked by the sandbox" card for `touch ~/x` | shown, same turn | shown, same turn | correctness, any load |

Invalid rows, kept in the data but out of every median:
- A6 covered: 3 of 4 rows had no cover. ADEMark's `ademark-native cover` found no on-screen window of the pid in 5 s,
  3 tries each (the `cover` field of those rows). Their CPU reads like the front numbers: before 1.56 % and 1.42 %,
  after 0.49 %. The one valid covered row is after, 0.62 %.
- A8 exploration rows (`~/.volt-r5/idle/explore/a8.jsonl`, not committed as results): load 15-46 at start and 17-79
  while typing. Key to pixels p50 33 ms (before, n 1) and 53-136 ms (after, n 5). At that load the spread is noise.

## Method

- **A6 Idle Burn** ([scripts/idle/a6.mjs](scripts/idle/a6.mjs), [a6-batch.mjs](scripts/idle/a6-batch.mjs)): each
  rep is a fresh launch of the arm with the composer focused (ADEMark's ready state). ADEMark's own sampler
  (`ademark-native sample`, `proc_pid_rusage` at 4 Hz) runs over main plus every process started with the arm's
  profile, for 60 s after 90 s of settling. CPU % is delta(user + sys) / wall for the `app` group; wakeups/s are
  idle-exit plus interrupt wakeups. "Front" means the window is visible, with focus emulated over CDP (the user works
  at this Mac, so the test window is not frontmost). "Covered" adds ADEMark's opaque cover panel for the sample.
- **A8 Typing Lag** ([scripts/idle/a8.mjs](scripts/idle/a8.mjs)): 5 chats each stream `replay:stream-<n>` from
  ADEMark's replay server (port 18977). Then 60 keys go into the composer of the chat on screen, one every
  250 ms +-20 %. Headline: Chromium's EventLatency of each KEY_PRESSED, from the key event to the presented frame.
  ADEMark's camera runner needs Screen Recording, which this account does not grant. Built, not run at quiet load.
- Timing lock `~/.volt-r5/timing.lock` for every timed row ([scripts/idle/session.sh](scripts/idle/session.sh)); the
  plan for the round was [sessions-r5.sh](scripts/idle/sessions-r5.sh) (A6 3 reps per arm, A8 4 reps per arm of
  before / after / after-without-gate). Only its first session ran: the timing lock was held by other areas from
  21:18 to 22:19 local, and at 22:3x the user asked to finish.
- **Denial card** ([scripts/idle/denial-card.mjs](scripts/idle/denial-card.mjs),
  [data/idle/denial-card.jsonl](data/idle/denial-card.jsonl)): a live Haiku 5.5 turn runs `touch ~/volt-r5-sbx-probe-<arm>.txt`
  outside the workspace in the sandbox. The card naming the file shows in the same turn in both arms, and the file
  is not written.

## Fixes

Each is one commit on `e5/idle`. The A6 numbers above are the whole branch; the per-role rows map to the fixes below.

1. **`ef70701ca2b` perf(sandbox): read Seatbelt refusals on demand instead of a resident log stream.**
   Cause: a `log stream` child ran for as long as any sandboxed process lived (a warm Claude spare, the Memory plugin
   host). Change: refusals are read with `log show` over a bounded window when one is likely: a tool call failed or
   its output reads like a refusal, a background command failed, a one-shot run exits, a host in its first seconds
   and at most every 30 s while it works, a host crashes. A `logger` marker must be in the answer, so every refusal
   logged before the call is delivered; only kernel lines count, so forged lines stay out. Numbers: `log stream`
   0.66 % -> 0. Tests: sandbox security, supervisor, MCP and pty suites; LOG-FORGE-2 and DENIAL-FLUSH-1 against the
   real kernel log.
2. **`0643a663877` fix(acp): a turn whose command was refused waits for the refusal read before it ends.** Found by
   the denial-card check: a short turn ended before `log show` answered, so its card waited for the next turn. A
   turn that ends while a read is under way now waits up to 4 s; turns without a failed command do not wait. The
   card then shows in the same turn (row 1 of `denial-card.jsonl`).
3. **`84ab0fc4fed` perf(sandbox): measure a sandboxed host from the helper's tracked tree.** Cause: every stats
   request made the macOS helper sweep every process on the system (1.1 ms of CPU each, polled at 1 Hz), and the
   supervisor spawned `/bin/ps -axo` every 10 s. Change: the helper sweeps only after a member forked, or every 10 s,
   and reports the tree's CPU time; the supervisor uses it. 200 stats calls: 0.22 s -> 0.01 s of helper CPU.
4. **`e1be4a31ff9` perf(sandbox): the helper checks a limited run's footprint and process cap itself.** Cause: a
   1 s `setInterval` in the agent server asked the helper for a limited run's footprint. Change: the helper watches on
   one kqueue timer and writes a line only when a run crosses a limit. Together with 3: sandbox helper 0.26 % ->
   0.03 %, and the agent server's 1 Hz request is gone. RES-MAC-1/2, MCP-QUOTA-MEM and the escaped-orphan test pass.
5. **`5649c83d3c5` perf(diagnostics): the main stall monitor rests when no IPC call arrives.** Its 100 ms drift timer
   was main's most frequent wakeup. It now runs for 10 s after each IPC call. Main wakeups 14.4/s -> 8.0/s.
6. **`fb9eaf8ece9` perf(agent-server): sweep revoked devices only while a device is connected.** The 2 s INV-08
   sweep woke the desktop's own agent server for its whole life. With 4 (no 1 s poll): agent server 0.23 % -> 0.09 %,
   8.2 -> 4.5 wakeups/s.
7. **`f4307569e85` perf(agent): adopt native thread scrolls in the frame pass, not in the scroll event.** The scroll
   handler read `scrollTop` after the follow wrote it each frame, which forced a layout every frame. Profile with 5
   chats streaming (load above 14, profile only): 1.2 s of the renderer's main thread in 20 s, 513 style recalcs in
   6 s, before the fix. No A8 number.
8. **`604496a7ce2` perf(agent): recount the draft in the context meter at most every 150 ms while typing.** About 1 ms
   per key in a renderer profile (25 ms over 30 keys). No A8 number.
9. **`70f9d9ff6c1` perf(agent): warm a restored chat's agent once its transcript is read.** Ported from round 4's
   smoothness work (uncommitted there). A chat drawn from its kept first screen at launch used to warm an agent before
   its model, mode and folder were known. Checked in a test window: a relaunch with 5 seeded chats warms one agent
   after the read.
10. **`ccbbbbc3749` (keystroke-first frame gate), reverted by `ce91ce68668`.** It held the thread render and follow
    glide for one frame after a composer keystroke. With no A8 row at load <= 14 there is no evidence of a gain, so
    it does not ship. The rig keeps a `nogate` arm (`lib.mjs` `setGate`) for whoever re-tries it.

## Not done, and why

- **A6 under 0.18 %: not reached (0.69 %).** What is left at rest in front: main 0.31 % (8 wakeups/s), the two node
  utility processes 0.22 %, agent server 0.09 %. These are dev builds. ADEMark measures the shipped app, and the
  minified after build was not made (time).
- **A8 typing lag: no valid number.** Quiet A8 (before / after / no-gate, ABC CBA) was queued as sessions 2 and 4 of
  `sessions-r5.sh`. The lock was busy for an hour, and the user then asked to finish. Target (under 48 ms key to
  pixels) unknown.
- **A6 covered:** ADEMark's cover tool found no on-screen test window in 3 of 4 reps (the user's screen and Spaces
  are not ours to change). 1 valid row.
- **A3 and A11** were not measured this round.
- A6 n is 2 per arm (the plan was 3); the third rep was in session 3, which did not run.
