Status: final

# Round 6, area "idle": idle CPU and the at-rest footprint

Branch `e6/idle` (worktree `volt-e5-idle`), from `7f07f73d677`. Before = `volt-e5-base` (dev) and the shared minified
before build (`~/.volt-r6/min/base`), after = this branch (dev) and its minified build (`~/.volt-r6/min/idle`, commit
`314da58e1ad`). One instance at a time on CDP 9977, profiles `~/.volt-r6/idle/ud/<arm>`. ADEMark method, unofficial.
The previous agent died after the timed sessions finished; this write-up was made from the rows by round 7's idle agent.

## Summary

Six fixes cut what Volt starts and re-reads at rest: the worktree size pass no longer re-measures 68 checkouts with
`du` after every launch, the code index process is held 90 s after a warm-up (not 20 minutes) and no longer forked for
a status question, the sandbox reads the kernel log once per host start (not twice), and the awake lease is re-sent
once a minute. On the release builds that bought **A5 at rest 869 -> 742 MiB** (median, n 5 each: the agent server
77 -> 56 MiB, the code index gone in 2 of 5 rows, no warm ACP adapter left in the sample) and **wakeups 19.8 -> 16.0
per s** in front (main 8.9 -> 7.2). **A6 CPU in front did not move beyond the noise** (0.70 % vs 0.71 %, ranges
0.46-1.16 and 0.49-0.88): what is left is Chromium's and Node's own floor per process plus the rest of main's
wakeups. Covered rows on the release builds are too few to compare: 6 of 10 covered samples lost ADEMark's cover panel
(the window was on another Space while the user had a full-screen app in front), and both valid minafter covered rows
had a warm ACP adapter running through the sample (see caveats). On dev builds (load 2-3, ABBA) the two arms match
within noise: front 0.62 vs 0.65 %, covered 0.45 vs 0.50 %, with fewer wakeups after (14.5 -> 13.4 front, 11.9 -> 9.8
covered).

## Before / after

Data: [data/idle/a6.jsonl](data/idle/a6.jsonl) (33 rows), raw 4 Hz samples in [data/idle/raw/](data/idle/raw/).
`node scripts/idle/summarize.mjs` prints the A6 medians, `node scripts/idle/a5-roles.mjs` A5 by process role (median
phys_footprint per pid over the sample, summed per role). Rows over load 14 and rows marked invalid are left out.
Release sessions A2, B and C ran 2026-11-15 05:25-06:28 UTC (09:25-10:28 local) under the timing lock, arms
interleaved; dev sessions 2026-11-14 22:00-00:06 UTC.

**Release (minified) builds**

| Test | Before (minbase) | After (minafter) |
|---|---|---|
| A6 in front, app CPU | **0.70 %** (n 5, 0.46-1.16, load 6.3-13.8) | **0.71 %** (n 5, 0.49-0.88, load 4.3-13.3) |
| A6 in front, app wakeups/s | 19.8 (16.5-20.4) | **16.0** (13.9-17.4) |
| front, window on screen / on another Space / not recorded | 1 / 3 / 1 | 2 / 3 / 0 |
| main CPU / wakeups (front) | 0.35 % / 8.9 per s | 0.24 % / 7.2 per s |
| agent server (front) | 0.12 % / 2.6 per s | 0.12 % / 2.6 per s |
| extension host (front) | 0.13 % / 0.9 per s | 0.12 % / 1.0 per s |
| shared process (node utility, front) | 0.07 % / 1.6 per s | 0.08 % / 1.6 per s |
| GPU / renderer (front) | 0.06 % / 0.04 % | 0.08 % / 0.06 % |
| A6 covered (cover held all 60 s), app CPU | 0.56 % (n 2, 0.43-0.69, load 13.5-13.8) | 1.13 % (n 2, 0.57-1.69, load 4.5-4.8), **ACP adapter alive in both** |
| A6 covered, app wakeups/s | 15.6 (14.4-16.7) | 15.8 (13.6-18.0) |
| **A5 at rest** (sampler's app median, front) | **869 MiB** (n 5, 778-937) | **742 MiB** (n 5, 700-888) |
| A5 by role (sum of per-pid medians): GPU | 233 | 235 |
| renderer | 197 | 189 |
| main | 107 | 106 |
| agent server | 77 (55-89) | **56** (55-88) |
| extension host | 65 | 65 |
| shared process (node utility) | 43 | 44 |
| code index | 33 (in 5 of 5 rows) | 33 (in 3 of 5 rows) |
| warm ACP adapter in the front sample | 69 MiB in 2 of 5 rows | none |
| processes in the app group (median) | 11 (11-19) | 11 (10-12) |

**Dev builds** (session 1 at load 9-13 plus ABBA session 2 at load 2-3)

| Test | Before | After |
|---|---|---|
| A6 in front, app CPU | 0.62 % (n 3, 0.52-0.71) | 0.65 % (n 3, 0.65-1.03) |
| A6 in front, wakeups/s | 14.5 (14.5-15.2) | **13.4** (12.9-14.4) |
| A6 covered, app CPU | 0.45 % (n 3, 0.36-0.53) | 0.50 % (n 3, 0.45-0.90) |
| A6 covered, wakeups/s | 11.9 (11.8-12.7) | **9.8** (9.0-11.4) |
| main wakeups/s, front / covered | 5.7 / 4.0 | 4.3 / 2.5 |
| A5 at rest (app median) | 1,209 MiB (1,200-1,440) | 1,159 MiB (1,157-1,385) |

Caveats:
- **Covered on the release builds.** ADEMark's cover panel needs the window on screen at layer 0. From 09:00 local the
  user had a full-screen app in front, so the test window sat on another Space: 5 of 9 recorded covered samples got
  `window_not_found` and are left out (the rig then sampled the window minimized, which is not ADEMark's method), and
  one more (session B, minafter) was lost to a hung CDP call. Of the 4 that held, both minbase rows ran at load 13.5-13.8 and both minafter rows had a warm ACP adapter (the focus
  warm's agent, 18-22 wakeups/s, 0.8-2.3 % of a core) alive through the sample: they measure the warm agent, not the
  idle window. No covered comparison is claimed for the release builds.
- **Front on another Space.** 6 of 10 front rows were taken with the window on another Space (`onScreen: false`), which
  macOS treats like an occluded window; those rows read lower (minbase 0.46-0.70 % off screen vs 1.07-1.16 % on screen).
  The arms had the same split (3 off screen each), so the comparison holds, but the absolute front number is optimistic.
- Session 1's dev after rows ran while weight's minified build compiled (load 12.6-12.9): about twice the CPU per
  wakeup in every process, Volt's and Chromium's alike. They are inside the gate and in the medians above; session 2
  (load 2-3) alone gives front 0.62/0.71 % before vs 0.65/0.65 % after.
- The first minbase session (rows 5-6) is invalid: its seed turns failed (the built app's launchd agent server had no
  `ANTHROPIC_BASE_URL`), and the failed chats kept the GPU at 285 wakeups/s. Fixed in the rig (`8faa2cb70a1`).

## What wakes Volt at rest (dev build, exploration, load 22-89, not timings)

Censuses over the inspector of each process ([scripts/idle/timers.mjs](scripts/idle/timers.mjs),
[spawns.mjs](scripts/idle/spawns.mjs)), 60-90 s each, window visible, after the launch burst:

| Process | JS timer fires at rest | What |
|---|---|---|
| main | 0.05/s | voltAwake's 30 s tick (only within the grace period after agent work), a 60 s managed-policy refresh |
| shared process | 0.03/s | idle-callback shim, one parcel watcher event |
| extension host | 0 | nothing |
| agent server | 1.18/s | **0.5/s dev-only hot-reload poll** (`restartWhenStale`, gated on `VSCODE_DEV && !product.commit`, not in a release build), 2 x 20 s WebSocket pings, a 30 s native timer, the 60 s lonely check |

The window itself is quiet too: with the composer focused and the focus burst over, a 20 s Chromium trace
([trace-front-rest.txt](data/idle/explore/trace-front-rest.txt)) shows the renderer's main thread at 0.7 tasks/s,
no display-link callbacks and no frames drawn (the caret rests after 10 s, round 4), the browser process at 5 tasks/s.

So the JS side is near silent; what the sampler sees (round 5: main 0.31 %, two node utilities 0.22 %, agent server
0.09 %) is Chromium's and Node's own floor per process (mojo notifications ~3/s in main, the macOS memory-pressure
evaluator every 5 s, PartitionAlloc's memory reclaimer, V8 GC timers), plus the processes Volt keeps alive at rest.

What is not silent is **a window focus**. One focus event (Cmd-Tab back to Volt, or the rig's focus emulation) runs
the warm-on-intent path (round 5, firstword) and with it, measured in one census:

- main: **18 git processes** in 3 s (the workspace snapshot: status, branches, upstream, remotes, PR state);
- agent server: an ACP adapter and Claude CLI (the warm agent, 30 s TTL), a **plugin host** (Memory's context for
  the warm prompt; lives 90 s after its last message), a **code-index process fork** (50-60 MB, the index loaded,
  for one "is this project large and indexed" question; exits after 30 s), and **two `log show` reads** of the kernel
  log for the plugin host (3 s and 20 s after its launch; one `log show` is 0.3-0.6 s of CPU, and at load 29 the two
  of them sat at 30 % of a core for the whole 40 s sample).

And **10 minutes after every launch**, the worktree-limit pass measured every checkout under `~/.volt/worktrees`
with one `du -sk`: 68 checkouts here, a `du` at 28 % of a core for over a minute, every launch, because the sizes
lived only in memory.

## Fixes

1. **`f6806cb7a98` perf(storage): the worktree size pass keeps its checkout sizes across launches and runs du at low
   priority.** Sizes are saved in the user data folder (`volt-checkout-sizes.json`, atomic write) and read before the
   first pass, so a launch measures only checkouts whose chats ran since; `du` runs under `nice -n 10`. Unit test.
2. **`c6e726227e5` perf(code-index): a warm-up alone holds the index process 90 s, a search 20 min.** Opening a
   workspace warms the index; the hold was 20 minutes for any use, so a window left alone kept a 50-60 MB process
   and its watchers through A5/A6. A shorter hold never cuts a longer one; the index is on disk and catches up from
   sizes and mtimes when forked again.
3. **`ee4949db043` perf(sandbox): a host's refusals are read once in its first seconds, not twice.** The 20 s read
   is gone; a host that works is still read 2 s after its activity (at most every 30 s) and at its exit.
4. **`735834661f3` perf(code-index): a status question while no index process runs is answered from the last
   answer** (under 10 minutes old); a live process always answers itself. No more 50 MB fork per agent start.
5. **`32d5cf55e2a` perf(code-index): the status cache survives a relaunch** (`status-cache.json` in the index's data
   folder), so the first warm after a launch does not fork either.
6. **`5863d7c1839` perf(awake): the window re-sends its unchanged agent lease once a minute, not every 30 s.** The
   only renderer-to-main IPC at rest ([ipc-main-rest.txt](data/idle/explore/ipc-main-rest.txt): 3 `voltAwake.setLease`
   in 90 s, each waking main's awake evaluation); main keeps a lease 2 minutes, so 60 s keeps twice the headroom.

Live check on the dev build after a relaunch (spawn census of the agent server across one focus toggle,
[explore logs](data/idle/explore/)): before, a focus started a code-index fork and two `log show`; after, no fork and
one `log show`. Main's code index, held 20 minutes before, was gone 3 minutes after launch.

## Method

- **A5 + A6** ([scripts/idle/a5a6-batch.mjs](scripts/idle/a5a6-batch.mjs), [a6.mjs](scripts/idle/a6.mjs)): per rep a
  fresh launch of the arm with its profile seeded once (5 chats answered `replay:seed` by ADEMark's replay server on
  18977), composer focused, then ADEMark's sampler (`ademark-native sample`, 4 Hz) over main plus every process of the
  arm's profile: 60 s front after a 90 s settle, then 60 s under ADEMark's cover panel. CPU % = delta(user + sys) /
  wall of the `app` group; wakeups/s = idle-exit + interrupt wakeups; A5 = the `app` group's median RAM over the front
  sample. Arms interleaved (ABBA), timing lock held, 1-minute load <= 14 at each sample's start and recorded in the row.
  Built arms run their own binary with `--use-mock-keychain`.
- **Censuses** (analysis aids, any load): [timers.mjs](scripts/idle/timers.mjs) logs every Node timer that fires in a
  process over its inspector; [spawns.mjs](scripts/idle/spawns.mjs) every child process it starts, with the caller;
  [idle-trace.mjs](scripts/idle/idle-trace.mjs) Chromium's trace of the window's processes; `--inspect` flags on main,
  the shared process and the extension host, `SIGUSR1` on the agent server.

## Not done, and why

- **The focus burst in main (18 git processes) and the warm agent, plugin host and adapter it starts** belong to the
  warm-on-intent path (firstword's area). This report measures them; it does not change when a focus warms. What idle
  owns in that burst (the second kernel-log read, the code-index fork) is fixed above.
- **The Chromium and Node floor per process** (mojo notifications, the memory-pressure evaluator, PartitionAlloc's
  reclaimer, V8's GC timers) is not Volt's code; the only lever is fewer processes at rest. The shared process, the
  extension host (the branch chip needs the git extension, round 5) and the network service stay.
- **The plugin host a focus warm starts lives 90 s after its last message** (round 5's idle stop), the warm agent 30 s:
  a focus right before ADEMark's 90 s settle leaves the host alive into the sample's first seconds. Stopping it with
  the warm agent it served is process lifetime (weight's area); noted, not changed.
- **A warm ACP adapter alive during a covered sample** (both valid minafter covered rows, 2 of 5 minbase front rows):
  the focus warm's agent outlives the 90 s settle often enough to dominate a 60 s idle sample (18-22 wakeups/s, up to
  2.3 % of a core). Left for round 7 (it is the largest single idle cost these rows show).
- **The agent server's 20 s WebSocket pings** (both directions) stay: longer pings would delay dead-peer detection for
  web and phone clients by minutes for about 0.1 wakeups/s.
